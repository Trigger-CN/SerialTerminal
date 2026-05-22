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
├─ workspace-manager.js       主工作区 pane/tab 状态与 DOM 编排管理
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
- 系统 shell 会话的创建、输入、resize、关闭与退出事件转发

#### `renderer.js`
负责：
- 主终端初始化（xterm）
- shell tab 初始化与输出渲染
- 串口数据显示解析与渲染
- 过滤标签页创建、关闭、过滤历史
- 搜索逻辑与结果计数显示
- 主输入框发送逻辑
- 快捷发送、自动发送、吞吐量 UI 等
- 当前也承担多语言在主窗口中的部分应用逻辑

#### `workspace-manager.js`
负责：
- `workspaceLayout` 的 pane/tab 状态管理
- pane 激活、tab 激活、tab 移动、关闭分屏等工作区操作
- 过滤 tab 加入/移出工作区时的 pane 归属与激活回退处理
- 配置恢复阶段的 workspace 布局替换与激活恢复
- 当前活动 pane / tab 解析，供搜索和其他行为统一复用
- 右键菜单相关目标 pane 解析与对侧 pane 推导
- 分屏开关、布局方向、tab 活动态等纯工作区状态读取
- workspace 布局标准化与快照/默认布局访问
- pane 分区比例应用与拖动后的尺寸持久化
- 将工作区状态统一映射回主界面 DOM
- 降低 `renderer.js` 继续演进分屏功能时的耦合风险

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
  "workspaceLayout": {
    "splitEnabled": false,
    "orientation": "horizontal",
    "activePaneId": "pane-1",
    "paneSizes": {
      "pane-1": 0.5,
      "pane-2": 0.5
    },
    "panes": [
      {
        "id": "pane-1",
        "activeTabId": "tab-main",
        "tabIds": ["tab-main"]
      },
      {
        "id": "pane-2",
        "activeTabId": null,
        "tabIds": []
      }
    ]
  },
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
- `filterTabs`：过滤标签页恢复所需状态（过滤文本、大小写、正则、所属 pane 等）
- `workspaceLayout`：主工作区分屏布局、pane 激活状态、各 tab 所属 pane
- `workspaceLayout.paneSizes`：两个 pane 的分区比例，用于拖动分隔条后恢复尺寸
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
- 主工作区 `workspace-root`
- pane-1 / pane-2 双 pane 容器（首版最多 2 个 pane）
- 主终端标签页 `tab-main`
- 多个过滤标签页 `tab-filter-*`
- 系统终端标签页 `tab-shell-*`
- 下方主输入框面板 `main-input-panel`

### 6.2.1 当前分屏能力（首版）
- 支持左右分屏
- 支持上下分屏
- 支持将当前 tab 移动到另一个 pane
- 支持关闭分屏并将第二 pane 的 tab 回收至第一 pane
- 支持拖动两个 pane 中间的分隔条，实时调整两个分区大小
- 每个 pane 各自维护 active tab
- 分屏操作入口已从顶部工具栏收敛到终端右键菜单，便于明确当前操作目标 tab / pane
- 每个 pane 的 tabs header 右侧都带独立“新建过滤标签页”按钮，用于明确在当前 pane 中创建新 tab
- 每个 pane 的 tabs header 右侧当前也带独立“新建 shell 标签页”按钮
- 搜索目标跟随当前 active pane 的 active tab
- 分屏布局会写入 `config.workspaceLayout` 并在启动后恢复

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
- 主进程根据 `terminalType`（main/filter/shell）、选区状态、串口连接状态、过滤状态动态生成菜单项
- 菜单动作通过 `terminal-context-menu-action` 发回渲染进程执行
- 菜单图标使用固定宽度文本前缀，避免 emoji 宽度不一致
- 当前已加入对 `showSidebarTab`、剪贴板访问和终端缓冲读取的基础保护，降低右键菜单动作直接抛错的概率
- 过滤终端已接入一版轻量源日志映射，用于从过滤终端回定位主终端日志

### 9.5 过滤终端定位主终端逻辑
- 当前实现已收敛为轻量方案：不再维护额外的源日志映射表
- 过滤终端右键时，直接读取点击命中的 buffer 行文本
- 再从该文本解析显示行号，例如 `[0035]`
- 最后切换到主终端，并通过搜索该显示行号完成定位与高亮

### 9.6 定位后高亮逻辑
- 当前采用稳定优先方案：定位后通过主终端搜索对应显示行号，实现对行号文本的高亮
- 已移除 Marker / Decoration 的整行高亮尝试，避免在不同 xterm 运行环境下表现不一致
- 当前高亮目标是行号文本本身，而不是整行背景

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
- 主终端与过滤终端右键菜单当前都已支持分屏相关动作：左右分屏、上下分屏、关闭分屏；过滤标签页额外支持移动到另一个 pane
- 过滤终端当前支持：复制、复制全部、查找选中内容、清空当前终端、用选中文本作为过滤条件、将选中文本追加到过滤条件、在主终端中定位、切换区分大小写、切换正则、关闭过滤标签页
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

### 11.5 过滤定位偏移问题
- 过滤终端“在主终端中定位”初版若直接使用鼠标 Y 坐标估算逻辑行索引，会因为 viewport 滚动和视觉换行产生偏移
- 当前修正原则：右键时先读取点击所在 buffer 行文本，再解析显示行号进行主终端定位
- 该方案比基于 `offsetY -> sourceLogIds[index]` 的估算更稳定，且与当前轻量映射方案耦合更低

### 11.6 pane 有 tab 但未显示内容的问题
- 根因不是单纯点击失效，而是 `workspaceLayout.activeTabId` 可能指向了当前 pane 中“逻辑上存在但 DOM 尚未就绪或节点已失效”的 tab
- 旧逻辑只校验 `activeTabId` 是否存在于 `pane.tabIds`，未校验对应 `.main-tab` / `.main-tab-pane` 节点是否真实存在
- 结果是 pane 内虽然有 tab，但没有任何 tab 被成功加上 `.active`，界面表现为空白
- 当前修正原则：只要 pane 中存在 tab，就必须回退到当前 pane 中第一个真实可渲染的 tab，并立即显示
- 当前还会在布局应用与激活兜底前清理 `pane.tabIds` 中已失效的脏 `tabId`，避免恢复后反复命中空白状态
- 当前在配置恢复后若发生上述自愈，还会自动把清理后的干净 `workspaceLayout` 回写到配置，避免下次启动再次恢复出脏状态

### 11.7 pane 交互抽搐 / 无法拖动 / 右键异常
- 根因是把“布局自愈后的配置回写”挂到了 `applyLayoutToDom()` 这种高频路径上
- `switchPaneTab()`、右键菜单动作、splitter 拖动等都会触发 `applyLayoutToDom()`；若这里立即 `save-config`，主进程会回发 `config-updated`，从而再次触发 `applyConfig()` 和 `restoreWorkspaceLayout()`
- 这会形成“交互 -> 布局应用 -> 保存配置 -> 配置回推 -> 再次恢复布局”的回环，表现为 pane 抽搐、拖动被打断、右键异常
- 当前修正原则：自愈后的回写只允许发生在布局恢复流程中，不能挂在高频 UI 布局应用路径上

### 11.8 串口 + shell 分屏拖动抽搐问题
- 当左侧为串口终端、右侧为 shell tab 时，若在 splitter 拖动高频过程中同步向主进程发送 `resize-shell-tab`，容易造成 shell 侧反复 resize，表现为分屏拖动抽搐
- 当前修正原则：拖动 splitter 期间只做前端 xterm fit，不在每一帧都向主进程发送 shell PTY resize；待拖动结束后再统一同步最终 cols/rows

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

### `workspace-manager.js`
- `createWorkspaceManager()`
- `getDefaultLayout()`
- `getLayoutSnapshot()`
- `isSplitEnabled()`
- `getOrientation()`
- `normalizeWorkspaceLayout()`
- `getActivePane()`
- `getActiveTabId()`
- `getActiveTabInfo()`
- `resolvePaneId()`
- `getOtherPaneId()`
- `getTabPaneId()`
- `isTabActive()`
- `setPaneSizes()`
- `switchPaneTab()`
- `moveTabToPane()`
- `addTabToPane()`
- `removeTab()`
- `restoreLayout()`
- `collapseSplit()`
- `applyLayoutToDom()`

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

## 15A. 分屏工作区方案 A 实施计划

### 15A.1 目标定义

在主界面中央终端工作区引入类似 VS Code 的 pane 工作区分屏能力，支持：

- 左右分屏
- 上下分屏
- 主终端与过滤终端分别放入不同 pane
- 两个过滤终端分屏显示
- 单串口连接下多个视图共享同一份串口输入流

本方案**不要求**：

- 同一个 tab 同时复制成两个同步 pane
- 同时监听多个物理串口
- 首版即支持任意层级嵌套分屏

### 15A.2 总体设计原则

1. 采用 **pane/workspace 容器** 替代当前“单 tabs 栈”主区域
2. 保持当前单串口主链路不变，不修改 `main.js` 的串口连接模型
3. 主终端 `tab-main` 与过滤终端 `tab-filter-*` 继续作为独立终端视图存在
4. 分屏仅改变这些视图在 UI 中的组织方式，不改变串口数据来源
5. 首版以“固定最多 2 个 pane”作为最小可用实现，优先保证稳定性

### 15A.3 首版范围（MVP）

首版建议仅实现以下能力：

- 无分屏 / 左右分屏 / 上下分屏 三种布局状态
- 最多 2 个 pane
- 每个 pane 内保留 tabs 机制
- 支持将当前 tab 移动到另一个 pane
- 支持在当前 pane 或新 pane 中创建过滤 tab
- 支持分屏布局持久化与启动恢复
- 支持 pane 间切换时搜索目标、右键菜单目标、fit 目标正确切换

首版暂不实现：

- tab 拖拽到任意停靠位置
- 多级嵌套 pane 树
- 任意数量 pane
- 同一 tab 的复制视图

### 15A.4 UI 结构改造方案

当前主区域结构为：

- 一个 `main-tabs-header`
- 一个 `main-tabs-content`
- 一个全局 `main-input-panel`

改造后建议为：

- 一个 `workspace-root`
- `workspace-root` 内最多 2 个 `pane`
- 每个 `pane` 各自包含：
  - `pane-tabs-header`
  - `pane-tabs-content`
- `main-input-panel` 继续保留为主区域底部全局输入区

建议新增概念：

- `activePaneId`：当前活动 pane
- `pane-1`：默认主 pane
- `pane-2`：分屏后出现的第二 pane

### 15A.5 状态模型建议

建议将当前“全局 tab 激活”改造为“pane 内部激活”。

首版可以采用轻量状态结构：

```js
workspaceLayout = {
  splitEnabled: false,
  orientation: 'horizontal', // horizontal=左右, vertical=上下
  panes: [
    {
      id: 'pane-1',
      activeTabId: 'tab-main',
      tabIds: ['tab-main']
    },
    {
      id: 'pane-2',
      activeTabId: null,
      tabIds: []
    }
  ]
}
```

过滤 tab 的运行时状态仍可保留在 `filterTabs` 中，但建议补充：

```js
{
  id,
  paneId,
  term,
  fitAddon,
  searchAddon,
  filterText,
  caseSensitive,
  useRegex
}
```

### 15A.6 配置持久化建议

建议在 `config.json` 中新增：

```json
{
  "workspaceLayout": {
    "splitEnabled": false,
    "orientation": "horizontal",
    "panes": [
      {
        "id": "pane-1",
        "activeTabId": "tab-main",
        "tabIds": ["tab-main"]
      },
      {
        "id": "pane-2",
        "activeTabId": null,
        "tabIds": []
      }
    ]
  }
}
```

说明：

- `filterTabs` 继续保存过滤配置本身
- `workspaceLayout` 只负责 tab 属于哪个 pane、当前方向和激活状态
- 启动恢复时先恢复过滤 tab，再按 `workspaceLayout` 组织 pane

### 15A.7 关键代码改造点

#### A. `index.html`

- 将当前单一 `main-tabs-header` / `main-tabs-content` 改造成工作区容器
- 在每个 `pane` 的 tabs header 右侧加入独立“新建过滤标签页”按钮
- 将分屏操作入口收敛到终端右键菜单，避免全局工具栏弱化当前操作目标

#### B. `style.css`

- 为 `workspace-root` 增加 flex 布局
- 支持：
  - `.split-horizontal`
  - `.split-vertical`
- 为 pane 增加独立 header/content 样式
- 预留 pane active 态高亮样式，便于区分当前搜索目标和右键上下文目标

#### C. `renderer.js`

需要新增或调整的核心能力：

- `switchMainTab(tabId)` -> 改造成 `switchPaneTab(paneId, tabId)`
- 新增 `setActivePane(paneId)`
- `createFilterTab(initialState)` -> 改造成支持 `targetPaneId`
- 新增 `moveTabToPane(tabId, targetPaneId)`
- 新增 `applyWorkspaceLayout()`
- 新增 `persistWorkspaceLayout()`
- 新增 `restoreWorkspaceLayout()`
- 将搜索目标解析逻辑从“全局 active tab”改为“active pane 的 active tab”
- 将右键菜单动作目标解析逻辑从“当前 active tab”改为“事件来源 pane/tab”

#### D. `main.js`

首版预计无需增加复杂 IPC；只需继续复用现有 `save-config` 配置持久化链路。

### 15A.8 串口数据与视图关系

本方案保持现有数据链路不变：

- 主进程继续向渲染层广播 `serial-output`
- 渲染层继续使用 `SerialDataParser.parse(data)` 解析
- 主终端写入主终端实例
- 各过滤终端继续根据各自 `filterRegex` 写入对应终端

即：**分屏只改变显示容器，不改变串口处理链。**

### 15A.9 搜索、右键菜单与焦点策略

这是分屏方案中的高风险区域，必须保持以下原则：

1. 搜索面板始终作用于“当前活动 pane 的活动 tab”
2. 右键菜单动作始终作用于触发菜单的终端实例，不能仅依赖全局 active tab
3. 切换 pane / tab / 布局恢复时，禁止无条件调用 `focusMainInput()`
4. 过滤输入框仍应优先保护焦点，不可因 pane 切换被主输入框抢焦点
5. 分屏切换、关闭、移动 tab 后，要重新确认当前 active pane 与 active tab 的一致性

### 15A.10 fit 与布局刷新策略

分屏后，`xterm fitAddon.fit()` 触发时机需要扩展到：

- pane 创建后
- 分屏方向切换后
- 分隔条拖动后
- tab 移动后
- tab 切换后
- 窗口 resize 后
- 布局恢复完成后

原则：

- 主终端使用 `serialFitAddon.fit()`
- 过滤终端使用各自 `tab.fitAddon.fit()`
- 避免在隐藏 pane 上频繁 fit，优先在实际可见后 fit

### 15A.11 分阶段实施步骤

#### 第一阶段：布局容器落地

- 引入 `workspace-root`
- 实现双 pane DOM 结构
- 实现左右 / 上下布局切换
- 暂不迁移全部 tab 逻辑，只先让主终端在 pane-1 正常显示

#### 第二阶段：tab 归属模型改造

- 为 `tab-main` 和 `tab-filter-*` 增加 `paneId`
- 支持每个 pane 内独立 active tab
- 支持过滤 tab 创建到指定 pane

#### 第三阶段：pane 操作能力

- 实现“移动当前 tab 到另一 pane”
- 实现“关闭分屏”并回收第二 pane tab 到第一 pane
- 完成 workspaceLayout 持久化与恢复

#### 第四阶段：行为联调

- 搜索目标切换
- 右键菜单动作目标校正
- 焦点保护回归
- fitAddon 刷新回归

#### 第五阶段：体验补充

- pane 激活态样式
- 多语言文案补充
- 可能的分隔条拖动调节比例（若首版时间允许）

### 15A.12 验证清单

分屏功能开发后，至少需要验证：

1. 主终端单独显示时行为不退化
2. 主终端 + 过滤终端左右分屏时：
   - 主串口输出正常
   - 过滤输出正常
   - 搜索目标正常
   - 右键菜单目标正常
3. 主终端 + 过滤终端上下分屏时行为一致
4. 两个过滤终端分屏时：
   - 各自过滤条件独立
   - 各自搜索独立切换正确
5. 移动 tab 后：
   - 不丢日志显示
   - 不丢过滤条件
   - 不抢焦点
6. 关闭应用后再次启动：
   - 过滤 tab 恢复正常
   - 分屏方向恢复正常
   - 各 tab 所属 pane 恢复正常

### 15A.13 主要风险与规避策略

#### 风险 1：fit 时机错误导致终端尺寸异常
- 规避：pane 可见后再 fit；布局切换后统一延迟一次 fit

#### 风险 2：搜索目标仍引用全局 active pane 旧逻辑
- 规避：统一封装 `getActivePaneSearchTarget()`，禁止分散判断

#### 风险 3：右键菜单动作误操作到非当前 pane
- 规避：菜单 payload 中显式携带 `paneId`、`tabId`、`terminalType`

#### 风险 4：过滤输入框再次被主输入框抢焦点
- 规避：分屏相关 UI 操作中复用当前 `suppressMainInputFocus` 保护策略

#### 风险 5：布局恢复顺序错误导致 tab 找不到容器
- 规避：先恢复 tab 实例，再恢复 pane 归属，最后统一激活与 fit

### 15A.14 后续增强方向

在 MVP 稳定后，可继续考虑：

- 拖拽 tab 到另一 pane
- 分隔条拖动调整比例
- 新建过滤 tab 时选择目标 pane
- 多 pane 嵌套树结构
- 将 workspace/pane/tab 状态从 `renderer.js` 进一步模块化拆分

### 15B. 系统终端 Shell Tab 实施计划（当前开发计划）

#### 15B.1 目标定义

在当前主工作区中新增 `shell tab`，作为与 `tab-main`、`tab-filter-*` 并列的新终端视图类型。

首版目标：

- 支持在 `pane-1` / `pane-2` 中新建 shell tab
- 每个 shell tab 对应一个独立系统 shell 会话
- 支持 shell 输入、输出、关闭
- 支持 shell tab 在两个 pane 之间移动
- 支持 shell tab 布局持久化
- 支持 shell tab 纳入当前 pane/tab 激活、fit 和搜索目标切换体系

首版暂不要求：

- 恢复上次关闭前的 shell 进程会话状态
- 自定义 shell 可执行路径
- 将主输入框复用于 shell 发送
- 将 shell 输出接入串口高亮/过滤链路
- 多级 pane 嵌套

#### 15B.2 实现原则

1. shell 必须作为新的 workspace tab 类型接入，而不是伪装成过滤 tab
2. shell 进程生命周期由主进程统一管理，渲染层仅负责 xterm 显示与输入转发
3. 串口主链路 `serial-output -> SerialDataParser -> 主/过滤终端渲染` 不得被 shell 功能污染
4. shell tab 应复用现有 pane/workspace 架构、分屏、fit 与 active pane 管理
5. 主输入框职责维持为串口输入，不因 shell tab 激活而切换语义

#### 15B.3 数据模型建议

运行时新增：

- `shellTabs`: 渲染层 shell tab 状态数组
- `nextShellTabId`: shell tab 自增编号
- `shellSessions`: 主进程 `tabId -> pty session` 映射

配置新增建议：

```json
{
  "shellTabs": [
    {
      "title": "Shell 1",
      "paneId": "pane-2"
    }
  ]
}
```

说明：

- `workspaceLayout` 仍只保存 tab 在 pane 中的归属与激活状态
- `shellTabs` 只保存 UI 恢复所需最小状态，不保存进程句柄
- 启动恢复阶段先恢复 shell tab DOM，再恢复 `workspaceLayout`

#### 15B.4 主进程改造计划（`main.js`）

将当前单实例 PTY 逻辑升级为多 session 模型。

计划新增：

- `create-shell-tab-session`
- `shell-tab-input`
- `resize-shell-tab`
- `close-shell-tab-session`
- `shell-tab-output`
- `shell-tab-exit`

实现要求：

- 由主进程维护 `Map<tabId, session>`
- 每个 shell tab 拥有独立 `node-pty` 进程
- 输出必须带 `tabId` 返回渲染层
- tab 关闭、shell 退出、应用退出时必须清理 session
- 首版 shell 路径仅允许使用系统默认 shell，避免开放任意可执行路径输入

#### 15B.5 渲染层改造计划（`renderer.js`）

计划新增：

- `shellTabs` 运行时状态管理
- `createShellTab()`
- `closeShellTab()`
- `persistShellTabs()`
- shell 输出/退出事件监听

接入要求：

- shell tab 使用独立 xterm 实例
- shell 输入通过 `shell-tab-input` 发往主进程
- shell 输出不经过 `SerialDataParser`
- `fitWorkspaceTerminals()` 需要纳入 shell tab
- 搜索目标切换需要兼容 shell tab
- 主输入框不得因 shell tab 激活而自动获得焦点

#### 15B.6 工作区与 UI 改造计划

首版在两个 pane 的 tabs header 中新增独立“新建 shell tab”入口。

要求：

- shell tab 按现有 `.main-tab` / `.main-tab-pane` 结构接入
- shell tab 可像过滤 tab 一样加入、切换、移动、关闭
- `workspace-manager.js` 保持通用 tabId 机制，不为 shell 单独设计新 pane 模型

#### 15B.7 输入与快捷键策略

要求：

- shell tab 焦点在 xterm 时直接输入 shell
- 复制/粘贴快捷键处理需按终端类型分流，不能继续默认转发到串口
- 主输入框、快捷发送、自动发送仍仅作用于串口

#### 15B.8 首版开发范围

本轮确定实现以下最小可用能力：

- 新建 shell tab
- 关闭 shell tab
- shell 输入输出
- shell tab 在两个 pane 间移动
- shell tab 布局与 UI 状态持久化
- shell 右键菜单基础能力（复制、复制全部、查找、清空、移动、关闭、重启）
- 启动后按保存的 shell tab 列表自动重建 shell session

本轮暂不实现：

- 重启 shell
- 自定义 shell 类型选择

#### 15B.9 风险点

1. 旧单实例 PTY 逻辑若未完全移除，容易与新 shell tab 架构冲突
2. 当前终端快捷键处理默认发送到串口，若未按类型拆分会导致 shell 粘贴误发串口
3. shell tab 若未纳入 fit 链路，分屏后容易出现尺寸错误
4. 启动恢复顺序若错误，可能出现 pane 中存在 shell tabId 但 DOM 未就绪的空白 pane
5. 不允许让 shell 改动影响串口日志链与过滤链

#### 15B.10 当前实施顺序

1. 更新 `agent_notes.md` 记录计划
2. 主进程改造为多 shell session
3. 渲染层接入 shell tab 创建/关闭/输入输出
4. UI 增加 shell tab 入口并接入 workspace 持久化
5. 回归验证分屏、fit、关闭与配置恢复行为

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
  - 右键菜单已增加符号前缀，用于提升菜单层次感与可辨识度
  - 已在过滤终端右键菜单中加入“在主终端中定位”动作
  - 已修正过滤终端定位主终端时的 1 行偏移问题，改为读取右键命中 buffer 行文本并解析显示行号
  - 已收敛为“搜索行号并高亮行号文本”的稳定方案，未继续保留 Decoration 整行高亮尝试
  - 已移除未使用的源日志映射逻辑，降低状态维护复杂度