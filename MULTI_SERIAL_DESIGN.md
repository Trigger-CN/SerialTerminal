# 多串口支持设计与实施基线

## 0. 当前状态与已定决策

本文是多串口（Serial Group）能力的**设计基线与实施约束**。

> **实施进度：P1（主进程多实例化）已完成并通过验证；P2 已完成分组注册表、分组上下文、行解析器、分组终端运行时注册表、分组 DOM 标识契约与终端工厂托管；P3 已全部完成（标签归属/分组增删改/标签栏结构描述/输出分桶四个纯逻辑层 + 渲染层数据面按 groupId 路由 + 分组标签栏 + 容器创建与关闭 + **Shell 标签的两层升降**）；配置 v14 → v15 迁移已完成并实测；P4（侧栏设置跟随）已完成（四个显示参数真正下沉到分组上下文 + 侧栏回显与写回绑定 activeGroupId）；P5 已全部完成（每分组独立的 pane 结构 + 每分组独立的布局与布局管理器 + 过滤页/图表页按分组各一份）。**
> 当前主进程已按 `groupId` 完全隔离；渲染层的数据面（输出队列、终端实例、解码器、HEX 格式化器、日志路径）也已按 `groupId` 隔离，并已能用「添加串口」建出真实容器、切换分组、关闭分组后回到单层；多分组时 Shell 标签与分组标签同处上层，单分组时回落到底层标签行；切分组时侧栏 9 个串口控件与连接按钮跟随该分组回显。**每个串口分组现在拥有自己的 root / pane / splitter / 标签行 / 过滤页 / 图表页 / 布局状态，多分组时并排显示；仍未在真实字节流层面验证的项见第 11.1 节。**
> 验证手段（本阶段新增）：除单测与模块加载门禁外，多了一轮**真实窗口 + CDP 真实点击**验证。这是必要的：分组标签栏首版在 `node --check`、加载门禁与 437 项全量测试下全绿，却存在「两个分组标签拿到同一个 id」导致关闭分组完全点不到的缺陷。详见 6.1B 与第 12 节。
> P1 的已核实实现细节以 `main.js` 为准，摘要见 `agent_notes.md` 第 13A 节。

已确认的产品与技术决策（**实施时不得自行更改**）：

| 决策点 | 结论 |
| --- | --- |
| 快捷指令作用域 | **全局共享**。`quickSendCommands` 及自动识别发送总开关保持单份，不随分组变化 |
| 分屏首版范围 | **分组级 + 组内级一起做**，不缩减为仅分组级 |
| 实施顺序 | **P1 已完成；P1.5–P5 待定**。（P1 含双端口真机冒烟，已验证通过） |
| Shell 标签归属 | **不归属任何分组**，始终位于分组层 |
| 并发与线程 | **端口留在主进程**，不改串口读的线程模型（binding 已自带读线程）；日志落盘实测后维持同步写，不做 Worker（见第 10 节 P1.5） |

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

`CONFIG_VERSION` 现为 **15**，由 [`serial-groups-config.js`](serial-groups-config.js) 的 `SERIAL_GROUPS_CONFIG_VERSION` 统一提供，`main.js` 只做 `const CONFIG_VERSION = SERIAL_GROUPS_CONFIG_VERSION;` 引用，不再硬编码。多串口引入的 `serialGroups` 字段与无损迁移规则见第 9 节。

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

### 6.1A 归属判定已落地（纯逻辑层）

上述规则的实现位于 [`serial-group-tabs.js`](serial-group-tabs.js)，不碰 DOM，可直接在 Node 断言（`test/serial-group-tabs.test.js`，17 项）。

为什么先把归属判定抽成纯函数：双层标签栏真正的难点不是样式，而是「哪个标签属于哪一层」。归属算错时标签会消失或跑到错层，而这类错误在浏览器里只能靠肉眼发现；抽成纯函数后就变成可断言的输入输出。

已固定的非显然行为（改前必读）：

| 场景 | 行为 | 理由 |
| --- | --- | --- |
| `activeGroupId` 不存在 | 退回第一个分组 | 返回 null 会让下层整层空掉，且用户无法自行恢复 |
| 当前分组的 `activeTabId` 失效 | 退回该组第一个标签 | 否则下层处于「一个都没选中」，终端区看起来是空的 |
| 分组列表含重复 id | 去重，只留第一个 | 两个相同分组标签都会指向同一个 `activeGroupId`，视觉上像「点了没反应」 |
| 分组标题为空 | `Serial N` 占位 | 空标题渲染成一块无法识别的空白 |
| 关闭当前分组 | 优先选**右邻**，无右邻再选左邻 | 「总是退回第一个」会让连续关右侧分组时焦点不断跳回最左 |
| 关闭非当前分组 | 保持当前选择不变 | 关别人不该把当前视图抢走 |
| 单分组模式 | `groupLayer` 只含 Shell，串口标签在下层 | 只有一个分组时再显示分组标签是纯噪声，必须与改造前完全一致 |

> **接线状态（2026-11-06 更新）**：两层投影已落地。实际有两种分工：
>
> - `serial-group-tab-bar.js` 负责**分组标签本身的节点描述**（id / 按钮 / 是否可关闭 / 可见性）；
> - `serial-group-tabs.js` 的 17 项规则是**归属判定的权威表述**，但其 `buildTabBarModel()` 假设「下层是某分组自己的标签列表」，与重构后「每个分组一个主终端标签 `tab-main-<g>`」的架构不符，因此**没有直接调用它**。
>
> Shell 标签的两层升降由 `renderer.js` 的 `syncShellTabLayer()` 实际执行（见 6.7），判据就是 `serialGroups.length > 1`，与 `buildTabBarModel()` 的 `isMultiGroup` 完全一致。


### 6.1B 分组标签栏的结构描述层（已落地）

实现在 [`serial-group-tab-bar.js`](serial-group-tab-bar.js)，纯数据、不碰 DOM，`test/serial-group-tab-bar.test.js` 15 项覆盖。

```text
GROUP_TAB_BAR_ID    = 'serial-group-tab-bar'
GROUP_TAB_LIST_ID   = 'serial-group-tab-list'
ADD_GROUP_BUTTON_ID = 'add-serial-group-btn'

groupTabId(groupId)         // 'tab-group-<sanitized>'，默认分组为 'tab-group-default'
groupTabButtonId(groupId)   // `${groupTabId}-button`
groupCloseButtonId(groupId) // `${groupTabId}-close`
describeGroupTab(group, { isDefault })
describeGroupTabBar({ groups, isMultiGroup, defaultGroupId })
describeAddGroupButton({ disabled })
describeGroupVisibility(groups, activeGroupId)
```

五条非显然规则（改前必读）：

| 规则 | 内容 | 理由 |
| --- | --- | --- |
| 分组标签与主终端标签 id 永不相交 | `tab-group-<g>` vs `tab-main-<g>` | 同 id 会让点击分组标签同时命中主终端标签，行为无法预期 |
| 默认分组也带 `-default` 后缀 | `tab-group-default-button` | 它代表「分组」，不是「该分组内的主终端」 |
| 默认分组 `closable: false` 但仍渲染关闭按钮 | 按钮置灰（`.disabled`） | 「有的没有按钮」会让标签宽度跳变、点击位置漂移 |
| `groupId` 放 `dataset` 不放闭包 | `dataset: { groupId }` | 标签会被重建，闭包会跟着丢，事件委托读不到 |
| 未知激活分组时全部隐藏 | 不猜一个分组显示 | 猜错会让用户看到不属于自己的终端内容 |

`describeGroupTabBar` 的显示判据是 **`isMultiGroup === true` 且 `groups.length > 1`**，两者缺一不可；单分组时 `hidden: true`、`tabs: []`，但 `canAdd` 恒为真（否则用户永远开启不了多分组）。`describeAddGroupButton` 在已达上限时**禁用而不是隐藏**（隐藏会让布局跳动）。`describeGroupVisibility` 要求非激活分组真正 `hidden`，不能只靠透明度或 aria —— xterm 在 `display:none` 的容器里 `fit()` 会算出 0 尺寸，切回来时字符被压扁或右侧被裁掉。

> **接 DOM 时踩过的真实缺陷（必读）**：`describeGroupTabBar()` 返回的 `tabs` **已经是 `describeGroupTab()` 的完整结果**（字段是 `groupId` / `buttonId` / `closeButtonId` / `closable` / `className`），**没有 `id` 字段**。如果在渲染层再把它喂回 `describeGroupTab()`，后者会用 `source.id` 取 groupId 而得到 `undefined`，**所有分组都会回落到 `'default'`**。症状是：两个分组标签拿同一个 id、新分组不高亮、`tab-group-g-1-close` 不存在、关闭分组整条流程点不到。
> 这类缺陷 `node --check`、renderer 模块加载门禁与全部单测都无法暴露——它们的 `document.getElementById` 每次返回新 stub，表达不了「同一个 id 被生成了两次」。**只能靠真实窗口 + 真实点击验证**（见 12 节的 CDP 验证项）。

### 6.2 「添加串口」按钮

位于分组层右端。点击即完成三件事：

1. 创建一个未连接的新分组，`serialOptions` 继承当前分组（无当前分组则用 `lastSerialOptions`）
2. 若原本只有 1 个分组 → 触发升层，新分组成为 active
3. 侧栏设置切到新分组，用户填端口/波特率后点连接

即「点击添加串口」这个动作本身就是进入多串口模式，不需要额外的模式开关。

**落地记录（`renderer.js` 的 `addSerialGroupFromUi`）**：`addSerialGroup(serialGroups, { inheritFrom: current })` → `serialGroupRegistry.ensureGroup` + `serialGroupContext.ensureContext`（**缺这两步会让 `serial-output-bytes` 以 `unknown-group` 把该分组全部字节静默丢弃**）→ `persistSerialGroups()` → `ensureSerialGroupMainTabDom` → `renderSerialGroupTabBar` → `applyActiveSerialGroup` → `portSelect.focus()`。

**新分组保持 `status = 'disconnected'`，不自动连接，等用户手动点连接**——这是用户明确确认的产品决定，不要改成自动连接。

### 6.3 分组关闭

关闭分组 = 断开该组串口 + 销毁该组所有子标签与其终端实例 + 从 `serialGroups` 移除。关闭到只剩一个时触发塌层。

分组处于 `connected` 状态时关闭需二次确认，避免误断正在通行的连接。

**落地顺序（`renderer.js` 的 `closeSerialGroup`，顺序不可乱）**：默认分组直接拒绝 → 已连接时 `window.confirm` → `disconnect-serial` → `serialRuntimes.release(id)`（内部先 `dispose()`）→ `serialGroupIo.delete(id)` → `serialOutputBuckets.clear(id)` → `serialGroupContext.removeContext(id)` → `serialGroupRegistry.removeGroup(id)` → 移除按钮 / 面板 / 容器 → `removeTabFromWorkspace(tabId, { persist: false })` → `removeSerialGroup` → 按「优先右邻」切到相邻分组。

先 `release` 后 `removeGroup` 的原因：释放时要能查到这个分组自己的运行时与上下文；反过来先删注册表会让释放路径拿到 `undefined` 而静默跳过 `dispose()`，canvas 与滚动缓冲会挂在已移除的 DOM 上不释放。

### 6.4 分组增删改的数据层（已落地）

实现在 [`serial-groups-model.js`](serial-groups-model.js)，同样是纯逻辑（不碰 fs / Electron / DOM），`test/serial-groups-model.test.js` 17 项覆盖。

**新分组的继承边界（只继承串口参数，绝不继承数据）：**

| 字段 | 新分组 | 理由 |
| --- | --- | --- |
| `serialOptions`（波特率/数据位/停止位/校验/收发编码/换行） | **继承**当前分组 | 再连一个同型号设备时不用重填 |
| `portPath` | **清空** | 继承来的端口已被原分组占用，否则用户点连接会去抢一个正在用的口 |
| `title` | 占位 `Serial N` | 继承来的标题会与新分组实际端口不符 |
| `filterTabs` / `chartTabs` / `workspaceLayout` | **清空** | 这些属于具体端口的数据视图，搬给一个还没连接的端口只会误导 |
| `status` / `sessionId` | `disconnected` / `null` | 新分组尚未连接 |

**`nextGroupId` 的两个非显然约束：**

1. 取**当前未被占用的最小 `g-<n>`**，不是「长度 + 1」。删掉中间分组后长度小于最大编号，用长度会直接撞车（实测 `[g-1, g-3]` 长度 2 → 若用长度+1 会得到 `g-3`）。
2. **不能用时间戳或随机数**。这个 id 会写进配置文件并参与日志目录归属，带随机性的话同一份配置两次加载会得到不同 id，幂等性立刻失效——与迁移层固定 `'default'` 是同一个理由。

**其它已固定的行为：** 删除不存在的 id 返回原列表而不抛错（标签栏关闭按钮可能被连点，抛错会变成未捕获异常）；删除会把被删分组对象一并返回，调用方需要用它去断串口、销毁子标签、关日志会话；重命名空标题回落到原标题（空标题标签是一块无法识别的空白）；标题上限 60 字符。

### 6.5 渲染层的分组状态与生命周期（已落地）

`renderer.js` 新增的三个模块级状态：

```js
let serialGroups = [];
let activeGroupId = REGISTRY_DEFAULT_GROUP_ID;
let isApplyingSessionGroups = false;   // 防止 applyConfig → persist 的回环
```

| 函数 | 职责 | 不可省的细节 |
| --- | --- | --- |
| `syncSerialGroupsFromConfig(config)` | 从配置同步分组状态与注册表 | **必须对每个分组执行 `serialGroupRegistry.ensureGroup` 与 `serialGroupContext.ensureContext`**。缺这两步会让 `serial-output-bytes` 以 `unknown-group` 把这些分组的全部字节静默丢弃 |
| `ensureSerialGroupMainTabDom(groupId, title)` | 建主标签按钮 / `.main-tab-pane` / `.terminal-wrapper` | 最后必须 `addTabToPane(tabId, 'pane-1', { activate: false, persist: false })`，否则 `switchPaneTab` 会因 `tabIds` 不含它而直接返回 |
| `applyActiveSerialGroup({ fit })` | 改注册表 activeGroupId + toggle 类名与 `aria-selected` + `switchPaneTab` | 最后必须 `fitWorkspaceTerminals()`，否则从隐藏容器切回来的终端尺寸是错的 |
| `renderSerialGroupTabBar()` | 重画分组标签栏 | 必须**直接用 `describeGroupTabBar()` 的 `tabs`**，不得二次描述（见 6.1B 结尾的缺陷记录） |
| `addSerialGroupFromUi()` | 新建分组并切过去 | 新分组 `status = 'disconnected'`，不自动连接 |
| `closeSerialGroup(groupId)` | 完整关闭流程 | 顺序见 6.3 |

`ensureSerialGroupMainTabDom` 建的三样东西（全部走 `serial-group-dom.js`，不手写拼接）：

```js
button.id = mainTabButtonId(id);   // 默认 'tab-main-button'，其它 'tab-main-g-1-button'
tabPane.id = mainTabId(id);       // 默认 'tab-main'，其它 'tab-main-g-1'
wrapper.id = serialContainerId(id); // 默认 'serial-container'，其它 'serial-container-g-1'
```

`applyConfig` 末尾调用 `syncSerialGroupsFromConfig(config)`（受 `isApplyingSessionGroups` 守卫），位置必须在布局恢复**之后**，确保 pane 的 `tabs-list` / `tabs-content` 已在 DOM 里。

### 6.6 数据面按分组路由（已落地）

改造前渲染层只有**一个**输出队列与**一个**终端，直接做标签栏会得到两类静默故障：未登记分组的字节被 `accepts()` 判为 `unknown-group` 后**直接丢弃**（终端空白、日志无记录、无报错），以及补上 `ensureGroup` 后两组字节被 `Buffer.concat` 拼进同一批、写进同一终端与同一日志文件。因此先做数据面、再做 UI。

| 基础设施 | 语义 |
| --- | --- |
| `serialOutputBuckets`（[`serial-output-buckets.js`](serial-output-buckets.js)） | 替代原单数组队列；`drain()` 的每一项严格只含一个 groupId 的字节；水位（默认 1 MiB）按分组独立判断 |
| `resolveSerialGroupId(groupId)` | 未登记回落默认分组，**绝不静默丢弃** |
| `isActiveSerialGroup(groupId)` | 过滤页 / 图表页目前全应用一份，只跟随激活分组 |
| `getGroupSessionId(groupId)` | 会话号真相源改为注册表（按分组各自递增） |
| `serialGroupIo: Map<groupId, { textDecoder, hexFormatter }>` | 每分组一份解码器与 HEX 格式化器；格式化器回调绑定自己的 groupId |
| `getSerialRuntime` / `getSerialTerm` | 按 groupId 取自 `serialRuntimes`，未登记回落默认 |
| `resolveGroupIdForMainTab(tabId)` | 用 `mainTabId(id)` 反查分组，供 `clearTerminalByTabId` 使用 |

全部改为接受 `groupId` 的写入路径：`writeTextLines` / `writeHexLines` / `renderSentRecord` / `flushTextReceive` / `resetTextReceive` / `createTextDecoder` / `writeMainTabLog` / `writeFilterTabLog` / `writeTabLog` / `connectSerialFromUi({ groupId })` / `sendSerialRequest` / `serial-output-bytes` / `serial-error` / `serial-disconnected` / `clearTerminalByTabId`。`main.js` 的 `ipcMain.on('write-tab-log')` 透传 `payload.groupId`。

**四条必须保留的关键判断：**

1. `serialSessionId` **只在 `groupId === REGISTRY_DEFAULT_GROUP_ID` 时同步**。否则 g-2 的一条入站消息会覆盖默认分组的会话号，让默认分组的写入被误判为 `STALE_SERIAL_SESSION` 而静默失败。
2. `serial-disconnected` **只在默认分组时**做 `updateSerialConnectionState(false)` / `stopAutoSendRuntime()` / 释放 `serialDisconnectWaiters` / `ipcRenderer.send('flush-tab-logs')`。关掉 g-2 不该让默认分组界面显示「已断开」。
3. `clearTerminalByTabId` 必须调 `serialOutputBuckets.clear(groupId)`——清屏后未上屏的旧数据不能紧接着又冒出来。
4. `getMainTabTitle(groupId)`：默认分组仍返回 `'Main_Terminal'`（零变化），其它分组取配置里的 title。

**本层仍是单例的部分（不得当作已完成）**：`filterTabs` 与 `chartTabs` 全应用只有一份，只跟随激活分组。按分组各一份属于后续阶段。

### 6.7 Shell 标签的两层升降（已落地）

用户描述的形态是「多串口时上层为串口分组标签 + Shell 标签（同级），下层为该分组的标签页」。实现上是**移动既有节点**，不是重建。

```js
// renderer.js
function syncShellTabLayer() {
    // 单分组：按 pane.tabIds 的相对顺序用 insertBefore 落回 pane 标签行
    // 多分组：appendChild 到 #serial-group-tab-list（排在分组标签之后）
}
```

**为什么必须移动节点而不能重建**：Shell 的 `onclick` / `ondblclick` / 关闭监听都绑在按钮节点自身，终端在 `tabPane` 里的 `terminalWrapper`。重建会丢掉监听、多出一个无人引用的 xterm 实例，而且用户可能对那个 Shell 滚动/输入到某个位置，重来一次缓冲区内容也没了。

**单分组回到 pane 行时必须用 `insertBefore` 而不是 `appendChild`**：用户可以把 Shell 拖到主标签前面，直接用 `appendChild` 会把它推到末尾，即「切到多分组再切回来」就静默改掉了用户的标签顺序。落位锚点取 `pane.tabIds` 里该 Shell 之后第一个仍在 DOM 里的标签。

**`workspace-manager.js` 为此改了两处**（不是新增 API，而是补全原有假设）：

| 位置 | 原假设 | 问题 |
| --- | --- | --- |
| `hasRenderableTab()` | 按钮一定在 `paneEl` 内 | Shell 搬到分组层后按钮找不到 → `prunePaneTabIds()` 会把它从 `tabIds` 里删掉 → **Shell 标签彻底消失** |
| `applyLayoutToDom()` | 把每个按钮 `appendChild` 回所属 pane 的 `tabsList` | 任何布局刷新（切分组、加标签、分屏）都会把 Shell 拽回 pane 行 |

因此新增两个**可选注入**：`resolveTabButtonHost(tabId, paneId)`（返回按钮应挂到哪个容器，返回 `null` 沿用 pane 的 `tabsList`）与 `findTabButton(tabId, paneId)`（放宽按钮查找范围）。两者都为 `undefined` 时行为与改造前逐字一致。

**还有一处容易漏的**：`applyActiveTabToPane()` 原本只在 `paneEl` 内清 `active` 类。Shell 被搬到分组层后不在 `paneEl` 里，会导致它残留上一个激活态，表现为「两个标签同时亮」。现改为按 `dataset.paneId` 全文档清理。

**调用时机**：`renderSerialGroupTabBar()` 末尾、`listEl.replaceChildren()` **之后**。`replaceChildren` 会把上一轮搬上来的 Shell 节点一并摘除，所以必须在它之后放回去；同时 `onLayoutApplied` 也会再调一次，保证任何布局重排后位置正确。

**已验证（真实点击 29/29）**：单分组在 pane 行且不在分组层；多分组升到分组层并排在分组标签之后；点击后终端切到该标签且仍在分组层；关闭多分组后回落 pane 行；全程 `shellCount` 恒为 1（未被复制）、渲染进程零未捕获错误。

---

## 7. 设置侧栏跟随（P4，已落地）

### 7.1 作用域划分

左侧设置 tab 的绑定对象从「全局唯一」改为 `activeGroupId`：

| 设置项 | 作用域 |
| --- | --- |
| 端口 / 波特率 / 数据位 / 停止位 / 校验 | **按组**（存 `group.portPath` / `group.serialOptions`） |
| 接收模式 / 接收编码 / 发送编码 / 换行模式 | **按组**（存 `SerialGroupContextStore`） |
| 字体 / 高亮配色 / 壁纸 / 暗色遮罩 | 全局 |
| 时间戳 / 行号 / 滚回行数 | 全局 |
| 发送回显三开关 / 回显背景色 | 全局 |
| 日志自动保存 / 保存范围 / Shell 日志开关 | 全局（路径按组隔离） |
| 快捷指令 / 自动发送总开关 | 全局（已定决策） |

### 7.2 四个显示参数的下沉手法（实际实现）

关键在于**保留四个模块级 `let` 作为默认分组的缓存**，而没有一次性改写全部 64 处读写点：

```js
function getGroupDisplay(groupId = REGISTRY_DEFAULT_GROUP_ID) {
    const id = resolveSerialGroupId(groupId);
    const state = serialGroupContext.get(id);
    return { receiveDisplayMode, receiveEncoding, sendEncoding, newlineMode };  // 取自 state
}

function setGroupDisplay(groupId, patch = {}) {
    const id = resolveSerialGroupId(groupId);
    const state = serialGroupContext.setDisplay(id, patch);
    if (id === REGISTRY_DEFAULT_GROUP_ID) {
        receiveDisplayMode = state.receiveDisplayMode;   // 同步模块级缓存
        receiveEncoding = state.receiveEncoding;
        sendEncoding = state.sendEncoding;
        newlineMode = state.newlineMode;
    }
    return state;
}
```

**代价与约束**：默认分组的值与四个 `let` 始终恒等，因此现有裸变量读取点（日志、快捷指令等）行为零变化；**但任何非默认分组必须走 `getGroupDisplay()`，不得读那四个变量。**

**默认参数必须用常量 `REGISTRY_DEFAULT_GROUP_ID`，绝不能用 `activeGroupId`**：`renderer.js` 模块顶层有 `getHexFormatter(REGISTRY_DEFAULT_GROUP_ID)` 这样的立即求值表达式，而 `activeGroupId` 声明在其后；默认参数引用它会直接重演本项目已经踩过一次的 TDZ 启动崩溃。

### 7.3 按分组读取的消费点

| 位置 | 为何必须按分组 |
| --- | --- |
| `dispatchSerialBatch(id, bytes)` | `receiveDisplayMode` 决定这批字节走 HEX 还是文本。不按分组读就无法让 A 组 text、B 组 hex |
| `createTextDecoder(id)` | 解码器实例本来就按分组存，但「用哪种编码解码」以前是全局的 |
| `clearTerminalByTabId` / `serial-disconnected` 的 flush 判据 | 否则 flush 错分组的 formatter |
| `sendSerialRequest` | 写入目标分组的发送编码与换行模式，`newlineMode` 不能缺省 |
| `getMainInputRequest` | 发送输入框发送的是激活分组的端口 |
| 新建过滤页的 `dataMode` | 过滤页新建时跟随当前可见终端的显示模式 |
| 右键菜单的 `receiveDisplayMode` | 菜单只开在可见终端上 |

### 7.4 侧栏回显与写回

`applyActiveSerialGroup()` 切完可见标签页后依次调用三个函数：

```text
applyGroupSerialOptionsToSidebar(activeGroupId)   // 9 个控件回显
refreshConnectButtonState()                        // 连接按钮跟随该分组
updateFilterModeStatuses()                         // 过滤页暂停态重算
```

`applyGroupSerialOptionsToSidebar()` 回显的控件：`port-select` / `baud-select` / `data-bits-select` / `stop-bits-select` / `parity-select` / `newline-mode-select` / `receive-mode-select` / `receive-encoding-select`（含 `disabled` 同步）/ `send-encoding-select`。

三条非显然的实现约束：

1. **全部用 `document.getElementById` 而不是模块级 `const`。** 该函数会被 `applyActiveSerialGroup` 在模块加载早期（`syncSerialGroupsFromConfig`）触发，那时下方的 `portSelect` / `baudSelect` 等 `const` 还在 TDZ 里。
2. **回显期间置 `isApplyingSessionGroups = true` 并在 `finally` 恢复。** 否则程序写入控件会触发 `change` → `saveSerialModeConfig()` → 把回显值当成新值再写一次配置。
3. **端口与波特率只在选项真的存在时才选中。** `refreshPorts()` 是异步的；若强制 `select.value = 'COM9'` 而选项还没建出来，`<select>` 会静默变成空值。

控件变更时写回两条路径（`persistActiveGroupSerialOptions()`）：

- `serialGroups[activeGroupId].serialOptions` —— 该分组自己的一份；
- `lastSerialOptions` —— 全局默认值，**只作为新建分组的继承来源**。

只写前者会让重启后丢设置；只写后者会让「切到 g-1 改波特率」把默认分组的波特率也改掉。

### 7.5 三个 `switch*` 的控件守卫

`switchReceiveMode` / `switchReceiveEncoding` / `switchSendEncoding` 都新增了 `groupId` 参数，但**只有 `id === activeGroupId` 时才去改侧栏控件与刷新发送校验**。理由：关闭或后台配置变更可能针对非激活分组，此时去改可见控件会让用户正在看的界面无端跳变。

### 7.6 快捷指令的例外（已定决策）

`createQuickTriggerDecoder()` 继续用**默认分组**的接收编码，快捷指令与自动发送的 `sendEncoding` 也继续读模块级缓存。因为快捷指令作用域本身就是全局共享——不得盲目改成 `activeGroupId`。

### 7.7 已验证

真实窗口 + CDP 真实点击 **37/37 通过**（`verify-groups-out6.txt`，exit=0），其中 P4 新增 6 项：

| 断言 | 实测 |
| --- | --- |
| 单分组时接收编码可读 | `{encoding:"utf8", mode:"text"}` |
| 在 g-1 侧栏改接收编码能生效 | `{value:"gbk", activeGroup:"g-1"}` |
| 切回默认分组后侧栏回显未变 | `{encoding:"utf8", activeGroup:"default"}` |
| 切回 g-1 后侧栏回显新值 | `{encoding:"gbk", activeGroup:"g-1"}` |
| 关闭 g-1 后分组栏塔回单层 | `{groupTabs:0, barHidden:true}` |
| 关闭 g-1 后默认分组编码未被污染 | `{encoding:"utf8"}` |

**尚未验证**：真实双端口字节流隔离（从未做过）；分组切换后 xterm `fit()` 在 `display:none` 容器切回来的尺寸。

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
- 备份**只写一次**：仅当「配置尚未迁移过」且「备份文件尚不存在」时生成。已迁移过的配置再备份会把真正的 v14 原件覆盖成 v15，用户回退时就无据可依
- 备份失败不得阻断启动：一次磁盘问题不能让用户打不开程序，只记 `log.error` 继续

> **订正**：本节曾写「迁移只读不写直到首次保存」。实测与实现均不成立——`loadConfig()` 在归一化后发现内容变化会立即写回 `config.json`。这是必要的：若不写回，`saveConfig()` 后续以 `currentConfig` 为默认值反复归一化，磁盘上的 v14 形态会与内存态长期分叉。

### 9.4 落地记录（v14 → v15）

实现在 [`serial-groups-config.js`](serial-groups-config.js)，纯逻辑、不碰文件系统与 Electron，可直接在 Node 断言。

**两个必须保留的设计决定：**

1. **默认分组 id 固定为 `'default'`，不能随机。** 随机 id 会让每次 `normalizeConfig()` 产生新 id，幂等性直接失效，日志目录归属也会跟着漂移。
2. **迁移判据是 `Object.prototype.hasOwnProperty.call(source, 'serialGroups')`，不是 `Array.isArray(...) && length`。** 空数组 `serialGroups: []` 是**合法状态**（用户把分组全关了、只剩 Shell），绝不能被当成「没迁移过」而重新造出一个幽灵分组。

其余已实现细节：

- `CONFIG_VERSION` 不再硬编码在 `main.js`，改为 `const CONFIG_VERSION = SERIAL_GROUPS_CONFIG_VERSION;`
- `normalizeConfig()` 末尾 `return migrateSerialGroupsConfig(normalized);`——迁移放在归一化最后一步，保证任何写盘路径（`loadConfig` / `saveConfig` / `persistTelemetryState`）都经过同一处
- 旧字段 `lastSerialOptions` / `filterTabs` / `chartTabs` / `workspaceLayout` 全部保留，支持降级回 v14
- `sessionId` 在归一化时一律重置为 `null`：它是运行时标识，重启后必须失效；`id` 才是稳定键
- 缺 id 的分组补位序 id（`g-00000001`），重复 id 派生确定性后缀（`g-1`、`g-1-2`），两者都稳定，不破坏幂等
- `buildMigratedDefaultGroup` 在端口为空时给 `'Serial 1'` 占位标题，避免分组标签变成一块无法识别的空白

**隔离实测（真实 v14 配置，`--user-data-dir` 指向独立目录，连启两次）：**

| 观察项 | 第一次启动 | 第二次启动 |
|---|---|---|
| `config.json` 大小 | 21667 → 23284 字节 | 23284 字节不变 |
| `configVersion` | 15 | 15 |
| `serialGroups.length` | 1 | 1（未重复生成） |
| 分组内容 | `default` / `COM6` / `COM6` / `921600` | 同上 |
| 旧字段 | `lastSerialOptions.path=COM6`、`filterTabs` 保留 | 保留 |
| 备份 | 21667 字节，`configVersion=14` | mtime 未变，未被覆盖 |

> **验证陷阱（已踩过，务必记住）**：开发版与已安装版共用同一个 `%APPDATA%\serialterminal`。若机器上还跑着**旧版本**的已安装程序，它会用自己的 `saveConfig` 把刚迁移好的 v15 配置覆盖回 v14 结构，表现为「迁移没生效」。判定方法：比对 `resources/app.asar` 里是否存在 `serialGroups`；若不存在，就是旧代码在覆盖。实机验证迁移必须用独立 `--user-data-dir`，或在确认没有旧版进程运行时进行。

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

### P1.5 — 日志落盘去同步化（已实测裁定：不做）

> **结论：本阶段经基线实测后判定收益不成立，不做。** 保留本节仅作为决策记录，避免后人重复论证。

原本的假设是「`fs.appendFileSync` 在主线程会拖慢所有端口」。实测（本机 Windows 10 + Node 20，写临时文件后已清理）推翻了该假设：

| 刷盘批次 | 单次 `appendFileSync` 耗时 |
| --- | --- |
| 56 KB（115200 bps × 5 秒刷盘间隔） | 0.39 ms |
| 450 KB（921600 bps × 5 秒） | 0.69 ms |
| 1 MB | 0.93 ms |
| 10 MB（`rawBufferAutoFlushMB` 默认阈值批次） | 12.72 ms |

事件循环抖动（每 300 ms 反复写一次，空闲基线为 17.51 ms，即 Windows 定时器 15.6 ms 分辨率）—— 56 KB 时 19.35 ms、450 KB 时 28.32 ms、10 MB 时 31.69 ms；而用 `fs.promises.appendFile`（libuv 线程池）对照时全部落在 16.5–17.3 ms，与空闲基线无异。

**关键事实：真实数据量下同步写盘只有 0.39 ms，比操作系统的定时器分辨率还小。** 即使再优化到 0 ms，UI 也感知不到差异；只有 10 MB 级洪水批次才有 12.7 ms 的单次阻塞，而那种量级下真正的瓶颈是终端渲染而不是写盘。用 Worker 换来的收益买不回引入的异步时序复杂度（见下方“本轮不做”）。

**因此：**

- 主线程同步写盘保持不变，`appendToTabLogSync` / `flushRawBinaryLogSync` / `saveLog` 继续使用 `fs.appendFileSync`
- 不新增日志写入 Worker
- 若未来出现真实的高吞吐卡顿现场（需有可复现的帧掉帧观测），应先查终端渲染路径（`terminal-output-buffer` / 分批写入）而不是先动写盘

也一并说明为何不选方案 B：native 串口句柄无法跨 `worker_threads` 转移，只能让 worker 自己打开；而端口枚举、错误弹窗、重连 UI 都在主进程，控制权被切开后更难维护（详见 5A.3）。

### P2 — 渲染层分组上下文对象化

把 `isConnected`、`serialTerm`、`dataParser`、`hexFormatter`、`textDecoder`、`filterTabs`、`chartTabs`、`workspaceLayout` 收进每个分组的上下文对象；`sessionToGroup` 映射建立；渲染层消费侧按组丢弃不匹配会话的字节。

验收：分组切换不串流、不串行号；两组同时刷数据互不影响。

**进度：已完成三步（分组注册表、分组上下文、行解析器），并已具备分组终端运行时注册表；持有 DOM 的对象尚未下沉，且受阻于单容器契约。**

已落地：

- 新增 [`serial-group-registry.js`](serial-group-registry.js)：`SerialGroupRegistry` 持有 groupId → `{ sessionId, connected, portPath }` 与 `sessionToGroup` 映射，对外提供 `ensureGroup` / `beginSession` / `invalidateSession` / `groupIdForSession` / `accepts` / `isVisible` / `removeGroup`。它是纯逻辑模块，不依赖 DOM，因此可以脱离 Electron 直接单测。
- `accepts()` 是「这条字节该不该进本分组的终端」的唯一判定入口，返回 `{ accepted, reason, groupId }`，其中 `reason` 区分 `ok` / `unknown-group` / `session-other-group` / `stale-session`，便于定位到底是丢错了还是本来就该丢。
- 新增 [`serial-group-context.js`](serial-group-context.js)：`SerialGroupContextStore` 提供 `serialLineCounter` / `logLineCounter` / `serialNewLine` 与四个收发显示参数（`receiveDisplayMode` / `receiveEncoding` / `sendEncoding` / `newlineMode`），以及 `resetLineCounters()` / `nextLineNumbers()` / `setDisplay()`。**当前只有三个计数器真正生效**：四个显示参数仍由 `renderer.js` 自己的模块级 `let` 持有，`setDisplay()` 尚未被调用。`nextLineNumbers()` 可选择只推进屏幕行号或只推进日志行号，对应改造前两个独立计数器的语义。
- `renderer.js` 已接入：`serial-output-bytes` 的归属判定走 `accepts()`；`connectSerialFromUi` 用 `beginSession()`；`disconnectSerial` 与 `serial-disconnected` 用 `invalidateSession()`；`getPrefix()` / `getLogPrefix()` 改从 `groupState(groupId)` 取行号；`clearTerminalByTabId` 与连接成功处改调 `resetLineCounters()`。
- 新增 [`serial-data-parser.js`](serial-data-parser.js)：把串口接收的行切分逻辑（含跨 chunk 拼接与超长行保护）从 `renderer.js` 抽出。**关键修复**：原 `SerialDataParser` 在 `parse()` / `flush()` 内部直接调用全局 `getPrefix()`，一旦出现多个分组各自的 parser 实例，所有实例都会把行号记到同一个分组上，表现为两个端口的行号互相跳号。现改为构造时注入 `prefixProvider`，每个实例绑定自己的分组。
- 兼容性：首版只注册 `default` 一个分组，单串口行为不变；不带 `sessionId` 的旧载荷退化为按 groupId 判定。

**硬约束：剩余对象无法脱离 UI 结构完成。**

`serialTerm` 在模块加载时就 `new Terminal(...)` 并 `serialTerm.open(document.getElementById('serial-container'))`，而 `index.html` 中 `#serial-container` 是整个页面**唯一**的串口终端容器（位于 pane-1 的 tab-main 内）。因此把 `serialTerm` / `filterTabs` / `chartTabs` 下沉成「每个分组一份」并不能凭空完成：必须先有「一个分组一个 Terminal 容器」的 DOM 契约。

否则得到的只是一个只能挂一个 Terminal 的上下文对象，属于**伪多实例**：看起来分组隔离了，实际第二个分组无处可显示。

因此 P2 的剩余部分必须与 P5 合并推进。**P5 的 DOM 层已完成**（`workspace-manager` 已能驱动任意 pane 数），但「一个分组一个 Terminal 容器」还需要 `index.html` 的动态 pane 创建，而 pane 数量由分组数量驱动，因此归 P3。在这之前下沉 `serialTerm` 只会产出无法验证的代码。

### P2 新增：分组终端运行时注册表（已落地）

实现在 [`serial-group-runtime.js`](serial-group-runtime.js)，`test/serial-group-runtime.test.js` 19 项覆盖。它管理的是「实例的生命周期」，而不是构造细节：

```text
SerialTerminalRuntimeRegistry
  constructor({ defaultGroupId, createRuntime })   // 不建任何实例
  has(groupId) / get(groupId)                       // 只读，不隐式创建
  attach(groupId, runtime)                         // 登记已存在的实例
  getOrCreate(groupId)                             // 惰性构造，失败不留半成品
  release(groupId) / releaseAllExceptDefault()     // 释放前先 dispose
  assertDefaultAttached()                          // 启动自检
```

三条硬约束（改前必读）：

1. **必须惰性创建**。xterm 的 `open()` 需要真实 DOM 节点，分组标签还没渲染出来就构造会直接失败。所以构造函数里不允许预先创建任何实例。
2. **默认分组不可释放**。它是应用启动就存在的分组，释放后没有任何路径能恢复，用户会看到一个空白终端区。
3. **释放必须先调 `dispose()`**。只从 Map 删掉引用而不断开，xterm 持有的 canvas/textarea 与滚动缓冲会一直挂在 DOM 上；切换几十次分组后内存与事件监听都会累积，而这种泄漏在任务管理器里看不出来，只表现为「用久了越来越卡」。

`attach()` 为什么必需：改造初期，默认分组的终端在 `renderer.js` 模块加载时就已经建好并 `open` 过了。此时再让注册表去构造一个，会得到**两个绑在同一容器的 xterm 实例**——互相抢输入、画面互相覆盖，比不接入更糟。所以必须先能把已有实例挂进去。`attach` 对已登记的分组返回 `false` 而不覆盖：静默替换会让先前持有旧引用的调用方继续操作一个已被遗弃的实例，这种错误极难发现。

其它已固定的行为：`get()` 不隐式创建（调用方在渲染前取终端拿到 `null` 即可立即报错，比悄悄建一个未 `open` 的终端好定位）；`createRuntime` 返回非法值时不缓存半成品；`dispose` 抛错时仍从 Map 移除（留着只会让后续每次访问都拿到损坏对象），错误走 `console.error` 不外抛，避免中断调用方的关闭分组流程。

### P2 新增：分组 DOM 标识契约（已落地）

实现在 [`serial-group-dom.js`](serial-group-dom.js)，`test/serial-group-dom.test.js` 8 项覆盖。它只回答一个问题：**给定 groupId，终端容器叫什么 id**。

```text
groupDomSuffix(groupId)      // 默认分组 → ''，其它 → '-<sanitized>'
mainTabId(groupId)           // 默认 → 'tab-main'
mainTabButtonId(groupId)     // 默认 → 'tab-main-button'
serialContainerId(groupId)   // 默认 → 'serial-container'
```

**为什么需要它。** 多串口卡住的不是「终端能不能建」，而是「终端该建在哪个容器里」。改造前 `renderer.js` 直接写 `document.getElementById('serial-container')`，`pane-layout-dom.js` 里又写了一份 `terminalContainerId: 'serial-container'`；两处字面量可以独立漂移，而漂移后的失败方式是**终端区一片空白且没有任何报错**。把 id 变成可计算的函数之后，「一个分组一个容器」才成为可断言的事实。

四条已固定的非显然规则：

| 规则 | 内容 | 理由 |
| --- | --- | --- |
| 默认分组无后缀 | `serial-container` 而非 `serial-container-default` | 加后缀会同时打断 `index.html` 的静态标记、`pane-layout-dom.js` 的描述与依赖 `#serial-container` 的既有断言，且失败静默 |
| 后缀在尾部 | `serial-container-g-1` 而非 `serial-g-1-container` | 保持同前缀，`[id^="serial-container"]` 这类批量查找（统一 fit 全部终端）才可能生效 |
| id 必须净化 | `[^A-Za-z0-9_-]` 一律替换为 `_` | 配置是用户可编辑文本；含空格或冒号的 id 直接进 `querySelector` 会抛 `SyntaxError`，而不是找不到元素 |
| 空 id 回落默认 | 空串/空白/null → 默认分组 | 否则得到永远不存在的 `serial-container-`，终端挂在一个不存在节点上 |

落地范围：`pane-layout-dom.js` 不再保存 `'tab-main'` / `'serial-container'` 字面量，改为委托本模块；`renderer.js` 的三处容器查找（open、context menu、wheel）改为 `serialContainerId(REGISTRY_DEFAULT_GROUP_ID)`，并合并为一次 `serialContainerEl` 解析。**单分组行为零变化**——默认分组算出的三个 id 与改造前逐字一致，`test/serial-group-dom.test.js` 里有一条用例直接读 `index.html` 断言这三个 id 真实存在于静态标记中，防止契约与页面漂移。

**这一层不建容器。** 真正的多分组容器节点仍未做：在容器节点按分组创建之前，`getOrCreate` 没有任何调用方能传入一个真实存在的 id。上轮已实测过一次这类提前接线：新增的构造器完全不可达，而重复的 `new Terminal(...)` / `new HexStreamFormatter(...)` 直接打破 `test/markup.test.js` 三个跨终端一致性计数断言，最终完整回退。结论仍然有效：**容器、调用点、按 groupId 取终端三步必须一起做。**

### P2 新增：终端构造改为工厂 + 注册表托管（已落地）

上面说的「`createSerialRuntime` 不可达」已被解决：现在默认分组就是经由 `serialRuntimes.getOrCreate()` 构造的，工厂有真实调用方。

```text
buildSerialTerminalOptions()        // 构造模板，唯一一份
createSerialRuntime(groupId)        // 返回 { groupId, term, fitAddon, searchAddon, dataParser, container, dispose }
serialRuntimes                      // SerialTerminalRuntimeRegistry 实例
  └─ getOrCreate(default) → defaultSerialRuntime
       └─ serialTerm / serialFitAddon / serialSearchAddon 从中取出
```

三条必须保留的决定：

| 决定 | 理由 |
| --- | --- |
| 构造参数只留一份模板 | 壁纸、Unicode 11 宽度、字体回退这些跨终端一致性要求，若每个分组各写一段构造代码就会逐份漂移 |
| `dataParser` 由运行时持有，模块级只做引用 | 同一分组若存在两个解析器，只有其中一个会被写入数据，行号会看起来「不涨」，属于最难定位的状态分裂 |
| 不在工厂外再调 `serialTerm.open()` | xterm 重复 `open` 同一容器会重建 DOM 并丢掉已写内容，**且不报错** |

**新增的加载门禁（重要）**：`scripts/check-renderer-module-load.js` + `test/renderer-module-load.test.js`。
改造后模块顶层会**立即执行** `createSerialRuntime()`，而它内部又调 `enableTerminalUnicode11()` / `getPrefix()` / `document.getElementById()`。只要其中任意一个的声明被移到构造点下方，应用就会启动即白屏，而所有源码文本断言仍然全绿——这正是 `node --check` 与正则断言共同的盲区。
门禁在**独立子进程**里执行完整模块体并只对**同步顶层求值**负责，随后 `process.exit()`；它带一个反向对照（故意写错顺序必须失败）。
为什么不写成同进程的 node:test 用例：renderer 顶层会排入异步回调（首帧 fit、图表初始化），它们依赖真实布局，stub 永远补不完；在测试进程内执行会让这些拒绝把整个文件判红，而那种红是测试夹具的缺陷。**本次在这个陷阱上连踩了六轮，教训是：遇到「stub 永远补不完」应首先怀疑验证范围选错，而不是继续补 stub。**

**关于 `test/markup.test.js` 的三个计数断言（已按预期改写，必读）**：

| 断言 | 旧 | 新 | 原因 |
| --- | --- | --- | --- |
| `allowTransparency: true` | 3 | 3（不变） | 串口那处从字面量变成了模板内容 |
| `enableTerminalUnicode11(term);` | 2 | **3** | 工厂真的是第三个终端构造点（串口 / 过滤 / Shell），少调一次会让那个终端的中日韩与 emoji 列宽算错 |
| `fontFamily: TERMINAL_FONT_FAMILY(` | 3 | 3（不变） | 同上，串口那处进入模板 |

另有一条断言从「`const serialTerm = new Terminal({...scrollback: 20000`」改为「`buildSerialTerminalOptions()` 模板 + 工厂内 `new Terminal(buildSerialTerminalOptions())`」：模板才是唯一真相源，只断言某一次 `new` 会漏掉后续分组。

区分标准只有一条：**新增实例是不是真实存在、真实可达**。若因为「让测试过」而改数字，那是伪造；若因为「现在真的多了一个终端」而改数字，那是维护断言。

### P3 — 双层标签栏与添加串口按钮

实现第 6 节的升降层规则、`+` 按钮、分组关闭。

验收：1↔2 分组切换时 Shell 标签正确升降层；单分组下与现状完全一致。

**落地进度（截至 `8f803d7`）**：

| 子项 | 状态 |
| --- | --- |
| 标签归属判定（纯逻辑） | ✅ `serial-group-tabs.js`，17 项单测 |
| 分组增删改数据层 | ✅ `serial-groups-model.js`，17 项单测 |
| 标签栏结构描述层 | ✅ `serial-group-tab-bar.js`，15 项单测 |
| 渲染层数据面按 groupId 路由 | ✅ 输出分桶、按分组取运行时、写入路径全部携带 groupId |
| 分组标签栏 DOM 接入 | ✅ 分组层作为独立一行，分组数 ≥2 显示、=1 隐藏 |
| 添加串口与真实容器创建 | ✅ 建 `serial-container-<g>` / `tab-main-<g>` / `tab-main-<g>-button` |
| 分组关闭与回落单层 | ✅ 含已连接二次确认；关到剩一组后分组栏回到 `hidden` |
| **Shell 标签与分组标签同级的两个层次投影** | ✅ **已接线**。多分组时 Shell 按钮搬到 `#serial-group-tab-list` 且排在分组标签之后；单分组时按 `tabIds` 相对顺序回到 pane 标签行（见 6.7） |

> 两层投影的做法是**移动节点**而不是重建：`syncShellTabLayer()` 直接 `appendChild` / `insertBefore`，监听与 xterm 实例全部保留。`workspace-manager.js` 为此补了两个可选注入（`resolveTabButtonHost` / `findTabButton`），不注入时行为与改造前逐字一致。

### P4 — 设置侧栏跟随（已完成）

按第 7 节绑定 `activeGroupId`。实现分两步：

1. **四个显示参数下沉**：`getGroupDisplay()` / `setGroupDisplay()` 成为唯一访问入口，保留模块级 `let` 仅作默认分组缓存；数据面、解码器、发送路径、右键菜单、新建过滤页共 7 类消费点改按分组读。
2. **侧栏回显与写回**：`applyActiveSerialGroup()` 末尾回显 9 个控件并刷新连接按钮；`persistActiveGroupSerialOptions()` 双写 `serialGroups[activeGroupId].serialOptions` 与 `lastSerialOptions`。

验收：切分组时设置正确回显与回写；全局设置不受分组切换影响；两个分组可各用一种接收编码。**均已通过真实窗口 + CDP 验证（37/37，其中 P4 6 项）**。

### P5 — 两级分屏

按第 8 节完成 `workspace-manager` 的 N pane 化，先做分组级，再叠加组内级。

验收：分组级左右/上下分屏；组内级左右/上下分屏；两级同时存在时 fit 正确；关闭分组后布局收敛。

**进度：已完成并提交（`f65fb98` 外层容器与可注入作用域、`a31ee20` 每分组独立布局与管理器）。**下面四条实现决定值得保留，它们都不属于「顺手接线」：

1. **默认分组沿用静态 id。** `workspace-root` / `pane-1` / `workspace-splitter` / `tab-main` / `serial-container` 逐字不变，只在外层多了一层 `#group-workspace` 父节点。这是**启动时序要求**而不是省事：默认分组的 xterm 在 `renderer.js` 模块加载期就 `open(#serial-container)`，只要这条祖先链不变，重构不可能引入「xterm 重复 open 丢内容」这类静默故障。非默认分组用后缀 id（`pane-1-<g>` / `workspace-root-<g>`），它们的终端本就是惰性创建。
2. **布局与管理器用 Map + 模块级别名，不逐处改写。** `groupWorkspaceLayouts` / `groupWorkspaceManagers` 按 groupId 存，模块级的 `workspaceManager` / `workspaceLayout` 降级为「指向激活分组」的别名，由 `setActiveGroupWorkspace()` 统一切换。理由：这两者合计 60 余处消费点全部应作用于激活分组，逐处改成 `getGroupWorkspaceManager(id)` 的风险是漏一处就静默铺错布局。
3. **Map 的键运算一律用 `normalizeGroupId`，不用 `resolveSerialGroupId`。** 后者会把未登记分组回落默认分组，那样新分组的布局会被静默存到默认分组头上。
4. **标签登记按 pane id 反推分组，不按 activeGroupId。** `addTabToOwningGroupPane()` / `resolveGroupIdFromPaneId()` 从 `pane-1-g-1` 反推 `g-1`。原因：创建标签时 `resolvedPaneId` 可能属于非激活分组（`syncSerialGroupsFromConfig` 逐组恢复、或新建分组后还没切别名），按 activeGroupId 判定必然错。同理，Shell 标签不归属任何分组（已锁定决策），它的切换与登记**永远**走默认分组的 manager（`switchShellTab`）。

另外两条与前面阶段同构但不显然的结论：

- **`applyLayoutToDom()` 清激活态必须限定在本分组自己的 pane 内。** 原实现用全局 `.main-tab` / `.main-tab-pane` 清，一个分组重排会把另一个分组已激活的标签与面板一并清空；而后者布局没变不会重算，表现为「加了一个分组，另一个分组的 Main 就白掉了」。这**不是**断言问题，是真实缺陷，由 CDP 实测发现。
- **标签拖动与分界条拖动必须事件委托，不能模块加载期逐 pane 绑定。** 非默认分组的 pane 与第 3 个及以后的 pane 都是后续动态创建的，写死 `pane-1`/`pane-2` 会让那些面板上的标签完全拖不动（没有任何报错，只是「拖了没反应」）。分界条的拖动比例必须相对**本分组**的 root 计算，用全局 root 会让非默认分组按默认分组宽度换算。

**已知未验证项**：分组级拖动分界条的实际比例换算、「拖动非默认分组的标签」这两条只有静态审查，没有 CDP 用例；两级分屏的断言（46 项）覆盖 DOM 结构与真实点击，不覆盖字节流。见第 11.1 节。

### 纯数据层：`workspace-layout-shape.js`

原 `workspace-manager.js` 把「恰好两个 pane」写死在规整与收敛逻辑里：`DEFAULT_WORKSPACE_LAYOUT` 固定 `paneSizes = {'pane-1': 0.5, 'pane-2': 0.5}` 与两元素 `panes`，`normalizeWorkspaceLayoutShape()` 的 `activePaneId` 白名单只有 `pane-1` / `pane-2`，`reconcileEmptyPaneLayout()` 也只理解这两个。现把其中的**纯数据规整**抽成 [`workspace-layout-shape.js`](workspace-layout-shape.js)，按任意 pane 列表工作，`workspace-manager.js` 的两个同名函数改为委托调用。

该模块不碰 DOM，只处理布局对象，因此可以直接在 Node 里断言。**关键约束：pane 数量为 2 时输出必须与改造前逐字段一致**——`test/workspace-layout-shape.test.js` 内嵌一份旧实现的 `legacyNormalize()`，用 10 组用例与 `normalizeLayoutShape()` 做 `assert.deepEqual` 比对，使这条约束成为可执行证据而不是口头声明。

四条不显眼但必须保留的规则：

1. **`normalizePaneSizes` 的缺项补位必须用 `share = remainder / missing.length`，不能有 `1 / n` 回退。** 已有尺寸已经占满时 `remainder` 为 0，缺失的 pane 就该是 0；否则会把已占满的 pane 生生缩小（曾实测得到 `{pane-1: 0.6, pane-2: 0.2, pane-3: 0.2}`，正确结果是 `1 / 0 / 0`）。
2. **`reconcileEmptyPanes` 只在「全空」或「只剩一个非空」时收敛。** 写成「任一 pane 为空就收敛」会拆散一个仍然有两个非空 pane 的合法三 pane 布局。
3. **宿主 pane 的选择按 pane 数量分叉。** 恰两 pane 时必须选 `pane-1`（这是旧实现的行为，逐字段一致所需）；多于两 pane 时选有内容的那个，否则活跃 pane 会落在一个空 pane 上。
4. **被搬 pane 的 `activeTabId` 必须跟着带过来**，直接取 `tabIds[0]` 会静默改变收敛后的活跃标签页。

另外还修掉一处更隐蔽的判定错误：`moveWorkspaceTab` 把某个 pane 的最后一个 tab 搬走后，该 pane 会残留一个指向已离开 tab 的陈旧 `activeTabId`。合并逻辑若拿合并**后**的 tab 列表去判定宿主活跃 tab 是否仍有效，刚被搬进来的同名 tab 会让这个陈旧值错误地通过检查，导致收敛后排错活跃标签页。现在在合并前记录 `primaryTabIdsBefore`，用合并前的列表判定。

**DOM 层已完成：`workspace-manager.js` 不再假设两个 pane。**

原实现有 12 处 `pane-1` / `pane-2` 字面量，现全部改为由布局驱动：

| 位置 | 原行为 | 现行为 |
| --- | --- | --- |
| `resolvePaneId` | 白名单只认 `pane-1` / `pane-2` | 只要求「存在于当前布局」 |
| `getOtherPaneId` | 固定互换两值 | 按 pane 列表循环取下一个 |
| `reconcileEmptyPanes` | DOM 搬移写死 `pane-1` | 宿主取 `layout.activePaneId`；源 pane 从调用前快照反查 |
| `setActivePane` | 三元强制两值 | 不存在时退回首个 pane |
| `updatePaneVisibility` | 只切 `pane-2` | 所有 index &gt; 0 的 pane 统一跟随 `splitEnabled` |
| `applyPaneSizes` | 只设两个 CSS 变量 | 写各 pane 的内联 `flexBasis` |
| `moveTabToPane` / `addTabToPane` | 目标为 `pane-2` 就开分屏 | 目标不是首个 pane 就开分屏 |
| `removeTab` / `collapseSplit` | 收敛后写死 `pane-1` | 用 `layout.activePaneId`；`collapseSplit` 合入除首个 pane 外的全部 pane |
| `setPaneSizes` | 只写两个键 | &gt;2 pane 时其余 pane 按现有比例分剩余空间 |

配套改动：`style.css` 删掉 `#pane-1` / `#pane-2` 的 `flex-basis` 规则（改用 `.workspace-pane` 统一过渡，`.workspace-root.resizing .workspace-pane` 统一禁用过渡）；`renderer.js` 的 `transitionend` 过滤由列举两个 id 改为 `classList.contains('workspace-pane')`。

**pane 节点：前两个仍为静态，第 3 个起按需创建。**

`index.html` 的 `pane-1` / `pane-2` 保留为静态标签，原因不是懒，而是 `serialTerm` 在模块加载时就 `serialTerm.open(document.getElementById('serial-container'))`——把这两个节点也改成动态创建，就必须同时改造 `serialTerm` 的挂载时机，而那属于 P2 剩余部分。这一轮只补上「多出来的 pane 能现建」的能力，单串口与现有两 pane 分屏的行为因此完全不变。

两个新模块/函数：

| 位置 | 职责 |
| --- | --- |
| [`pane-layout-dom.js`](pane-layout-dom.js) | 纯数据描述：`describePane` / `describeWorkspace` / `findMissingPaneIds`。不碰 DOM，因此可直接在 Node 里断言 pane 的 id 命名、三个按钮的顺序与主终端容器归属 |
| `workspace-manager.js` 的 `ensurePaneElements()` | 在 `applyLayoutToDom()` 开头调用，先把布局里有、DOM 里没有的 pane 建出来，再 `appendChild` |
| `renderer.js` 的 `createPaneElement(paneId)` | 按描述建节点（`pane-N-tabs-list` / `pane-N-tabs-content` / 三个新建按钮），插入到最后一个已有 pane 之后以保证 splitter 仍在中间 |

**为什么必须先补节点再布局**：`appendChild(null)` 不报错也不警告，标签页会静默消失，得到一块空面板。这是最难查的一类缺陷，因此 `ensurePaneElements()` 被放在 `applyLayoutToDom()` 的第一行，而不是等出错再补救。

验证：`test/workspace-pane-n.test.js` 8 项（三 pane 的内联尺寸、可见性、任意 pane id、循环取下一个、三 pane 收敛、拖拽分尺寸、`ensurePaneElements` 只请求缺失的 pane、无创建器时为空操作）；`test/pane-layout-dom.test.js` 9 项；当时 `npm test` **316/316 通过、0 失败**（当前基线为 **437/437**）。

---

## 11. 风险与未验证项

### 11.1 未验证（最高优先级）

> **本节已于 2026-11-05 重写。** 原文写的是「同一进程内并发打开多个串口端口的稳定性未经验证」，但 P1 已完成双端口真机冒烟（COM6 + COM1），该条已不成立。下列三条才是目前真正未验证的事项。

**1）多串口从未做过真实双端口端到端验证。** P1 的双端口冒烟验证的是主进程侧（两个端口能同时开、各自可写、关一个不影响另一个）与日志目录归属，但 **渲染层从未真实连过两个端口**。已建立的验证手段（CDP 真实点击）只覆盖「添加 / 切换 / 关闭分组」的 DOM 行为，不包含任何字节流。具体未验证：

- 两个分组同时接收时，各自的终端是否真的只显示自己的数据（单测证明分桶函数正确，但不证明接线后的端到端行为）
- 两个分组的主终端日志是否真的落进两个不同的端口目录
- 切换分组后 xterm 的 `fit()` 是否真的正确（理论依据：在 `display:none` 容器里 `fit()` 会算出 0 尺寸，切回来时字符被压扁或右侧被裁掉；`applyActiveSerialGroup` 已调 `fitWorkspaceTerminals()`，但没有观测过效果）

**2）libuv 线程池在并发端口数 > 4 时的行为未测量。** 串口读用的是 binding 自带的 `ReadThread`（见 5A.1），但在 Linux/macOS 上走 libuv poller；默认线程池只有 4 个线程。

**3）两级分屏只有 DOM 层与点击验证。** P5 已接线完成，CDP 46 项覆盖了外层容器、两组各自拥有 root/pane-1/标签行、主标签不串行、两组工作区同时可见、`#serial-container` 仍在静态 `pane-1` 内等结构断言，但**不覆盖**：分组级拖动分界条的实际比例换算（`activeBoundsEl` 的改动只有静态审查）、拖动非默认分组的标签（委托化改动同样只有静态审查）、两级共存时两个分组同时收数据时各自的终端渲染。

**4）P4 的“两个分组各用一种显示模式”只在 DOM 层验证过。** CDP 断言证明了能存两份不同的 `receiveEncoding` 并正确回显，**但没有用真实字节流证明**：A 组设 `text`、B 组设 `hex` 同时收数据时，两个终端是否真的各按自己的模式渲染。`dispatchSerialBatch` 已改为按本批字节所属分组读显示模式，单测与代码审阅支持这个结论，但**字节级证据仍然缺失**。

**5）P5 的节点搬迁未做压力验证。** 分组数从 1 增到 2、再减回 1 时，布局层会调用 `applyLayoutToDom()` 把按钮与面板 `appendChild` 回各自的容器。已用 CDP 多次真实点击验证「不重复、不消失、顺序正确」，但未测大量分组（如 8 组以上）下反复切换的稳定性与性能。

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

### 配置迁移（v14 → v15）

- [x] `CONFIG_VERSION` 升到 15，由 `serial-groups-config.js` 统一提供
- [x] 无 `serialGroups` 的旧配置迁入一个默认分组（id 固定为 `default`）
- [x] 旧字段 `lastSerialOptions` / `filterTabs` / `chartTabs` / `workspaceLayout` 保留不删，可降级回 v14
- [x] 归一化幂等：重复执行不造出第二个分组、不改 id
- [x] 空数组 `serialGroups: []` 不被当成「未迁移」重新播种
- [x] 迁移前写入 `config.v14.backup.json`，且只写一次、不覆盖原件
- [x] 备份失败不阻断启动
- [x] 真机磁盘验证：连启两次均为 v15 / 1 组，备份保持 v14 且 mtime 未变（用独立 `--user-data-dir` 隔离）

### P1

- [x] 双端口真机并发打开成功（首个门禁）—— 实测 COM6 + COM1 同时打开、各自可写、关闭一个另一个不受影响
- [x] 两组同时收发，数据**逐字节**校验不串流（含 `serial-output-bytes` 的 sessionId 归属正确）—— 端到端 9 项通过。代码侧由 `session.outputBuckets`（`Map<sessionId, entries>`，main.js:2819/2917/2938/3035）保证按会话分桶
- [x] 关闭 A 组，B 组连接与数据不受影响 —— 同上端到端验证；代码依据 `cleanupSerialConnection(message, port, groupId)` 按**本会话端口**判定（main.js:2958），不再全局比较
- [x] 断开重连只影响对应分组 —— `connect-serial` 只关闭 `session.port`（main.js:3020-3022），不再 close 其他分组
- [x] 日志目录下存在以端口号命名的子文件夹（如 `COM3/`），两个端口不写同一目录 —— `buildPortLogFolderName()`（main.js:763）取 `path.basename(portPath)` 并去尾部 `.`/空格，端口缺失时退回 `groupId`（避免多分组撞进同一目录）
- [x] 重连同一端口继续写同一文件夹；换成另一个端口则新建对应文件夹，不往旧文件追加 —— `connect-serial` 会重置 `mainLogFilePath` / `activeMainLogGroupId` / 各 tab entry 的 `filePath`
- [x] 开启 `logCreateDateFolder` 时层级为 `<logPath>/<日期>/<端口号>/`，`log-cleanup` 能正常清理 —— `ensureLogDirectory()` 为 `path.join(baseDirectory, resolveLogFolderName(groupId))`（main.js:990-999），日期在外层；`log-cleanup.js:35` 只递归匹配 `^\d{4}-\d{2}-\d{2}$` 的目录名，顺序写反会让过期日志永远无法删除
- [x] `npm test` 全绿 —— P1 当次为 391/391，**当前基线 437/437**；后续纯逻辑层新增测试抬高了总数
- [x] 单端口全部现有行为回归通过 —— 双端口冒烟与全量测试均通过
- [x] 采集双端口高吞吐下的主线程响应基线，作为 P1.5 的决策依据 —— 已采集并据此裁定 P1.5 不做，详见第 10 节

> **本节订正说明（2026-11-03）**：上一版这里 10 项全为 `[ ]`，与 `ToDo.md` 记录的 P1 已完成状态矛盾。本次逐项对照 `main.js` 实际代码与既有实测记录后勾选。其中「逐字节不串流」「日志端口子目录」「日期层级可被清理」三项的代码依据已在括号内标明文件与行号，**不是仅凭摘要推断**；但需如实声明：这几项没有可重放的自动化用例，当年的端到端证据以 `ToDo.md` 的记录为准。
### P1.5（已裁定不做）

- [x] 采集主线程响应基线作为决策依据 —— 已采集，结论为收益不成立，详见第 10 节 P1.5
- [~] 日志写入改经 Worker 队列 —— **不做**：真实数据量下同步写盘仅 0.39 ms，低于 Windows 定时器分辨率

### P2

- [x] `sessionId → groupId` 分流正确 —— `serial-group-registry.js` 已实现并由 10 项单测覆盖
- [~] 行号、过滤器、图表数据各自独立 —— **行号已独立**（`serial-group-context.js` + `serial-data-parser.js`，共 18 项单测）；过滤器与图表数据仍是全局单例，且受阻于单容器的 DOM 契约
- [ ] 快捷指令自动发送只向触发来源组发送
- [x] 分组终端生命周期管理 —— `serial-group-runtime.js`（惰性创建、已有实例可 attach、默认分组不可释放、释放前 dispose），19 项单测
- [x] 分组 DOM 标识契约 —— `serial-group-dom.js`（`serialContainerId` / `mainTabId` / `mainTabButtonId` / `groupDomSuffix`），8 项单测；默认分组算出的三个 id 与改造前逐字一致，并由一条用例直接读 `index.html` 校验真实存在
- [x] 终端构造改为工厂 + 注册表托管 —— `buildSerialTerminalOptions()` / `createSerialRuntime(groupId)` / `serialRuntimes`；默认分组经 `getOrCreate` 构造，单分组行为与改造前一致；4 项加载门禁
- [x] 分组工作区形状纯数据层 —— `serial-group-workspace.js`（`describeGroupWorkspace` / `describeGroupWorkspaceEntry` / `findMissingGroupContainers` / `attributeSelector`），15 项单测
- [x] **新增 renderer 模块加载门禁** —— `scripts/check-renderer-module-load.js` + `test/renderer-module-load.test.js`（4 项，含 TDZ 反向对照）。这是本次改造最关键的一条护栏：工厂在模块顶层被立即调用，一旦顺序写错会启动即白屏，而 `node --check` 与源码正则都看不见
- [x] `serialTerm` 的剩余引用改为按 `activeGroupId` 动态取用 —— `getSerialRuntime(groupId)` / `getSerialTerm(groupId)`，未登记回落默认；全部写入路径携带 groupId
- [x] **`#serial-container` 不再全局唯一** —— `ensureSerialGroupMainTabDom()` 为每个非默认分组建出 `serial-container-<groupId>`（走 `serialContainerId`），并由 `serialRuntimes.getOrCreate(groupId)` 惰性构造终端

### P3

纯逻辑层：

- [x] 标签归属判定抽成纯函数 —— `serial-group-tabs.js`，17 项单测覆盖两层构成、Shell 始终在分组层、切换分组只换下层、缺失 activeGroupId / activeTabId 的兜底、关闭分组选邻规则、空列表不崩
- [x] 层数变化判定（1 ↔ 2+）—— `didLayerCountChange()`
- [x] 分组增删改数据层 —— `serial-groups-model.js`（`nextGroupId` / `addSerialGroup` / `removeSerialGroup` / `renameSerialGroup` / `findSerialGroup`），17 项单测；新分组只继承串口参数，端口与数据视图均清空
- [x] `nextGroupId` 取未被占用的最小 `g-<n>`，不用长度+1、不用随机或时间戳
- [x] 标签栏结构描述层 —— `serial-group-tab-bar.js`，15 项单测（见 6.1B）
- [x] 渲染层输出分桶纯逻辑 —— `serial-output-buckets.js`，12 项单测（`drain()` 的每一项严格只含一个分组）

渲染层数据面：

- [x] 数据面按 groupId 路由 —— 队列分桶、终端/解析器/解码器/HEX 格式化器全部按分组取用，写入与日志路径全部携带 groupId（见 6.6）
- [x] 未登记分组回落默认而不是静默丢弃 —— `resolveSerialGroupId()` + `dispatchSerialBatch()`
- [x] `serialSessionId` 降级为只代表默认分组 —— 否则 g-2 的一条入站消息会让默认分组的写入被误判为 STALE 并静默失败
- [ ] 过滤器与图表数据按分组各一份 —— 仍是全应用单例，只跟随激活分组

分组标签栏 DOM：

- [x] 单分组下分组栏完全隐藏、`hidden` 不占高度 —— CDP 实测 `barHidden: true` / `groupTabs: 0` / `mainTabs: 1`
- [x] 「添加串口」按钮（分组层右端）新建分组并成为 active —— CDP 实测新分组 `status=disconnected`、标签 `active: true`、`closable: true`
- [x] 新分组真实建出容器与主标签 —— CDP 实测 `serial-container-g-1` / `tab-main-g-1` / `tab-main-g-1-button` 均存在
- [x] 点击分组标签切换激活分组 —— CDP 实测切回默认后高亮与主标签都正确
- [x] 分组关闭（断开 + 销毁子标签与终端 + 回落到单层）—— CDP 实测关闭后 `barHidden: true` / `groupTabs: 0` / `containerGone: true` / `mainTabGone: true` / `defaultStillThere: true`
- [x] **Shell 标签与分组标签同级的两个层次投影** —— CDP 实测：单分组时 `inPaneRow:true / inGroupRow:false`；多分组时升到分组层且顺序为 `[分组标签..., Shell]`；点击后终端切到该标签且仍留在分组层；关闭多分组后回落 pane 行；全程 `shellCount` 恒为 1（未被复制）（见 6.7）

> **已验证的方式（重要）**：上述 DOM 层各项全部由**真实窗口 + CDP 真实点击**验证（`Runtime.evaluate` 驱动 `.click()` 并断言 DOM），共 **29 项全 PASS、退出码 0**。这不是推断——因为同一组功能在 `node --check`、renderer 模块加载门禁与 437 项单测下全部全绿时，实际上存在「两个分组标签拿到同一个 id」的致命缺陷（见 6.1B 结尾）。**凡涉及真实 DOM 结构或交互的改动，必须补这一层验证。**
>
> 另外两条同样值得记录的教训：① 验证脚本本身也会写错（本轮曾因多重插一次 `click()` 在已关闭的分组上取到 null，以及用 `element.id` 去匹配 `dataset.target` 导致断言恒假）——**断言出错时先修断言，绝不改期望值**；② 「只移动节点不重建」这条决定如果在实现时图省事换成重建，监听与 xterm 实例都会静默丢失，而三层门禁都拦不住。

### P4

- [x] 四个显示参数在 `serial-group-context.js` 里有存储位（`receiveDisplayMode` / `receiveEncoding` / `sendEncoding` / `newlineMode`）
- [x] **`setDisplay()` 真正接入** —— `getGroupDisplay()` / `setGroupDisplay()` 成为唯一访问入口，`switch*` 三个函数与 `connectSerialFromUi` 都真实调用它
- [x] 全部收发参数读写点改走分组上下文——按分组读取的 7 类消费点已全部落地（见 7.3）；保留的模块级 `let` 仅作默认分组缓存
- [x] 切换分组设置正确切换——`applyGroupSerialOptionsToSidebar()` 回显 9 个控件，`refreshConnectButtonState()` 同步连接按钮（CDP 实测 6 项全 PASS）
- [x] 全局设置不被分组切换影响——快捷指令 / 自动发送 / 外观 / 时间戳 / 行号仍为全局
- [x] 新分组继承合理的默认参数——`serialOptions` 继承自当前分组，`portPath` / `filterTabs` / `chartTabs` / `layout` 清空，`status='disconnected'`
- [x] 两个分组各存一份 `serialOptions.receiveEncoding`（CDP 实测：先在 g-1 改成 `gbk`，切回默认分组仍为 `utf8`，再切到 g-1 回显 `gbk`）
- [x] 关闭分组后的默认分组值不被污染

> **已完成阶段的起点订正（保留以作教训）**：早期记录把 P4 描述成「侧栏绑 `activeGroupId`」的接线工作，但 `SerialGroupContextStore.setDisplay()` 当时 **零调用**。它实际上是「状态真的下沉」：先把四个参数从模块级 `let` 搬进分组上下文，再把 40+ 处读写改过去，最后才轮到侧栏跟随。实际落地时的关键在于**保留模块级 `let` 作默认分组缓存**——否则要同时改 64 处，风险与收益不成比例。

### P5

纯数据层：

- [x] 布局规整按任意 pane 列表工作 —— `workspace-layout-shape.js`，16 项单测（含 10 组与旧实现逐字段对比）
- [x] 两 pane 时输出与改造前逐字段一致 —— 由内嵌 `legacyNormalize()` 对比用例兼容性保障
- [x] `normalizePaneSizes` / `reconcileEmptyPanes` 在 N>2 下行为正确
- [x] 收敛后保留被搬 pane 的活跃标签页（含陈旧 `activeTabId` 场景）

DOM 层：

- [x] `workspace-manager.js` 去掉全部两 pane 硬编码（12 处）—— 由 6 项 `test/workspace-pane-n.test.js` 覆盖
- [x] `style.css` 不再用 `#pane-1` / `#pane-2` 选择器设 `flex-basis`，改用 `.workspace-pane` 统一过渡
- [x] `renderer.js` 的 `transitionend` 过滤按 `.workspace-pane` 类名判断
- [x] 第 3 个及以后的 pane 可按需创建 —— `pane-layout-dom.js` + `ensurePaneElements()` + `createPaneElement()`，由 9 项 + 2 项单测覆盖
- [x] **静态 pane 标记的处理方式已定并落地** —— 用户接受了「每个分组一套 pane」的方案。实现上**默认分组仍沿用静态 `workspace-root` / `pane-1` / `workspace-splitter`**（启动时序要求，见第 10 节 P5），非默认分组的 `#serial-group-workspace-<g>` → `#workspace-root-<g>` → `#pane-1-<g>` 由 `ensureSerialGroupWorkspaceDom()` 动态创建。原计划的「静态标记全部改动态」因此**不必要**，且会引入真实的启动回归风险。
- [x] 分组级左右/上下分屏 —— `#group-workspace` 为 flex row（`.split-vertical` 转 column），每个直接子元素就是一个分组的工作区；分组数 >= 2 时 `#group-workspace-splitter` 可见。CDP 实测：`outerExists: true` / `outerSplitterVisible: true` / `defaultRoot` 与 `g1Root` 同时可见
- [x] 组内级左右/上下分屏 —— 每个分组都有自己的一套 `describeGroupWorkspace().panes`，由该分组的 manager 驱动；`applyConfig` 的三处 `pane-1`/`pane-2` 硬编码已改为按布局枚举。CDP 实测：两组各自拥有 `pane-1` 与 `pane-1-g-1`，主标签不串行
- [x] 关闭分组后布局正确收敛 —— `closeSerialGroup()` 清理 `groupWorkspaceLayouts` / `groupWorkspaceManagers` / 外层容器，并在关掉激活分组时把别名切回默认分组。CDP 实测：关闭后 `barHidden: true` / `containerGone: true` / `mainTabGone: true` / `defaultStillThere: true`
- [ ] 两级共存时 fit 正确 —— `applyActiveSerialGroup()` 与各 manager 都调 `fitWorkspaceTerminals()`，但**未肉眼确认**（在 `display:none` 容器里 `fit()` 会算出 0 尺寸，切回来是否被压扁/裁切属理论推断，见第 11.1 节）
- [ ] 键盘输入严格跟随焦点组 —— 未验证（这是有物理后果的风险，见 11.2 第 5 条）
- [x] 过滤页与图表页按分组各一份 —— `serial-group-tab-lists.js`（13 项单测）+ `filterTabsStore` / `chartTabsStore`，`applyActiveSerialGroup()` 首批切别名，写入/持久化/关闭清理/重启恢复全部按 groupId 取桶；原先 `isActiveSerialGroup()` 临时边界导致的「非激活分组字节不进过滤页」已消除

---

## 13. 相关文档

- `agent_notes.md`：项目接手入口与架构不变量
- `ToDo.md`：全局工程待办与验证基线
- `README.md`：面向用户的功能说明
- `CHART_TAB_IMPLEMENTATION_PLAN.md`：图表页设计基线（多串口后图表需按组隔离）
