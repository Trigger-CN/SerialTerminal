# 多串口支持设计与实施基线

## 0. 当前状态与已定决策

本文是多串口（Serial Group）能力的**设计基线与实施约束**。

> **实施进度：P1（主进程多实例化）已完成并通过验证；P2–P5 尚未开始。**
> 当前主进程已按 `groupId` 完全隔离，但 UI 仍为单串口形态（`renderer.js` 固定使用 `DEFAULT_SERIAL_GROUP_ID`）。
> P1 的已核实实现细节以 `main.js` 为准，摘要见 `agent_notes.md` 第 13A 节。

已确认的产品与技术决策（**实施时不得自行更改**）：

| 决策点 | 结论 |
| --- | --- |
| 快捷指令作用域 | **全局共享**。`quickSendCommands` 及自动识别发送总开关保持单份，不随分组变化 |
| 分屏首版范围 | **分组级 + 组内级一起做**，不缩减为仅分组级 |
| 实施顺序 | **P1 已完成；P1.5–P5 待定**。（P1 含双端口真机冒烟，已验证通过） |
| Shell 标签归属 | **不归属任何分组**，始终位于分组层 |
| 并发与线程 | **端口留在主进程**，不改串口读的线程模型（binding 已自带读线程）；多线程用于 P1.5 的日志落盘去同步化 |

已处理（P1 已实测）：同一进程并发打开多个串口端口在本机（Windows 10 + serialport 13.0.0）成立：COM6 与 COM1 可同时打开、各自可写、关闭其中一个不影响另一个。

并发模型的完整论证（含已核实的 binding 线程源码位置、三种候选方案的取舍、以及一个已确认的串流缺陷）见 **第 5A 节**。

---

## 1. 目标与范围

### 1.1 目标

1. 通过「添加串口」按钮把应用从单串口模式切换到多串口模式，无需独立的总开关。
2. 每个串口分组拥有独立的主终端、过滤标签页、图表标签页。
3. 标签栏分两层：上层为串口分组标签（与 Shell 标签同级），下层为当前分组的所有子标签。
4. 点击分组标签时左侧设置侧栏跟随切换，显示并控制该分组自己的串口参数。
5. 分组标签支持左右、上下分屏，下层子标签跟随所属分组。
6. 单分组时标签栏回归一层，Shell 标签回到该层。

### 1.2 明确不在范围内

- 跨分组的终端内容合并、统一搜索。
- 单条串口连接内多协议会话。
- 分组的云端同步或跨设备迁移。
- 快捷指令按分组隔离（已决定全局共享）。

---

## 2. 现状勘察（代码事实）

本节记录设计所依据的已核实事实。修改前请重新核对，不要沿用本文的隐式假设。

### 2.1 主进程是单串口单例

`main.js` 用一组模块级变量表达「唯一一条串口连接」：

```js
let currentSerialPort = null;      // main.js:2728
let serialSendEncoding = 'utf8';
let serialNewlineMode = 'crlf';
let serialSessionId = ...;
let serialConnectInProgress = ...;
let rawBinaryBuffers / rawBinaryByteCount / rawBinaryLogPath
let tabLogBuffers / throughputState
```

`cleanupSerialConnection()`（main.js:2837 起）以 `currentSerialPort` 作为唯一判据，并通过 `if (port && currentSerialPort && port !== currentSerialPort) return;` 丢弃「非当前端口」的迟到事件。这套判据在存在多个端口时会**丢弃真实数据**，是 P1 必须重写的核心。

`connect-serial` 的处理是 **close-then-open**：已有连接时先 `await currentSerialPort.close()`，再打开新端口。因此多端口并存在当前架构下结构性不可达。

### 2.2 渲染层同样是单例

`renderer.js` 持有单份：`isConnected`（约 4889 行）、`serialTerm`、`dataParser`、`hexFormatter`、`textDecoder`、`quickTriggerDecoder`，以及三个扁平数组 `filterTabs` / `shellTabs` / `chartTabs`，再加单份 `workspaceLayout`。

### 2.3 接收通道已带会话标识但未分流

主进程发出的 `serial-output-bytes` 已经携带 `sessionId`，但渲染层的 `flushSerialOutputQueue()` **没有按 `sessionId` 路由**，直接写入唯一那个 `serialTerm`。这是多串口改造中最自然的接缝：协议层已经具备分流能力，缺的是消费端。

### 2.4 分屏是「恰好两栏」，不是 N 栏

`workspace-manager.js` 有三处硬编码：

1. `DEFAULT_WORKSPACE_LAYOUT` 固定 `panes = [pane-1, pane-2]`，`paneSizes` 固定两项且和为 1。
2. `normalizeWorkspaceLayoutShape()` 的 `activePaneId` 白名单只接受 `pane-1 | pane-2`。
3. `reconcileEmptyPaneLayout()` 只理解这两个 pane：仅在 pane-2 为空时把标签搬回 pane-1 并关闭分屏。

另外 `tab-main` 是全局硬编码标签，归一化时若缺失会被强制 unshift 回 `pane-1`。

好消息是该模块通过注入回调（`getLayout` / `setLayout` / `cloneLayout` / `normalizeLayout` / `persistLayout` / `getPaneDom` / `getPaneTabsList` / `getPaneTabsContent` / `onLayoutApplied` / `onTabActivated` / `onTabMoved` / `fitWorkspace`）与 DOM 解耦，因此 N pane 化改造是可单测的。

### 2.5 配置 schema

`main.js:138` 当前为 `const CONFIG_VERSION = 14;`。多串口引入后必须升到 15，并做无损迁移（见第 9 节）。

---

## 3. 数据模型

### 3.1 串口分组

串口分组是「一条独立串口连接 + 它自己的一套标签页」：

```js
serialGroups: [{
  id: 'g-xxxxxxxx',           // 稳定唯一 id，作为 IPC 与配置键
  title: 'COM3',              // 标签显示名，默认端口名，可重命名
  portPath: 'COM3',
  status: 'disconnected',     // disconnected | connecting | connected | error
  sessionId: null,            // 连接后由主进程下发
  serialOptions: {            // ── 组内独享
    baudRate, dataBits, stopBits, parity,
    receiveDisplayMode, receiveEncoding, sendEncoding, newlineMode
  },
  filterTabs: [],             // ── 组内独享
  chartTabs: [],              // ── 组内独享
  workspaceLayout: { ... }    // ── 组内独享，复用现有两栏模型
}]
```

设计要点：

- `id` 一旦生成永不复用。分组关闭后其 id 作废，避免迟到的异步回调写到新分组。
- `sessionId` 是「本次连接」的标识，断线重连后会变；`id` 不变。两者不可混用。
- 状态机单向推进：`disconnected → connecting → connected`，失败进 `error`，`error` 下允许重试回 `connecting`。

### 3.2 `tab-main` 从全局常量变为组内隐式标签

现状 `tab-main` 是全局唯一字符串。多分组后必须区分归属，标签 id 改为：

```text
`${groupId}:tab-main`
```

配套调整：

- 归一化逻辑改为**对每个分组独立执行**，保证该组必有且仅有一个主标签，且位于该组 `pane-1`。
- 分组删除时，其主标签随组消失，不参与「主标签必须存在」的全局校验。
- 过滤标签、图表标签的 id 同样加组前缀，保证跨组唯一。
- 日志 `tabId` 沿用同一命名规则，主进程按前缀解析出 `groupId`。

---

## 4. 主进程多实例化

### 4.1 单例下沉为 Map

```js
const serialSessions = new Map();   // groupId -> session

// session = {
//   groupId, port, sessionId,
//   sendEncoding, newlineMode, connectInProgress,
//   rawBinaryBuffers, rawBinaryByteCount, rawBinaryLogPath,
//   tabLogBuffers, throughput,
//   closing   // 防止 close 与 open 竞态
// }
```

需要整体迁移的变量清单：`currentSerialPort`、`serialSessionId`、`serialSendEncoding`、`serialNewlineMode`、`serialConnectInProgress`、`rawBinaryBuffers`、`rawBinaryByteCount`、`rawBinaryLogPath`、`tabLogBuffers`、`throughputState`。

### 4.2 连接语义变更

| 场景 | 现状 | 目标 |
| --- | --- | --- |
| 新分组连接 | 先关闭现有端口 | 只检查**该 groupId** 是否已有连接 |
| 同一分组重连 | 关闭该端口再开 | 关闭该组端口再开（语义保留） |
| 其他分组已连接 | 被强制关闭 | **不受影响** |
| 断开 | 无参数，断开唯一端口 | `disconnect-serial(groupId)`，只断指定组 |

`list-ports` 保持全局，不需要 `groupId`。

### 4.3 事件归属与迟到事件

`cleanupSerialConnection()` 的判据从「是否等于 `currentSerialPort`」改为「是否等于 `serialSessions.get(groupId).port`」。这是 P1 最容易出错的地方：现有代码在多端口下会把其他端口的正常 `data` / `error` / `close` 事件当成迟到的幽灵事件丢弃。

新增约束：

- 每次连接生成新的 `sessionId`，事件回调闭包捕获自己的 `sessionId` 与 `groupId`。
- `sessionId` 不匹配的回调一律丢弃（这是**正确**的丢弃，与当前错误丢弃不同）。
- 分组关闭时先标记 `closing = true`，再 `close()`，回调看到 `closing` 直接返回。

### 4.4 日志与 raw 文件隔离（按端口号建文件夹）

`saveAllTabsLogToFiles` 开启时，多个分组会写同一路径，产生交错污染。

**已定方案：每个串口在日志目录下拥有一个以端口号命名的子文件夹。**

```text
<logPath>/
├─ 2026-04-01/                ← logCreateDateFolder 开启时（保持现有行为）
│  ├─ COM3/
│  │  ├─ Main_Terminal_log_2026-04-01_10-00-00.txt
│  │  ├─ Filter_XXX_log_....txt
│  │  └─ raw_2026-04-01_10-00-00.bin
│  ├─ COM5/
│  │  └─ ...
│  └─ _shell/                 ← Shell 不归属任何分组，固定用保留名
└─ COM3/                      ← logCreateDateFolder 关闭时
   └─ ...
```

**日期目录在外、端口目录在内**，不是反过来。原因：`log-cleanup.js` 的 `cleanEntries()` 只对 `^\d{4}-\d{2}-\d{2}$` 的目录递归（第 35 行），端口目录名不匹配这个正则。若反过来写成 `<logPath>/COM3/2026-04-01/`，外层 `COM3` 不匹配日期格式会被直接 `continue` 跳过，里面的过期日志**永远不会被清理**。保持日期在外可以完全复用现有清理逻辑，零改动。

#### 目录名的生成规则

```js
function buildPortLogFolderName(portPath, groupId) {
  const base = path.basename(String(portPath || '').trim());
  const safe = sanitizeFileNamePart(base).replace(/[. ]+$/g, '');
  return safe || groupId;   // 端口缺失时退回 groupId，避免多个组撞进同一目录
}
```

- 用 `path.basename()`：Windows 下 `COM3` → `COM3`；Linux 下 `/dev/ttyUSB0` → `ttyUSB0`（否则会把整条路径当文件夹名，产生非法字符）
- 去尾部 `.` 与空格：Windows 会默默修正，导致目录名与预期不一致
- 端口名缺失（未连接就开启日志）时退回 `groupId`
- 端口重命名/更换不迁移历史日志，新文件夹自然生成——旧文件夹的归属由名称本身表达，无需额外索引

#### 已实测验证

本机（Windows 10 + Node 20）实际执行了目录创建与追加写入，结果：

```text
COM3 -> OK   dir created, append ok, size=2
COM11 -> OK  dir created, append ok, size=2
com9 -> OK   dir created, append ok, size=2
port-COM3 -> OK
USB-SERIAL CH340 (COM3) -> OK
```

结论：`COM3` / `COM11` 这类名字作为**目录名**在本机可用，不会触发设备命名空间重定向。注意区分：`CreateFile("COM3")` 会打开设备，而 `mkdir("COM3")` 只是普通相对目录名——路径形式不同，语义不同。

> 未验证：更老的 Windows 版本与特定文件系统下 `COM1`–`COM9` 作为目录名是否也完全无副作用。这是历史遗留保留名的经典坑，P1 冒烟时随手复测一次即可，不阻塞设计。

#### 需要同步改造的现有函数

| 位置 | 现状 | 改动 |
| --- | --- | --- |
| `main.js:936` `ensureLogDirectory()` | 无参数，返回全局目录 | 增加端口参数：`ensureLogDirectory(folderName)` |
| `main.js:807` `ensureMainLogFilePath()` | 用 `ensureLogDirectory()` | 传入当前端口文件夹名 |
| `main.js:823` `ensureRawBinaryLogPath()` | 同上 | 同上 |
| `main.js:756` `ensureTabLogFile()` | 同上 | 按 `tabId` 所属分组取端口名；Shell 标签固定用 `_shell` |
| `main.js:914` `rotateLogFilesForCurrentDate()` | 重置 `mainLogFilePath` / `rawBinaryLogPath` / 各 `entry.filePath` | 逻辑不变，但重置后下次会按新日期+当前端口重新计算 |
| `log-cleanup.js` | 只递归日期目录 | **无需改动**（见上方日期在外层的原因） |

#### 必须一并修复的缓存缺陷

`mainLogFilePath` 在 `connect-serial` 里**没有被重置**（`main.js:2889-2966` 只重置了 `rawBinaryLogPath`）。当前单串口下表现为：换端口后通用日志继续写到旧端口的文件里。

多端口后这个缺陷会放大成「日志写进错误端口的文件夹」，是数据归属错误而非仅仅是命名难看。P1 必须在每次连接成功时重置：

```js
mainLogFilePath = '';
rawBinaryLogPath = '';
// 该分组的 tab 日志 entry 一并清空 filePath
```


---

## 5. IPC 与输出分流

### 5.1 通道参数

所有串口相关通道新增 `groupId`：

```text
connect-serial      { groupId, path, options }
disconnect-serial   { groupId }
serial-write        { groupId, ... }
get-throughput      { groupId }
flush-tab-log       { groupId, tabId }     // tabId 已带组前缀，groupId 可推导但显式传更稳
serial-output-bytes { sessionId, data }    // 已带 sessionId，不变
```

### 5.2 渲染层分流

```js
const sessionToGroup = new Map();   // sessionId -> groupId
```

`flushSerialOutputQueue()` 收到字节后：

1. 查 `sessionToGroup` 得到 `groupId`
2. 取该组上下文：`dataParser` / `hexFormatter` / `textDecoder` / `mainTerminal`
3. 写入该组主终端及其 pending 缓冲

必须按组隔离的还有：

- 过滤标签页分发（只在该组内 fan-out）
- 图表数据流（该组独立时间序列与独立 Worker 客户端）
- 快捷指令自动触发（**配置全局共享，但触发的发送目标跟随接收到数据的那个组**）
- `serialLineCounter` / `logLineCounter` 行号（每组独立计数）

> 快捷指令的语义补充：命令定义是全局的，但「哪个串口收到的数据触发了自动发送」决定了发送到哪个串口。即作用域是「全局配置 + 组内触发」。

---

## 5A. 并发与线程模型（多线程的实际落点）

> 本节回答「多串口能不能用多线程」并把它落到具体代码位置。结论：**串口读本身已经是线程化的，不需要再包一层；真正需要多线程的是日志落盘与 CPU 密集的格式化路径。**

### 5A.1 已有的线程事实（不要重复造）

**Windows：每个端口已自带一个阻塞读线程。** 依据 `node_modules/@serialport/bindings-cpp/src/serialport_win.cpp`：

- `Read()` 内部 `CreateThread(..., ReadThread, ...)`，`ReadThread`（第 506 行）在 `while (!baton->complete)` 中循环 `ReadFileEx(...)` + `SleepEx(INFINITE, TRUE)`（第 530、538 行）。`SleepEx` 是 alertable 等待，等待期间**不占 CPU**。
- 数据到达后经 `uv_async_send(async)`（第 542 行）回到 JS 主线程执行完成回调。
- `Write()` 同理 `CreateThread(..., WriteThread, ...)`（第 431 行），`WriteFileEx` + `SleepEx` 后再 `uv_async_send`。
- 端口句柄以 `FILE_FLAG_OVERLAPPED` 打开（第 100 行），共享模式默认 `FILE_SHARE_READ | FILE_SHARE_WRITE`（第 89 行；`lock` 为真时降为 0）。

**结论**：打开 N 个端口就已经是 N 个 OS 读线程在并发等待。再开 `worker_threads` 去调 `port.read()` **不会减少任何等待时间**，只会多一次跨线程数据拷贝。

**Linux / macOS 不走自定义线程**：`dist/unix-read.js` 用 `promisify(fs.read)` 配合 poller 的 `readable` 事件（第 21–42 行），由 libuv 线程池异步执行；`linux.js` / `darwin.js` 的 `read()` 均委托给 `unixRead()`。

> libuv 默认线程池大小为 4，且本仓库未设置 `UV_THREADPOOL_SIZE`（已用 `Select-String` 在 `main.js` / `renderer.js` / `package.json` 中确认为 0 处引用）。端口数较多时的实际并发表现**尚未实测**，列为验证项而非常已确认缺陷。

### 5A.2 真正的瓶颈在 JS 主线程的同步写盘

串口读不占 JS 线程，但每个字节到达后仍要在主线程做一串同步工作。当前已确认的同步阻塞点：

| 位置 | 调用 | 性质 |
| --- | --- | --- |
| `main.js:772` `appendToTabLogSync()` | `fs.appendFileSync` | 同步写盘，每个过滤标签每次刷写一次 |
| `main.js:844` `flushRawBinaryLogSync()` | `fs.appendFileSync` | 同步写盘 |
| `main.js:958` `saveLog()` | `fs.appendFileSync` | 同步写盘 |
| `main.js:684` / `1201` / `1208` | `fs.writeFileSync` | 配置写盘 |

这些调用都在主进程 JS 线程上。**关键后果不是「慢」而是「牵连」**：

```text
COM3 高速刷数据 → 同步 appendFileSync 阻塞主线程 80ms
                        ↓
COM5 / COM7 的 data 回调同样在排队，三个端口的 UI 一起卡
```

单串口时这只表现为偶发卡顿；多串口后，一个高吞吐端口可以拖慢**所有**端口。这是多串口场景下线程化真正的价值所在，而它跟「串口读」无关。

### 5A.3 三种可选方案

| 方案 | 内容 | 收益 | 代价 | 结论 |
| --- | --- | --- | --- | --- |
| **A. 仅用 binding 自带线程** | 不动线程模型，靠 `Map<groupId, session>` 做多实例 | 零新增复杂度；已能支持 N 端口并发读 | 一个端口的高吞吐仍可能拖慢全局 UI | **P1 采用** |
| **B. 每端口一个 Worker 持有串口** | worker 内 `require('serialport')` 自行打开端口 | 端口完全隔离 | 端口枚举、错误、重连全部跨线程；**native handle 不可跨线程转移**，主进程将失去对端口的直接控制 | **不推荐** |
| **C. 把日志落盘与 HEX 格式化解耦到 Worker** | 端口仍在主进程，只把「格式化 + 写盘」投递到 worker 队列 | 主线程不再被 `appendFileSync` 阻塞；一个端口卡不住其他端口 | 需引入队列与背压控制 | **P1 之后的首选优化** |

关于方案 B 的硬限制（必须写进约束，否则会走弯路）：`SerialPort` 实例持有一个 native fd/handle，`worker_threads` 的 `postMessage` 只能传可结构化克隆的值和少数可转移对象，**不能把一个已打开的串口句柄搬到另一个线程**。若要让 worker 拥有端口，就只能让 worker 自己打开；而主进程仍需枚举端口、做错误弹窗与重连 UI，控制权被切成两块，反而比现状更难维护。

### 5A.4 决策

1. **P1 不改线程模型**。串口读已由 binding 提供线程，`Map<groupId, session>` 化即可获得 N 端口并发。
2. **日志同步写盘列为 P1 之后的第一个性能项**（方案 C）。理由：它与多串口的耦合最强——端口数增加时写盘频率线性上升，而它影响的又是全局 UI。
3. **不在 Worker 中打开串口**。格式化解码类工作可以进 Worker（已有现成范式），端口生命周期必须留在主进程。
4. 图表解析已经有 Worker 实现可直接复用：`chart-parser-worker.js` + `chart-parser-worker-client.js`（含超时 500ms、批量 500、队列上限 5000、溢出丢弃计数与 `_recover` 重启）。多串口后只需**每个分组一个 `ChartParserIpcClient` 实例**，而不是另起一套线程框架。

### 5A.5 已确认的新增缺陷点（P1 必须修）

`main.js:2807` `flushSerialOutputQueue()` 在合并队列时只取 `queued[0].sessionId` 作为整批的会话标识（第 2815 行），并把整批字节合并成一个 `serial-output-bytes` 消息。`queueSerialOutput()`（第 2826 行）靠「sessionId 不同就先 flush」维持单队列顺序假设。

多端口下这个假设会失效：只要一次调度窗口内混入了两个 session 的条目，整批就会被贴上第一个 session 的 id，**数据会串到错误的分组**。P1 必须改为**按 `sessionId` 分桶**（`Map<sessionId, entries[]>`），每个 session 独立合并与发送。

## 6. 双层标签栏

### 6.1 渲染规则

**分组数 > 1（多串口模式）**

```text
┌──────────────────────────────────────────────────┐
│ [COM3] [COM5] [COM7]  │  [Shell 1] [Shell 2]  [+] │  ← 上层：分组 + Shell
├──────────────────────────────────────────────────┤
│ [主终端] [过滤1] [过滤2] [图表1]                    │  ← 下层：当前分组子标签
│                                                    │
│                  （工作区内容）                      │
└──────────────────────────────────────────────────┘
```

**分组数 = 1（回归现状）**

```text
┌──────────────────────────────────────────────────┐
│ [主终端] [过滤1] [图表1]  │  [Shell 1]        [+] │  ← 一层，Shell 混排
└──────────────────────────────────────────────────┘
```

规则汇总：

- **上层**：`serialGroups`（active 高亮）+ `shellTabs`
- **下层**：`activeGroup` 的 `tab-main` / `filterTabs` / `chartTabs`
- Shell 标签永不归属任何分组，始终在分组层
- 分组从 2 减到 1 → **自动塌回一层**，Shell 标签回到同一层
- 分组从 1 增到 2 → **自动升为两层**，Shell 标签上移到上层
- 切换分组标签不销毁下层 DOM，只切换可见性（保留终端内容与滚动位置）

### 6.2 「添加串口」按钮

位于标签栏右端。点击即完成三件事：

1. 创建一个未连接的新分组，`serialOptions` 继承当前分组（无当前分组则用 `lastSerialOptions`）
2. 若原本只有 1 个分组 → 触发升层，新分组成为 active
3. 侧栏设置切到新分组，用户填端口/波特率后点连接

即「点击添加串口」这个动作本身就是进入多串口模式，不需要额外的模式开关。

### 6.3 分组关闭

关闭分组 = 断开该组串口 + 销毁该组所有子标签与其终端实例 + 从 `serialGroups` 移除。关闭到只剩一个时触发塌层。

需确认的行为：分组处于 `connected` 状态时关闭需二次确认，避免误断正在通行的连接。

---

## 7. 设置侧栏跟随

左侧设置 tab 的绑定对象从「全局唯一」改为 `activeGroupId`：

| 设置项 | 作用域 |
| --- | --- |
| 波特率 / 数据位 / 停止位 / 校验 | **按组** |
| 接收模式 / 接收编码 / 发送编码 / 换行模式 | **按组** |
| 字体 / 高亮配色 / 壁纸 / 暗色遮罩 | 全局 |
| 时间戳 / 行号 / 滚回行数 | 全局 |
| 发送回显三开关 / 回显背景色 | 全局 |
| 日志自动保存 / 保存范围 / Shell 日志开关 | 全局（路径按组隔离） |
| 快捷指令 | 全局 |

切换分组时：

1. 读取该组 `serialOptions` 重新渲染控件
2. 同步顶部连接状态按钮与端口显示
3. 同步该组终端引用（搜索框、过滤输入框等焦点相关控件）

控件变更时写回 `activeGroup.serialOptions` 并持久化，**不得**写全局 `lastSerialOptions`（后者仅作为新分组的默认值来源）。

---

## 8. 两级分屏

### 8.1 目标形态

**分组级分屏 + 组内级分屏同时支持**：

```text
┌───────────────────────┬───────────────────────┐
│ 分组 COM3              │ 分组 COM5              │
│ ┌─────────┬─────────┐ │ ┌───────────────────┐ │
│ │ 主终端   │ 过滤1    │ │ │ 主终端             │ │
│ └─────────┴─────────┘ │ └───────────────────┘ │
└───────────────────────┴───────────────────────┘
        ↑ 分组级（左右/上下）      ↑ 组内级（左右/上下）
```

即两级独立的 split 容器：

- **外层**：`WorkspaceSplit`，每个 pane 承载一个 `serialGroup`
- **内层**：每个分组自己的 `WorkspaceSplit`，承载该组的主/过滤/图表标签

### 8.2 `workspace-manager.js` 的 N pane 化

| 位置 | 改动 |
| --- | --- |
| `panes[]` | 由固定两项改为动态数组，支持 1..N |
| `activePaneId` | 去掉 `pane-1/pane-2` 白名单，改为「必须存在于 `panes` 中」 |
| `paneSizes` | 对任意 pane 键归一化，总和为 1 |
| `reconcileEmptyPaneLayout` | 改为通用裁撤：任一 pane 为空 → 移除该 pane → 剩余尺寸重新归一化 → 剩 1 个时关闭分屏 |
| `moveWorkspaceTab` | 支持任意 `(sourcePane, targetPane)` 对 |
| `tab-main` 校验 | 按 pane 所属分组判断，不再是全局唯一 |

改造策略：**保留现有两 pane 的归一化行为作为 N=2 的特例**，用现有测试作为回归护栏。这样单分组下的分屏行为与今天完全一致，风险可控。

### 8.3 内层与外层的职责划分

- 外层只关心「哪个分组在哪个 pane」，不关心组内标签
- 内层只关心「组内哪个标签在哪个 pane」，不感知其他分组
- `fitWorkspaceTerminals()` 需要两级遍历：先按外层 pane 尺寸，再按内层 pane 尺寸
- 拖动分界条时两级都要触发 fit，且复用 `.workspace-root.resizing` 禁用过渡

---

## 9. 配置迁移

### 9.1 字段归属变化

现有配置中的这些字段在多串口后失去唯一归属：

```text
lastSerialOptions · filterTabs · chartTabs · workspaceLayout
```

### 9.2 迁移规则

1. `CONFIG_VERSION` 从 **14 升到 15**
2. 若配置中无 `serialGroups`：用现有 `lastSerialOptions` / `filterTabs` / `chartTabs` / `workspaceLayout` 构造一个默认分组，`portPath` 取 `lastPort`（或空），`title` 取端口名
3. 迁移后旧字段**保留不删**，仅作为「新分组默认值来源」，避免回退旧版本时读不到配置
4. 归一化必须幂等：重复执行 `normalizeConfig()` 结果不变

### 9.3 迁移风险控制

- 迁移前备份 `config.json` 为 `config.v14.backup.json`
- 首次以 v15 启动后，若用户回退到旧版本，旧版本读到的仍是完整 v14 字段（因为保留未删）
- 迁移只读不写直到首次保存，避免启动即改写配置

---

## 10. 分阶段落地

每阶段独立提交、独立可回滚。

### P1 — 主进程多实例化（**本轮只做这个**）

**范围**

1. `currentSerialPort` 等单例下沉为 `Map<groupId, session>`
2. 所有串口 IPC 通道增加 `groupId`
3. `connect-serial` 不再关闭其他分组的端口
4. 新增 `disconnect-serial(groupId)`
5. 日志 / raw 文件按**端口号命名的子文件夹**隔离（`<logPath>/[日期]/<端口号>/`，见 4.4）
6. `cleanupSerialConnection` 按 `sessionId` 判据重写
7. `flushSerialOutputQueue()` 改为按 `sessionId` 分桶（当前单队列假设会串流，见 5A.5）
8. 不改线程模型：串口读已由 binding 提供独立线程（见 5A.1）
9. 每次连接成功时重置 `mainLogFilePath` / `rawBinaryLogPath` / 该组各 `entry.filePath`（否则换端口后通用日志继续写旧文件，见 4.4）

**明确不做的**

- 不改任何 UI
- 不加双层标签栏
- 不做分屏改造
- 不改设置侧栏

**验收**

- 单端口全部现有行为回归通过（`npm test` 全绿）
- 两个真实串口设备同时打开，各自收发互不干扰（接收侧逐字节比对，确认无串流）
- 关闭其中一个不影响另一个
- 日志目录下出现以端口号命名的子文件夹（如 `COM3/`），且两个端口写入的文件不在同一目录
├─ 断开后重连同一端口 → 继续写同一端口文件夹（非新开一个）
├─ 断开后连接另一个端口 → 新建对应端口文件夹，不再往旧端口文件追加
- 开启 `logCreateDateFolder` 时目录层级为 `<logPath>/<日期>/<端口号>/`，且 `log-cleanup` 能正常删除过期日志
- 断线重连只影响对应分组
- 记录多端口并发下的主线程响应：单端口与双端口同时高吞吐时，UI 卡顿是否显著变差（为方案 C 提供基线数据）

> P1 的第一件事应是**双端口真机冒烟**，先确认 Node `serialport` 在本项目环境下能稳定并发持有两个端口。若这一步不成立，整个方案需要重新评估，不应继续投入 P2。

### P1.5 — 日志落盘去同步化（多线程的实际收益点）

把「格式化 + 写盘」从主线程移出，端口仍留在主进程（方案 C，见 5A.3）。

**范围**

1. 新增日志写入 Worker（沿用 `chart-parser-worker-client.js` 的队列/超时/重启范式）
2. `main.js:772` `appendToTabLogSync`、`main.js:844` raw 二进制、`main.js:958` `saveLog` 改为投递到队列
3. 队列满时按当前已有的「溢出提示」机制上报，不静默丢失（与 `shouldAcceptMoreCachedLog` 语义一致）
4. 分组隔离与 P1 一致：队列按 `groupId` 分桶，避免不同端口串写

**本轮不做**：配置写盘（`fs.writeFileSync`）同步化。触发频率低，收益远小于风险。

**验收**

- 单端口高吞吐（≥ 115200）时主线程无长任务毛刺
- 双端口同时高吞吐，一个端口卡顿不影响另一个的 UI 响应
- 日志内容与同步版本逐字节一致
- 写盘失败与队列溢出的用户可见提示与现状相同

**为何不选方案 B（端口进 Worker）**：native 串口句柄无法跨 `worker_threads` 转移，只能让 worker 自己打开；而端口枚举、错误弹窗、重连 UI 都在主进程，控制权被切开后更难维护。详见 5A.3。

### P2 — 渲染层分组上下文对象化

把 `isConnected`、`serialTerm`、`dataParser`、`hexFormatter`、`textDecoder`、`filterTabs`、`chartTabs`、`workspaceLayout` 收进每个分组的上下文对象；`sessionToGroup` 映射建立；渲染层消费侧按组丢弃不匹配会话的字节。

验收：分组切换不串流、不串行号；两组同时刷数据互不影响。

### P3 — 双层标签栏与添加串口按钮

实现第 6 节的升降层规则、`+` 按钮、分组关闭。

验收：1↔2 分组切换时 Shell 标签正确升降层；单分组下与现状完全一致。

### P4 — 设置侧栏跟随

按第 7 节绑定 `activeGroupId`。

验收：切换分组时设置正确回显与回写；全局设置不受分组切换影响。

### P5 — 两级分屏

按第 8 节完成 `workspace-manager` 的 N pane 化，先做分组级，再叠加组内级。

验收：分组级左右/上下分屏；组内级左右/上下分屏；两级同时存在时 fit 正确；关闭分组后布局收敛。

---

## 11. 风险与未验证项

### 11.1 未验证（最高优先级）

**同一进程内并发打开多个串口端口的稳定性未经验证。** Node `serialport` 在原理上支持多实例，但本项目从未实测。潜在问题：

- Windows 下同型号 USB 转串口设备的枚举与打开顺序
- 驱动对多设备同时独占的行为
- 高吞吐并发时的 `data` 事件顺序与背压
- Linux/macOS 下 libuv 线程池（默认 4）在端口数超过 4 时的并发度表现

**处置**：P1 开工第一件事就是双端口真机冒烟，不通过则停止后续阶段。

> 与此相关的另一个未验证点：多端口并发时**主线程**是否能保持流畅。串口读本身不占 JS 线程（见 5A.1），但同步写盘会占（见 5A.2），所以真正的风险在写盘而不在读。P1 验收时要顺手采集一份双端口高吞吐下的主线程响应基线，作为 P1.5 是否需要做的依据。

### 11.2 已知风险

1. **改动面极大**。涉及 `main.js` 串口段、`renderer.js` 终端/过滤/图表/布局全链路、`workspace-manager.js`、配置结构、i18n。这是本项目迄今最大的一次重构。
2. **事件归属判断错误**。`cleanupSerialConnection` 的判据从「单例比较」改为「会话比较」时，最容易把正常数据当迟到事件丢弃。P1 必须专门为此写测试。
3. **配置迁移不可逆**。迁移写坏会导致回退旧版本读不到配置。必须保留旧字段并先备份。
4. **日志文件污染**。两个组写同一文件会交错，且这种损坏事后无法恢复。已定方案为按端口号建子文件夹（见 4.4）；但若连接时未重置 `mainLogFilePath`，日志会被写进**上一个端口**的文件夹，这是归属错误而非仅命名难看。
5. **焦点与键盘路由**。分屏后多个终端同时在屏，键盘输入必须严格跟随焦点所在组，否则会往错误端口发送数据——这是**有实际物理后果**的风险（可能向错误设备发送控制命令）。
6. **`workspace-manager` 现有测试全部基于两 pane 假设**，N pane 化后需同步改写而非只加新测试。
7. **快捷指令跨组误发**。自动发送由 A 组数据触发、发往 B 组的场景必须明确排除；实现上应保证触发时携带来源 `groupId` 并只向该组发送。
8. **输出队列串流**。`flushSerialOutputQueue()` 当前以 `queued[0].sessionId` 作为整批标识（main.js:2815），多端口下会贴错标签。P1 必须改为按 sessionId 分桶（见 5A.5）。
9. **端口文件夹名冲突**。同一端口重复连接会复用同名文件夹（预期行为）；但若用户同时连接两个逻辑上同名不同物理的端口（如两个不同主机映射到同一 COM 名），后写入的会追进同一文件。靠 `groupId` 退回只能在端口名为空时生效，名称相同时无法区分——属极罕场景，不做额外处理，但需在文档中明示。
10. **日期目录与端口目录的顺序**。必须是 `<logPath>/<日期>/<端口号>/`，不能反过来，否则 `log-cleanup.js` 的日期正则匹配不到外层端口目录，过期日志永远不会被清理（见 4.4）。
9. **线程方案的误用**。若有人以「多线程」为由把串口搬进 Worker，会碰到 native 句柄不可跨线程转移的硬限制，并导致主进程失去端口控制权。端口生命周期必须留在主进程（见 5A.3）。

### 11.3 回滚策略

每阶段独立提交，回滚只需 revert 对应提交。P1 的提交必须保证：回滚后单串口行为完全恢复，且 v15 配置能被 v14 逻辑正常读取（靠保留旧字段实现）。

---

## 12. 验收清单

### P1

- [ ] 双端口真机并发打开成功（首个门禁）
- [ ] 两组同时收发，数据**逐字节**校验不串流（含 `serial-output-bytes` 的 sessionId 归属正确）
- [ ] 关闭 A 组，B 组连接与数据不受影响
- [ ] 断开重连只影响对应分组
- [ ] 日志目录下存在以端口号命名的子文件夹（如 `COM3/`），两个端口不写同一目录
- [ ] 重连同一端口继续写同一文件夹；换成另一个端口则新建对应文件夹，不往旧文件追加
- [ ] 开启 `logCreateDateFolder` 时层级为 `<logPath>/<日期>/<端口号>/`，`log-cleanup` 能正常清理
- [ ] `npm test` 全绿
- [ ] 单端口全部现有行为回归通过
- [ ] 采集双端口高吞吐下的主线程响应基线，作为 P1.5 的决策依据

### P1.5

- [ ] 日志写入改经 Worker 队列，主线程无 `appendFileSync` 长任务
- [ ] 队列按 `groupId` 分桶，不同端口不串写
- [ ] 日志内容与同步版本逐字节一致
- [ ] 队列溢出与写盘失败的用户提示与现状一致
- [ ] 双端口同时高吞吐时，一个端口卡顿不影响另一个的 UI 响应

### P2

- [ ] `sessionId → groupId` 分流正确
- [ ] 行号、过滤器、图表数据各自独立
- [ ] 快捷指令自动发送只向触发来源组发送

### P3

- [ ] 1→2 分组升层，Shell 标签上移
- [ ] 2→1 分组塌层，Shell 标签回落
- [ ] 单分组下标签栏与现状完全一致

### P4

- [ ] 切换分组设置正确切换
- [ ] 全局设置不被分组切换影响
- [ ] 新分组继承合理的默认参数

### P5

- [ ] 分组级左右/上下分屏
- [ ] 组内级左右/上下分屏
- [ ] 两级共存时 fit 正确
- [ ] 关闭分组后布局正确收敛
- [ ] 键盘输入严格跟随焦点组

---

## 13. 相关文档

- `agent_notes.md`：项目接手入口与架构不变量
- `ToDo.md`：全局工程待办与验证基线
- `README.md`：面向用户的功能说明
- `CHART_TAB_IMPLEMENTATION_PLAN.md`：图表页设计基线（多串口后图表需按组隔离）
