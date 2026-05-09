# SerialTerminal 项目接手说明 / AI 记忆文档

## 1. 项目概述

- 项目名：`SerialTerminal`
- 类型：基于 Electron 的桌面串口终端工具
- 目标场景：嵌入式开发、串口调试、设备联调、日志查看、关键字过滤、自动发送与快捷发送
- 运行平台：Windows / Linux
- 当前主界面形态：左侧侧边栏 + 中央主终端区 + 主输入框 + 多过滤标签页

项目核心能力：
- 串口连接和参数配置
- 基于 xterm.js 的终端显示
- 主终端搜索和过滤标签页
- 自动发送 / 快捷发送
- 日志记录与配置持久化
- 多语言支持
- 设置窗口与在线更新

---

## 2. 技术栈与关键依赖

### 2.1 技术栈
- Electron
- Node.js
- JavaScript（无 TypeScript）
- HTML / CSS

### 2.2 关键依赖
- `serialport`：串口通信
- `@xterm/xterm`：终端显示
- `@xterm/addon-fit`：终端尺寸自适应
- `@xterm/addon-search`：终端搜索
- `iconv-lite`：编码转换（含 GBK 等）
- `electron-updater`：应用更新
- `electron-log`：更新/日志输出
- `font-list`：系统字体读取
- `node-pty`：历史遗留依赖，目前主流程以串口为核心，不是当前重点

### 2.3 打包相关
- `electron-builder`
- `@electron/rebuild`

---

## 3. 目录结构与文件职责

```text
SerialTerminal/
├─ assets/                    图标、截图资源
├─ test/                      Python 测试脚本
│  ├─ serial_test.py
│  └─ serial_tester.py
├─ index.html                 主窗口 HTML
├─ renderer.js                主窗口渲染逻辑（终端、过滤、搜索、主输入框、侧边栏）
├─ main.js                    主进程逻辑（窗口、配置、串口、日志、更新）
├─ preferences.html           设置窗口 HTML
├─ preferences.js             设置窗口逻辑
├─ style.css                  主界面和公共样式
├─ i18n.js                    多语言字典与翻译函数
├─ README.md                  对外项目说明
├─ package.json               脚本、依赖、打包配置
└─ agent_notes.md             本文档，AI 接手记忆文件
```

### 3.1 主文件说明

#### `main.js`
负责：
- 创建主窗口与设置窗口
- 读取/写入用户配置 `config.json`
- 串口连接、收发、解码、日志缓冲
- 向渲染进程发送串口输出、错误、吞吐量数据
- 自动更新逻辑
- 启动时自动检查更新与用户确认安装逻辑
- 更新提示通过 GitHub Release API 读取对应 tag 的正文，获取不到时提示网络异常
- 更新弹窗文案跟随当前界面语言显示

#### `renderer.js`
负责：
- 主终端初始化（xterm）
- 串口数据显示解析与渲染
- 过滤标签页创建、关闭、过滤历史
- 搜索逻辑与结果计数显示
- 主输入框发送逻辑
- 快捷发送、自动发送、吞吐量 UI 等
- 当前也承担多语言在主窗口中的部分应用逻辑

#### `preferences.js`
负责：
- 设置窗口的初始化、表单回填
- 高亮规则编辑
- 字体加载
- 配置保存 / 恢复默认
- 更新状态展示

#### `i18n.js`
负责：
- 多语言字典维护
- `getLanguage()`
- `t()` 翻译函数
- 当前已有语言：
  - `en`
  - `zh-CN`
  - `zh-TW`
  - `fr`
  - `ru`
  - `de`

---

## 4. 运行方式与常用命令

### 安装依赖
```bash
npm install
```

### 启动项目
```bash
npm start
```

### 重编译原生依赖
```bash
npm run rebuild
```

### 打包
```bash
npm run dist
npm run dist:win
npm run dist:linux
```

---

## 5. 当前配置文件结构（用户目录 config.json）

配置由 `main.js -> loadConfig()` 提供默认值，并通过 `saveConfig()` 合并写回。

当前重要配置项包括：

```json
{
  "fontSize": 14,
  "fontFamily": "Consolas",
  "fontFamilyZh": "\"Microsoft YaHei\"",
  "foreground": "#cccccc",
  "background": "#000000",
  "timestampColor": "#00ff00",
  "lineNoColor": "#ffff00",
  "logEnabled": false,
  "logPath": ".../SerialTerminalLogs",
  "logFileNameFormat": "log_%Y-%m-%d_%H-%M-%S.txt",
  "logEncoding": "utf8",
  "highlightRules": [],
  "showTimestamp": false,
  "showLineNumbers": false,
  "scrollbackLimit": 100000,
  "historyBufferSize": 5000000,
  "filterHistory": [],
  "windowBounds": {
    "width": 1000,
    "height": 700
  },
  "filterTabs": [],
  "mainInputSettings": {
    "visible": true,
    "sendOnEnter": true,
    "appendCrLf": false
  },
  "skippedUpdateVersion": "",
  "lastSerialOptions": {
    "path": "",
    "baudRate": "9600",
    "dataBits": "8",
    "stopBits": "1",
    "parity": "none",
    "encoding": "utf8",
    "newlineMode": "crlf"
  }
}
```

### 重要说明
- `filterHistory`：过滤输入框的历史记录
- `filterTabs`：过滤标签页恢复所需状态（过滤文本、大小写、正则等）
- `windowBounds`：主窗口大小恢复
- `mainInputSettings`：主输入框显示、按回车发送、末尾追加 CRLF
- `skippedUpdateVersion`：用户选择跳过的更新版本号
- `lastSerialOptions`：上次串口连接参数

---

## 6. 主窗口功能结构

### 6.1 左侧侧边栏
分为三块：
1. 串口连接区
2. 侧边栏 tab（设置 / 搜索 / 发送）
3. 底部设置与输入框显示按钮

其中“发送”标签页内的快捷发送列表支持用户拖动排序，调整顺序后会按当前顺序持久化保存。

### 6.2 主区域
- 主终端标签页 `tab-main`
- 多个过滤标签页 `tab-filter-*`
- 下方主输入框面板 `main-input-panel`

### 6.3 主输入框功能（当前需求版本）
当前保留并实现的功能：
- 手动发送按钮发送
- 输入框旁可一键将当前命令加入左侧快捷发送列表
- 历史命令记录
- 上下键切换历史命令
- 可选“按回车发送”
  - 开启：Enter 直接发送
  - 关闭：Enter 在输入框中插入换行
- 可选“末尾自动追加 CRLF”
  - 发送时将 `text` 变为 `text + \r\n`
- 发送后**不主动清空**输入框（这是当前用户明确要求）
- 输入框显示状态持久化

### 6.4 终端输入功能
- 主终端本身保留直接输入串口的能力
- 用户在 xterm 主终端中键入字符，应逐键发送并本地回显
- 这是与下方输入框并行存在的两套发送入口

---

## 7. 过滤标签页功能说明

### 7.1 过滤标签页当前设计
- 过滤窗口不是独立 BrowserWindow，而是主界面中的 tab
- 可创建多个过滤标签页
- 每个标签页有：
  - 文本过滤输入框
  - 区分大小写按钮
  - 正则按钮
  - 独立 xterm 显示区

### 7.2 持久化状态
每个过滤标签页状态会写入 `config.filterTabs`，典型内容：
```json
[
  {
    "filterText": "error",
    "caseSensitive": false,
    "useRegex": false
  }
]
```

### 7.3 过滤历史
- 全局记录在 `config.filterHistory`
- 可从下拉中快速复用旧过滤条件

### 7.4 启动恢复
- 启动后读取 `config.filterTabs`
- 自动重新创建过滤标签页
- 用户不需要手动重新打开

---

## 8. 串口收发实现原理

### 8.1 主进程接收流程
`main.js`
1. `connect-serial` 创建 `SerialPort`
2. 根据编码创建 `iconv.decodeStream()`（非 hex）
3. `currentSerialPort.on('data')`
4. 若 `hex` 模式则直接转 hex 字符串
5. 否则走 decoder 输出文本
6. 调用 `handleSerialData(str)`
7. `mainWindow.webContents.send('serial-output', str)` 发给渲染进程

### 8.2 主进程发送流程
`main.js -> ipcMain.on('serial-input')`
- 根据换行模式处理 `\r`
- 根据编码转换成 Buffer
- 调用 `currentSerialPort.write(buffer)`

### 8.3 渲染进程显示流程
`renderer.js`
- `ipcRenderer.on('serial-output')`
- `SerialDataParser.parse(data)` 按换行拆分
- `formatLineForTerminal()` 生成终端输出字符串
- 写入主终端和各过滤标签页

### 8.4 `SerialDataParser` 的作用
- 累积不完整串口文本到 `incomingBuffer`
- 遇到 `\r\n / \r / \n` 再切分成完整行对象
- 行对象结构：
```js
{
  text: '实际文本',
  delimiter: '\n' | '\r' | '\r\n' | '',
  prefix: '时间戳/行号前缀'
}
```

---

## 9. 日志显示、前缀与高亮原理

### 9.1 前缀生成
`getPrefix()` 负责生成：
- 时间戳（若启用）
- 行号（若启用）

### 9.2 高亮逻辑
`applyHighlighting(text, filterRegex)`：
- 先应用全局高亮规则 `highlightRules`
- 再应用过滤命中高亮
- 结果通过 ANSI 转义序列写回 xterm

### 9.3 搜索逻辑
主终端搜索依赖 `@xterm/addon-search`
- 文本搜索
- 正则
- 区分大小写
- 整词匹配
- 左侧搜索面板会跟随当前激活的主终端 / 过滤标签页切换搜索目标
- 左侧搜索面板显示当前匹配序号 / 总匹配数
- 结果计数改为本地遍历终端 buffer 统计，不再依赖 xterm decorations / proposed API

### 9.4 终端右键菜单逻辑
- 终端右键菜单采用“渲染进程收集上下文 + 主进程构建原生菜单”的方式实现
- 渲染进程在主终端和过滤终端的 `terminal-wrapper` 上监听 `contextmenu`
- 渲染进程通过 `show-terminal-context-menu` 向主进程发送右键上下文
- 主进程根据 `terminalType`、选区状态、串口连接状态、过滤状态动态生成菜单项
- 菜单动作通过 `terminal-context-menu-action` 发回渲染进程执行
- 当前已加入对 `showSidebarTab`、剪贴板访问和终端缓冲读取的基础保护，降低右键菜单动作直接抛错的概率

---

## 10. 已实现的用户需求（重要）

以下是当前项目在本轮需求演进后明确要保留的行为：

### 10.1 主输入框需求
- 保留输入框发送功能
- 保留“加入快捷发送”按钮，便于把当前输入快速保存到左侧快捷发送列表
- 保留历史命令记录
- 上下键切换历史命令
- 不做自动发送
- 不做“任何按键都自动发送”
- 不做特殊按键发送
- 发送后输入框**不自动清空**
- 支持“按回车发送”开关
- 支持“末尾自动追加 CRLF”开关

### 10.2 主终端需求
- 主终端保留像终端一样的直接输入发送能力
- 在主终端中输入字符应逐键发送，而不是攒到回车整段发送

### 10.3 过滤窗口需求
- 过滤窗口在主界面内作为标签页存在
- 关闭应用后再次打开，应自动恢复之前打开的过滤标签页
- 恢复过滤文本、正则状态、区分大小写状态
- 过滤历史继续保留

### 10.4 终端右键菜单需求
- 主终端支持右键菜单
- 过滤终端支持右键菜单
- 主终端当前支持：复制、复制全部、查找选中内容、清空终端、粘贴并发送、发送选中内容、基于选中文本新建过滤标签页
- 过滤终端当前支持：复制、复制全部、查找选中内容、清空当前终端、用选中文本作为过滤条件、将选中文本追加到过滤条件、切换区分大小写、切换正则、关闭过滤标签页
- 右键菜单动作执行时不应无条件抢占主输入框焦点

### 10.5 快捷发送需求
- 左侧快捷发送列表支持拖动排序
- 拖动后的顺序应写回配置并在下次启动时保持

### 10.6 窗口状态需求
- 主窗口大小应写入配置，关闭后再次打开恢复上次大小

### 10.7 多语言需求
输入框相关区域必须多语言适配，包括：
- 输入框 placeholder
- Send 按钮
- “加入快捷发送”按钮
- 上一条发送
- 输入框显示/隐藏按钮
- 按回车发送开关
- 末尾追加 CRLF 开关
- 终端右键菜单文案

### 10.8 自动更新需求
- 每次启动应用自动检查更新
- 发现新版本时提示用户选择：立即更新、暂不更新、跳过此版本
- 若选择跳过此版本，后续启动不再提示该版本
- 更新下载完成后提示用户立即重启安装或稍后安装

---

## 11. 本轮开发中出现过的重要问题与经验

### 11.1 过滤窗口日志截断 / 缺失 / 串行错乱
这是项目里一个高风险区域。

曾出现的问题包括：
- 打开过滤窗口时复制主窗口历史导致严重卡顿
- 过滤窗口显示缺失
- 过滤窗口半行接下一行
- 过滤命中后内容被截断
- 过滤输入时焦点跳到主输入框

### 11.2 焦点问题的根因
真正根因不是过滤输入框本身，而是**主输入框被设计成会在某些全局流程中抢焦点**。

典型错误模式：
- 在 tab 切换、布局恢复、状态刷新时自动 `focusMainInput()`
- 结果导致过滤输入框刚输入一个字符就被抢焦点

正确原则：
- 主输入框只能在用户显式操作时聚焦
- 不要在全局 UI 更新、tab 切换、配置恢复、过滤输入变化后自动聚焦主输入框

### 11.3 关于输入框功能与日志链路的耦合风险
曾经引入过一种问题：
- 为修复主输入框自动发送或特殊键发送，引入了对主终端输入链路的副作用
- 进而影响过滤窗口日志显示

**经验**：
- 主输入框功能必须和主终端串口接收显示链路解耦
- 修改输入框逻辑时，避免动 `serial-output` -> `SerialDataParser` -> `formatLineForTerminal` 这条主渲染链

### 11.4 右键菜单与焦点风险
- 右键菜单容易引发焦点回到主输入框的问题，尤其是在过滤输入框刚操作后
- 当前处理原则：右键菜单动作执行期间临时抑制 `focusMainInput()`
- 动作完成后再根据当前激活元素恢复焦点策略，避免过滤输入框被无条件抢焦点
- 后续若继续扩展右键菜单动作，应复用现有焦点抑制逻辑，不要直接在菜单动作末尾强制聚焦主输入框

---

## 12. 关键函数与关注点清单

### `main.js`
- `loadConfig()`：配置默认值来源
- `saveConfig()`：配置合并写回
- `createWindow()`：主窗口大小恢复与 resize 持久化
- `handleSerialData(str)`：串口文本接收主入口
- `ipcMain.on('serial-input')`：串口发送主入口
- `ipcMain.on('save-config')`：渲染层配置保存
- `ipcMain.on('show-terminal-context-menu')`：终端右键菜单入口
- `checkForAppUpdates()`：统一的自动/手动检查更新入口
- `promptForAvailableUpdate()`：新版提示与用户选择
- `promptToInstallDownloadedUpdate()`：下载完成后的安装提示
- `fetchGithubReleaseNotes()`：通过 GitHub Release API 拉取版本正文

### `renderer.js`
- `SerialDataParser`
- `formatLineForTerminal()`
- `createFilterTab()`
- `closeFilterTab()`
- `persistFilterTabs()`
- `bindTerminalContextMenu()`
- `handleTerminalContextMenuAction()`
- `getTerminalPlainText()`
- `sendSerialData()`
- `sendMainInputBuffer()`
- `navigateMainInputHistory()`
- `applyConfig()`

### `preferences.js`
- `applyPrefsI18n()`
- `createRuleElement()`
- `init()`

### `i18n.js`
- `translations`
- `getLanguage()`
- `t()`

---

## 13. 当前已知架构特点与限制

1. 主窗口使用 `nodeIntegration: true` + `contextIsolation: false`
   - 开发方便，但安全性不是现代 Electron 最佳实践

2. 渲染层逻辑较重
   - `renderer.js` 负责终端、过滤、搜索、主输入框、吞吐量、配置恢复等大量功能
   - 后续若要重构，优先考虑拆模块

3. 过滤标签页逻辑和主终端逻辑共享部分状态
   - 修改时需谨慎验证对主终端渲染的影响

4. 自动发送和快捷发送属于旧功能区
   - 这些功能保留在左侧“Send”标签页
   - 与下方主输入框是两套不同发送体系

---

## 14. AI 接手时建议的工作流程

建议每次接手本项目时按以下顺序理解：

1. 先读本文件 `agent_notes.md`
2. 再看：
   - [`main.js`](main.js)
   - [`renderer.js`](renderer.js)
   - [`index.html`](index.html)
   - [`i18n.js`](i18n.js)
   - [`preferences.js`](preferences.js)
3. 明确本次修改属于哪一类：
   - 串口收发
   - 主终端显示
   - 过滤标签页
   - 主输入框
   - 设置窗口
   - 多语言
   - 配置持久化
4. 若改动输入框逻辑，必须验证：
   - 主终端逐键发送是否仍正常
   - 过滤输入焦点是否正常
   - 发送历史是否正常
   - 多语言是否正常
5. 若改动过滤逻辑，必须验证：
   - 主终端显示是否正常
   - 不会截断/缺失/错行
   - 过滤历史保存/恢复是否正常
6. 若改动配置逻辑，必须验证：
   - 启动恢复
   - 保存 JSON 结构
   - 设置窗口/主窗口读取是否一致

---

## 15. 推荐后续改进方向

1. 将 `renderer.js` 拆分为多个模块：
   - terminal-core
   - filter-tabs
   - main-input
   - throughput
   - sidebar-send
   - i18n-apply

2. 为过滤标签页建立更清晰的数据模型

3. 为主输入框和主终端输入建立明确的职责边界

4. 为配置结构建立版本字段，方便以后迁移

5. 建立最小测试用例，至少覆盖：
   - 串口文本完整性
   - 过滤标签页恢复
   - 输入框发送历史
   - 多语言切换
  - 更新跳过版本的持久化与启动检查行为

---

## 16. 维护声明（AI 必读）

**今后任何 AI 在本项目中完成功能开发、修复缺陷、调整配置结构、修改界面交互、增加/删除文件、改变实现原理后，必须同步更新本 `agent_notes.md` 文档。**

最低更新要求：
- 若新增功能：补充到“已实现的用户需求”和相关模块说明
- 若修改实现：补充到“实现原理 / 关键函数 / 架构特点”
- 若新增配置项：补充到“配置文件结构”
- 若修复重要问题：补充到“重要问题与经验”
- 若调整目录结构或新增关键文件：补充到“目录结构与文件职责”

**禁止只改代码不改本文档。**

本文档应始终被视为该项目的 AI 接手记忆文件与工程说明总入口。

---

## 17. 右键菜单开发任务清单与进度

### 17.1 本轮开发目标

在以下区域加入右键菜单：
- 串口主窗口主终端
- 主界面内的过滤标签页终端

第一阶段目标：
- 建立统一右键菜单架构
- 支持主终端与过滤终端共用基础菜单
- 支持各自的专属菜单动作
- 保持焦点行为稳定，不影响主输入框与过滤输入框

### 17.2 代办清单

- [x] 梳理右键菜单范围
- [x] 设计终端菜单数据结构
- [x] 补充多语言菜单文案
- [x] 在主进程实现菜单
- [x] 在主终端绑定右键
- [x] 在过滤终端绑定右键
- [x] 实现复制与复制全部
- [x] 实现查找与清空
- [x] 实现主终端专属操作
- [x] 实现过滤窗口专属操作
- [x] 联调 IPC 与状态同步
- [x] 回归验证焦点与发送
- [x] 更新 agent_notes 说明

### 17.3 实时开发进度

- 当前阶段：完成文档归档
- 当前状态：已完成主要开发
- 当前结论：
  - 右键菜单建议采用“渲染进程采集上下文 + 主进程创建原生菜单”的模式
  - 主终端与过滤终端共享基础菜单项，减少重复逻辑
  - 与过滤条件、搜索、串口发送有关的动作应通过现有渲染层逻辑回调执行
  - 必须避免在右键菜单动作后无条件聚焦主输入框，防止再次引入焦点抢占问题
  - 已开始接入主进程 `show-terminal-context-menu` IPC 和渲染层动作回调
  - 已规划首批菜单动作：复制、复制全部、查找选中内容、清空终端、粘贴并发送、发送选中内容、过滤条件相关动作
  - 已完成主终端和过滤终端的右键菜单接入
  - 已完成主进程原生菜单动态构建
  - 已完成首批动作联通：复制全部、查找选中内容、清空、粘贴并发送、发送选中内容、基于选中文本创建过滤标签页、过滤条件编辑、关闭过滤标签页
  - 已补充右键菜单动作执行期间的主输入框焦点抑制，降低对过滤输入框的焦点干扰风险
  - 已完成右键菜单 IPC 联调与状态回传链路
  - 已补充对 `showSidebarTab`、剪贴板访问和终端缓冲读取的基础保护
  - 静态检查已通过；未发现本次改动引入的语法错误
  - 实际 UI 交互仍建议在 Electron 窗口中手工点按验证一轮