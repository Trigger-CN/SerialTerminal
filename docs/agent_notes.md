# SerialTerminal 项目接手说明 / AI 记忆文档

> 当前权威状态：以本文第 0 节、`main.js` 的 `CONFIG_VERSION`/`normalizeConfig()`、实际模块和测试为准。后文 15A、15B、17 节及独立计划文档保留历史设计背景，不代表尚未实现。

## 0. 当前状态快照（维护入口）

- **滚轮行数设置修复**：配置保存/下发原本正常，但新串口组漏绑滚轮，Shell 普通回滚没有接入；旧监听放在 xterm 根元素，也未统一隔离内部滚动处理。现每个 `createSerialRuntime()` 在 `term.open()` 后通过 `bindTerminalWheel(term, container)` 绑定各自外层容器 capture，默认组不再额外绑定；过滤终端复用同路。处理有效纵向事件时阻止默认行为和继续传播，按方向滚动当前 `mouseWheelScrollLines`，0/非有限 delta 不滚动。Shell 普通 buffer 且无鼠标跟踪时及文本模式复用此路径；非文本模式的鼠标报告/备用屏交给 xterm，保留 vim/tmux 协议。`applyConfig()` 用共享整数规则（1–50，默认3），已有终端即时读取新值，不需重建或重连。新增6项行为回归：双组构造/独立目标、动态设置、方向、无效事件和Shell模式，专项 **67/67**、根 **833/833**、0 skipped，renderer语法/module-load/diff check通过（Node20.16.0）。未启动应用/截图或修改真实配置，真实滚轮硬件体验待用户手测；未改schema/依赖。

- **标签关闭按钮外移**：所有使用 `.main-tab-close` 的 Shell、过滤、图表和串口分组标签统一将右侧内边距从 16px 调为 6px，关闭按钮左侧增加 10px 留白；按钮向右外移 10px，文字与按钮的间隔从 8px 扩为 18px，原有标签总宽和 16×16 点击区域不变。按钮禁止 flex 压缩，不用绝对定位或 hover 位移；无关闭按钮的主标签不受影响。该阶段 markup/关闭确认专项 **79/79**、根项目 **810/810**、0 skipped；关闭确认随后替换为下一条的应用内邻近弹窗。

- **关闭标签页统一风格并靠近目标**：用户点击关闭按钮或右键关闭 Shell、过滤、图表标签，以及关闭非默认串口组，均经 `requestTabCloseConfirmation()` → `showTabCloseDialog()` → `anchored-confirm-dialog.js`，复用 `.app-dialog` 的背景、边框、标题、正文、取消/危险操作按钮，不再调用原生 `confirm-tab-close` IPC。弹窗优先位于目标标签下方 8px、右边缘对齐，底部不足翻到上方，左右/上下夹紧视口，resize/scroll 跟随；串口组显式传实际点击的锚点，避免同组多区域串位，无可见锚点时安全居中。默认焦点取消；Esc、遮罩、关闭按钮及窗口卸载取消；Tab/Shift+Tab 限制弹窗内，拦截底层快捷键，取消后恢复原焦点。文字用 textContent；显示目标名称和会话/分组影响。确认前不改布局、不销毁终端或连接；重复提示去重，迟到确认不关同ID新对象，组仅提示一次，内部 reset 显式 `{ confirm:false }`，默认组/主标签不可关闭规则和几何合并不变。未新增依赖/配置项/schema。新增定位/焦点/安全交互回归并迁移原生弹框测试，专项 **130/130**、根项目 **827/827**、0 skipped，main/renderer/dialog语法、renderer module-load与差异检查均通过（本地Node20.16.0）。未启动应用、截图或修改真实配置；实际外观、原生菜单返回后的交互/PTY与硬件仍待用户手测。

- **Shell 快捷命令目标已修复**：发送目标读取唯一 `workspaceModel.focusedTabId`（模型初始化前仅用启动焦点），不再借用串口控制组的 `getActiveTabInfo()`。原实现会在单组双 Shell 分屏时发给另一格的 Shell，多组时还可能误判未选 Shell。现在只发给最近通过标签或可见内容 click/focusin 选中的 Shell；串口获得焦点时提示先选择 Shell，选中会话未 ready 时拒绝，不回退到其他 Shell，也不广播。保留已有追加回车与精确 `tabId` → PTY 路由，不修改配置 schema。新增 11 项真实函数/model/manager/IPC 回归；相邻专项 **86/86**、根项目 **785/785**、0 skipped，renderer 语法/module-load/diff check 通过（Node20.16.0）；Node >=22.12.0、telemetry-server 和真实 Shell 手测未验，未启动应用或截图。用户仅反馈上轮简单布局测试未发现问题，不视为完整布局/硬件验收。下面 774 等数字为对应历史阶段结果。

- **统一布局内核已接入生产**：现有 `workspaceModel.layout.root` 使用同构 Split/Stack，根与组内共用几何、独立节点 ID、四方向 source/target、局部 merge 与相邻 resize；不是第二个可写 Workspace。取消某组分屏只搬指定锚点，不关闭/断开业务组、不全局收走 Shell。菜单/IPC/拖拽/激活/创建/关闭/递归渲染/fit/保存统一接通；移入已有分屏不再创建新格。稳定按钮/面板移动保留终端资源引用。单多转换保合法子树，同格多锚点回单组时以横向等比分支组合完整 content，内部轴向/比例/选择不丢；收起只隐藏非首条 header，首条保留展开按钮。详见 [布局内核契约与手测](WORKSPACE_LAYOUT_KERNEL.md)。
- **本轮验证边界**：根项目 **774/774**、0 skipped，`main.js`/`renderer.js`/全部 workspace 模块语法、renderer module-load、差异检查共 16 项全部退出 0（Node **20.16.0**）。包含独立 I1–I10、120×120 随机动作、40 组随机渲染及真实生产函数/递归模块的 VM/fake-DOM 回归，补跨锚点收起时首个可见栏的展开入口。旧表示断言迁移但有效行为不跳过；这不是原生菜单、真实拖拽、实际重启、xterm/PTY 或物理串口验收。Node >=22.12.0、telemetry-server 及上述用户手测待验。本轮未截图、未启动/操作应用、未改真实配置。下列旧数字、v16/v1 和扁平列说明只代表各历史阶段。

- **新增第二串口组保留单组 Shell 分屏**：修复单→多转换仅提升 Shell 归属却删除原格的问题。原格转为显式根区域，保留顺序、方向、比例与各格活动标签；多个 Shell 格分别保留，串口叶 owner 不变，新组加入原串口区域并保持 disconnected。已存在的外层独立 Shell 列同样保留。区域关闭/搬空统一收敛，回到单组恢复普通 pane 自由拖动，新增/合并串口 pane 与再次拆组维护唯一投影。renderer 复用现有按钮/面板和单行 Shell 列构造；codec 在快照 v1 中兼容可选 `containerId`/`paneIds`，过滤重复区域及 pane 引用。新增 17 项转换/恢复回归和 2 项真实 renderer 函数回归；最终根测试 **759/759**、相关专项 **120/120**、三份产品 JS 语法、renderer module-load 与差异检查通过（Node 20.16.0）。未运行 telemetry-server 或 Node >=22.12.0；未截图、启动/操作用户应用，原生拖拽、实际重启与硬件仍待用户验证。配置维持 v16/v1，未增加依赖或线程；不同方向的任意独立嵌套布局仍未实现。见 [单→多保留记录](MULTI_SERIAL_TAB_FIX_PLAN.md#后续缺陷新增第二组破坏单组-shell-分屏)。下列数字及范围说明为历史阶段记录。

- **串口组分屏保留既有 Shell 列**：修复 `split-group` 将已开启的隐式列重建为共享列、均分时遗漏 `__shell__`、显式布局把 Shell 挪到末尾及源列改名丢局部选择的问题。已有列只固化、不重新合并；从共享列拆组只二分该源列空间，保留其他列与 Shell 的位置、比例及局部活动标签；codec 恢复独立 Shell 列选择。新增 7 项回归，最新根测试 **740/740**、相邻模型/codec/renderer **103/103**、两份模块语法/renderer module-load/差异检查全部退出 0（Node 20.16.0）；未运行 telemetry-server 测试，Node >=22.12.0 仍待验证。配置维持 v16/v1，不增加依赖、线程或终端重建。范围为既有根级 Shell 列；外层仍共用一个方向，未实现独立嵌套分屏方向，也未修改新增组时的单→多 Shell 格提升。详情和手测见 [Shell 列保留记录](MULTI_SERIAL_TAB_FIX_PLAN.md#后续缺陷串口组分屏破坏既有-shell-列)。本轮未截图、未启动/操作用户应用，原生交互、正常关闭重启及硬件待用户验证；下列数字为各历史阶段结果。

- **右键分屏菜单修复**：内容区与标签栏统一读取模型 `canSplitTab`；仅按被拆标签的当前格判断，不借其他格/组计数，保留单组根 Shell 路径和唯一叶不可新建格约束。chart/filter/Shell 的“移到另一分屏”改为 `move` 到布局顺序中的下一合法已有格（末格回首格），无目标置灰；唯一叶移入已有格由模型收敛空源格。执行时按最新模型校验，失败通过状态栏提示，不再静默返回。新增 8 项模型/真实菜单模板/renderer 行为回归；本轮根测试 **733/733**、相邻专项 **90/90**、语法/module-load/差异检查通过（Node 20.16.0），未运行 telemetry-server 测试。详情见 [菜单修复记录](MULTI_SERIAL_TAB_FIX_PLAN.md#后续缺陷终端内容区分屏菜单)。本轮不截图、不操作用户应用；原生菜单手测、Node >=22.12.0 和原有硬件/长时验收仍待完成。下列 666/642 等数字保留为各历史阶段结果，不是当前测试总数。

- 标签缺陷修复进度见 [MULTI_SERIAL_TAB_FIX_PLAN.md](MULTI_SERIAL_TAB_FIX_PLAN.md)。F1–F5、M1–M2 已实施：关闭组同步控制上下文并共用资源销毁，连接请求/会话身份隔离迟到回调；搜索/导出/清空统一按焦点解析，后台关闭不抢焦点；模型同步格/组/列激活并修复归属和恢复边界。当前根测试 **666/666 通过（Node 20.16.0）**，语法、renderer 模块加载与差异检查通过；隔离桌面已验证侧栏同步、资源销毁、Shell 操作目标及正常关闭重启布局等价，进程和临时目录已清理；Node >=22.12.0、原生交互/真实双端口/长时验收仍待完成，具体结果以专项计划记录为准，不能视为多串口整体验收完成。

- **多串口当前入口：[WORKSPACE_LAYOUT_KERNEL.md](WORKSPACE_LAYOUT_KERNEL.md)**，阶段背景见 [MULTI_SERIAL_REFACTOR.md](MULTI_SERIAL_REFACTOR.md)。R1–R4 历史隔离/状态/保存成果保留，旧 R5 记录不作为新几何内核验收。当前代码及自动化完成，本轮原生菜单/拖拽、正常关闭重启与真实双端口/长时场景仍待用户手测，不能宣称多串口整体验收完成。
- 当前配置 schema：**v17**，由 `workspace-layout-state.js` 的 `WORKSPACE_CONFIG_VERSION` 提供；布局快照为 **v2**，保存实际树。v1 仅单向导入，v2 对照业务清单去重/补漏/修复身份；不合成业务终端。升级前保留旧 schema 备份（例如 `config.v16.backup.json`）；读取、备份或不安全迁移失败进入本次运行写保护，普通及遥测保存均不覆盖原文件，窗口加载后提示。`serial-groups-config.js` 的 15 仅为历史迁移阶段。
- 当前工作区标签类型：主 Log、过滤 Log、实时图表和 Shell。运行态布局只写 `workspaceModel`，manager 读派生副本/写动作；初始化后清旧缓存和 Shell 位置字段，旧几何仅在导入边界消费。每格独立 active，每个 Split 的 N 个孩子有 N−1 条 6px gutter；拖动合帧且释放后最终 fit。布局变化不主动重建 panel/xterm/parser/PTY。
- 多串口规则：单组所有叶自由移动，默认扁平、显式分屏采用方案 A；多组串口叶不脱 owner、Shell 根级；只移动指定组/锚点，新组 disconnected。快捷定义共享，会话、日志、发送与触发执行隔离；完整业务+布局快照合并保存，恢复期不写半成品。树成员数组决定区域顺序；内容 click/focusin 按实际叶 owner 更新侧栏，Shell 不改控制组。settings 不重导入运行态，reset 为显式清理恢复；未新增任意外部导入功能。
- 当前发送模型：编码与换行按目标组读取；底部输入框保存自身 `mode`/`appendCrLf`，快捷指令各自保存 `mode`/`appendCrLf`。所有入口最终调用 `sendSerialRequest()` / `serial-write`，发送链与自动触发去重按组隔离，成功 Text 发送只滚动目标组主终端。
- 当前搜索模型：渲染层扫描活动 xterm buffer 并维护匹配数组；`search-history.js` 管理查询及正则/大小写/整词选项、置顶、删除和 0-200 条上限。大 scrollback 的同步扫描仍是待优化项。
- 当前外观能力：终端支持 PNG/JPEG/WebP 壁纸和 0-100% 暗色遮罩；Windows 主窗口、设置窗口和更新进度窗口使用统一自绘标题栏配色。
- 当前图表能力：三级文本解析、Worker 过载保护、原始数据保留与降采样趋势、主图/时间轴交互、CSV 导出和配置恢复均已落地；不恢复跨重启数据点。
- 当前测试入口：`npm test` 通过 `scripts/run-tests.js` 运行根项目 Node 测试并继续运行 `telemetry-server` 测试。串口、长时间性能、Linux 打包和桌面交互仍需人工验证。
- 文档职责：`README.md` 面向用户；本文记录维护不变量；`ToDo.md` 是全局未完成项；Hex/图表计划文档记录设计基线和专项验证。

---

## 1. 项目概述

- 项目名：`SerialTerminal`
- 类型：基于 Electron 的桌面串口终端工具
- 目标场景：嵌入式开发、串口调试、设备联调、日志查看、关键字过滤、自动发送与快捷发送
- 运行平台：Windows / Linux
- 当前主界面形态：可折叠左右侧栏 + 支持嵌套双轴的 Split/Stack 工作区 + 发送输入框 + 主/过滤/图表/Shell 标签；串口业务归属与几何位置分离。

项目核心能力：
- 串口连接和参数配置
- 基于 xterm.js 的终端显示
- 主终端搜索和过滤标签页
- 自动发送 / 快捷发送
- 实时图表解析、趋势查看与 CSV 导出
- 日志记录与配置持久化
- 多语言支持
- 设置窗口与在线更新
- 设置-高亮页提供“恢复默认高亮”，仅重置高亮规则列表，保存后写入默认高亮配置，不影响其它设置；`README.md` 已同步说明。
- `README.md` 已按当前功能补充实时图表标签页、快捷发送分组、选区快捷搜索、标签重命名、字体字重/高亮颜色、按日期日志、自动清理和活动终端手动导出说明；后续相关行为变化需同步维护。
- 项目开源协议为 MIT；`LICENSE`、`package.json`、`package-lock.json` 和 `README.md` 应保持一致。
- 底部发送框历史导航需同步 `mainInputDrafts[entry.mode]`，避免上/下方向键切到历史内容后又被当前草稿覆盖。
- 底部发送框 meta 行中长度/校验提示应优先保留宽度；“上一条发送”提示右对齐并让位，窄屏再恢复左对齐换行。
- 底部发送框发送历史持久化到 `mainInputHistory`；设置项 `mainInputSettings.historyLimit` 默认 20，范围 0-200，新增历史时去重后追加，超限删除最老条目。历史下拉只替换输入框内容，不立即发送。
- 快捷键配置保存于 `shortcuts`，默认包括 `Ctrl+Enter` 发送、`Alt+H` 历史菜单、`Alt+Up/Down` 历史导航、`Ctrl+F` 搜索、`Ctrl+L` 清空当前终端、`Ctrl+R` 刷新串口、`Ctrl+Shift+D` 连接/断开；设置窗口“快捷键”页可修改或恢复默认。
- `Ctrl+F`/搜索快捷键优先使用当前活动终端的选中文本填充搜索框并立即搜索；无选区时只聚焦搜索框。
- `Ctrl+F`/自定义搜索快捷键触发 `focusSearchWithActiveSelection()` 时必须先展开左侧边栏，再切换搜索页；展开状态按现有 `sidebarCollapsed` 规则持久化。
- 应用级快捷键监听不能跳过 `.xterm` 内部事件；否则 Log 终端获得焦点并选中文本后，`Ctrl+F`/自定义搜索快捷键不会进入 `focusSearchWithActiveSelection()`。未匹配应用快捷键的按键仍交由 xterm 自定义处理器处理。
- 主 Log、过滤 Log 和 Shell 的所有 xterm 实例必须通过 `enableTerminalUnicode11()` 加载 `TerminalUnicodeWidthAddon`；该 provider 以 `@xterm/addon-unicode11` 为基线，并将 `Extended_Pictographic` 与已确认的圆形/平方运算符图标族提升为双宽。终端字体栈统一由 `TERMINAL_FONT_FAMILY()` 补充系统 emoji 字体，避免图标字形被裁切。
- Shell 标签页的文本模式只保存在对应的 tab state 中，不得写入配置；文本模式开启时必须阻止 xterm 鼠标报告发送到 PTY，并在标签上显示状态提示，便于使用终端文本选择复制内容。
- 底部发送框普通 `ArrowUp/ArrowDown` 在多行内容中先保留 textarea 光标移动；只有光标位于第一行/最后一行时才切换历史。带修饰键的历史快捷键仍由全局快捷键处理。
- 快捷发送条目的编辑/删除动作按钮位于主快捷发送按钮左侧，悬浮/动作按钮聚焦/编辑态显示，竖向排列且删除在上、编辑在下；主快捷发送按钮点击后不应因焦点停留而持续显示动作按钮。
- 快捷发送支持每条指令独立的 `mode`、`appendCrLf` 与 `autoTrigger` 设置（`enabled`、`text`、`useRegex`、`caseSensitive`、`wholeWord`）；RX 原始字节按当前接收编码解码并匹配最近窗口，命中后按该快捷指令自身的发送配置发送，同一指令发送未完成时不重复排队，并让对应按钮绿色慢速闪烁一次。
- 快捷指令编辑窗口保留 `.app-dialog` modal 外壳，内部字段统一使用首选项窗口同款 `.form-group` 表单结构；不要再新增 `.app-dialog-field` 这类并行表单控件体系。
- 波特率、数据位、停止位和校验位控件变更时需立即保存 `lastSerialOptions`，避免后续配置回填把未连接时选择的新串口参数覆盖成旧值。自定义波特率必须经 `baud-rates.js` 校验为正安全整数，确认后加入顶层 `customBaudRates` 并永久显示在下拉菜单；标准值、重复值、非法值及取消输入不得加入。串口已连接时切换或确认波特率应先走 `disconnectSerial()`，等待 `serial-disconnected` 事件完成后再复用手动连接路径按当前 UI 参数重连，避免旧断开事件覆盖新连接状态。
- `scrollToBottomOnSend` 默认 true，只在发送成功且为 Text 模式时把主终端滚动到底部；该行为位于 `sendSerialRequest()` 成功分支，不改变 Hex 发送、终端逐键输入和接收路径的滚动表现。
- 所有提交信息必须沿用近期提交格式：主题行为“emoji + type(scope): 中文摘要”，主题行后空一行，正文使用 `1.`、`2.`、`3.` 编号逐条说明主要改动，不得只提交主题行。修复示例：`🐛 fix(shortcuts): 修复 Log 选中文本快捷搜索`；功能示例：`✨ feat(ui): 添加可配置快捷键`。正文应覆盖实现行为、兼容性影响、测试或文档更新等实际改动。

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
- `node-pty`：Shell 标签页的独立系统终端会话

### 2.3 打包相关
- `electron-builder`
- `@electron/rebuild`

---

## 3. 目录结构与文件职责

```text
SerialTerminal/
├─ assets/                     图标、截图和菜单图标
├─ docs/                       设计、待办与维护文档
├─ scripts/                    测试、发布、镜像和 native 准备脚本
├─ src/                        模块源码，按功能域分层
│  ├─ chart/                   图表解析、数据模型、绘图与 CSV 导出
│  ├─ common/                  配置归一化、i18n 与 locales、遥测、搜索历史
│  ├─ log/                     日志目录命名与清理
│  ├─ serial/                  串口编解码、分组模型、标签栏与运行时
│  ├─ shell/                   Shell Profile 与 ConPTY 鼠标兼容
│  ├─ terminal/                终端缓冲区、宽度、搜索状态与 Hex 格式化
│  └─ workspace/               标签树模型、布局序列化与工作区投影
├─ test/                       Node 自动化测试与 Python 串口联调脚本
├─ telemetry-server/           匿名活跃统计与动态更新 manifest 服务
├─ index.html                  主窗口 HTML
├─ renderer.js                 主窗口渲染与业务编排
├─ main.js                     窗口、配置、串口、日志、更新和 Shell PTY
├─ preferences.html/js         设置窗口
├─ update-progress.html/js     更新下载进度窗口
├─ material-icons.js           图标字形注入
├─ window-titlebar.js          自绘标题栏
├─ style.css                   全局样式
├─ README.md                   对外项目说明
└─ docs/agent_notes.md         本文档

### 3.1 主文件说明

#### `main.js`
负责：
- 创建主窗口与设置窗口
- 读取/写入用户配置 `config.json`
- 串口连接、原始字节收发、统一发送校验、日志缓冲
- 主日志与各 tab 独立日志缓冲、文件名生成、落盘与 auto-flush
- 可选 RX-only 原始二进制日志缓冲（`rawBinaryBuffers`），与显示日志分离
- ANSI 颜色码剥离（可配置）
- 向渲染进程发送串口输出、错误、吞吐量数据
- 自动更新逻辑
- 启动时自动检查更新与用户确认安装逻辑
- Windows 新版客户端优先检查动态 manifest，失败时按 Gitee、COS、GitHub Release 顺序回退；动态检查成功后外部来源仅作为同版本、同 EXE SHA-512 的下载备份。Linux 直接使用 GitHub `latest-linux.yml`。所有元数据请求限制为 5 秒和 512 KiB，稳定渠道拒绝预发布版本；更新提示仍通过 Gitee Release API 读取对应 tag 的正文
- 更新弹窗文案跟随当前界面语言显示
- 系统 shell 会话的创建、输入、resize、关闭与退出事件转发
- shellProfiles 配置管理、profile 查找与 shell 路径/参数解析
- "管理配置文件…"按钮发送 `open-prefs` 消息打开设置窗口
- shellProfiles 可通过设置窗口的"Shell Profiles"标签页进行 CRUD 管理
- 每个 profile 支持"浏览"按钮选择可执行文件
- `open-log-folder` IPC：在资源管理器中打开日志目录（自动创建）
- 设置窗口默认大小：750×650
- 设置窗口使用主窗口作为 parent，但不使用 `modal: true`；Windows 下模态子窗口关闭会重新启用父窗口，容易导致主窗口 UI 整体闪烁
- 左侧边栏可通过 `sidebarCollapsed` 持久化为 48px 窄工具栏；顶部 RX/TX 速率复用 `updateThroughputPanel()` 数据，底部按钮转发现有连接、清空日志、设置、输入栏和 Shell 栏按钮行为，不要复制对应业务逻辑。折叠状态切换后需调用 `fitWorkspaceTerminals()`
- 全仓库审查后的已确认问题、优化顺序和验收标准集中记录在根目录 `ToDo.md`；实施完成后应同步勾选对应条目并更新本文档中的架构约定
- P0 优化已落地：Shell tab 保存 `sessionCreateTimer`/`closed` 防止快速关闭后创建孤儿 PTY；主窗口 `save-config` 只合并落盘，不再把完整配置回广播给自身，首选项 `save-config-request` 仍广播；过滤条件输入按 250ms debounce 持久化
- 生产更新依赖使用 `electron-updater ^6.8.9`、`builder-util-runtime 9.7.0` 和 `js-yaml ^5.2.3`；使用官方 registry 执行 `npm audit --omit=dev` 应保持 0 High/Critical
- 主按钮、快捷键、右键菜单和窄工具栏清空动作统一按活动/目标 `tabId` 调用 `clearTerminalByTabId()`，Shell 标签不得回退清空主终端；展开侧栏的 `clear-all-logs-btn` 调用 `clearAllLogTabs()`，固定清空主终端与全部过滤标签，只有 `clearAllLogsIncludesShell` 开启时才清空全部 Shell 标签；该设置默认关闭，图表页始终跳过且不修改磁盘日志
- `fitWorkspaceTerminals()` 使用单一 `requestAnimationFrame` 合并请求，Shell 仅在 cols/rows 变化时发送 resize；pane `flex-basis` 和 sidebar `width` 过渡结束后均需触发 fit
- Text 发送校验与最终发送均复用 `buildSerialWriteBuffer()`；ASCII/GBK 对无法表示的字符返回 `UNREPRESENTABLE_CHARACTER`，不得静默替换为 `?`。`parseHexInput()` 在扫描/累计超过 `maxBytes` 时应提前失败，避免超大输入构造完整副本
- `npm test` 通过 `scripts/run-tests.js` 执行根项目 Node 测试与 `telemetry-server` 测试；codec、formatter、图表、搜索历史、日志、工作区、i18n、发布链路等行为变化必须同步相关测试
- Shell profile 参数在设置窗口中逐项编辑并始终以 argv 字符串数组保存；不得通过空格 join/split 往返转换
- 配置版本为 13；历史配置统一由 `normalizeConfig()` 迁移并在变化后写回。Shell profile 和 Shell 快捷指令使用稳定 `id`；主输入与串口快捷指令发送模型、搜索历史、图表、壁纸和遥测字段均以当前 schema 为准
- 右侧 Shell 侧边栏不再维护活跃会话副列表；`shellQuickCommands` 独立保存 `id`、`label`、`command`、`appendEnter`。点击快捷指令只能向 `getActiveTabInfo()` 指向且 `sessionReady` 的 Shell 标签发送 `shell-tab-input`，不得回退发送到其他 Shell 或串口
- 字体大小、scrollback、历史缓冲、滚轮行数、输入历史上限、Hex 空闲刷新和日志自动刷盘大小统一通过 `config-values.js` 的整数范围规则校验；主进程和设置窗口不得各自维护不同 clamp 逻辑
- 工作区布局通过 `workspace-manager.js` 的 `normalizeWorkspaceLayoutShape()` 全局去重 tab ID；DOM 可渲染检查必须在目标 pane 内同时找到 tab 按钮和内容。任一 pane 变空时自动关闭分屏，若唯一非空的是 `pane-2`，需按原顺序整体迁移到 `pane-1` 并保持活动标签和 pane 内 index 不变
- 开发、测试和打包使用 Node.js `>=22.12.0`，与当前 electron-builder 间接依赖的 engine 要求一致；CI 固定 Node 22.12
- `.github/workflows/checks.yml` 在 push/PR 上执行 `npm ci --ignore-scripts`、`npm test`、全仓库 JavaScript 语法检查和官方 registry 生产依赖审计；简中 i18n 必须覆盖英语基线键，其他语言允许回退英语
- `.github/workflows/release.yml` 仅响应 `v*` tag；Windows/Linux 使用同一 Node 22.12、官方 registry lockfile、`npm ci --ignore-scripts`、显式 `npm run rebuild` 和打包命令，并检查构建不修改 lockfile
- Windows 客户端自动更新先请求 `https://trigger-cn.top/serialterminal/latest.yml`，仅该请求附带客户端版本和 `stable` 渠道；服务端按数据库策略返回规范化 manifest。动态入口失败时按 Gitee、腾讯云 COS、GitHub 回退，并且只有版本、目标安装包类型和 SHA-512 与选定版本一致的来源可参与下载；`DebUpdater` 校验 `.deb`，其他 Linux updater 校验 `.AppImage`，Windows 校验 `.exe`。Linux 客户端直接使用 GitHub `latest-linux.yml`。COS 和 Gitee 均保存 Windows 自动更新必需的 `.exe`、`.exe.blockmap` 和 `latest.yml`，Linux 产物只保留在 GitHub Release。严格 SemVer 预发布 Tag 不得覆盖 COS `releases/latest/`，稳定客户端也必须拒绝预发布 manifest。GitHub Actions 先上传 draft Release，再由 COS 脚本从原始元数据在内存中生成 COS URL，仅发布和验证 `releases/<tag>/` 版本化对象，严禁修改 `dist/latest.yml`；随后按大小和 SHA-512 校验全部 GitHub 资产并发布 draft，稳定版此时成为 GitHub latest。GitHub、COS、Gitee 的同 Tag 资产不可覆盖，重试只能复用完全一致的对象或附件。之后工作流同步 main/Tag 到 Gitee并最多轮询 15 分钟，等待 Gitee Tag 流水线完成；该流水线运行 `scripts/mirror-github-release-to-gitee.js`，`.exe`、`.exe.blockmap` 和 `latest.yml` 三类资产一律优先从 COS 版本化对象下载、失败才回退 GitHub（Gitee 运行器对 github.com release 资产地址经常不可达，元数据若只挂 GitHub 会在取不到元数据时直接失败退出，连安装包的 COS 备用源都走不到），每个来源首次请求后按 `2s/5s/10s` 再重试三次；元数据在各镜像的 URL 形式不同、字节大小必然不同，因此不按 expectedSize 校验，镜像前后仍由 `verifyUpdateArtifacts()` 按元数据版本、文件大小和 SHA-512 校验 EXE。Gitee 已存在附件使用无令牌下载并手动跟随最多三次重定向，只允许 `gitee.com` 及其子域名。Gitee 流水线需单独配置加密变量 `CI_GITEE_ACCESS_TOKEN`，调用脚本时映射为 `GITEE_ACCESS_TOKEN`，发布后主工作流重新下载 Gitee manifest、EXE 和 blockmap 做公开验证。Gitee 当前忽略 Range 请求，因此客户端在 Gitee 源直接下载完整 EXE，COS/GitHub 仍可使用差分更新。只有 GitHub、COS 版本化对象和 Gitee 全部验证成功后，稳定 Tag 才通过独立 `--promote-latest` 将 COS 版本化元数据提升到 `releases/latest/` 并回读验证；预发布永不切换稳定 latest。最后 `--prune-only` 分别保留最新三个稳定和三个预发布前缀，并保护当前稳定 latest 引用的版本；COS CAM 身份需具备 `cos:GetBucket` 和批量删除对象权限。
- GitHub Release 资产哈希必须等待响应流完整读取后再中止清理用的 `AbortController`；`hashGitHubAsset()` 调用 `hashResponse()` 时需使用 `await`，避免大文件校验提前报 `This operation was aborted`。若正式发布在资产上传后失败，使用 `.github/workflows/recover-release.yml` 并传入原 Tag 与失败 Release run ID；恢复工作流会校验 run 名称、事件、Tag、提交和失败状态，复用原构建产物，从公开 COS 校验、GitHub draft 提升、Gitee 同步及 COS latest 提升继续，不移动 Tag、不重建或覆盖版本化资产。
- `v0.3.7` 将更新源固定为 `https://trigger-cn.top/serialterminal/`；无版本/渠道头的请求由 telemetry 服务中的唯一 legacy 策略处理。部署脚本会清空旧静态兼容 snippet，不能再并存另一条 `/serialterminal/latest.yml` location。
- Release 的 Windows native rebuild 固定使用 `windows-2022`、MSBuild 和 VS developer environment，避免旧版 Electron node-gyp 无法识别 VS 18；构建矩阵必须传 `--publish never`，产物统一交由独立 publish job 上传 GitHub Release
- Release artifact 必须使用安装包白名单，仅上传 Windows `.exe`/`.blockmap`/`latest.yml` 与 Linux `.AppImage`/`.deb`/`latest-linux.yml`；禁止使用 `dist/**`，避免把 unpacked 目录和 native build 中间文件发布到 GitHub
- Windows NSIS `artifactName` 固定为 `${productName}-Setup-${version}.${ext}`，GitHub Release、镜像和 `latest.yml` 均不得出现空格或由 GitHub 转义成点号的安装包文件名
- GitHub Actions 的 checkout/setup-node 使用 v6；GitHub Release action 必须固定到经核对的 `softprops/action-gh-release` commit SHA，不能改回可移动的主版本 Tag
- 主终端 tab 不使用 inline `onclick`；所有主工作区 tab 切换统一由 renderer 绑定并调用 workspace manager，避免重复事件和持久化
- 窄侧边栏采用顶部吞吐区、中间 `.sidebar-tool-scroll` 可滚动操作区和底部固定展开按钮；新增工具按钮必须放入中间区，不能挤出展开入口
- sidebar/footer 和 workspace tab 的主要操作使用原生 button；tab 需保持 `role=tab`、`aria-controls`、`aria-selected` 与对应 tabpanel 同步，确保 Enter/Space 和焦点提示可用
- 过滤标签页提供区分大小写、全字和正则三个匹配开关；三个状态均需随 `filterTabs` 持久化，并与终端右键菜单保持同步
- 未启用全标签页日志时，每次串口连接使用独立的主日志会话；断开通知后由 renderer 刷新尾部数据并发送 `flush-tab-logs`，主进程随后清空 `mainLogFilePath`，切换到全标签页日志时也需结束主日志会话；写入失败时保留路径以便重试
- 左侧手动保存按钮导出当前活动 pane 的活动标签页 xterm 缓冲区，通过系统另存为对话框选择路径和文件名，默认名称包含标签名与日期时间并使用 UTF-8；成功保存后以独立的 `manualExportDirectory` 记住目录，取消或失败不更新；该流程不得读取或修改自动日志配置
- 过滤标签页和 Shell 标签页支持双击标签通过统一弹窗自定义标题；标题写入对应 tab 配置，清空后恢复默认标题，日志文件标签名和手动导出名称使用自定义标题
- 图表标签页可在任一 pane 创建、关闭、重命名、拖动和恢复；解析、数据模型、时间轴、导出及资源释放规则详见 `CHART_TAB_IMPLEMENTATION_PLAN.md` 顶部状态区
- 搜索历史保存查询及三类搜索选项，支持置顶和删除；置顶项可超过普通历史上限，相关纯逻辑集中在 `search-history.js`
- 终端壁纸通过 `terminalWallpaper.path` 与 `overlayOpacity` 保存；渲染前验证本地文件存在，加载失败或路径无效时保持纯色背景

#### `renderer.js`
负责：
- 主终端、过滤 tab、Shell tab 和图表 tab 的创建、恢复、激活及销毁编排
- 原始 RX 字节的 Text 流式解码或 Hex 流式格式化与批量渲染
- 过滤、搜索、搜索历史、主输入框、快捷发送、自动发送和吞吐量 UI
- 图表文本流 fan-out、Worker 解析结果接收、数据模型更新和 CSV 导出
- 主终端 / 过滤 tab / Shell tab 的独立日志采集与关闭时 flush；Shell 自动日志仅在 `saveShellTabsLogToFiles` 开启时进入标签页日志缓冲
- Text/Hex 双草稿、结构化发送历史、严格 Hex 实时校验
- 右侧 Shell 侧边栏、动态 profile 和会话列表管理
- 多语言在主窗口中的应用及终端壁纸加载
- `renderer.js` 仍是高耦合核心；新增纯逻辑应优先拆到可测试模块，而不是继续扩大该文件

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
- About 页 QQ 群二维码展示（`assets/Snipaste_2026-07-24_16-14-14.png`），用于问题反馈和需求建议
- Shell Profiles 标签页的 CRUD 编辑界面
- 日志文件名格式（含扩展名）配置，不再单独设置后缀
- Hex dump 设置和 RX 原始 `.bin` 日志设置的回填、归一化与保存

#### 图表模块
- `serial-text-stream.js`：按图表页编码独立流式解码 RX 字节并生成文本记录，不依赖主终端显示模式
- `chart-parser.js`：自动键值、格式模板、正则解析、字段发现和单位换算
- `chart-parser-worker.js` / 客户端：批量解析、队列边界、超时与过载恢复
- `chart-data-model.js`：原始点保留、裁剪、统计、查询及降采样历史
- `chart-view.js`：uPlot 主图、完整时间轴、视口平移/缩放和实时跟随；锁定实时后只采纳滑动窗口比例、始终钉在最新数据边缘
- `chart-csv.js`：导出当前窗口或全部保留原始数据

#### `search-history.js`
- 以查询文本及 Regex/大小写/整词选项组成搜索身份
- 归一化稳定 ID、时间和置顶状态，合并重复项
- 普通条目按上限淘汰，置顶条目保留；提供置顶、取消置顶和删除操作

#### `serial-codec.js`
负责：
- `parseHexInput()` 严格解析 Hex，支持连续输入、空白/逗号/冒号/连字符分隔和两位 `0xNN` token
- 返回结构化错误 code、位置/token、标准化大写文本和字节数
- `buildSerialWriteBuffer()` 统一处理 Text/Hex、Text 编码、终端 Enter 换行和追加 `0D 0A`
- 默认单次载荷上限为 1 MiB；调用方可传入更小上限

#### `hex-formatter.js`
负责：
- `HexStreamFormatter` 将任意串口 chunk 视为连续字节流，不把 `data` 事件边界当作帧边界
- 按 8/16/24/32 字节成行，维护累计偏移与残余字节
- 空闲超时刷新残余行，支持 flush/reset/configure/dispose
- `formatHexLine()` 生成 `{ offset, bytes, hexText, asciiText, output }`；ASCII 可打印范围为 `0x20..0x7E`

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

## 5. 当前配置模型（用户目录 `config.json`）

配置由 `main.js -> loadConfig()` 提供默认值，`normalizeConfig()` 按 schema v14 归一化和迁移，`saveConfig()` 合并写回。不要复制整份默认配置到文档；字段增加或语义变化时，应同时更新默认值、归一化、设置窗口、测试和本节。

### 5.1 主要配置分组

- 外观：`fontSize`、`fontWeight`、字体、前景/背景色、`highlightColors`、`highlightRules`、`terminalWallpaper`。
- 终端：`showTimestamp`、`showLineNumbers`、`scrollbackLimit`、`historyBufferSize`、`mouseWheelScrollLines`、`scrollToBottomOnSend`（默认 true，控制发送文本内容后是否自动滚动到底部）。
- 串口：`lastSerialOptions` 保存端口、当前物理参数、RX 模式/编码、TX Text 编码和终端换行模式；`customBaudRates` 保存可复用的自定义正整数波特率字符串列表。
- 底部输入：`mainInputSettings` 保存可见、Enter 发送、Text/Hex 模式、追加 CRLF 和历史上限；`mainInputHistory` 仅保存 `{ mode, content }`。
- 搜索：`searchSettings.historyLimit` 默认 20、范围 0-200；`searchHistory` 保存查询、三个选项、置顶和时间元数据。
- 快捷发送：`quickSendList` 每项保存稳定 ID、分组、`mode`、`appendCrLf`、内容、窄侧栏入口和自动触发；分组与两个侧栏顺序分别持久化。
- 自动发送：`autoSendSettings` 仅保存 enabled、interval、content；当前自动发送固定为 Text。
- 标签与工作区：`filterTabs`、`shellTabs`、`chartTabs` 与 `workspaceLayout` 分别保存 tab 配置和 pane 布局。
- 日志：普通/全部串口 tab/Shell tab/Raw 开关、独立前缀、缓存阈值、目录、日期子目录、保留天数、文件名、编码和手动导出目录；`saveShellTabsLogToFiles` 默认关闭且仅在全部 tab 日志开启时生效。
- Shell：`shellProfiles` 使用稳定 ID 和 argv 数组，`defaultShellProfileId` 精确引用默认项。
- 清理范围：`clearAllLogsIncludesShell` 控制“一键清空所有 Log 标签页”是否同步清空 Shell，默认关闭。
- 应用状态：窗口大小、侧边栏状态、快捷键、欢迎/更新提示版本和跳过版本。
- 遥测：开关、随机安装 ID、上次成功上报日期与版本。

### 5.2 关键当前结构

```json
{
  "configVersion": 15,
  "serialGroups": [
    {
      "id": "default",
      "title": "COM6",
      "portPath": "COM6",
      "status": "disconnected",
      "sessionId": null,
      "serialOptions": {
        "baudRate": "921600",
        "dataBits": "8",
        "stopBits": "1",
        "parity": "none",
        "receiveDisplayMode": "text",
        "receiveEncoding": "utf8",
        "sendEncoding": "utf8",
        "newlineMode": "crlf"
      },
      "filterTabs": [],
      "chartTabs": [],
      "workspaceLayout": null
    }
  ],
  "customBaudRates": ["250000"],
  "clearAllLogsIncludesShell": false,
  "saveAllTabsLogToFiles": false,
  "saveShellTabsLogToFiles": false,
  "terminalWallpaper": { "path": "", "overlayOpacity": 55 },
  "lastSerialOptions": {
    "receiveDisplayMode": "text",
    "receiveEncoding": "utf8",
    "sendEncoding": "utf8",
    "newlineMode": "crlf"
  },
  "mainInputSettings": {
    "visible": true,
    "sendOnEnter": true,
    "mode": "text",
    "appendCrLf": false,
    "historyLimit": 20
  },
  "searchSettings": { "historyLimit": 20 },
  "mainInputHistory": [],
  "searchHistory": [],
  "filterTabs": [],
  "shellTabs": [],
  "chartTabs": [],
  "workspaceLayout": {
    "splitEnabled": false,
    "orientation": "horizontal",
    "activePaneId": "pane-1",
    "paneSizes": { "pane-1": 0.5, "pane-2": 0.5 },
    "panes": [
      { "id": "pane-1", "activeTabId": "tab-main", "tabIds": ["tab-main"] },
      { "id": "pane-2", "activeTabId": null, "tabIds": [] }
    ]
  }
}
```

### 5.3 配置约束

- `logFileSuffix` 是废弃兼容字段，不再决定最终日志文件名。
- `workspaceLayout` 只描述 pane 和 tab 归属；各标签自身配置保存在对应数组中。
- 图表、过滤和 Shell 只恢复 UI/配置状态；Shell 进程重新创建，图表数据点不跨重启恢复。
- 主输入模式和追加选项不属于 `lastSerialOptions`；快捷指令也不继承底部输入框模式。
- 配置字段的数值范围统一从 `config-values.js` 读取；主进程与设置窗口不能维护不同 clamp。
- 配置版本只是迁移标记，不等于应用发布版本。

---

## 6. 主窗口功能结构

### 6.1 左侧侧边栏
分为三块：
1. 串口连接区（连接/断开按钮 + 波特率选择 + 清除日志按钮 + 打开日志文件夹按钮）
2. 侧边栏 tab（设置 / 搜索 / 发送）
3. 底部设置与输入框显示按钮
4. 已移除串口连接状态指示（原状态圆点+文字）

其中“发送”标签页内的快捷发送列表支持用户拖动排序，调整顺序后会按当前顺序持久化保存。

### 6.2 主区域
- 主工作区 `workspace-root`
- pane-1 / pane-2 双 pane 容器（首版最多 2 个 pane）
- 主终端标签页 `tab-main`
- 多个过滤标签页 `tab-filter-*`
- 系统终端标签页 `tab-shell-*`
- 实时图表标签页 `tab-chart-*`
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
- 每个 pane 的 header 也提供新建图表入口；过滤、图表和 Shell 可拖动排序或跨 pane 移动
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
- 可选“末尾追加 CRLF / 0D 0A”
  - Text 发送追加 `\r\n`，Hex 发送追加真实字节 `0D 0A`
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
    "id": "tab-filter-1",
    "filterText": "error",
    "caseSensitive": false,
    "useRegex": false,
    "paneId": "pane-2"
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

## 8. 串口收发实现原理（config v14 / 原始字节架构）

### 8.1 主进程接收流程
`main.js`
1. `connect-serial` 创建 `SerialPort`
2. `port.on('data')` 保留 Node `Buffer`，以 `data.length` 统计 RX 吞吐量
3. 若启用 raw 日志，`bufferRawSerialBytes(data)` 复制并缓冲原始 RX 字节
4. 通过 `serial-output-bytes` 发送 `Uint8Array` 和 `receivedAt`；主进程不再按显示模式解码
5. 主窗口销毁和过期 port 回调均有保护

### 8.2 主进程发送流程
`renderer.js -> sendSerialRequest() -> ipcRenderer.invoke('serial-write') -> main.js -> writeSerialPayload()`
- 渲染层先校验并串行化写请求；主进程再次调用 `buildSerialWriteBuffer()` 做最终校验
- Text 使用 UTF-8/ASCII/GBK 编码；终端 Enter 根据 `newlineMode` 变为 CR/LF/CRLF
- Text 发送最终只在 `serial-codec.js` 中通过 `iconv.encode(content, sendEncoding)` 转为 Buffer；主进程直接 `port.write()`，不会再次字符串转码。若对端文本显示乱码，优先让对端切 Hex 对照实际字节并确认其显示编码与 TX 编码一致，例如 `中文` UTF-8 为 `E4 B8 AD E6 96 87`，GBK 为 `D6 D0 CE C4`
- Hex 使用严格 parser 生成实际字节，不把输入字符串作为待发数据
- `appendCrLf` 对 Text/Hex 整段消息发送都追加真实 `0D 0A`，即使内容已以该字节序列结尾也会再次追加；主终端 Text 逐键输入不应用该选项，Enter 只服从 `newlineMode`
- `SerialPort.write()` 回调成功后返回 `{ ok: true, bytesWritten }`，TX 吞吐量按最终 Buffer 长度统计；当前不调用 `drain()`
- `serial-write` 是当前唯一串口写 IPC；新增入口必须复用 `sendSerialRequest()`，不得恢复旧 `serial-input` 分支

### 8.3 渲染进程显示流程
`renderer.js`
- `ipcRenderer.on('serial-output-bytes')` 接收字节
- RX Text：`iconv.getDecoder()` 流式解码，再经 `SerialDataParser`、时间戳/行号和高亮链路
- RX Hex：`HexStreamFormatter.push()` 生成格式化行，绕过文本换行 parser；每个 Hex dump 行仍调用一次 `getPrefix()`，因此显示终端和文本日志支持与 Text 相同的时间戳/行号，Raw `.bin` 不受影响
- Text/Hex 切换会 flush 旧链路，不重放历史；重连重置 Hex offset，普通清屏 flush pending 但不重置 offset
- 右键“清空并重置 Hex 偏移”同时清屏、清 pending 和 offset

### 8.4 `SerialDataParser` 的作用
- 累积不完整串口文本到 `incomingBuffer`
- 用模块级复用正则 `LINE_DELIMITER_RE`（`g` 标志）从上次扫描位置 `lastIndex` 继续单遍 `exec`，遇到 `\r\n / \r / \n` 再切分成完整行对象；不再每个 flush 重新 `split` 整个增长中的缓冲
- 行对象结构：
```js
{
  text: '实际文本',
  delimiter: '\n' | '\r' | '\r\n' | '',
  prefix: '时间戳/行号前缀'
}
```

### 8.5 模式、输入、过滤与搜索
- `receiveDisplayMode` 与发送入口模式独立；Text 编码分别由 `receiveEncoding` / `sendEncoding` 保存。
- 底部输入框以 `mainInputSettings.mode` 保存 Text/Hex，以 `appendCrLf` 保存追加选项；Text/Hex 草稿仅驻留当前 renderer 会话。
- 快捷指令各自保存 `mode` 和 `appendCrLf`，手动点击和自动触发均使用该指令自身配置。
- 自动发送固定为 Text，只保存 enabled、interval、content；主终端逐键、终端 Enter、右键粘贴和发送选区也固定为 Text。
- 所有串口发送入口最终进入 `sendSerialRequest()` / `serial-write`，主进程再次执行 `buildSerialWriteBuffer()` 最终校验。
- 主输入、快捷发送、粘贴和终端单次上限 1 MiB；自动发送上限 64 KiB、最小间隔 10ms，并以 generation/in-flight 状态防重入。
- 每次连接分配 `serialSessionId`；renderer 队列和主进程写入同时校验，防止旧会话排队数据发往新设备。
- 过滤 tab 固定保存创建时的 `dataMode`，只消费同模式记录；模式不一致显示 paused。Hex 过滤作用于单条格式化行，不支持跨行或字节通配符。
- 搜索由 renderer 扫描活动 xterm buffer 并维护 `{ line, column, length }` 匹配数组；Prev/Next 直接滚动并装饰目标。SearchAddon 仅保留兼容性清理能力，不承担结果计数。
- 搜索历史以 query + Regex/大小写/整词选项去重，支持置顶和删除；默认上限 20，配置范围 0-200。
- 连接、端口切换、写队列和模式切换必须继续遵守 session、generation、decoder/formatter flush 与焦点保护规则。

### 8.6 config v14 与迁移
- `CONFIG_VERSION = 14`；`loadConfig()` 调用 `normalizeConfig()`，类型错误回退默认值，规范化结果变化时写回磁盘。
- 旧 `lastSerialOptions.encoding` 仍迁移为 RX 模式/编码与 TX Text 编码；当前主输入模式和追加选项归属 `mainInputSettings`。
- config v7 之前快捷指令的追加语义会迁移为每条 `appendCrLf`；快捷项补齐稳定 ID、分组、模式、侧栏入口和自动触发。
- Shell profile 缺失或重复 ID 会生成稳定 ID；旧默认名称引用迁移为 `defaultShellProfileId`。
- Shell 快捷指令在 v12 加入 `shellQuickCommands`，补齐稳定 ID，并限制标签、命令和 `appendEnter` 类型；该列表与串口 `quickSendList` 完全独立。
- 旧 100000 默认 scrollback 在 v5 迁移为当前默认 20000；数值字段统一经 `config-values.js` 限制。
- 搜索历史、图表配置、终端壁纸、遥测、日志保留与日期目录等后续字段均由当前归一化逻辑兜底。
- 关闭 Raw 日志或修改日志目录/文件名配置前必须先刷盘；失败时保留设置窗口并提示。
- v13 新增 `clearAllLogsIncludesShell` 与 `saveShellTabsLogToFiles`，均归一化为布尔值且默认关闭；前者控制批量清理 Shell，后者控制 Shell 自动日志。
- v14 新增 `customBaudRates`；使用 `baud-rates.js` 过滤非法、非正整数、重复及标准波特率，并把旧配置中合法的非标准 `lastSerialOptions.baudRate` 自动迁入列表。
- 配置迁移必须向前兼容历史用户文件；修改 schema 时递增版本并补自动化测试。


---

## 9. 日志显示、前缀与高亮原理

### 9.1 前缀生成
`getPrefix()` 负责生成：
- 时间戳（若启用）
- 行号（若启用）

时间戳字符串由 `formatTimestamp()` 生成；`flushSerialOutputQueue()` 在每个刷新批次开始时计算一次并放入 `currentBatchTimestamp`，供本批所有行复用，批次结束重置为 `null`（非批次调用即时生成）。因此同一批次内多行共享同一时间戳。`getLogPrefix()` 同样复用该批次时间戳。

### 9.1A 日志文件命名与多 tab 日志

#### 日志数据来源
- **主终端显示日志**（`tab-main`）：renderer 在 `writeTextLines()` / `writeHexLines()` 中生成与当前显示模式一致的文本，通过 `writeMainTabLog()` → `write-tab-log` 发送到主进程
- **过滤 tab 日志**：renderer 将匹配后的格式化行通过 `writeFilterTabLog()` → `write-tab-log` 发送到主进程
- **Shell tab 日志**：renderer 仍将 shell 输出通过 `writeShellTabLog()` → `write-tab-log` 发送到主进程；仅 `saveAllTabsLogToFiles` 与 `saveShellTabsLogToFiles` 同时开启时才进入独立缓冲
- **通用主日志**：未启用 `saveAllTabsLogToFiles` 时，`main.js::writeTabLog()` 将 `tab-main` 内容转交 `writeLog()`；启用后，主终端与过滤 tab 进入独立条目，Shell 是否进入由独立开关决定
- **RX Raw 日志**：仅 `port.on('data')` 的原始 Buffer 进入 `bufferRawSerialBytes()`，与上述显示日志完全独立
- **发送回显**：`sendSerialRequest()` 成功后由 `renderSentRecord()` 生成一条 TX 记录，同时写入主终端与主终端日志；不经过 `SerialDataParser`、不占用接收行号计数器、不触发快捷指令自动触发

#### 发送回显（Show Sent Data）
- 开关：`echoSentData`（总开关，默认开）、`echoSentDataBothFormats`（文本 + HEX 双表示，默认关）、`echoSentDataInFilterTabs`（过滤标签页也显示，默认开）、`echoSentDataHighlightColor`（整行背景色，默认 `#1e3a5f`）
- 行格式：`[HH:mm:ss.SSS] [TX 12B] 内容`；发送行总是带自己的时间戳，不受 `showTimestamp` / `logIncludeTimestamp` 控制
- 转义：`\r` `\n` `\t` 与其它不可打印字符统一转成可见字面量（如 `\x1b`），避免控制字符被 xterm 当作转义序列执行
- 追加换行：开启 `appendCrLf`（输入框与快捷发送各自的追加换行开关）时，回显文本必须在内容末尾拼上 `\r\n`，否则 header 中的字节数会比可见字符多 2 字节，用户会误以为换行没发出去
- 截断：文本预览最多 512 字符、HEX 预览最多 256 字节，超出后缀 `…`；完整内容仍照常发送到串口
- 整行背景：`hexToAnsiBackground(...)` → 内容 → `\x1b[0m` → 整行 `\r\n`；依赖 xterm `_eraseAttrData()` 用当前背景填充新行，因此不需要 `\x1b[K`，也不会污染下一行
- 仅在实际写入成功后回显；失败时只在状态栏报错
- 格式化逻辑位于纯模块 `sent-record.js`（`formatSentRecord` / `formatSentBody` / `escapeControlChars`），单测在 `test/sent-record.test.js`

#### 过滤标签页“仅显示发送内容”
- 过滤标签页头部新增 `filter-sent-only-btn`，切换 `tab.showSentOnly`；开启后该标签页不再接收串口数据，只显示发送回显，可直接当作发送历史面板
- 开启时 `writeTextLines()` / `writeHexLines()` 在分发阶段跳过该 tab，模式徽标显示 `SENT`，过滤输入框与大小写/整词/正则按钮变半透明且不可交互
- `showSentOnly` 随 `filterTabs` 持久化，并在 `main.js::normalizeConfig()` 中做布尔归一化
- `showSentOnly` 随 `filterTabs` 持久化，并在 `main.js::normalizeConfig()` 中做布尔归一化

#### 左侧设置 tab 的分组结构
- 设置页按方向分为两个 `<section class="settings-section">`，各自带 `<h3 class="settings-section-title">` 标题：`main.receiveSettings`（接收）与 `main.sendSettings`（发送）
- 接收组：接收显示模式与接收编码、显示时间、显示行号
- 发送组：发送编码、发送回显三个开关
- 数据位/停止位/校验位/换行模式跨收发两侧，保持在分组之外单独成行，避免同一配置同时属于两个分组
- 分组样式使用 `.settings-section` / `.settings-section-title`，主题颜色与间距沿用 CSS 变量；原有的 `.settings-group` 保持作为组内细分隔，不新建重复样式
#### 缓冲与落盘机制
- 显示日志经主进程 `writeTabLog()` 统一按 `stripAnsiInLog` 配置处理 SGR 序列，再写入 `logBuffer` 或 `tabLogBuffers`；字节数使用 `Buffer.byteLength()` 统计
- `tabLogBuffers` 的每个条目包含 `{ title, buffer[], filePath, byteCount }`；`logBuffer` 保存未启用全部 tab 日志时的主终端显示日志
- `rawBinaryBuffers` 保存 RX-only Buffer，并用 `rawBinaryByteCount` 按真实字节数计数；达到阈值后由 `flushRawBinaryLogSync()` 追加到 `.bin`
- 各显示日志缓冲达到 `getAutoFlushThreshold()` 后同步追加落盘；5 秒定时器还会静默刷盘所有待处理日志，降低异常退出的丢失窗口
- `ensureMainLogFilePath()`、`ensureTabLogFile()` 和 `ensureRawBinaryLogPath()` 按日志会话延迟创建并缓存路径，后续持续追加，避免产生碎片文件
- `connect-serial` 仅在 `logEnabled` 与 `saveAllTabsLogToFiles` 同时开启时才预注册 `tab-main` 条目；实际文件路径仍在首次写入时创建
- **`logEnabled` 是全部写盘路径的总开关**：`writeTabLog()` 在分流前统一校验它，`saveAllTabLogs()`、`flushPendingLogs()` 与 `flush-tab-log` 也各自校验，因此关闭后不会再有追加写入（包括分标签页与 Shell 日志）
- 关闭 `logEnabled` 时由 `closeLogSessionsForDisabled()` 把已缓冲内容一次性落盘、清空所有缓冲并重置文件路径，避免重新开启时接写到旧文件

#### 日志标题命名
- 日志标题使用固定英文名，不受界面语言切换影响：
  - `Main_Terminal` → 主终端
  - `Filter_1` / `Filter_2` … → 过滤标签页（按 `filterTabs` 数组索引）
  - `Shell_1` / `Shell_2` … → Shell 标签页（按 `shellTabs` 数组索引）
- `buildLogFileName()` 在未使用 `%tab` 时自动在文件名开头追加 tab 标题（空格转下划线）

#### 落盘时机
- 缓冲区达到 `rawBufferAutoFlushMB` 阈值时立即刷盘
- 5 秒定时器：`flushPendingLogs()` 静默刷盘但保留活动 tab 条目
- 串口断开：主进程先 flush RX Raw；renderer 收到 `serial-disconnected` 后发送 `flush-tab-logs`，保存并关闭显示日志条目
- 单个 tab 关闭：renderer 发送 `flush-tab-log`，主进程保存该条目
- 应用退出：`before-quit` 刷盘显示日志与 RX Raw 日志
- 启用 `saveAllTabsLogToFiles` 时，`writeLog()` / `saveLog()` 不重复维护主日志，`tab-main` 由 `tabLogBuffers` 统一处理
- 运行中关闭 `saveShellTabsLogToFiles` 时，主进程先刷盘并关闭已存在的 Shell 日志条目，再阻止后续 Shell 输出进入自动日志；主终端和过滤日志不受影响

#### ANSI 剥离
- `stripAnsi()` 仅剥离 SGR 序列（`\x1b[数字;数字m`），不触碰其他 CSI 命令
- 可通过设置页 `stripAnsiInLog` 选项关闭此行为
- 主进程对所有经 `write-tab-log` 到达的显示日志统一调用；RX Raw `.bin` 不经过字符串处理
- `stripAnsi()` 在字符串不含 `\x1b` 时直接返回，避免对无颜色输出执行正则替换

### 9.1B Hex 显示日志与 RX raw 日志
- 显示日志来自渲染层实际写入终端的内容：Text 保存解码/格式化文本，Hex 保存当前 Hex dump；过滤日志保存命中的格式化行
- `rawBufferAutoFlushMB` 现在作为通用日志缓存刷盘阈值暴露在设置中，默认 10 MB、范围 1-1024 MB；普通主日志、标签页日志和 Raw `.bin` 均达到该字节阈值后写盘，主日志路径在本次日志会话内缓存，避免长时间自动刷盘生成碎片文件
- 日志每 5 秒静默刷盘一次，降低异常退出时的丢失窗口；定时刷盘只 flush 不关闭标签页日志条目，断开/退出/手动 flush 才关闭条目
- 文本日志、标签页日志和 Raw 日志写盘失败会通过 `log-error` 通知 renderer；同一错误去重提示，成功写盘后清除错误状态。若持续失败且缓存已达到阈值，会暂停继续缓存该类日志以保护内存
- `logIncludeTimestamp` / `logIncludeLineNumbers` 是独立日志前缀设置，不依赖终端显示时间戳/行号；renderer 为每个接收行生成一次日志前缀并复用于主日志和过滤日志，避免行号因多处写日志重复递增。Raw `.bin` 不写入这些前缀
- raw 日志是独立路径，仅在 `saveRawSerialToFile` 启用时记录 `port.on('data')` 的 RX Buffer；不包含 TX、连接/断开提示、错误提示或 Hex 文本
- `rawBinaryBuffers` + `rawBinaryByteCount` 达到 `rawBufferAutoFlushMB` 阈值时 `Buffer.concat()` 后同步追加；断开和应用退出也会 flush
- `ensureRawBinaryLogPath()` 在本次连接首次写入时生成并缓存路径，重名时使用 `_2`、`_3`；文件名会清理非法字符并强制 `.bin`
- `rawBinaryFlushError` 保存最近写盘错误。失败时缓冲不会被清空，但当前 UI 不主动展示该错误，这是后续可改进风险
- 显示日志和 raw 日志开关彼此独立；raw 日志不受当前 RX Text/Hex 显示模式影响

### 9.2 高亮逻辑
`applyHighlighting(text, filterRegex, globalMatches)`：
- 先应用全局高亮规则：`highlightRules` 在 `applyConfig()` 时经 `compileHighlightRules()` 预编译为 `compiledHighlightRules`（含 `(?i)`、`caseSensitive`、`useRegex` 处理），逐行只重置 `lastIndex` 后 `exec`，不再逐行逐规则 `new RegExp`
- 再应用过滤命中高亮：`filterRegex` 本身保持无 `g`（供 `tab.filterRegex.test(text)` 做无状态筛选），带 `g` 的副本按对象缓存在 `globalFilterRegexCache` 中复用
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

### 9.7 终端显示写入缓冲上限
- `writeTerminalOutput()` 对每个终端维护待写入缓冲（`terminalWriteStates`），xterm 一次只允许一次 `write` 在途，期间新输出先排队。
- 上限以**回滚行数**（`scrollbackLimit`，默认 20000）为主：未达到该行数前完整排队，超过后才从最旧一端**整行**丢弃，因此长时间高吞吐下不会再因固定字节阈值提前丢内容。
- `TERMINAL_PENDING_OUTPUT_HARD_LIMIT`（32 MB）仅作为极端长行的内存兜底，且至少保留最后一行。
- 丢弃策略位于纯逻辑模块 `terminal-output-buffer.js`（`appendPendingOutput` / `dropOldestLines`），有独立单测 `test/terminal-output-buffer.test.js`。
- 只要有丢弃，下一次实际写入时会在该位置插入一次 `[Display output skipped to limit memory usage]`；日志文件路径不受影响。
- 只要有丢弃，下一次实际写入时会在该位置插入一次 `[Display output skipped to limit memory usage]`；日志文件路径不受影响。
- 写入侧按字节预算分批：`drainTerminalOutput()` 每次仅取 `TERMINAL_WRITE_BATCH_BYTES`（512 KB）内容调一次 `term.write`，剩余部分由 `scheduleTerminalDrain()` 在 `setTimeout(0)` 里继续。xterm 的 WriteBuffer 时间分片只在多个 write 块之间生效，单块解析是同步的，因此必须在这里限流，否则窗口恢复时一次巨型解析会冻结界面。
- 取批函数 `takePendingChunk()` 与丢弃策略同在 `terminal-output-buffer.js`，取批时尽量在行边界处切开。
- 历史实现曾使用固定 2 MB 字节上限，在同一窗口最小化/被遮挡导致刷新暂停的情况下会一次性丢掉约 2 MB 显示内容（曾表现为“丢失 15 分钟日志”），现已按行数上限解决。

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
- 末尾追加由左侧统一发送设置控制，底部不再提供独立开关

### 10.2 主终端需求
- 主终端保留像终端一样的直接输入发送能力
- 在主终端中输入字符应逐键发送，而不是攒到回车整段发送

### 10.3 过滤窗口需求
- 过滤窗口在主界面内作为标签页存在
- 关闭应用后再次打开，应自动恢复之前打开的过滤标签页
- 恢复过滤文本、正则状态、区分大小写状态
- 过滤历史继续保留
- 若启用多 tab 日志保存，过滤标签页输出应写入各自独立日志文件

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

### 10.6A 日志保存需求
- 设置窗口新增"将所有标签页日志保存到文件"开关
- 文件名格式支持 `%tab` 作为标签页标题占位符，可直接在格式中指定扩展名
- 主终端和过滤 tab 可分别保存为独立日志文件；Shell tab 由默认关闭的 `saveShellTabsLogToFiles` 独立控制
- `logFileSuffix` 已废弃，`logFileNameFormat` 现在完整控制输出文件名

- 设置窗口“终端”页提供批量清理是否包含 Shell 的开关，默认关闭；“日志”页提供 Shell 自动日志开关，默认关闭。
### 10.7 多语言需求
输入框相关区域必须多语言适配，包括：
- 输入框 placeholder
- Send 按钮
- “加入快捷发送”按钮
- 上一条发送
- 输入框显示/隐藏按钮
- 按回车发送开关
- 左侧统一发送模式、文本编码和追加 CRLF / 0D 0A 设置
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

### 11.9 多 tab 日志保存的实现注意点
- 多 tab 日志采集应挂在各终端实际写入显示的链路上，避免修改串口主协议链路
- 主终端和过滤 tab 的日志标题取各自当前 tab 标题；Shell 输出只有在 `saveShellTabsLogToFiles` 开启时进入独立日志，用于 `%tab` 文件名替换
- 单个 tab 关闭时要先 flush 再销毁终端，避免缓冲丢失
- 串口断开时要统一 flush 所有 tab 日志，避免只在应用退出时落盘

### 11.10 底部 shell 开关按钮一致性
- 底部左下角 shell 切换按钮应与其他 footer 按钮保持统一尺寸和视觉对齐。
- 修复已将 `#toggle-shell-sidebar.footer-btn` 也纳入与 `#open-prefs.footer-btn`、`#toggle-main-input.footer-btn` 相同的 `32px` 规则，并增加了图标居中对齐。

### 11.11 过滤 tab 恢复后不可用（无输入框、无右键菜单）
- 根因是过滤 tab 的 `id` 没有写入 `config.filterTabs`，导致重启后 `filterTabs` 里缺少 `id` 字段，`workspaceLayout.panes[].tabIds` 引用的 tabId 无法匹配
- 同时 `createFilterTab` 使用自增 `nextFilterTabId` 生成新 ID，与 layout 中保存的旧 ID 不一致
- 修正：
  - `persistFilterTabs()` 现在保存 `id` 字段
  - `createFilterTab()` 恢复时优先使用 `initialState.id`
  - 新增 `syncNextFilterTabId()` 避免恢复后新创建 tab 的 ID 与已恢复 tab 冲突
  - `applyConfig()` 恢复顺序调整为：先创建 filterTabs / shellTabs，再恢复 workspaceLayout
  - 新增 `layoutTabToPaneMap` 和 `paneFilterQueue` / `paneShellQueue`，兼容旧配置中缺少 `id` 的场景

### 11.12 多 tab 日志保存不生效（历史问题）
- 旧实现曾把 `saveAllTabsLogToFiles` 错误绑定到 `logEnabled`，并在断开时遗漏全部 tab 的刷盘。
- 当前实现中 `writeTabLog()` 独立判断两个开关：`tab-main` 可进入通用主日志，全部 tab 日志则进入 `tabLogBuffers`。
- renderer 收到 `serial-disconnected` 后发送 `flush-tab-logs`；主进程据配置调用 `saveAllTabLogs()` 或关闭通用主日志会话，避免遗漏或重复文件。
- 显示日志先在内存中缓冲，达到阈值或定时器触发时同步追加，而不是每条串口数据都直接写磁盘。

### 11.13 多 tab 日志文件名冲突
- 默认 `logFileNameFormat` 不含 `%tab`，多个 tab 同一秒落盘会写入同一文件互相覆盖
- 修正：`buildLogFileName()` 在未使用 `%tab` 时自动在文件名开头追加 tab 标题
- 日志标题使用固定英文名（`Main_Terminal` / `Filter_1` / `Shell_1`），不受界面语言影响
- 文件名中空格自动替换为下划线

### 11.14 日志文件中存在 ANSI 颜色控制码（历史问题）
- renderer 生成的终端内容可能包含 xterm SGR 序列（例如 `\x1b[38;2;...m`）。
- 当前主进程在所有显示日志进入缓冲前统一调用 `stripAnsi()`；该函数只剥离 SGR，且受 `stripAnsiInLog` 配置控制。
- RX Raw `.bin` 不经过字符串转换或 ANSI 处理。

### 11.15 显示日志内容与原始字节混淆（历史问题）
- 旧方案试图让主终端日志直接复用主进程原始串口缓冲，导致显示日志语义、格式化选项和原始字节保存职责混杂。
- 当前显示日志由 renderer 生成：Text 保存解码后的显示行，Hex 保存 Hex dump；`logIncludeTimestamp` / `logIncludeLineNumbers` 控制独立日志前缀。
- 连接、断开和错误提示也可进入显示日志；需要逐字节证据时必须使用独立 RX Raw `.bin`，其不包含 TX 或界面提示。

### 11.16 日志缓冲区无限增长导致内存问题（历史问题）
- 长时间连接下，通用主日志、各 tab 显示日志和 RX Raw 日志都可能持续占用内存。
- 当前三类缓冲均受 `rawBufferAutoFlushMB` 阈值约束：显示日志按 `Buffer.byteLength()` 计数，Raw 按 Buffer 的真实字节数计数。
- 达到阈值会同步追加落盘，5 秒定时器还会调用 `flushPendingLogs()`；持续写盘失败时会停止继续缓存对应日志类型并通知 renderer。

### 11.17 auto-flush 文件碎片化与覆盖问题（历史问题）
- 初版 auto-flush 每次重新生成文件名，且最终保存可能覆盖此前追加的数据。
- 当前主日志、tab 日志和 Raw 日志都在一个日志会话内缓存文件路径，后续统一使用追加写入。
- `connect-serial` 仅预注册 `tab-main` 条目；`ensureTabLogFile()` 在首次实际写入时创建路径。
- `saveAllTabLogs()`、`flush-tab-log` 和定时刷盘复用同一同步 flush 逻辑，避免异步竞态和覆盖。

---

## 12. 关键函数与关注点清单

### `main.js`
- `normalizeConfig()`：config v14 归一化、历史迁移、自定义波特率、串口/Shell 快捷指令、清理/日志范围、搜索、图表、壁纸、遥测及日志字段校验
- `loadConfig()`：配置默认值来源
- `saveConfig()`：配置合并写回
- `bufferRawSerialBytes()` / `flushRawBinaryLogSync()` / `ensureRawBinaryLogPath()`：RX-only Buffer 缓冲、追加刷盘和单连接文件路径
- `writeSerialPayload()`：主进程发送最终校验、`SerialPort.write()` 和真实字节吞吐量统计
- `createWindow()`：主窗口大小恢复与 resize 持久化
- `queueSerialOutput()` / `port.on('data')`：保留原始 RX Buffer、统计吞吐、Raw 缓冲并批量发送 `serial-output-bytes`
- `stripAnsi(str)`：按配置剥离显示日志中的 ANSI SGR 序列；无 `\x1b` 时短路返回
- `formatFileName(format, extra)` / `buildLogFileName(extra)`：格式化日志文件名并处理 `%tab`
- `ensureMainLogFilePath()` / `ensureTabLogFile(tabId)` / `ensureRawBinaryLogPath()`：为三类日志延迟创建并缓存路径
- `flushTabLogEntrySync()` / `saveAllTabLogs()`：追加刷盘并管理各 tab 日志条目
- `writeLog(data)` / `saveLog()`：维护未启用全部 tab 日志时的通用主日志缓冲
- `writeTabLog(tabId, title, data)`：接收 renderer 的显示日志，先校验 `logEnabled` 总开关，再统一处理 ANSI 并分流到通用主日志或 `tabLogBuffers`；Shell 需额外通过 `saveShellTabsLogToFiles` 开关
- `closeShellTabLogSessions()`：关闭 Shell 自动日志时刷盘并移除已有 Shell 日志条目
- `closeLogSessionsForDisabled()`：关闭 `logEnabled` 时刷盘、清空所有日志缓冲并重置文件路径
- `flushPendingLogs()` / `startLogAutoFlushTimer()`：每 5 秒静默刷盘显示日志与 RX Raw 日志；`logEnabled` 关闭时直接返回
- `cleanupSerialConnection()`：清理串口状态并刷盘 RX Raw；显示日志由 renderer 的断开事件处理继续触发 flush
- `ipcMain.handle('connect-serial')`：串口连接入口；仅 `logEnabled` 与全部 tab 日志同时开启时预注册 `tab-main`
- `ipcMain.handle('serial-write')`：唯一串口发送入口
- `ipcMain.on('save-config')`：渲染层配置保存
- `ipcMain.handle('connect-serial')`：串口连接入口，预注册 `tab-main` 条目
- `ipcMain.handle('serial-write')`：唯一串口发送入口
- `ipcMain.on('save-config')`：渲染层配置保存
- `ipcMain.on('write-tab-log')`：接收渲染层 tab 日志写入请求
- `ipcMain.on('flush-tab-log')`：保存单个 tab 日志
- `ipcMain.on('flush-tab-logs')`：保存所有 tab 日志
- `ipcMain.on('show-terminal-context-menu')`：终端右键菜单入口
- `checkForAppUpdates()`：统一的自动/手动检查更新入口
- `promptForAvailableUpdate()`：新版提示与用户选择
- `downloadUpdateWithFallback()`：下载时按已验证的同版本、同校验和来源回退
- `configureUpdateFeed()`：将自定义更新 Provider 指向当前动态入口、Gitee、COS 或 GitHub 元数据地址
- `fetchGiteeReleaseNotes()`：通过 Gitee Release API 拉取版本正文

### `renderer.js`
- `SerialDataParser`：复用 `LINE_DELIMITER_RE` 单遍 `exec` 切分接收文本行
- `formatTimestamp(now)`：生成批次时间戳字符串
- `compileHighlightRules(rules)` / `compiledHighlightRules`：配置变更时预编译全局高亮规则
- `globalFilterRegexCache`：缓存过滤正则的 `g` 副本
- `switchReceiveMode()` / `switchReceiveEncoding()`：flush 旧 RX 链路并切换 Text decoder/Hex formatter
- `writeTextLines()` / `writeHexLines()`：分别写主终端、同模式过滤 tab 和显示日志
- `validateSendContent()` / `formatValidation()`：渲染层实时校验和本地化状态
- `sendSerialRequest()`：所有现代发送入口的串行 IPC 包装；写入成功后调用 `renderSentRecord()` 回显
- `renderSentRecord(record)`：生成发送回显行并写入主终端、主终端日志与（可选）过滤标签页
- `applySentOnlyMode(enabled)`：切换过滤标签页的“仅显示发送内容”状态与徽标
- `formatLineForTerminal()`
- `writeTabLog()` / `writeMainTabLog()` / `writeFilterTabLog()` / `writeShellTabLog()`
- `getMainTabTitle()` / `getFilterTabLogTitle()` / `getShellTabLogTitle()`：生成固定英文日志标题
- `createFilterTab()` / `createShellTab()` / `createChartTab()`
- 对应 close/persist/sync ID 函数：管理三类动态 tab 生命周期、恢复和稳定 ID
- `bindTerminalContextMenu()`
- `handleTerminalContextMenuAction()`
- `getTerminalPlainText()`
- `sendSerialData()`
- `sendMainInputBuffer()`
- `navigateMainInputHistory()`
- `updateAutoSendValidation()` / `runAutoSendTick()`：自动发送校验、断线等待、防重入和失败停止
- `normalizeQuickSendItem()` / `renderQuickSendList()`：快捷项 v2 字段、badge、tooltip 和拖动持久化
- `refreshSearchCount()` / `selectSearchMatch()` / `renderSearchHistory()`：buffer 扫描、定位和历史 UI
- `clearChartDataSession()` / `persistChartTabs()` / `exportChartSamples()`：图表会话、配置和 CSV 导出
- `clearAllLogTabs()`：始终清理主终端和过滤终端，按 `clearAllLogsIncludesShell` 可选清理 Shell
- `applyConfig()`
- `renderCustomBaudRates()` / `restoreBaudRateConfig()` / `confirmCustomBaudRate()`：恢复持久化自定义项，确认有效输入并保存后沿用串口参数重连流程

### 图表与搜索模块
- `serial-text-stream.js`：图表文本记录流
- `chart-parser.js` / `chart-parser-worker*.js`：字段发现与隔离解析
- `chart-data-model.js`：原始样本、统计和降采样
- `chart-view.js`：uPlot 主图与时间轴
- `chart-csv.js`：CSV 生成
- `search-history.js`：搜索历史纯逻辑

### `baud-rates.js`
- 统一维护标准波特率、正安全整数规范化，以及自定义波特率去重和标准项过滤；主进程、renderer 与测试不得各自复制判定规则。

### `serial-codec.js`
- `parseHexInput()`：严格语法、结构化错误、标准化 Hex 和 byte count
- `buildSerialWriteBuffer()`：Text/Hex 统一构造最终 Buffer

### `hex-formatter.js`
- `HexStreamFormatter.push()` / `flush()` / `reset()` / `configure()`：流式成行、残余刷新、偏移和设置生命周期
- `formatHexLine()` / `byteToPrintableAscii()`：Hex/ASCII 列和最终 xterm 行

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

4. 主界面动画与 xterm fit
   - 可用 opacity/transform 做菜单、弹窗和 tab 的轻量过渡；影响终端容器尺寸的动画必须同步考虑 `fitWorkspaceTerminals()`
   - 工作区 pane 的 `flex-basis` 过渡结束后需要补一次终端 fit；拖动 splitter 时复用 `.workspace-root.resizing` 禁用该过渡，避免跟随光标延迟

5. 自动发送和快捷发送属于旧功能区
   - 这些功能保留在左侧“Send”标签页，状态模型独立于下方主输入框
   - 三者均经 `sendSerialRequest()` / `serial-write` 生成最终字节，不得再引入直接 `port.write()` 分支

6. Hex 关键风险与既定决策
   - 串口 `data` chunk 不是协议帧；formatter 必须持续跨 chunk 累积
   - Text 必须使用流式 decoder；禁止逐 Buffer 独立 `toString()` 解码 UTF-8/GBK
   - 禁止用 `Buffer.from(input, 'hex')` 替代严格解析器，否则非法尾部可能被静默截断
   - Raw `.bin` 固定为 RX-only；若未来要混合 RX/TX，必须设计带方向和时间信息的新容器，不能改变现有 raw 文件语义
   - `SerialPort.write()` 回调表示交给底层写缓冲，当前没有 `drain()`；不要把 UI 的“已发送”描述扩展为设备已接收
   - Hex dump 会放大显示数据量；高吞吐、长时间 scrollback 和 raw 同步刷盘仍需实机性能验证
   - 模式切换只影响新数据，普通清屏不重置 offset；修改这些产品决策必须同步 UI、README 和 TODO
   - Shell IPC/输入链路与串口模式完全独立，Hex 改动不得复用到 Shell tab
   - Raw 写盘失败会保留待写 Buffer 并记录 `rawBinaryFlushError`/electron-log；在待写数据成功刷盘前拒绝开始新连接，避免重连覆盖缓冲。当前仍没有独立的用户可见恢复界面

## 13A. 多串口支持（P1 已实现；配置迁移已完成；P2 已完成；P3 全部完成；P4 已完成；P5 已完成）

- 完整设计文档：[`MULTI_SERIAL_DESIGN.md`](MULTI_SERIAL_DESIGN.md)，包含数据模型、主进程多实例、IPC 分流、双层标签栏、设置跟随、两级分屏、配置迁移、分阶段落地与风险清单。
- **当前进度：P1（主进程多实例化）已完成并通过验证；配置 v14 → v15 迁移已完成并实测；P2 已完成（注册表/上下文/行解析器/运行时注册表/DOM 标识契约/终端工厂托管）；P3 已全部完成（四个纯逻辑层 + 渲染层数据面按 groupId 路由 + 分组标签栏 + 容器创建/关闭 + Shell 标签的两层升降）；P4 已完成（四个显示参数下沉 + 侧栏 9 个控件与连接按钮随 activeGroupId 回显与回写）；P5 已全部完成（每分组独立的 pane 结构 + 每分组独立的布局与管理器 + 过滤页/图表页按分组各一份）。** P1–P5 的功能全部落地；剩下的是**验证缺口**而非功能缺口，详见下方「P5：每分组独立的布局与终端 pane」与 `MULTI_SERIAL_DESIGN.md` §11.1。
- P3 标签归属纯逻辑层（`serial-group-tabs.js`，17 项单测）：
  - `buildTabBarModel()` 输出两层内容；三条硬规则：Shell 永不归属分组、group 数 ≥2 双层 / =1 塌回一层、切换分组只换下层集合。抽成纯函数的原因是归属判定错了在浏览器里只能靠肉眼发现。
  - 已固定的非显然行为：`activeGroupId` 不存在退回第一个分组（否则下层整层空掉且无法恢复）；`activeTabId` 失效退回该组第一个标签；重复分组 id 去重（两个相同标签都指向同一 id，点击像没反应）；空标题给 `Serial N`；关闭当前分组优先选**右邻**（总退回第一个会让焦点反复跳回最左）；关闭非当前分组保持当前选择；单分组时 `groupLayer` 只含 Shell且串口标签排在 Shell 之前。
  - **注：`buildTabBarModel()` 本身未被渲染层直接调用。** 它假设「下层是某分组自己的标签列表」，与「每分组一个主终端标签 `tab-main-<g>`」的现架构不符。渲染层的两层投影由 `syncShellTabLayer()` 实现（见上方「Shell 标签的两层升降」），判据与它的 `isMultiGroup` 一致。
- P3 分组增删改数据层（`serial-groups-model.js`，17 项单测）：
  - `addSerialGroup` 的继承边界：**只继承 `serialOptions`**（同型号设备不用重填）；`portPath` 必须清空（继承来的端口已被原分组占用，否则用户点连接会去抢正在用的口）；`title` 给 `Serial N` 占位；`filterTabs` / `chartTabs` / `workspaceLayout` 一律清空（属于具体端口的数据视图）。
  - `nextGroupId` 取**当前未被占用的最小 `g-<n>`**，不是「长度 + 1」：删掉中间分组后长度小于最大编号，用长度会撞车（`[g-1,g-3]` 长度 2 → 长度+1 得到已存在的 `g-3`）。也**不能用时间戳或随机数**：id 会写进配置并参与日志目录归属，随机化会让同一配置两次加载得到不同 id，幂等性失效（与迁移层固定 `'default'` 同一理由）。
  - `removeSerialGroup` 对不存在的 id 返回原列表而不抛错（关闭按钮可能被连点，抛错会变成未捕获异常），并把被删分组对象一并返回供调用方断串口/销毁子标签/关日志会话。`renameSerialGroup` 空标题回落到原标题，上限 60 字符。
- P2 分组终端运行时注册表（`serial-group-runtime.js`，19 项单测）：
  - 只管理实例生命周期，构造细节通过注入的 `createRuntime(groupId)` 完成，因此可在 Node 里测透而不把 DOM 耦合搬进来。
  - **三条硬约束**：① 惰性创建——xterm 的 `open()` 需要真实 DOM，标签未渲染就构造会失败；② 默认分组不可释放——释放后无路径可恢复，用户会看到空白终端区；③ 释放前必须 `dispose()`——只删引用会让 canvas/textarea 与滚动缓冲挂在 DOM 上，长用越来越卡。
  - `attach(groupId, runtime)` 是为改造初期准备的：默认分组的终端在 `renderer.js` 加载时就已建好并 open，再让注册表构造会得到**两个绑在同一容器的 xterm 实例**（互相抢输入、画面覆盖），比不接入更糟。`attach` 对已登记分组返回 `false` 而不覆盖，因为静默替换会让旧引用持有者继续操作被遗弃的实例。
  - `assertDefaultAttached()` 是启动自检：默认分组未登记意味着主终端不在注册表里，后续按 groupId 取终端全拿 null；宁可在启动时明确报错。
- 分组 DOM 标识契约（`serial-group-dom.js`，8 项单测）：
  - 提供 `groupDomSuffix` / `mainTabId` / `mainTabButtonId` / `serialContainerId`，把 `tab-main` 与 `serial-container` 从「散文式字面量」变成可计算的事实。
  - **默认分组不携带后缀**：算出来仍是 `tab-main` / `tab-main-button` / `serial-container`，与改造前逐字一致；只有非默认分组才拼 `-<groupId>`，如 `serial-container-g-1`。给默认分组加后缀会让 `index.html` 的静态标记、`pane-layout-dom.js` 的描述与依赖 `#serial-container` 的既有断言同时失效，而失败方式是「终端区一片空白」而不是报错。
  - 后缀放**尾部**而非中部（`serial-container-g-1` 而不是 `serial-g-1-container`），这样非默认容器仍以同一前缀开头，按 `[id^="serial-container"]` 批量查找才能生效。
  - groupId 会拼进 HTML id，因此 `[^A-Za-z0-9_-]` 一律替换为 `_`：配置是用户可编辑的文本，含空格或冒号的 id 直接进 `querySelector` 会抛 `SyntaxError` 而不是找不到元素。空 id 回落到默认分组（否则得到永远不存在的 `serial-container-`）。
  - `pane-layout-dom.js` 不再保存 `'tab-main'` / `'serial-container'` 字面量，改为委托本模块；`renderer.js` 的三处容器查找（open、context menu、wheel）改为 `serialContainerId(REGISTRY_DEFAULT_GROUP_ID)`，并合并为一次 `serialContainerEl` 解析。**单分组行为零变化。**
  - 本层只负责「id 怎么算」，**不负责建容器**。多分组容器节点仍未做。
- 终端构造改为工厂 + 注册表托管（`renderer.js` + `serial-group-runtime.js`，2026-11-03）：
  - `buildSerialTerminalOptions()` 是唯一构造模板；`createSerialRuntime(groupId)` 返回 `{ groupId, term, fitAddon, searchAddon, dataParser, container, dispose }`；`serialRuntimes` 为 `SerialTerminalRuntimeRegistry` 实例。
  - **默认分组经 `serialRuntimes.getOrCreate()` 构造**，`serialTerm` / `serialFitAddon` / `serialSearchAddon` 从运行时取出。工厂因此不再是死代码——这是上一轮回退的直接修复。
  - **`dataParser` 由运行时持有**，模块级只做引用（`let` + 赋值）。同一分组若有两个解析器，只有一个会被写入，行号会看起来「不涨」。
  - **不得在工厂外再调 `serialTerm.open()`**：xterm 重复 open 同一容器会重建 DOM 并丢掉已写内容，**且不报错**。
  - `serial-group-workspace.js`（15 项）提供每组应有的容器 id / 选择器与 `findMissingGroupContainers`；仍是纯数据，不建节点。
  - **新增加载门禁**：`scripts/check-renderer-module-load.js`（独立子进程执行完整模块体，只对同步顶层求值负责，完成后 `process.exit()`）+ `test/renderer-module-load.test.js`（4 项，含 TDZ 反向对照与「serialTerm 必须取自运行时」断言）。
    - 为什么不写成同进程 node:test：renderer 顶层会排入异步回调（首帧 fit、图表），依赖真实布局，stub 永远补不完；在测试进程内执行会让这些拒绝把整个文件判红。
    - **连踩六轮 stub 的教训**：遇到「stub 永远补不完」，首先怀疑验证范围选错（应当只验证同步求值），而不是继续补 stub。
  - **markup 计数断言已按预期改写**：`enableTerminalUnicode11(term);` 由 2 → **3**（串口工厂 / 过滤 / Shell 三处）；`allowTransparency: true` 与 `fontFamily: TERMINAL_FONT_FAMILY(` 仍为 3（串口那处进了模板）。另有一条从「`const serialTerm = new Terminal({...scrollback: 20000`」改为断言模板与工厂调用。
- 后续改造前必须知道的两件事（2026-11-03 核实）：
  - **P4 的起点比声称的更靠后。** `SerialGroupContextStore.setDisplay()` **至今零调用**，`renderer.js` 里 `receiveDisplayMode` 的 17 处读写、`receiveEncoding`/`sendEncoding`/`newlineMode` 全部仍在模块级 `let` 上。P4 不是「侧栏读 activeGroupId」的接线，而是「状态真的下沉 + 40+ 处读写点改造」，应作为独立前置阶段。
  - **P1 验收清单已订正。** `MULTI_SERIAL_DESIGN.md` §12 曾把 10 项全列为 `[ ]`，与 `ToDo.md` 记录的 P1 已完成矛盾。现已逐项对照 `main.js` 实际代码（`buildPortLogFolderName` @763、`ensureLogDirectory` @990、`cleanupSerialConnection` 按本会话端口判定 @2958、`session.outputBuckets` @2819/2917/2938）勾选并注明依据；但「逐字节不串流」与「日志端口子目录」当年只有端到端摘要级记录，**没有可重放的自动化用例**，这一点已在文档中声明。
- 配置迁移 v14 → v15（已实现，代码在 `serial-groups-config.js`，14 项单测）：
  - `CONFIG_VERSION` 不再硬编码，`main.js` 改为 `const CONFIG_VERSION = SERIAL_GROUPS_CONFIG_VERSION;`。
  - 默认分组 id **固定为 `'default'`**，不能随机：随机 id 会让每次 `normalizeConfig()` 产生新 id，幂等性直接失效，日志目录归属也会跟着漂移。
  - 迁移判据是 `Object.prototype.hasOwnProperty.call(source, 'serialGroups')`，**不是** `Array.isArray(...) && length`。空数组 `serialGroups: []` 是合法状态（用户把分组全关了只剩 Shell），绝不能被当成「没迁移过」重新造出一个幽灵分组。
  - 旧字段 `lastSerialOptions` / `filterTabs` / `chartTabs` / `workspaceLayout` 全部保留，支持降级回 v14；`sessionId` 归一化时一律重置为 `null`（运行时标识，`id` 才是稳定键）。
  - 备份 `config.v14.backup.json` **只写一次**：仅当「尚未迁移过」且「备份不存在」时生成；已迁移过的配置再备份会把真正的 v14 原件覆盖成 v15。备份失败只记 `log.error`，不得阻断启动。
  - 迁移调用位置是 `normalizeConfig()` 的最后一条语句 `return migrateSerialGroupsConfig(normalized);`，这样 `loadConfig` / `saveConfig` / `persistTelemetryState` 三条写盘路径都经过同一处。
  - **验证陷阱**：开发版与已安装版共用同一个 `%APPDATA%\serialterminal`。若机上还跑着旧版已安装程序，它会用旧 `saveConfig` 把刚迁移好的 v15 覆盖回 v14 结构，表现为「迁移没生效」。判定方法：查 `resources/app.asar` 里是否存在 `serialGroups`。实机验证迁移必须用独立 `--user-data-dir`，或确认没有旧版进程在跑。
  - 隔离实测（连启两次）：第一次 21667→23284 字节、version=15、groups=1、g0=`default/COM6/921600`，旧字段保留；第二次仍为 15/1 组，备份 mtime 未变。幂等与一次性备份均实测通过。
- P1 已落地的事实（以 `main.js` 为准）：
  - `serialSessions = new Map()` + `DEFAULT_SERIAL_GROUP_ID = 'default'`；会话对象持有 `groupId/portPath/port/sessionId/sendEncoding/newlineMode/cleanupComplete/connectInProgress/outputBuckets/outputFlushScheduled/throughput`。`normalizeSerialGroupId()` / `createSerialSession()` / `getSerialSession()` / `getOrCreateSerialSession()` 为入口。
  - 旧的 `currentSerialPort` / `serialSendEncoding` / `serialNewlineMode` / `serialCleanupComplete` / `serialConnectInProgress` / 全局 `throughputState` / 全局 `serialOutputQueue` 已**全部删除**，不得再引入。
  - `connect-serial` 接受 `options.groupId`，**只关闭本分组已有端口，不再关闭其他分组**；`connectInProgress` 为会话级；连接成功时重置 `mainLogFilePath`、`activeMainLogGroupId` 与各 tab entry 的 `filePath`。
  - `disconnect-serial` 接受 `{ groupId }` 只断指定分组；`serial-error` / `serial-disconnected` / `serial-throughput-update` 均携带 `groupId`。
  - `cleanupSerialConnection(message, port, groupId)` 的判据是「本会话的 port 是否等于传入 port」，不再是全局单例比较，因此不会丢弃其他分组的真实数据。
  - `flushSerialOutputQueue()` 按**会话 + sessionId 双维度分桶**发送，`serial-output-bytes` 携带 `sessionId` 与 `groupId`；已消除原来用 `queued[0].sessionId` 标注整批的串流缺陷。
  - 日志层：`ensureLogDirectory(groupId)` / `writeLog(data, groupId)` / `writeTabLog(tabId, title, data, groupId)` / `bufferRawSerialBytes(data, groupId)`；`buildPortLogFolderName()` 与 `resolveLogFolderName()` 负责端口目录名。
  - 渲染层：新增 `DEFAULT_SERIAL_GROUP_ID = 'default'`，并在 connect/disconnect/serial-write 三处回传 groupId；**UI 未变**，单串口行为与改造前一致。
- 已定决策（实施时不得自行更改）：快捷指令与自动发送总开关**全局共享**；分屏首版**分组级 + 组内级同时做**。
- 日志目录（已实现）：层级固定为 `<logPath>/[日期]/port_<端口号>/`。**日期目录必须在外层**：`log-cleanup.js` 的 `cleanEntries()` 只递归匹配 `^\d{4}-\d{2}-\d{2}$` 的目录（第 35 行），若把端口目录放外层，过期日志永远不会被清理。目录名由 `log-directory.js` 的 `buildPortLogFolderName()` 生成：显式 `split(/[\\/]/)` 取末段（**不用 `path.basename()`**，它在 POSIX 下不把 `\` 当分隔符，会让 `\\.\COM6` 在 Linux CI 上变成 `port____COM6`）、替换 Windows 非法字符、去尾部 `.`/空格，最后统一加 `port_` 前缀；端口缺失时由 `main.js` 回退到 `groupId`；Shell 固定用 `_shell`（不加前缀）。
- **端口目录必须加 `port_` 前缀（2026-11-19 实测修复）**：`COM1`-`COM9`、`LPT1`-`LPT9`、`CON`/`PRN`/`AUX`/`NUL` 是 DOS 保留设备名。企业加密/DLP 驱动（实测天锐绿盾 `TFsdframe`/`TFsfltdrv`/`TsdEncrypt`）会给同名目录写入 `Low Mandatory Level:(NW)` + 全显式 ACE（无 `(I)` 继承），导致资源管理器报"无权访问"，且 `takeown`/`icacls`/`fsutil reparsepoint` 全部从驱动层被拒绝，用户无法自行修复。触发条件是目录名完全匹配 `COM`+单个数字（`COM11`/`COM99` 不受影响），**与路径无关**——换日志根目录无法规避（实测 C 盘 D 盘同样中招）。回归测试见 `test/log-directory.test.js`。
- 并发模型（核实结论，详见设计文档 5A）：**串口读已经是线程化的**。`@serialport/bindings-cpp` 在 Windows 上为每个端口 `CreateThread` 出 `ReadThread`，内部 `ReadFileEx` + `SleepEx(INFINITE, TRUE)` 阻塞等待，数据到达后 `uv_async_send` 回 JS 线程（`src/serialport_win.cpp`）；Linux/macOS 走 libuv 线程池（`dist/unix-read.js`）。因此**不要为了「多线程」把串口搬进 `worker_threads`**：native 句柄不可跨线程转移，只能让 worker 自己打开，反而使主进程失去端口控制权。
- 多线程在**写盘**上曾经列过名单（P1.5），但**已实测裁定不做**：`fs.appendFileSync` 在真实数据量下（56 KB / 450 KB / 1 MB）分别只需 0.39 / 0.69 / 0.93 ms，比 Windows 15.6 ms 的定时器分辨率还快，Worker 化买不到可感知收益；只有 10 MB 级批次才有 12.7 ms 阻塞，而那时真正的瓶颈已是终端渲染。结论：保留同步写盘，不引入日志 Worker。完整数据见 `MULTI_SERIAL_DESIGN.md` 第 10 节 P1.5。
- P1 验证记录：双端口真机并发（COM6 + COM1）同时打开、独立写入、关闭一个另一个不受影响；完整测试套件 255/255；沙箱行为验证 19 项、双端口端到端 9 项均通过；模块体加载门禁 3/3 通过。
- **启动崩溃教训（已修复，必须遵守）**：`main.js` 曾在模块顶层写 `let activeMainLogGroupId = DEFAULT_SERIAL_GROUP_ID;`，而 `const DEFAULT_SERIAL_GROUP_ID = 'default';` 声明在其后约 2000 行。`const`/`let` 具有暂时性死区（TDZ），模块加载执行到该行时抛出 `ReferenceError: Cannot access 'DEFAULT_SERIAL_GROUP_ID' before initialization`，主进程加载失败、窗口根本无法创建。修复方式：把常量前置到 `SERIAL_LOG_FOLDER_SHELL` 之后、所有顶层使用者之前，并删除后部重复声明。
  - **为什么原有校验没拦住**：`node --check` 只做语法解析、**从不执行代码**，看不见 TDZ；原单元测试是对源码做正则断言，同样不执行模块体。二者在应用已完全无法启动时仍然全绿。
  - **硬性规则**：任何改动 `main.js` 顶层结构的变更（新增/移动顶层 `const`/`let`、新增顶层立即求值的初始化表达式），**必须真的执行一次模块体**来验证，不能只靠 `node --check` 与正则断言。
  - **门禁**：`test/main-module-load.test.js` 用 `vm.runInThisContext` 执行完整 `main.js` 模块体（只 stub `electron` / `electron-log` / `serialport` / `@serialport/*`，相对 require 用 `Module.createRequire(mainPath)` 解析），并含一个**反向对照**用例：构造 usage-before-declaration 片段并断言确实抛出 `ReferenceError`，防止门禁退化成恒真。
  - **进程清理提醒**：`Start-Process electron.cmd` 拿到的是 `cmd.exe` 包装进程，结束它**不会**连带结束 `electron.exe` 子进程树。验证完应用后必须用 `Get-Process electron | Where-Object { $_.Path -eq '<repo>\node_modules\electron\dist\electron.exe' }` 精确核对并清理，不要凭 PID 数量或「应该无关」的推断放过残留窗口。
- **P1.5（日志落盘去同步化）已实测裁定不做**。实测（Windows 10 + Node 20）：单次 `appendFileSync` 在 56 KB（115200 bps × 5 秒刷盘间隔）只耗 0.39 ms，450 KB 为 0.69 ms，1 MB 为 0.93 ms，10 MB 阈值批次才 12.72 ms；而 Windows 定时器分辨率本身就是 15.6 ms。也就是说**真实数据量下的同步写盘比系统定时器还快，Worker 化买不到任何可感知收益**。只有当单批次达到 10 MB 级洪水时才有 12.7 ms 阻塞，而那种量级下真正的瓶颈是终端渲染。因此保留 `fs.appendFileSync`，不引入日志写入 Worker；若将来真出现高吞吐卡顿，先查 `terminal-output-buffer` 与分批写入，不要先动写盘。完整数据见 `MULTI_SERIAL_DESIGN.md` 第 10 节 P1.5。
- **P2 进度（已完成前两步：分组注册表 + 分组上下文接管纯状态）**：
  - 第一步 `serial-group-registry.js`：**不依赖 DOM、可直接单测**的纯逻辑模块，持有 groupId → `{ sessionId, connected, portPath }` 与 `sessionToGroup` 映射。`accepts()` 是「这条字节该不该进本分组终端」的唯一判定入口，返回的 `reason`（`ok` / `unknown-group` / `session-other-group` / `stale-session`）能让丢包问题可定位。`renderer.js` 已接入：`serial-output-bytes` 走 `accepts()`、`connectSerialFromUi` 用 `beginSession()`、`disconnectSerial` 与 `serial-disconnected` 用 `invalidateSession()`。
  - 第二步 `serial-group-context.js`：`SerialGroupContextStore` 提供了 `serialLineCounter` / `logLineCounter` / `serialNewLine` 与四个收发显示参数（`receiveDisplayMode` / `receiveEncoding` / `sendEncoding` / `newlineMode`）。**目前只有三个计数器真正生效**：`getPrefix()` 与 `getLogPrefix()` 已从 `groupState(groupId)` 取行号，`clearTerminalByTabId` 与连接成功处改调 `resetLineCounters()`。四个显示参数仍由 `renderer.js` 自己的模块级 `let` 持有，`setDisplay()` 尚未被调用——不得假设它们已经按分组隔离。**屏幕行号与日志行号必须是两个独立计数器**，`nextLineNumbers()` 允许只推进其中一个，这是改造前就有的语义，不得合并。
  - 第三步 `serial-data-parser.js`：把行切分逻辑从 `renderer.js` 抽出，含跨 chunk 拼接与超长行（`MAX_UNTERMINATED_LINE`）保护。**这是一处真实缺陷修复**：原 `SerialDataParser` 在 `parse()` / `flush()` 内部直接调用全局 `getPrefix()`，一旦有多个分组各自的 parser 实例，所有实例会把行号记到同一个分组上，表现为两个端口行号互相跳号。现改为构造时注入 `prefixProvider`，每个实例绑定自己的分组。
  - **关键设计约束**：注册表状态必须与裸的 `serialSessionId` **同步**更新，否则注册表会认为旧会话仍有效而把正常数据全丢掉。以后新增任何递增/重置 `serialSessionId` 的地方，必须同时调用 `beginSession()` 或 `invalidateSession()`。
  - **硬阻塞（必须知道，否则会白做）**：`serialTerm` 在模块加载时就 `new Terminal(...)` 并 `.open(document.getElementById('serial-container'))`，而 `index.html` 里 `#serial-container` 是全页**唯一**的串口终端容器。所以 `serialTerm` / `filterTabs` / `chartTabs` / `workspaceLayout` 的「每分组一份」无法单独完成——必须先有「一组一个 Terminal 容器」的 DOM 契约。没有这一步就下沉，只会得到只能挂一个 Terminal 的上下文对象，即**伪多实例**。
  - **后续次序**：先把 `workspace-manager.js` 扩展为可动态创建 pane 与容器（P5），再让 `serialTerm` 等对象按 `groupId` 实例化并挂到各自容器上。在这之前继续改写渲染层只会产出无法验证的代码。
- **P5 纯数据层与 DOM 层（已落地，详见本节末尾「P5：每分组独立的布局与终端 pane」）**：
  - 新增 [`workspace-layout-shape.js`](workspace-layout-shape.js)：把 `workspace-manager.js` 里的 pane 规整逻辑抽成不碰 DOM 的纯数据模块，按任意 pane 列表工作。`normalizePaneSizes` / `reconcileEmptyPanes` / `normalizeLayoutShape` / `createDefaultLayout` 为导出；`workspace-manager.js` 的同名函数改为委托调用。
  - **硬性约束：pane 数为 2 时输出必须与改造前逐字段一致。** 因此 `test/workspace-layout-shape.test.js` 内嵌一份旧实现的 `legacyNormalize()`，用 10 组用例（undefined / 空对象 / 默认布局 / 分裂两满 / pane-2 空 / pane-1 空 / 非法尺寸 / 未知 activePaneId / 跨 pane 重复 tabId / 缺 tab-main）与 `normalizeLayoutShape()` 做 `assert.deepEqual`。这是「N=2 字节等价」的唯一证据来源，不能删。
  - 四条不显眼但必须保留的规则：
    1. `normalizePaneSizes` 的缺项补位**不存在** `1 / n` 回退，只能 `share = remainder / missing.length`。若已有尺寸已占满（`remainder === 0`），缺失的 pane 就是 0，不能反过来均分整个 1——否则会把已占满的 pane 生生缩小（实测曾得到 `{pane-1: 0.6, pane-2: 0.2, pane-3: 0.2}`，正确结果是 `1 / 0 / 0`）。
    2. `reconcileEmptyPanes` **只在「全空」或「只剩一个非空」时收敛**。写成「任一 pane 为空就收敛」会拆散一个仍有两个非空 pane 的合法三 pane 布局。
    3. 宿主 pane 选择按 pane 数量分叉：恰两 pane 时必须选 `pane-1`（旧实现行为，逐字段一致所需）；多于两 pane 时选有内容的那个，否则活跃 pane 会落到空 pane 上。
    4. 被搬 pane 的 `activeTabId` 必须跟着带过来，直接取 `tabIds[0]` 会静默改变收敛后的活跃标签页。
  - 另一个更隐蔽的判定错误：`moveWorkspaceTab` 把某个 pane 的最后一个 tab 搬走后，该 pane 会残留一个指向已离开 tab 的**陈旧** `activeTabId`。若合并时拿合并**后**的 tab 列表去判定宿主活跃 tab 是否仍有效，刚被搬进来的同名 tab 会让这个陈旧值错误通过检查，导致收敛后排错活跃标签页。现改为在合并前记录 `primaryTabIdsBefore`，用合并前的列表判定。修改此处前请先看 `test/workspace-manager.test.js` 的 `moving the last primary-pane tab collapses the split without changing its target index`。
  - **DOM 层：`workspace-manager.js` 不再假设两个 pane。** 原实现有 12 处 `pane-1` / `pane-2` 字面量，现全部由布局驱动：`resolvePaneId` 只要求「存在于当前布局」；`getOtherPaneId` 按 pane 列表循环；`reconcileEmptyPanes` 的宿主取 `layout.activePaneId`（不再写死 `pane-1`），源 pane 从调用前快照反查；`setActivePane` 不存在时退回首个 pane；`updatePaneVisibility` 让所有 index > 0 的 pane 统一跟随 `splitEnabled`；**`applyPaneSizes` 改为写各 pane 的内联 `flexBasis`**（旧的 `--pane-1-size` / `--pane-2-size` 两个 CSS 变量无法表达 N>2）；`moveTabToPane` / `addTabToPane` 用「目标不是首个 pane」判断开分屏；`removeTab` / `collapseSplit` 用 `layout.activePaneId`；`collapseSplit` 合入除首个 pane 外的全部 pane；`setPaneSizes` 在 >2 pane 时其余 pane 按现有比例分剩余空间。
  - 配套：`style.css` 删除 `#pane-1` / `#pane-2` 的 `flex-basis` 规则，改由 `.workspace-pane` 统一过渡、`.workspace-root.resizing .workspace-pane` 统一禁用过渡；`renderer.js` 的 `transitionend` 过滤由列举两个 id 改为 `classList.contains('workspace-pane')`。
  - **pane 节点：前两个仍为静态，第 3 个起按需创建。** 新增 [`pane-layout-dom.js`](pane-layout-dom.js)（纯数据描述，不碰 DOM，因此可单测）与 `workspace-manager.js` 的 `ensurePaneElements()`、`renderer.js` 的 `createPaneElement(paneId)`。`ensurePaneElements()` 被放在 `applyLayoutToDom()` 的**第一行**：`appendChild(null)` 不报错也不警告，标签页会静默消失，得到一块空面板——必须先补节点再布局。
  - **为何不把 `pane-1` / `pane-2` 也改成动态**：`serialTerm` 在模块加载时就 `serialTerm.open(document.getElementById('serial-container'))`，而 `#serial-container` 在两个静态 pane 里。动这两个节点就得同时改 `serialTerm` 的挂载时机，那属于 P2 剩余部分。这一轮只补「多出来的 pane 能现建」，单串口与现有两 pane 分屏行为完全不变。
  - 验证基线（当时）：`npm test` **316/316 通过、0 失败**（`test/workspace-pane-n.test.js` 8 项 + `test/pane-layout-dom.test.js` 9 项）；实机启动主窗口正常、`main.log` 无 JS 错误、electron 进程清理后 `remaining: 0`。**多串口行为至今仍未做过真实双端口 GUI 验证**——所有隔离结论都来自单测、源码断言、CDP DOM 断言与「应用能启动并存活」。

### P3 渲染层数据面按 groupId 路由（已落地）

- 改造前渲染层只有**一个** `serialOutputQueue` 与**一个** `serialTerm`。先做标签栏会得到两类静默故障：未登记分组的字节被 `accepts()` 判为 `unknown-group` 后**直接丢弃**（终端空白、日志无记录、无报错），以及补上 `ensureGroup` 后两组字节被 `Buffer.concat` 拼进同一批、写进同一终端与同一日志文件。**因此顺序必须是「先数据面、后 UI」。**
- `serial-output-buckets.js`（12 项单测）：`drain()` 的每一项**严格只含一个 groupId 的字节**；水位按分组独立判断（默认 1 MiB，与旧 `SERIAL_OUTPUT_QUEUE_HIGH_WATER_BYTES` 同值）；`Uint8Array` 走自身 `byteOffset`/`byteLength` 构造视图（防止读到相邻内存）；缺失或非法 groupId 回落默认而不是丢弃。
- 新增的按分组基础设施：`resolveSerialGroupId`（未登记回落默认，**绝不静默丢弃**）/ `isActiveSerialGroup` / `getGroupSessionId` / `serialGroupIo: Map<groupId, {textDecoder, hexFormatter}>` / `getSerialRuntime` / `getSerialTerm` / `resolveGroupIdForMainTab`。
- **四条必须保留的关键判断**：
  1. `serialSessionId` **只在 `groupId === REGISTRY_DEFAULT_GROUP_ID` 时同步**。否则 g-2 的一条入站消息会覆盖默认分组的会话号，让默认分组的写入被误判为 `STALE_SERIAL_SESSION` 而静默失败。
  2. `serial-disconnected` **只在默认分组时**做 `updateSerialConnectionState(false)` / `stopAutoSendRuntime()` / 释放 `serialDisconnectWaiters` / `ipcRenderer.send('flush-tab-logs')`。关掉 g-2 不该让默认分组界面显示「已断开」。
  3. `clearTerminalByTabId` 必须调 `serialOutputBuckets.clear(groupId)`——清屏后未上屏的旧数据不能紧接着又冒出来。
  4. `getMainTabTitle(groupId)`：默认分组仍返回 `'Main_Terminal'`（零变化），其它分组取配置里的 title。
- 全部改为接受 `groupId` 的写入路径：`writeTextLines` / `writeHexLines` / `renderSentRecord` / `flushTextReceive` / `resetTextReceive` / `createTextDecoder` / `writeMainTabLog` / `writeFilterTabLog` / `writeTabLog` / `connectSerialFromUi({ groupId })` / `sendSerialRequest` / `serial-output-bytes` / `serial-error` / `serial-disconnected` / `clearTerminalByTabId`。`main.js` 的 `ipcMain.on('write-tab-log')` 透传 `payload.groupId`。
- **本层仍是单例的部分（不得当作已完成）**：`filterTabs` 与 `chartTabs` 全应用只有一份，只跟随激活分组。若不设 `isActiveSerialGroup(groupId)` 这道边界，g-2 的字节会同时写进 g-1 的过滤页与日志。

### P3 分组标签栏的 DOM 结构描述层（已落地）

- `serial-group-tab-bar.js`（15 项单测）——纯数据、不碰 DOM。导出 `GROUP_TAB_BAR_ID` / `GROUP_TAB_LIST_ID` / `ADD_GROUP_BUTTON_ID` / `groupTabId` / `groupTabButtonId` / `groupCloseButtonId` / `describeGroupTab` / `describeGroupTabBar` / `describeAddGroupButton` / `describeGroupVisibility`。
- 五条非显然规则：① 分组标签与主终端标签 id 永不相交（`tab-group-<g>` vs `tab-main-<g>`）；② 默认分组也带 `-default` 后缀；③ 默认分组 `closable: false` 但**仍渲染关闭按钮**（按钮置灰，否则标签宽度跳变、点击位置漂移）；④ `groupId` 放 `dataset` 不放闭包（标签会重建，闭包会跟着丢）；⑤ 未知激活分组时全部隐藏而不猜。
- `describeGroupTabBar` 的显示判据是 **`isMultiGroup === true` 且 `groups.length > 1`**，两者缺一不可；`canAdd` 恒为真（否则用户永远开启不了多分组）。`describeAddGroupButton` 在已达上限时**禁用而不是隐藏**（隐藏会让布局跳动）。
- `describeGroupVisibility` 要求非激活分组**真正 `hidden`**：xterm 在 `display:none` 的容器里 `fit()` 会算出 0 尺寸，切回来时字符被压扁或右侧被裁掉。

### P3 渲染层分组状态与生命周期（已落地）

- 三个模块级状态：`serialGroups` / `activeGroupId` / `isApplyingSessionGroups`（防止 `applyConfig` → persist 的回环）。
- `syncSerialGroupsFromConfig(config)` **必须对每个分组执行 `serialGroupRegistry.ensureGroup` 与 `serialGroupContext.ensureContext`**。缺这两步会让 `serial-output-bytes` 以 `unknown-group` 把这些分组的全部字节静默丢弃。
- `ensureSerialGroupMainTabDom(groupId, title)` 建三样节点：主标签按钮（`mainTabButtonId`）、`.main-tab-pane`（`mainTabId`）、`.terminal-wrapper`（`serialContainerId`），然后 `addTabToPane(tabId, 'pane-1', { activate: false, persist: false })`。**不登记进布局的话 `switchPaneTab` 会因 `tabIds` 不含它而直接返回**。已存在则直接返回，保证反复调用无副作用。
- `applyActiveSerialGroup({ fit })` 同时改三处：注册表 `setActiveGroup`、`.serial-group-tab` 的 `active` 类与 `aria-selected`、`switchPaneTab('pane-1', mainTabId(activeGroupId))`，最后 `fitWorkspaceTerminals()`。
- `addSerialGroupFromUi()`：新分组 **status=disconnected**（用户明确决定，不自动连接），persist、建 DOM、切过去、`portSelect.focus()`。
- `closeSerialGroup(groupId)` 的顺序不可乱：默认分组拒绝 → 已连接时 `window.confirm` → `disconnect-serial` → `serialRuntimes.release` → `serialGroupIo.delete` → `serialOutputBuckets.clear` → `serialGroupContext.removeContext` → `serialGroupRegistry.removeGroup` → 移除按钮/面板/容器 → `removeTabFromWorkspace` → `removeSerialGroup` → 按「优先右邻」切到相邻分组。**先 release 后 removeGroup**：反过来会让释放路径拿 `undefined` 而静默跳过 `dispose()`，canvas 与滚动缓冲挂在已移除的 DOM 上不释放。
- `applyConfig` 末尾调用 `syncSerialGroupsFromConfig(config)`（受 `isApplyingSessionGroups` 守卫），位置在布局恢复**之后**，确保 pane 的 `tabs-list`/`tabs-content` 已在 DOM 里。

### CDP 真实点击验证手段（本阶段新增，必读）

仓库**没有** `ws` / `websocket` / `puppeteer` / `playwright`（实测 `require.resolve('ws')` → `ws-missing`）。为了不引入生产依赖，验证工具是手写的最小 CDP 客户端（`.me/tmp/` 下临时脚本，只依赖 Node 内置 `net` / `http` / `crypto`）：自实现 WebSocket 握手（`Sec-WebSocket-Key` + 校验 `HTTP/1.1 101`）与帧编解码（opcode `0x1`/`0x8`/`0x9`/`0xa`，长度分支 `<126`/`<65536`/127，客户端掩码），导出的 `send(method, params)` 把每帧 JSON 的 `id` 与 waiter 配对。

用法：带 `--remote-debugging-port=9222` 与独立 `--user-data-dir` 启动实例，用 `Runtime.evaluate`（`returnByValue` + `awaitPromise`）**真实点击按钮**并断言 DOM，逐项 PASS/FAIL。

**为什么非得补这一层（最有力的证据）**：分组标签栏首版在 `node --check`、renderer 模块加载门禁与 437 项全量测试下**全部全绿**，却存在如下致命缺陷：

```text
实测：[{id:"tab-group-default-button", groupId:"default"},"Serial 1"],
      [{id:"tab-group-default-button", groupId:"default"},"Serial 2"]   ← 两个分组拿到同一个 id
```

根因是「二次描述」：`describeGroupTabBar()` 返回的 `tabs` **已经是 `describeGroupTab()` 的完整结果**（没有 `id` 字段），渲染层又把它喂回 `describeGroupTab()`；后者用 `source.id` 取 groupId 而得到 `undefined`，**所有分组都回落 `'default'`**。后果：新分组不高亮、`tab-group-g-1-close` 不存在、**关闭分组整条流程点不到**。

**教训（必须遵守）**：`scripts/check-renderer-module-load.js` 的 `document.getElementById` **每次都返回新的 stub 对象**，因此它无法表达「同一个 id 被生成了两次」「点按钮后页面真的多了一个容器」这类问题。它的职责边界只是「顶层同步求值不抛错」。**凡涉及真实 DOM 结构或交互的改动，必须补真实窗口 + CDP 驱动验证。**

**当前基线：`verify-groups.js` 29/29 PASS、退出码 0**（扩展后覆盖 Shell 标签两层升降）。

**验证脚本自身也会说谎，同样需要怀疑**（本轮实测踩到两次）：

1. 编辑脚本时多插了一次 `click()`，第一次已关掉分组、第二次取到 `null` 抛 `TypeError`。**这不是产品缺陷**——写一个单独的探针脚本（只做加/切/关三步并打印中间态）证明流程本身正常后，才能定位到是脚本的问题。
2. 断言用错了身份键：Shell 按钮的 `id` 是 `tab-shell-1-button` 而 `data-target` 是 `tab-shell-1`，断言里用 `element.id` 组数组、又拿 `dataset.target` 去 `indexOf`，永远得到 -1。**这类错误不会让产品出错，但会让「验证」说谎 —— 必须修断言而不是改期望值。**

### Shell 标签的两层升降（已落地）

- `renderer.js` 的 `syncShellTabLayer()`：多分组时把 Shell 按钮 `appendChild` 到 `#serial-group-tab-list`（排在分组标签之后）；单分组时按 `pane.tabIds` 的相对顺序 `insertBefore` 落回 pane 标签行。
- **只移动节点、不重建。** Shell 的点击/双击/关闭监听都绑在按钮节点自身，终端在 `tabPane` 的 `terminalWrapper` 里。重建会丢监听、多出一个无人引用的 xterm 实例。
- **单分组回落必须用 `insertBefore` 而不是 `appendChild`。** 用户可以把 Shell 拖到主标签前面，直接推到末尾会借「切到多分组再切回来」静默改掉用户的标签顺序。
- `workspace-manager.js` 为此新增两个**可选注入**（不注入时行为与改造前逐字一致）：`resolveTabButtonHost(tabId, paneId)`（按钮应挂哪个容器，`null` 表示沿用 pane 的 `tabsList`）与 `findTabButton(tabId, paneId)`（放宽按钮查找范围）。
- **不补 `findTabButton` 的后果**：`hasRenderableTab()` 只在 `paneEl` 内 `querySelector`，被搬走的 Shell 找不到按钮 → `prunePaneTabIds()` 把它从 `tabIds` 删掉 → **Shell 标签彻底消失**。
- **不补 `resolveTabButtonHost` 的后果**：`applyLayoutToDom()` 会把每个按钮强制 `appendChild` 回所属 pane 的 `tabsList`，任何布局刷新（切分组/加标签/分屏）都会把 Shell 拽回 pane 行。
- `applyActiveTabToPane()` 的 `active` 类清理必须**按 `dataset.paneId` 全文档清**，否则被搬到分组层的 Shell 会残留上一个激活态，表现为「两个标签同时亮」。
- 调用时机：`renderSerialGroupTabBar()` 末尾、`listEl.replaceChildren()` **之后**（`replaceChildren` 会把上一轮搬上来的节点一并摘掉）；另由 `onLayoutApplied` 再调一次，保证任何布局重排后位置正确。
- 判定：`serialGroups.length > 1`，与 `serial-group-tabs.js` 的 `isMultiGroup` 一致。**`serial-group-tabs.js` 的 `buildTabBarModel()` 本身没有直接使用**——它假设「下层是某分组自己的标签列表」，与「每分组一个主终端标签 `tab-main-<g>`」的现架构不符。
- 验证：单分组 `inPaneRow:true / inGroupRow:false`；多分组顺序 `[tab-group-default-button, tab-group-g-1-button, tab-shell-1]`；点击后 `activePane:['tab-shell-1']` 且 `stillInGroupRow:true`；关闭多分组后 `backInPaneRow:true`；全程 `shellCount` 恒为 1。

### P4：四个显示参数下沉 + 侧栏跟随（已落地）

**核心手法：保留四个模块级 `let` 作为「默认分组的缓存」**，新增两个访问器，只改真正需要隔离的点。

```js
function getGroupDisplay(groupId = REGISTRY_DEFAULT_GROUP_ID) {
    const id = resolveSerialGroupId(groupId);
    const state = serialGroupContext.get(id);
    return { receiveDisplayMode, receiveEncoding, sendEncoding, newlineMode };  // 取自 state
}
function setGroupDisplay(groupId, patch = {}) {
    const id = resolveSerialGroupId(groupId);
    const state = serialGroupContext.setDisplay(id, patch);
    if (id === REGISTRY_DEFAULT_GROUP_ID) { receiveDisplayMode = state.receiveDisplayMode; /* 其余三个同理 */ }
    return state;
}
```

**不一次性改 64 处的理由**：默认分组的值与四个 `let` 恒等，现有裸变量读取点（日志、快捷指令等）行为零变化，风险与收益不成比例。**代价是必须记住：任何非默认分组必须走 `getGroupDisplay()`，不得读那四个变量。**

- **默认参数必须用常量 `REGISTRY_DEFAULT_GROUP_ID`，绝不能用 `activeGroupId`。** 模块顶层有 `getHexFormatter(REGISTRY_DEFAULT_GROUP_ID)` 这样的立即求值表达式，而 `activeGroupId` 声明在其后；默认参数引用它会直接重演 TDZ 启动崩溃。
- **按分组必须读的 7 类消费点**：`dispatchSerialBatch`（hex/text 判定，最实质）、`createTextDecoder`、`clearTerminalByTabId` 与 `serial-disconnected` 的 flush 判据、`sendSerialRequest`（编码 + `newlineMode`）、`getMainInputRequest`、新建过滤页的 `dataMode`、右键菜单的 `receiveDisplayMode`。
- **三个 `switch*` 的控件守卫**：都新增 `groupId` 参数，但**只在 `id === activeGroupId` 时才改侧栏控件与 `refreshSendConsumers()`**。否则关闭/后台配置变更作用于非激活分组时，用户正在看的界面会无端跳变。
- **双写持久化**：`persistActiveGroupSerialOptions()` 同时写 `serialGroups[activeGroupId].serialOptions`（该组自己的一份）与 `lastSerialOptions`（新分组的继承来源）。只写前者重启后丢设置；只写后者会让「切到 g-1 改波特率」把默认分组也改掉。
- **侧栏回显**：`applyActiveSerialGroup()` 末尾调 `applyGroupSerialOptionsToSidebar(activeGroupId)` + `refreshConnectButtonState()` + `updateFilterModeStatuses()`。回显 9 个控件：端口/波特率/数据位/停止位/校验/换行/接收模式/接收编码（含 `disabled`）/发送编码。
- **回显函数必须全用 `document.getElementById` 而非模块级 `const`。** 它会被 `applyActiveSerialGroup` 在模块加载早期（`syncSerialGroupsFromConfig`）触发，那时下方的 `portSelect` / `baudSelect` 等 `const` 还在 TDZ 里。
- **回显期间置 `isApplyingSessionGroups = true` 并在 `finally` 恢复。** 否则程序写入控件会触发 `change` → `saveSerialModeConfig()` → 把回显值当成新值再写一次配置。
- **端口与波特率只在选项真的存在时才选中。** `refreshPorts()` 是异步的；强制 `select.value='COM9'` 而选项还没建出来时，`<select>` 会静默变成空值。
- **`isGroupConnected(groupId)` 读注册表而非全局 `isConnected`**。用全局值判定会让「切到 g-1 后往它的终端里打字」被默认分组的状态拦掉。
- **必须保留的例外**：`createQuickTriggerDecoder()` 仍用默认分组接收编码；快捷指令与自动发送的 `sendEncoding` 仍读模块级缓存。快捷指令作用域本身就是全局共享（已锁定决策），不得盲目改成 `activeGroupId`。
- **验证**：CDP 真实点击 **37/37 PASS、exit=0**（`verify-groups-out6.txt`）。P4 新增 6 项：单分组编码可读 → 在 g-1 改成 `gbk` 生效 → 切回默认仍为 `utf8` → 切回 g-1 回显 `gbk` → 关闭 g-1 后塔回单层 → 默认分组编码未被污染。
- **未验证**：真实双端口字节流（A 组 text / B 组 hex 同时接收，两个终端是否真的各按自己的模式渲染）。代码与单测支持这个结论，但**字节级证据仍然缺失**。

### P5：每分组独立的布局与终端 pane（已落地）

**这是本项重构里唯一必须动 `index.html` 静态结构的一步，而它被拆成了两步提交：`f65fb98`（外层容器 + 可注入作用域）与 `a31ee20`（每分组独立布局与管理器）。**

**静态结构的最终形态**（关键：默认分组沿用静态 id，不是「全部改动态」）：

```text
.main-container
  ├─ #serial-group-tab-bar              （>=2 组时显示）
  ├─ #group-workspace                    ← 外层「分组级」pane 容器（flex row）
  │    ├─ #workspace-root                ← 默认分组，静态不动（内含 #pane-1 / #serial-container）
  │    ├─ #group-workspace-splitter      ← 分组级拖动分界条
  │    └─ #serial-group-workspace-g-1    ← 动态，含 #workspace-root-g-1 → #pane-1-g-1
  └─ #main-input-panel
```

**为什么默认分组必须沿用静态 id（不是省事，是启动时序）**：默认分组的 xterm 在 `renderer.js` 模块加载期就 `open(document.getElementById('serial-container'))`。只要 `workspace-root` / `pane-1` / `workspace-splitter` / `tab-main` / `serial-container` 这条祖先链逐字不变，重构就不可能引入「xterm 重复 open 丢内容」这类静默故障。非默认分组的终端本就是惰性创建，没有这个约束。

**布局与管理器：Map + 模块级别名。**

```js
const groupWorkspaceLayouts = new Map();   // groupId -> layout
const groupWorkspaceManagers = new Map();  // groupId -> manager
let workspaceManager = null;               // 别名，指向激活分组那一个
let workspaceLayout = null;                // 同上
```

`workspaceManager.xxx` 与 `workspaceLayout` 合计 60 余处消费点全部应作用于激活分组，因此集中到 `setActiveGroupWorkspace(groupId)` 一处切换，而不是逐处改成 `getGroupWorkspaceManager(id)`——后者漏一处就是静默铺错布局。

**五条必须保留的规则**：

1. **Map 的键运算一律用 `normalizeGroupId`，不用 `resolveSerialGroupId`。** 后者会把未登记分组回落默认分组，那样新分组的布局会被静默存到默认分组头上。
2. **`setActiveGroupWorkspace` 必须早于 `switchPaneTab`。** 后者通过 `workspaceManager` 读 `tabIds`，晚切一步就会在上一个分组的布局里找这个主标签，直接返回不切。
3. **标签登记按 pane id 反推分组，不按 `activeGroupId`。** `addTabToOwningGroupPane()` / `resolveGroupIdFromPaneId()`：`pane-1-g-1` → `g-1`，`pane-1` → 默认。原因：创建标签时 `resolvedPaneId` 可能属于非激活分组（`syncSerialGroupsFromConfig` 逐组恢复、或新建分组后尚未切别名）。曾经的缺陷形态实测为 `{"d":["tab-main","tab-main-g-1"],"g":[]}` —— 默认分组标签行里挂着两个 Main，g-1 标签行全空。
4. **Shell 标签的切换与登记永远走默认分组的 manager**（`switchShellTab`）。Shell 不归属任何分组（已锁定决策），走别名会让切到 g-1 后找不到 `tab-shell-1`，`switchPaneTab` 直接 return。
5. **`applyLayoutToDom()` 清激活态必须限定在本分组自己的 pane 内。** 原实现用全局 `.main-tab` / `.main-tab-pane` 清，一个分组重排会把另一个分组已激活的标签与面板一并清空；后者布局没变不会重算，表现为「加了一个分组，另一个分组的 Main 就白掉了」。这不是断言问题，是 CDP 实测到的真实缺陷。

**拖动与分界条：必须事件委托。** 非默认分组的 pane 与第 3 个及以后的 pane 都是后续动态创建的，模块加载期写死 `pane-1`/`pane-2` 绑定会让那些面板上的标签完全拖不动（无任何报错，只是「拖了没反应」）。分界条同理，且拖动比例必须相对**本分组**的 root 计算（`activeBoundsEl`），用全局 root 会让非默认分组按默认分组宽度换算。

**其它已同步的改动**：`applyConfig` 的三处 `paneFilterQueue` / `paneShellQueue` / `paneChartQueue` 从写死 `pane-1`/`pane-2` 改为按布局枚举 + `makePaneQueue(pattern)`；`closeSerialGroup()` 清理 `groupWorkspaceLayouts` / `groupWorkspaceManagers` / 外层容器，并在关掉激活分组时把别名切回默认分组；`persistWorkspaceLayout()` 双写 `serialGroups[activeGroupId].workspaceLayout`（多分组时的唯一真相源）与 `currentConfig.workspaceLayout`（仅默认分组，作兼容镜像）。

**验证**：CDP 真实点击 **54/54 PASS、exit=0**（`verify-groups-out26.txt`），`npm test` **467/467**。两级分屏新增 9 项结构断言，两层入口互斥新增 9 项。另新增一个独立探针 `probe-shell.js` 用于把「产品行为」与「验证逻辑」分离开——本轮就是靠它确认「点 Shell 后不切换」实际是断言用错了全局列表，产品本身正常。

### 「添加串口」入口：两层显隐互斥（已落地）

**需求原句是一切的判据**：`点击添加串口按钮相当于开启多串口后，终端的标签栏将分为两层`。因此入口必须在**单层模式下就可见**。

两个入口：

| id | 静态位置 | 归属层 |
|---|---|---|
| `#add-serial-group-inline-btn` | `#pane-1-tab-actions` | 单层 |
| `#add-serial-group-btn` | `#serial-group-tab-bar` 内的 `.serial-group-tab-actions` | 分组层 |

`syncSerialGroupAddButtonLayer()`（在 `renderSerialGroupTabBar()` 末尾调用）按 `serialGroups.length > 1` 切换两者的 `hidden`。**只改 `hidden`，绝不搬移节点**——早期版本把 inline 按钮 `appendChild` 进分组栏容器，而那里已经有静态按钮，于是多分组时并排两份「添加串口」，用户直接看到重复按钮。

**动态 pane 不提供第三份入口。** `createPaneElement` / `createGroupPaneElement` 的 `buttonSpecs` 只有 Shell / 过滤 / 图表三项。分屏后每个 pane 各有一套标签行，若那里也埋「添加串口」，会排出一行重复按钮；而全局动作在两层间始终可见，不需要逐 pane 复制。

**两层缺陷的真实根因（必记）**：`style.css` 全局 `button { display: inline-flex; }` **覆盖了浏览器默认的 `[hidden] { display: none }`**。同层优先级下作者样式胜出，因此 `el.hidden = true` 对任何按钮**完全不生效，且不报错**。`#add-serial-group-btn` 早期看起来能隐藏，纯粹是因为它的祖先 `#serial-group-tab-bar[hidden]` 有 `display:none`（属性选择器高于元素选择器）。现已在 `button` 规则之后补一条全局 `[hidden] { display: none !important; }`。

**为什么 51 项 CDP 全绿却仍有缺陷**：旧断言只调 `.click()`，而**对隐藏元素调 `.click()` 同样会触发监听器**。「能找到元素并点击成功」与「用户看得见它」是两件事。可见性断言必须测量 `offsetParent !== null`、`getBoundingClientRect()` 的实际宽高与祖先可见链。

**验证**：54/54 CDP PASS、`npm test` 467/467。新增 9 项含「全文档只存在两个入口实例」的全量清点（按标题而非 id 识别，因为动态 pane 的 id 带 paneId 前缀无法枚举）。另用 `probe-hidden-regression.js` 逐项复验 14 个依赖 `[hidden]` 的元素，`violations=[]`。

**仍未验证**：分屏后的入口互斥没有单独 CDP 用例——分屏由主进程右键菜单 IPC 触发，CDP 无法直接调起。依据是「`buttonSpecs` 已不含 group 项」的代码事实 + 全文档清点的间接保障。
### 分组工作区可见性、分组级分屏与 Shell 覆盖（已落地）

**可见性模型（`bf016a4` 起）**：分组工作区不再「有几个分组就并排几套」。`syncGroupWorkspaceVisibility()` 委托 `resolveVisibleGroupWorkspaceEntryIds()`：

- **未分屏（默认）**：只返回激活分组的 entryId —— 一套下层标签行。
- **已分屏**：返回 `groupWorkspaceSplit.groupIds` 中仍存在的分组，**并强制加入激活分组**（否则切到一个没参与分屏的分组会导致屏幕全空）。
- **Shell 覆盖**：若 `shellWorkspaceOverride` 有值，把该分组的 entryId 也加进可见集合。
- **外层分界条**：`hidden = !(enabled && visibleSize > 1)`。

修复前的实测形态是三套并排、各 387px、`visibleLabelRows: 3`；修复后只显示激活分组、占满可用宽度、`visibleLabelRows: 1`（`diag-tabs-out3.txt`）。

**分组级分屏状态机**：

```js
const groupWorkspaceSplit = {
    enabled: false,          // 默认关闭 —— 分屏必须是用户主动能力
    groupIds: [],            // 参与并排的分组，有序决定左右/上下
    orientation: 'horizontal',
    sizes: {}                // groupId -> 比例
};
```

| 函数 | 职责 |
|---|---|
| `resetGroupWorkspaceSplit()` | 复位到未分屏 |
| `getGroupSplitCandidates()` | 需 `serialGroups.length >= 2`，否则返回空 |
| `pruneGroupWorkspaceSplit()` | 清掉已不存在的分组；剩余 < 2 时自动退出分屏 |
| `setGroupWorkspaceSplit(enabled, { groupIds, orientation })` | 开启/关闭；参与组不足 2 时默认取「激活组 + 邻居」 |
| `applyGroupWorkspaceSplitLayout()` | 先清所有条目的 `flex-basis`/`flex`，再给参与分屏的写 `flexBasis` + `flexGrow:0` + `flexShrink:0` |
| `bindGroupWorkspaceSplitter()` | 委托 `[data-group-splitter="group"]` 的 pointerdown；比例按**外层** `#group-workspace` 矩形算 |
| `placeGroupWorkspaceSplitter()` | 把分界条移到「第一个可见分组之后」；已在正确位置则 no-op |

**退出分屏必须清 `flex-basis`**，否则上次比例残留，表现为「退出分屏后当前分组只占半宽」。

**拖动比例的一个顺序陷阱**：`bindGroupWorkspaceSplitter()` 的 `flush()` 里必须先算旧权重、再覆写 `groupWorkspaceSplit.sizes`。倒过来会把右侧全变成 0——因为「其余分组按原权重瓜分剩余」需要读取覆写前的值。

**分界条位置**：`#group-workspace-splitter` 原先放在 `#group-workspace` 末尾（flex 排列下自然落到最右），且 `ensureSerialGroupWorkspaceDom()` 用 `insertBefore(container, outerSplitter)` 每加一组就把它再往右推。现由 `placeGroupWorkspaceSplitter()` 在每次同步可见性时重排到第一个可见分组之后。

**Shell 覆盖（`shellWorkspaceOverride`）**：Shell 面板住在**默认分组**的 `pane-1` 里（`switchShellTab` 固定走 `getGroupWorkspaceManager(REGISTRY_DEFAULT_GROUP_ID)`）。一旦可见性改成「只显示激活分组」，切到 g-1 后默认分组整条被 `hidden`，`switchShellTab()` 只切默认分组的布局与 `.active` 类 → 标签高亮但屏幕全空，用户报「点 shell 标签没反应」。

```js
// 必须声明在 switchPaneTab 之前：那里会清空它，模块加载期就可能被调用。
let shellWorkspaceOverride = null;

function switchShellTab(tabId) {
    const defaultManager = getGroupWorkspaceManager(REGISTRY_DEFAULT_GROUP_ID);
    const paneId = defaultManager.getPaneIdForTabId(tabId);
    shellWorkspaceOverride = REGISTRY_DEFAULT_GROUP_ID;
    syncGroupWorkspaceVisibility();
    const switched = defaultManager.switchPaneTab(paneId, tabId);
    fitWorkspaceTerminals();
    return switched;
}

function switchPaneTab(paneId, tabId, options = {}) {
    // 任何串口标签的切换都意味着离开了 Shell。
    if (shellWorkspaceOverride) {
        shellWorkspaceOverride = null;
        syncGroupWorkspaceVisibility();
    }
    return workspaceManager.switchPaneTab(paneId, tabId, options);
}
```

**关键不变量：`shellWorkspaceOverride` 只影响可见性，绝不修改 `activeGroupId`。** 侧栏必须仍停留在原来那个串口分组。

**主标签文案 = 分组名**：默认分组的主标签来自 `index.html` 静态标记，带 `data-i18n="main.mainTerminal"`，国际化一跑就改回「主终端」，导致「新分组叫 Serial 2、默认分组叫主终端」的不一致。`syncAllGroupMainTabTitles()` 遍历 `serialGroups`，把每个主标签按钮文案改为分组名，并 **`button.removeAttribute('data-i18n')`** 防下次覆盖。两种 DOM 结构都要处理：动态按钮内有 `.main-tab-title`，静态按钮是裸文本节点 + 关闭占位符。**`getMainTabTitle()` 不改**——它用于日志文件名（`Main_Terminal` / `Main_Terminal_<g>`）。

**各分组终端必须逐个绑定右键菜单**：`bindTerminalContextMenu` 原先只在模块加载期对默认分组的 `#serial-container` 绑一次，新分组的容器是后建的 → 「新建的串口窗口没有右键菜单」。补绑时 **`term` 必须传函数而非实例**（`term: () => getSerialTerm(id)`）：新分组的 xterm 由 `createSerialRuntime` 在切标签时才建，此刻 `getSerialRuntime` 会回落到 `defaultSerialRuntime`，右键菜单里的选区/清屏全部作用于**错的终端**。

**解构参数里不能写 getter**：`function f({ get term() { ... } })` 报 `SyntaxError: Invalid destructuring assignment target`。必须用普通参数 + 内部 `resolveTerm()`。

**验证**：CDP `verify-titles.js` 6/6（侧栏分组名 + 主标签文案）；CDP `verify-shell.js` **16/16、exit=0**（`verify-shell-out2.txt`，隔离实例 `userdata-diag4`）覆盖 Shell 覆盖的完整生命周期：单分组建 Shell → 加分组切到 g-1（断言默认分组 `display:none` 且 rect 为 0）→ 点分组层的 Shell 标签（断言 `#workspace-root` 重新有尺寸、Shell 面板 `.active` 且 w/h > 0）→ **断言 `activeGroupId` 仍为 g-1** → 点回 g-1 主标签（断言默认分组重新隐藏，override 已清空）。

**分组级分屏的 UI 入口（已落地）**：入口在**分组标签的右键菜单**上，不在工具栏。分屏是低频且带方向的开关（左右 / 上下 / 关闭三选一），排成按钮会把标签栏挤满——用户在布局图里明确要求分组标签不挤在一起。

链路：分组标签 `contextmenu` → `requestSerialGroupContextMenu(groupId)` → `show-terminal-context-menu`（`terminalType: 'group'`）→ `main.js` 的三段条件菜单模板 → `terminal-context-menu-action` → `handleTerminalContextMenuAction` 的四个 case。

**复用 `show-terminal-context-menu` 而不另开 IPC**：主进程那份菜单模板与回流逻辑已经存在，再造一条会让「渲染进程发什么、主进程回什么」变成两套。

**动作名必须与组内分屏区分**：`split-horizontal` / `split-vertical` 是「把单个标签搬到另一个 pane」（组内 pane 分屏），`split-group-horizontal` / `split-group-vertical` 是「哪些分组并排显示」（分组级）。两者名字相近但作用面完全不同，**不得合并**。

**入口守卫必须给 group 开口子**：`handleTerminalContextMenuAction` 开头有一句「拿不到目标终端就 return」。分组级动作不承诺任何终端，不改守卫的话四个 case 永远走不到：

```js
const isGroup = terminalType === 'group';
const targetTerm = (isChart || isGroup) ? null : (...);
if (!isGroup && ((isChart && !chartTab) || (!isChart && !targetTerm && action !== 'paste-send'))) return;
```

**关闭分屏必须重写一次布局**：`setGroupWorkspaceSplit(false)` 只调 `resetGroupWorkspaceSplit()` + `syncGroupWorkspaceVisibility()` 是**不够的**——reset 只改状态对象，DOM 上的 `group-split-vertical` 类名与 `flex-basis` 仍在。实测关闭后 `flexDirection` 仍是 `column`、`splitVerticalClass` 仍是 `true`。必须补 `applyGroupWorkspaceSplitLayout()`。

**CSS 类名必须与 JS 完全一致**：`applyGroupWorkspaceSplitLayout()` 切换的是 `group-split-vertical` / `group-split-horizontal`，而 CSS 原先写的是 `.group-workspace.split-vertical`。**类名不匹配不会报任何错，只是上下分屏完全不生效**。已统一为 `.group-workspace.group-split-vertical`（含两条 `::before` 与分界条 cursor 共三条规则）。

**i18n 文案必须能区分**：已有的 `main.splitHorizontal` 是「左右分屏」，新的分组级项若也叫「左右分屏」，用户在两个同名菜单项之间无法判断。中文用「左右分屏（分组）」。

**CDP 验证分两层，缺一不可**：

- 第 1 层：真实右键分组标签，断言标签可见、派发 `contextmenu` 后渲染进程零错误。原生菜单无法 CDP 点击，这一层只能证到「用户能触达入口」。
- 第 2 层：直接调 `window.__handleContextMenuAction`（即 `ipcRenderer.on('terminal-context-menu-action')` 的真实回调，不是另写的测试分支），断言外层容器的可见条目数、`flexDirection`、方向类名、分界条显隐与位置、两列/两行尺寸约等分。

**实测（`verify-group-split.js` 19/19、exit=0，`verify-group-split-out2.txt`，`userdata-diag6`）**：两分组基线（1 条可见、分界条隐藏）→ 左右分屏（2 条可见、`row`、类名、分界条显示且紧跟第一个可见条目、宽度 400/400 约等分）→ 上下分屏（2 条可见、`column`、类名、高度约等分）→ 关闭分屏（1 条可见、分界条隐藏、类名清空、无残留 flex-basis 且占满 799px）。

**仍未验证**：`bindGroupWorkspaceSplitter()` 的真实鼠标拖动。CDP 的 `Input.dispatchMouseEvent` 可以模拟 pointer 事件，但拖动比例换算依赖真实 `getBoundingClientRect` 与 pointer capture，现有脚本未覆盖——**拖动逻辑目前只有静态审查**。
### 分组列结构与两行标签栏（第 9 项，已落地）

**用户原话**：`便签栏显示的时候，分组标签不能挤在一起，而是位于自己分组页的上方，shell标签页如果独立一组，则该组只显示一行标签栏`。

**结构变化**：`#group-workspace` 的直接子元素从「分组工作区」变成「分组列」。每个分组（含默认分组）都占一列，列内自上而下是「本组的分组标签行 → 本组的工作区」。

```
#group-workspace
  ├─ .group-column.serial-group-workspace#serial-group-workspace-default   ← index.html 静态新增
  │    ├─ .group-tab-row#serial-group-tab-bar        （原有 id 逐字保留，只是挪进了列首）
  │    └─ .workspace-root#workspace-root → #pane-1 → #serial-container      （全部后代 id 不变）
  ├─ #group-workspace-splitter
  └─ .group-column.serial-group-workspace#serial-group-workspace-g-1         （动态建）
       ├─ .group-tab-row#serial-group-tab-bar-g-1
       └─ .workspace-root-g-1 → #pane-1-g-1
```

**关键设计：只用一条静态行，靠「借用」改变归属。** `#serial-group-tab-bar` 不复制多份，而是在列之间搬移：

- **未分屏**：它被搬到当前激活列的列首，里面渲染**全部**分组标签（否则用户没法切分组）。
- **已分屏**：它留在默认分组列，只渲染默认分组自己那一个；其它列各有一条自己的行，各自只渲染自己那一个。

不复制静态 DOM 是有原因的：复制会产生重复 id，而 `describeGroupTabBar()` 返回的 `tabs` 每项**已经是** `describeGroupTab()` 的完整结果（没有 `id` 字段），再喂回去会让所有分组回落 `'default'`。

**`groupWorkspaceEntryId()` 语义变了**：现在**始终返回列容器 id**，默认分组也从 `workspace-root` 变成 `serial-group-workspace-default`。因此 `applyGroupWorkspaceSplitLayout()` / `syncGroupWorkspaceVisibility()` / `placeGroupWorkspaceSplitter()` 里的 `document.getElementById(groupWorkspaceEntryId(...))` 自动就落在列上，JS 逻辑不用改。

**`serial-group-layout-dom.js` 新增两个 id 函数**：`groupTabRowId(groupId)` / `groupTabListId(groupId)`。默认分组沿用静态 `serial-group-tab-bar` / `serial-group-tab-list`，其它分组带后缀。

**必须记住的三个陷阱**：

1. **关闭列前必须把静态行与「添加串口」按钮抢回来**。`closeSerialGroup()` 里的 `document.getElementById(groupWorkspaceContainerId(id))?.remove()` 会把整列删掉，而静态行可能正被 borrow 在那一列里（未分屏时它就住在激活列首）。不先调 `reclaimSharedGroupTabRow()` + `reclaimGroupAddButton()`，分组栏与按钮就永久消失，**且没有任何报错**。
2. **一列里本就有两条 `.group-tab-row`**：本组自己那条（未分屏时 hidden）+ 借来的静态行。所以断言「一列只有一条行」是错的，应断言「**可见**行恰好一条」。
3. **未分屏时其它列的行必须 hidden**。否则一列里会出现两条标签行（上一条还是空的），看起来就是「标签栏多了一条空白」。

**过程中真实抓到一个只有启动才能发现的缺陷**：`renderSerialGroupTabBar()` 引用了未 require 的 `GROUP_TAB_BAR_ID` / `GROUP_TAB_LIST_ID`，真实启动即抛 `ReferenceError`。`node --check` 只解析不执行、模块加载门禁不会走到这个函数（它只在 `applyConfig` 的 Promise 回调里被调），**两轮全绿**；只有 `app-diag9-err.log` 的 `[RENDERER DIAGNOSTIC]` 才暴露。已把 13 个新标识补进 `scan-undefined.js` 候选表（`checked=63`）。

**验证**：CDP `verify-group-columns.js` **39/39 PASS、exit=0**（`verify-group-columns-out4.txt`，`userdata-diag11`）。断言全部量真实布局：静态列存在且行是其首子元素、`#serial-container` 祖先链完整、单分组基线只一列可见且行隐藏、加分组后共享行进入激活列且在内容之上、切回默认行跟着搬、分屏时每列各一条行且行内只有自己那一个标签、Shell 落在默认列的组行里且不新开列、关闭分屏回单列、关掉分组后静态行与按钮存活且 inline 入口恢复可见。

**回归**：`verify-group-split.js` 19/19、`verify-shell.js` 16/16、`verify-sidebar-groups.js` 14/14、`verify-titles.js` 6/6、`npm test` 468/468。

**两处断言按判据更新**（改的是验证代码，不是产品行为）：`verify-shell.js` 两处已改为量 `#serial-group-workspace-default` 列容器——`#workspace-root` 现在不是外层条目，它永远 `hidden=false` 而实际 w/h=0（父列被隐藏），量它会得到恒真的假结论。


### Shell 标签跨层拖动（第 8 项 → 已被「逐标签归属」重构取代）

> **本节的「三态语义」已被整段删掉。** 用户实测报告「拖动 shell，所有 shell 会跟着一起移动」，
> 根因就是归属存成了**模块级单变量** `shellOwnerGroupId`，`placeShellTabs()` 用同一套宿主搬全部标签。
> 现行模型是**逐标签两态**（`tabState.ownerGroupId` = `null` 或 `<groupId>`），详见下一节。
> 本节以下内容保留，仅因为其中的**布局层注入约束**（`hasRenderableTab` / `applyLayoutToDom` /
> `applyActiveTabToPane`）与**拖放机制的四处改动**至今成立、仍是必须遵守的不变量。

**用户原话**：`shell标签页应该可以拖动，拖动到分组标签栏意味着和所有串口标签页分屏显示，自己成为独立一组，拖动到某个组的下层标签栏，意味着在所在的组中显示`。

**旧三态及其被推翻的过程（仅作教训，不要再照着实现）：**

```js
// 已删除
let shellOwnerGroupId = null;   // null | SHELL_COLUMN_GROUP_ID | <串口分组 id>
```

旧表把「不归属」与「独立成组」当成两件事，理由是没有拖过就不该凭空多出一列。**该结论本身仍然成立**，但它不需要第三种状态：「独立成组」只是 `null` 在**已分屏**下的必然形态，用 `groupWorkspaceSplit.enabled` 就能区分。把它建成独立状态反而引出了两个真缺陷：归属是全局的（拖一个带走全部）、以及 `isShellColumnActive()` 没检查分屏开关时能在未分屏时凭空建列。

```js
function getShellOwnerGroupId() {
    if (shellOwnerGroupId === SHELL_COLUMN_GROUP_ID) return SHELL_COLUMN_GROUP_ID;
    if (shellOwnerGroupId && serialGroups.some(g => g.id === shellOwnerGroupId)) return shellOwnerGroupId;
    return null;
}
function getShellHostGroupId() {
    const owner = getShellOwnerGroupId();
    if (owner) return owner;
    if (isShellColumnActive()) return SHELL_COLUMN_GROUP_ID;
    return activeGroupId;   // 不归属 → **激活**列，不是默认列
}
function isShellColumnActive() {
    return getShellOwnerGroupId() === SHELL_COLUMN_GROUP_ID
        && serialGroups.length > 1
        && shellTabs.length > 0;
}
```

**`__shell__` 复用分组命名，不另起一套**：`shellColumnId()` / `shellTabRowId()` / `shellTabListId()` / `shellWorkspaceRootId()` / `shellPaneId()` / `shellPaneTabsContentId()` 全部是 `groupWorkspaceContainerId` / `groupTabRowId` / `groupTabListId` / `groupWorkspaceRootId` / `groupPaneId` 对伪 id `'__shell__'` 的计算结果。独立列在结构上就是「一个只有单行标签栏的分组列」，复用同一套运算后它才能**自动**进入现有的可见性遍历、分屏比例写回与 pane 布局层（`getPaneTabsList(paneId)` 就是 `getElementById(paneId + '-tabs-list')`），不必在二十多处写「这是不是 shell」的分支。代价是所有早期字面量（`'serial-group-workspace-shell'` 等）全部失效，验证脚本必须改为调用契约函数。

**独立列的 DOM 形态**（无第二层标签行，正是用户「该组只显示一行标签栏」的字面要求）：

```
.group-column.shell-column#serial-group-workspace-__shell__   [data-group-id="__shell__"][data-shell-column="true"]
  ├─ .group-tab-row.serial-group-tab-bar#serial-group-tab-bar-__shell__
  │    └─ .main-tabs-list.serial-group-tab-list#serial-group-tab-list-__shell__
  └─ .workspace-root#workspace-root-__shell__
       └─ .workspace-pane.active#pane-1-__shell__
            └─ .main-tabs-content.pane-tabs-content#pane-1-__shell__-tabs-content
```

仍保留一个 `.workspace-pane`：xterm 的 `fit()` 需要真实尺寸链，而 `.main-tab-pane` 是绝对定位、依赖最近的已定位祖先（`.main-tabs-content` 有 `position: relative`）。

**`placeShellTabs()` 是 DOM + 布局同步的唯一入口，四个分支**：

| 条件 | `buttonHost` | `contentHost` | `layoutHost` |
|---|---|---|---|
| `hostId === SHELL_COLUMN_GROUP_ID` | 独立列列首列表 | 独立列内容区 | `SHELL_COLUMN_GROUP_ID` |
| 单分组（`!isMultiGroup`） | `pane-1-tabs-list` | `pane-1-tabs-content` | 默认分组 |
| 多分组 + `owner === null` | **借来的静态行** `GROUP_TAB_LIST_ID` | **激活列** `pane-1` 内容区 | 激活列分组 |
| 多分组 + 归属某分组 | 该组 **pane 标签行** `groupPaneId(hostId,1)-tabs-list` | 该组 pane-1 内容区 | `hostId` |

**三条必须记住的规则**：

1. **按钮与面板必须同属一列**。按钮在列 A 而行内其余内容在列 B 时，xterm 会在隐藏列里——表现为「标签亮着但看不到终端」。
2. **「共享上层行」不能写成 `getGroupTabList(activeGroupId)`**。非默认分组自己那条行在未分屏时是 `hidden` 的（屏幕上的标签是借来的静态行），往那里 append 得到的标签用户根本看不到。
3. **归属某分组时按钮进的是 pane 标签行，不是上层行**。放到上层行就变成「与分组标签同级」，与用户要求相反。

**`syncShellLayoutOwnership(hostGroupId)` 是必须的**：面板搬到另一列的 DOM 后，源分组布局仍把它列在 `tabIds` 里，下一次 `applyLayoutToDom` 要么把它拽回去（「拖过去又跳回来」），要么因 `hasRenderableTab()` 找不到而 `prune`（标签凭空消失）。它**逐个标签、逐个分组**摘出（多个 Shell 标签可能分散在不同分组布局里），再向宿主登记，并**显式 `switchPaneTab`** —— `addTabToPane({ activate: false })` 只把它排进行里，用户点开之前看不到任何东西。

**`isSyncingShellLayer` 重入闸**：调用链会成环——`placeShellTabs()` → `addTabToPane` → `applyLayoutToDom` → `onLayoutApplied` → `syncShellTabLayer()` → `placeShellTabs()`。不拦住会无限递归且每轮都动 DOM（表现为界面卡死）。

**拖放机制的四处改动**（原机制在 `renderer.js` 的 `bindWorkspaceTabDragging()` 一带）：

1. `getWorkspaceTabDropTarget()` 原来用**模块级别名** `workspaceLayout.panes`（即当前激活分组的布局），跨列拖动会失效 → 改为枚举 `document.querySelectorAll('.group-column .pane-tabs-list')`，并从 `column.dataset.groupId` 得出目标分组。
2. 新增 `getGroupRowDropTarget(clientX, clientY)`：枚举 `.group-tab-row`，跳过 `column.hidden`，这是「把 Shell 升为独立一组」的落点。
3. `pointerdown` 改为「按标签本身判定是否 Shell」（`isShellTabId(tabButton.dataset.target)` + `tabButton.closest('.group-tab-row')`），因此可从 `.group-tab-row` 起拖；串口分组标签（`.serial-group-tab`）不得从此起拖。
4. `finishWorkspaceTabDrag()` 落到分组标签行 → `setShellOwnerGroup(SHELL_COLUMN_GROUP_ID)`；落到 pane 行 → `setShellOwnerGroup(state.targetGroupId)`。非 Shell 标签走 `moveTabToGroupPane()`，它在目标分组 ≠ `activeGroupId` 时改用 `getGroupWorkspaceManager(groupId).moveTabToPane(...)`（**不能走别名**，否则会在当前分组布局里找目标 pane 直接 return）。

**实现过程中修掉的四个真实缺陷**（全部只有真实拖动 + 真实布局测量才能发现）：

1. **Shell 面板留在隐藏列**。实测 `{"listId":"serial-group-tab-list-g-1","shown":true}` 而 `{"contentId":"pane-1-tabs-content","shown":false,"w":0}`。修法：`placeShellTabs()` 必须**同时**解析 `buttonHost` 与 `contentHost`。
2. **布局归属不同步**（见上）。
3. **归入分组后没有激活**。实测 `{"contentId":"pane-1-g-1-tabs-content","active":false,"shown":false,"w":0}`。修法：登记后无条件 `switchPaneTab`。
4. **无限递归**（见上）。

**`closeSerialGroup()` 的 Shell 抢救块**：若被关的分组正是 Shell 的宿主，必须先把标签与面板搬回默认分组的 `pane-1` 再删列——直接 remove 整个列会把 xterm 节点一起删掉，而 `shellTabs` 仍持有已脱离文档的引用，之后无论怎么切都看不到终端**且不报错**。

**验证**：CDP `verify-shell-drag.js` **24/24 PASS、exit=0**（`verify-shell-drag-fix1.txt`，`userdata-diag24`）。它用 `Input.dispatchMouseEvent` 合成 pointer 事件（mousePressed → 8 步 mouseMoved → mouseReleased），全部 id 由 `require('../../../serial-group-layout-dom')` 契约函数算出。关键断言：`shell-tab-now-in-target-group-pane-row`、`shell-pane-now-in-target-group-content`、`group-tab-row-drag-creates-shell-column`、`shell-column-has-exactly-one-visible-tab-row`、`shell-column-has-no-pane-tab-row`、`unsplit-shell-sits-in-shared-group-row`、`split-does-not-create-shell-column-without-drag`、`close-split-removes-shell-column`、`drag-keeps-active-group`（**拖动不改 `activeGroupId`**，双向各一条）。

**回归中发现并修掉的一处真实缺陷（第 8 项自己引入的）**：`closeSerialGroup()` 里 `document.getElementById(groupWorkspaceContainerId(id))?.remove();` 这行被误删，注释「外层容器要整个拿掉」却还在。后果是关组后列容器永远留在 DOM（只是 `hidden`），`columnCount` 恒为 2、DOM 节点持续堆积。诊断脚本 `diag-columns2.js` 证实残留的是 `serial-group-workspace-g-1` 且 `shellTabs: 0`（**不是**原先推断的残留 shell 列）。已补回。

**一处断言按判据更新**：`verify-shell.js` 的「点 Shell 后默认分组被亮出」改为「点 Shell 后面板所在列可见」。第 8 项之后「不归属任何分组的 Shell」渲染在**激活列**的 `pane-1` 里，用户看的就是激活列；面板跑到被隐藏的默认列里才是缺陷。新断言量 `panel.closest('.group-column')` 的 `offsetParent` + 实际宽高，比旧断言更贴近用户实际看到的东西，**未放宽产品行为**。

**回归基线**：`verify-group-columns` 39/39、`verify-shell` 16/16、`verify-shell-drag` 24/24、`verify-group-split` 19/19、`verify-sidebar-groups` 14/14、`verify-titles` 6/6，六个脚本各用一个全新 `--user-data-dir`，`app-diagNN-err.log` 全部无 `[RENDERER DIAGNOSTIC]`。`npm test` **469/469**。

**仍未验证**：Shell 归入某分组后的长期行为（关组回落、跨多次切分组）只有 DOM 层证据，没有真实双端口端到端验证。


### Shell 归属改为逐标签 + 修正标签层级联动（用户报告的五个缺陷）

**用户原话**：`标签逻辑真是乱，shell标签页没法正常拖动，新建串口分组选到第二个分组发现没有新建串口按钮，点击分组或者shell标签会莫名其妙分屏，拖动shell，所有shell会跟着一起移动，shell处于上层标签栏时他的下层标签栏没有隐藏还在显示串口的子标签，但是他又不是串口组`。

这是「断言全绿 ≠ 用户可用」最严重的一次应验：上一轮 9 项全绿、七个 CDP 脚本 39/39 + 24/24 + 19/19 + 17/17 + 16/16 + 14/14 + 6/6，用户一上手就撞出五个真缺陷。

**取证**：`diag-user-path.js` 在全新 profile `userdata-diag40` 上按真实用户路径 0→6 七步连续操作，每步 dump 全量布局（列/行/pane 的 `hidden`/`shown`/宽度、每个标签的 `parentRow`/`parentColumn`/`shown`、两个「添加串口」入口的可见性）。

#### 三个共同根因

| # | 根因 | 对应的用户症状 |
| --- | --- | --- |
| 1 | Shell 归属是**模块级单变量** `shellOwnerGroupId`，`placeShellTabs()` 用同一套宿主搬**全部**标签 | 拖动一个 Shell 带走全部 |
| 2 | 「按钮该挂哪一行」有**三套互不一致**的实现：`placeShellTabs()` 的 owner 分支、`resolveWorkspaceTabButtonHost()`、`placeGroupAddButton()` | Shell 标签切分组后消失→拖不动；第二个分组的「添加串口」不可见；Shell 在上层却带着串口子标签 |
| 3 | 可见列集合与「是否分屏」**解耦**：`shellWorkspaceOverride` 与「Shell 归属在另一列就点亮那一列」能在 `groupWorkspaceSplit.enabled === false` 时多点亮一列，而 `applyGroupWorkspaceSplitLayout()` 在 `!isSplit` 时直接 return，两列各占 `flex: 1 1 0` | 点分组或 Shell 标签「莫名其妙分屏」（肉眼与真分屏完全一致，但菜单里仍显示「未分屏」） |

#### 修法总纲

| 改动 | 内容 |
| --- | --- |
| 归属下沉 | `tabState.ownerGroupId`（`null` \| `<groupId>`），**两态**；删除 `shellOwnerGroupId` / `getShellOwnerGroupId()` / `getShellHostGroupId()` / `shellWorkspaceOverride` |
| 单一宿主入口 | 新增 `resolveShellTabHost(tabState)` → `{ listEl, contentEl, layoutGroupId, layer }`，`layer ∈ {'subRow','ownColumn','topRow'}`；`placeShellTabs` / `resolveWorkspaceTabButtonHost` / 子行显隐全部调它 |
| 可见列收敛 | `resolveVisibleGroupWorkspaceEntryIds()` = 分屏集合 + 激活列 + `isShellColumnActive()` 时的 Shell 列；**删除**「归属在另一列就点亮那一列」整段 |
| 分屏前提 | `isShellColumnActive()` 必须包含 `groupWorkspaceSplit.enabled` |
| 可见行定位 | 新增 `getVisibleGroupRow(columnGroupId)`：已分屏→该列自己的行；否则→静态借位行 |
| 子行联动 | 新增 `isUnownedShellActiveIn(groupId)` + `syncGroupSubRowVisibility()` |

#### 验证过程中又揭出的三个真缺陷（不修则只是换了个地方坏）

**D1 点上层 Shell 完全无反应（我上一轮改动引入的回归）**：`switchShellTab()` 对 `topRow` 走 `activateDetachedShellTab()`，但后者只认独立列（`document.getElementById(shellTabListId())` 在未分屏时为 `null` → 直接 `return false`）。实测点 Shell 后 `tab-main-g-1` 仍 `.active`、面板也没换。
修法：新增 `activateShellTabInHost(tabId)` 按 `host.layer` 三分派。

**D2 上层 Shell 的激活态无处表达**：上层栏与独立列的 Shell 不在任何 `pane.tabIds` 里，`workspaceManager.switchPaneTab()` 开头 `if (!pane.tabIds.includes(tabId)) return;` 直接返回；DOM 上主标签又一直是 `.active`，于是两个标签同时亮、两个面板同时 `.active`、xterm `fit()` 算错高度。
修法：`stackShellTabOverHostGroup(layoutGroupId, tabId)` —— 把面板搬进该 pane 内容区并**直接叠 `.active`**，**不改布局**（布局里必须留着主标签：否则用户点不回去，重排还会因空 pane 被 `reconcileEmptyPanes` 规整掉）。配套 `hideStackedShellTabsIn(paneId, exceptTabId)` 在 `switchPaneTab()` 开头与分组主标签按钮点击时把它遮回去，**并显式点亮目标面板**（布局层此时会因「同一个标签」早退，两边都不亮就会全空）。

**D3 `isUnownedShellActiveIn()` 建在布局层状态上是错的**：按 D2，布局层永远认为主标签是 active，用 `manager.getActiveTabId(...)` 判断恒为 `false`，缺陷 E 等于完全没修。
修法：改按 DOM 判——该 pane 内容区里是否存在 `ownerGroupId === null` 且带 `.active` 的 Shell 面板。

#### 其余口径修正

- `activateDetachedShellTab()` 原先是 `shellTabs.forEach` 全量 toggle，会把**已归入分组的** Shell 的 `.active` 一起抢掉；已由 `activateShellTabInHost()` 逐标签按 `layer` 过滤取代。
- `syncGroupSubRowVisibility()` 改用 `#<paneId>-tabs-list` 的父节点精确定位 header，且单分组时必须把 `hidden` 清掉（从多分组退回来时上一次的 `hidden` 会残留，表现为「关掉其它分组后主终端没有标签栏」）。
- `clearActiveTerminal()` 改为优先清「屏幕上真正盖在最上面的面板」（新增 `resolveDisplayedTabIdInPane()`）——否则用户看着 Shell 却清掉了背后的串口主终端。
- `createShellTab()` 结束时调 `syncShellWorkspaceLayout()`（不能只调 `placeShellTabs()`：新列默认 `hidden`，要靠 `syncGroupWorkspaceVisibility()` 才亮出来），否则新 Shell 卡在创建时的 pane 行里。
- `placeShellTabs()` 记录「上一步真正在屏幕上显示过的 Shell」，布局变化后让它继续显示（包括刚被拖进某组的那个），否则标签亮着但终端区一片空白。

#### 配置与持久化

`shellTabs[]` 每项新增 `ownerGroupId`（`null` \| `<groupId>`），`persistShellTabs()` 写入、`createShellTab(initialState)` 恢复。`setShellOwnerGroup()` 在归属真正变化时持久化。旧配置缺该字段时按 `null` 处理（全部不归属），与改造前默认行为一致，**不需要提高 `SERIAL_GROUPS_CONFIG_VERSION`**。

#### 验证基线

| 脚本 | 结果 |
| --- | --- |
| `verify-user-paths.js`（本轮新增，15 项） | **15/15**（`userdata-diag45`） |
| `verify-group-columns.js` | 39/39（`diag48`） |
| `verify-shell.js` | 16/16（`diag52`） |
| `verify-group-split.js` | 19/19（`diag53`） |
| `verify-sidebar-groups.js` | 14/14（`diag54`） |
| `verify-titles.js` | exit=0（`diag55`） |
| `verify-context-menu-and-highlight.js` | 17/17（`diag56`） |
| `verify-shell-drag.js` | exit=0（`diag59`） |
| `npm test` | **469/469**（`full55.txt`） |
| `scan-undefined.js` | `checked=92` / `missing=none` |

每个脚本一个全新 `--user-data-dir`，`app-diagNN-err.log` 全部无 `[RENDERER DIAGNOSTIC]`。

#### 三处按判据更新的旧断言（不是产品缺陷）

1. `verify-group-columns`：`shell-does-not-create-extra-column` / `shell-tab-row-belongs-to-default-column` / `split-does-not-create-shell-column-without-drag` —— 这三条断言的是「Shell 不新开一列」，属**改造前全局单变量语义**。现行语义下不归属的 Shell 在已分屏时必须自占一列（对应用户 ASCII 图最右的 `SHELL1`）。改为断言「该列存在、可见、恰好一行、无下层标签行」。
2. `verify-shell-drag` 的 `unsplit-shell-pane-visible`：Shell 创建后**没有被点击过**，面板自然不会叠到主终端上面——这正是设计。改为先点一下再量可见性。
3. 本轮 `verify-user-paths.js` 自身的三处：单分组时分组标签行整体隐藏（`.serial-group-tab` 数量本来就是 0，不能断言 `=== 1`）；拖动前必须先点回该列主标签（否则目标下层行是隐的、`rect` 全 0，`dst` 退化成 `(0,0)` 使整段拖动空转）；`document.querySelector('.group-column .pane-tabs-list .main-tab')` 会先命中**已隐藏的默认列**，必须按 `#pane-1-g-1-tabs-list` 精确定位。


### 从上层 Shell 切回串口终端（用户实测缺陷：点串口标签仍是 Shell）

**用户原话**：`打开shell标签，再点击串口标签，窗口显示的还是shell，无法显示串口了`。

这是上一次提交（`2eb89d3`）修「缺陷 E」时自己挖的坑：为了让「Shell 在上层时不带串口子标签」，
`.pane-tabs-header` 被整体隐掉了。于是屏幕上**根本没有可点的串口子标签**，用户唯一能点的「串口标签」
就是分组标签本身——而这条路径恰好没人测过。

#### 取证

两份诊断脚本：

| 脚本 | profile | 结论 |
| --- | --- | --- |
| `diag-shell-switchback.js` | `diag70` | 单分组点 `tab-main` → `tab-main`（797×546）；多分组点 `tab-main-g-1` → `tab-main-g-1`（797×509）。**主标签链路本身是好的** |
| `diag-group-tab-click.js` | `diag71` | 命中：`subRowShown:false` 但 `subRowTabs:["tab-main-g-1"]`；屏幕上可点的非 Shell 标签只有 `{target:null, rowId:"serial-group-tab-bar"}` 两个分组标签；点当前分组标签后 `visibleActivePanels` 仍是 `[{id:"tab-shell-1", isShell:true}]` |

#### 三条成因

1. `activateSerialGroup(id)` 在 `id === activeGroupId` 时**直接 return** —— 用户点当前分组标签等于什么也没发生。
2. `applyActiveSerialGroup()` 走模块级别名 `switchPaneTab(paneId, mainTabId)`；布局层认为主标签已 active，走「同一个标签」早退分支不做 DOM 改动；而叠着的 Shell **不在 `pane.tabIds` 里**，布局层永远不知道它的存在，也不会遮它。
3. `placeShellTabs()` 的「让上一次显示的 Shell 继续显示」分支会把**跨分组被搬过来**的 Shell 再次点亮（这是为拖动/关闭分屏服务的），于是切到哪个分组都还是 Shell。

#### 修法

| 位置 | 改动 |
| --- | --- |
| `activateSerialGroup()` | 当前分组时改为调 `revealSerialGroupActiveTab(id)` |
| 新增 `revealSerialGroupActiveTab(groupId)` | 取该 pane 布局层记录的激活标签（不写死主标签），`hideStackedShellTabsIn` + `syncGroupSubRowVisibility` + `fitWorkspaceTerminals` |
| `applyActiveSerialGroup()` | 主标签切换改用**本分组布局管理器**；末尾统一调 `revealSerialGroupActiveTab(activeGroupId)`，把「切分组 = 看这个分组的串口」固定在一个地方 |
| 静态 `#tab-main-button` click | 补一次 `hideStackedShellTabsIn`（该监听注册于模块加载期，早于函数定义） |
| `placeShellTabs()` | 恢复分支保留「上一次显示的 Shell 继续显示」，但**切分组的覆盖由 `applyActiveSerialGroup` 末尾的 reveal 负责** |

#### 回归断言（`verify-shell-switchback.js`，14 项）

判据一律是「屏幕上实际占面积的 active 面板」（`getBoundingClientRect().width/height > 0`），不是 DOM 属性。

| 断言 | 覆盖的用户路径 |
| --- | --- |
| `single-group-click-main-shows-serial` | 单分组点主标签 |
| `P1-click-current-group-tab-shows-serial` | **点当前分组的分组标签**（用户最可能的操作） |
| `P2-click-other-group-tab-shows-serial` | 点另一个分组的分组标签 |
| `P4-switch-back-still-shows-serial` | 再切回来仍然要是串口 |
| `P5-shell-still-clickable` | 修复不能把 Shell 弄坏 |
| `P6-shell-in-top-row-still-hides-sub-row` | 缺陷 E 仍然成立 |
| `P7-click-main-tab-shows-serial` | 下层行恢复后主标签可点且能切回串口 |

**中间态一次失败（已修）**：首版只做前三条修法，`verify-shell-switchback` **12/14**——P2 与 P4 仍显示 Shell，
根因是 `placeShellTabs` 跨分组带 Shell。曾尝试用「宿主这一轮没变」作恢复条件，结果 `verify-shell-drag`
退到 2 项失败（拖动与关分屏都是布局变化，此时应该继续显示），说明那个判据方向错了；最终改为由
`applyActiveSerialGroup` 末尾统一 reveal。

#### 验证基线（本轮）

| 脚本 | 结果 | profile |
| --- | --- | --- |
| `verify-shell-switchback.js`（新增） | **14/14** | `diag108` |
| `verify-user-paths.js` | 15/15 | `diag100` |
| `verify-group-columns.js` | 39/39 | `diag101` |
| `verify-shell.js` | 16/16 | `diag102` |
| `verify-group-split.js` | 19/19 | `diag103` |
| `verify-sidebar-groups.js` | 14/14 | `diag104` |
| `verify-titles.js` | exit=0 | `diag105` |
| `verify-context-menu-and-highlight.js` | 17/17 | `diag106` |
| `verify-shell-drag.js` | exit=0 | `diag107` |
| `npm test` | **469/469** | — |
| `scan-undefined.js` | `checked=95` / `missing=none` | — |


### 新分组右键菜单与分组标签高亮（第 4 / 6 项，已闭环）

这两项长期只有「代码已提交」而没有行为证据，现已用 `verify-context-menu-and-highlight.js` **17/17 PASS、exit=0** 闭合（`verify-ctx-highlight-fix4.txt`，`userdata-diag31`）。

**第 4 项（新分组终端右键菜单）的判据与做法**：

原生菜单由主进程弹出，CDP 点不到菜单项。所以脚本在渲染进程里**旁路记录** `ipcRenderer.send`（只记录 `show-terminal-context-menu`，其余转发给真实 `send`，不阻止主进程弹菜单），然后在终端容器上派发真实 `contextmenu` 事件，断言：

1. 默认分组（对照组）：发出 IPC，payload 为 `terminalType:'main' / tabId:'tab-main' / paneId:'pane-1'`；
2. 新分组：发出 IPC，payload 为 `terminalType:'main' / tabId:'tab-main-g-1' / paneId:'pane-1-g-1'`。

**写这条断言时踩到的一个陷阱（必须记住）**：**非默认分组的 runtime 在生产代码里只在连接串口时才建**。`serialRuntimes.getOrCreate` 全局只有两处调用——模块加载期的默认分组，以及验证钩子 `__seedGroupSentinel`。所以：

- 「点一下该分组的主标签」**不会**建出 xterm（实测 `xtermAfter:false`）；
- 若不管这一点直接右键，`getSerialTerm('g-1')` 会走 `getSerialRuntime` 的**回落分支**拿到默认分组 term，`bindTerminalContextMenu` 里 `if (!currentTerm) return;` 也就不会拦（它非空），于是「新分组右键有反应」变成恒真的假结论。

脚本因此先用 `window.__seedGroupSentinel()` 把 runtime 建出来，并断言 `.xterm` 真的挂在 `#serial-container-g-1` 里，再右键。

**第 6 项（只高亮当前分组的标签）的判据**：不是「代码里有没有 `.active`」，而是三条同时成立——带 `.active` 的分组标签**恰好一个**、其 `groupId` 等于激活分组、且它**可见**（`offsetParent` + 实际宽高）。未分屏与已分屏各测一次：分屏时两列的行同时可见，是最容易出现「都亮」的形态；另外还断言非激活列的分组标签**不带** `.active`。



### 侧栏控件按当前分组分发（已落地）

**这是最容易反复错的一层**：`renderer.js` 里有三类「当前」读法，含义各不相同：

| 读法 | 实际含义 | 适用场景 |
|---|---|---|
| `getActiveTabId()` / `getActiveTabInfo()` | 读 `workspaceManager` **别名**指向的分组 | 仅限「创建标签」（新标签应落在正在操作的分组） |
| `serialTerm` / `serialSearchAddon` | **默认分组**运行时的常量别名 | 仅限默认分组专属逻辑 |
| `filterTabs` / `chartTabs` | 模块级别名，只指向一个分组 | 仅在 `setActiveGroupTabLists()` 之后可信 |

**别名只在 `applyActiveSerialGroup()` 里被同步过。** 侧栏按钮不保证在那个时序下被点击，所以必须按 `activeGroupId` 显式取。为此新增两个辅助函数（默认参数用常量 `REGISTRY_DEFAULT_GROUP_ID`，模块加载期安全）：

```js
function getGroupActiveTabId(groupId = REGISTRY_DEFAULT_GROUP_ID, fallbackTabId = 'tab-main') {
    return getGroupWorkspaceManager(groupId).getActiveTabId(fallbackTabId);
}
function getGroupActiveTabInfo(groupId = REGISTRY_DEFAULT_GROUP_ID, fallbackTabId = 'tab-main') {
    return getGroupWorkspaceManager(groupId).getActiveTabInfo(fallbackTabId);
}
```

**已修的四处真实缺陷**（用户原话：`左边栏的一些按钮事件应该也没有按照当前选中的串口分组分发`）：

1. **`clearActiveTerminal()`（「清空当前终端」）** —— 原用 `getActiveTabInfo()` 读别名，可能清掉用户看不到的那个终端。
2. **`clearAllLogTabs()`（「清空所有 Log 标签页」）** —— 原 `clearTerminalByTabId('tab-main')` + `filterTabs.forEach(...)`：主标签写死 `tab-main` 只清默认分组，`filterTabs` 是别名只覆盖一组。**按钮名字承诺「所有」，实现只清了一组。** 改为按 `serialGroups` 展开。
3. **`getActiveTerminalExport()`（「保存当前标签」）** —— 原用 `getActiveTabId()` + `serialTerm` + `filterTabs`。切到 g-1 后保存，拿到的是默认分组主终端的内容，日志文件名也错。
4. **`getActiveSearchTarget()`（侧栏搜索目标）** —— 同上，切到 g-1 后搜索仍在默认分组终端里找。`addon` 也必须从本分组 runtime 取。

**另一处同类缺陷**：静态 `#tab-main-button` 的 click 原写 `switchPaneTab(getPaneIdForTabId('tab-main'), 'tab-main')`。切到 g-1 后别名指向 g-1 布局，`switchPaneTab` 在 g-1 里找不到 `tab-main` 就直接 return —— **点默认分组的主标签没反应**。改为先把别名切到默认分组、切完在 `finally` 里恢复（`switchPaneTab` 只转交给别名，不能传 `groupId`）。

**验证脚本的设计（关键）**：判据不是「代码里有没有 `activeGroupId`」，而是**两个分组各写一份可区分的内容，点按钮后被操作的是不是屏幕上那一个**。

- 写哨兵用 `serialRuntimes.getOrCreate()`，**不能用 `getSerialTerm()`** —— 后者在分组运行时未创建时**会回落到默认分组**，那样「写 g-1 哨兵」实际写进默认分组，验证就变成恒真。
- 读哨兵走 `serialRuntimes.get()`，同样不走回落分支。
- **双向验证**：g-1 激活时清空 → g-1 哨兵消失、默认哨兵仍在；切回默认再清空 → 方向相反。**只测一个方向无法排除「写死某一组」这种实现。**

**实测（`verify-sidebar-groups.js` 14/14、exit=0，`verify-sidebar-groups-out1.txt`，`userdata-diag7`）**：两分组建立、激活是 g-1、两个哨兵已写入、搜索目标是 `tab-main-g-1` 且有 term/addon、导出内容含 G1 不含 DEFAULT、清空按钮可见且可点、清空只删 G1 哨兵且保留 DEFAULT 哨兵、切回默认后激活正确、搜索目标是 `tab-main`、导出含 DEFAULT 不含 G1、清空删除 DEFAULT 哨兵。


**验证脚本自身的一次失效（必记）**：`verify-shell.js` 第一版把「归一化到单分组」断言成 `.serial-group-tab` 数量 === 1，实测为 0。查 `renderSerialGroupTabBar()` 确认：单分组时 `barEl.hidden = true` 且 `listEl.replaceChildren()`，**列表本就是空的**。这是断言写错而非产品缺陷，按判据（改动不让被验证行为更正确）改为断「栏隐藏 + 列表为空」。



**本轮两条工具层面的实证**：

- **加载门禁第一次在真实缺陷上发挥决定性作用**：`node scripts/check-renderer-module-load.js` 报 `renderer.js failed at module init: ReferenceError: layout is not defined`（`getGroupWorkspaceLayout` 漏写 `let layout =`）。`node --check` 完全看不见。
- **加载门禁仍覆盖不到异步回调**：`applyConfig` 是 `ipcRenderer.invoke('get-config').then(...)` 的回调，其中的 `ReferenceError`（`groupWorkspaceEntryId is not defined`、`tabsContent is not defined`）只能靠真实启动窗口 + `appNN-err.log` 的 `[RENDERER DIAGNOSTIC]` 暴露。因此新增第三层保险 `.me/tmp/*/scan-undefined.js`：静态扫描一批候选标识符是否以 `function X` / `const|let|var X` / `class X` / require 解构形式出现过。**它刻意保守、不做真正的作用域分析**，用途只是「新写的代码里漏了 require 或漏了声明」。

**测试 stub 同步的判据**：`test/workspace-manager.test.js` 的三处 pane stub 补了 `querySelectorAll` 与 `classList.remove`，因为实现真的新增了「在 pane 内清激活态」的正当行为；断言期望值（`tabIds` / `activeTabId` / `splitEnabled` / `activePaneId` / `moved` 事件）一字未改。**判断「改断言还是改实现」的唯一标准是：改动是否让被验证的行为本身变得更正确。** 本窗口的反例对照：曾给 `switchPaneTab` 的「同一标签」早退分支加 DOM 重同步，`test 10`（纯切换不该有 DOM 副作用）立即失败——那个断言是对的，改动已回退。

### 13A.9 连接 / 断开按钮必须作用于当前串口分组

**用户实测缺陷**（逐字）：`选择串口2组，点击链接串口，串口1组会链接，并开始接受串口数据并显示，串口1组 的连接断开按钮会处于来连接状态，串口2组的处于断开状态`。

**取证（确凿，不是推断）**。`diag-connect-group.js`（`userdata-diag111`）在让 g-1 保持激活、选中 `COM6` 后点击 `#sidebar-connect-btn`，用 monkey-patch 旁路记录 IPC（`connect-serial` 假成功，不碰真实硬件）：

```text
activeGroupId at click time : g-1
connect-serial payload      : {"groupId":"default","path":"COM6",...}
disconnect-serial payload   : {"groupId":"default"}
sidebar-btn-after-connect   : {"cls":"sidebar-tool-btn disconnect-action","title":"Disconnect"}
per-group-connected-after   : {"default":true,"g-1":false}
```

即界面停在 Serial 2，点连接实际把 Serial 1 连上，按钮也变成了 Serial 1 的已连接态。用户描述 100% 复现。

**根因：整条连接链路写死默认分组**。七处，必须一起改，只改一半会出现「连对了但状态错」或「状态对但终端错」：

| 处 | 旧写法 | 后果 |
| --- | --- | --- |
| `toggleSerialConnection()` | `isConnected` 判定 + 不传 `groupId` | 永远操作默认分组 |
| `connectSerialFromUi()` | 默认参 `REGISTRY_DEFAULT_GROUP_ID`，参数全从侧栏控件读 | 即便传了 groupId，读到的也是激活组的控件值 |
| `disconnectSerial()` | `invalidateSession(REGISTRY_DEFAULT_GROUP_ID)` + `{groupId: DEFAULT_SERIAL_GROUP_ID}` | 断不开其它组 |
| `serialConnectInProgress` | 全局布尔 | 一个组在连时吞掉另一个组的点击 |
| `waitForSerialDisconnected()` | 全局 `serialDisconnectWaiters` 数组 | 任一组断开都会唤醒别的组的重连流程 |
| `serialTerm.onData` | 只在默认终端绑一次 | 非默认分组终端即便已连接也打不进去 |
| `sendSerialRequest()` | `if (!isConnected) return` | 非默认分组已连接也被默认分组的态拦下 |

**顺带修的三处同源错配**（不修就会在别的地方重新翻车）：

1. **连接提示跑错终端。** `getSerialTerm(groupId)` 在目标分组尚未创建 runtime 时会静默回落到默认分组，于是「Serial 2 已连接」写进了 Serial 1 的画面。改为 `serialRuntimes.getOrCreate(groupId).term`。
2. **吞吐面板被后台分组冲刷。** 主进程的 `serial-throughput-update` 本来就带 `groupId`，但渲染层不看，任一组的流量都会刷当前面板。改为按 `groupId === activeGroupId` 过滤。
3. **保存当前标签可能存错内容。** `getActiveTerminalExport()` 兜底走 `getSerialTerm(groupId)` 也会回落；改为无 runtime 时存空内容——宁可空，不可错。

**新增断言**：`verify-connect-group.js` **23/23**（`diag129`，exit=0，renderer-diag=clean），并入 `run-all.ps1`（九个 → 十个脚本）。覆盖：连接目标 = 激活组 / 另一组仍断开 / 按钮跟激活组 / 断开只断自己 / 连接提示不污染另一组终端 / 端口不跨分组继承。

**写这个脚本时踩到的两个断词问题（值得记住）**：

- 第一版忘了给 Serial 1 自己选端口，导致「切回默认后点连接」无反应。**这不是产品缺陷，而是「端口也按分组隔离」生效的证据**。硬把断言改成「会在」，而是先把「Serial 1 端口为空」作为一条独立断言写进去（`serial1-port-not-inherited-from-serial2`），再为它选端口。
- 「Serial 1 终端不应有连接横幅」这条一开始放在最后，而中间已经连过 Serial 1——断言自己制造了失败。改为在连 Serial 1 **之前**断言。**断言也有时序，不能只看“变量名对不对”。**

**尚未验证**：两个真实串口同时连接时的并发收发字节流隔离与按钮态刷新（无硬件）。


### 13A.10 同一物理端口只允许一个串口分组占用

**用户实测报告**（逐字）：`两个组选择相同的端口居然都能打开`。

#### 一、先要如实说清的一点：本机无法复现「都能打开」

两层取证都指向同一个结果 —— 第二次打开被**驱动**拒绝：

```text
portprobe/probe.js
  ports=["COM6","COM17","COM1","COM18","COM11"]
  COM6 => first:OK | second:Opening COM6: Access denied

diag-same-port-out2.txt  (profile diag131, exit=0, renderer-diag=clean)
  target port                : COM6
  after default connect      : {"default":{"connected":true,"portPath":"COM6"}}
  after g1 connect same port : {"default":{...true,"COM6"},"g-1":{"connected":false,"portPath":"COM6"}}
  both-claim-connected       : false
  alerts                     : ["Failed to connect: Error: Error invoking remote method 'connect-serial': Opening COM6: Access denied"]
```

所以这一轮**不是修复一个被复现的缺陷**。用户看到的现象很可能来自允许共享打开的虚拟串口 / USB 复合设备驱动。

#### 二、代码层的真实缺口

`serialSessions` 按 `groupId` 建会话，`getOrCreateSerialSession(groupId, portPath)` 只按 `groupId` 取/建，`connect-serial` **从不检查该端口是否已被别的分组打开**。唯一防线是驱动本身。而驱动行为不可控：一旦允许共享打开，两个分组会各持一个句柄、同一份字节流被两边消费、日志写两遍，**不会招异常**，只会让数据错乱。

#### 三、修法：应用层端口占用表

新模块 `serial-port-claims.js`（纯逻辑，不碰 `SerialPort` / DOM / IPC）：

| 成员 | 语义 |
| --- | --- |
| `normalizePortPath` | 字符串才 trim，其余一律 `''` |
| `normalizePortKey` | trim + 转大写（Windows 端口名大小写不敏感，避免 `com6` 与 `COM6` 被当成两个端口） |
| `claim(groupId, portPath)` | `{ ok, reason, portKey, ownerGroupId }`，`reason ∈ {empty-port, port-in-use, claimed}` |
| `releaseGroup(groupId)` | 释放该分组的占用，返回被释放的端口键或 `null` |
| `releasePort(groupId, portPath)` | **只有键与所有者同时匹配**才释放 |
| `ownerOf` / `isClaimedByOther` / `size` / `clear` | 查询与清空 |

两个非常容易写错、写错后很难发现的点：

1. **`port-in-use` 的判断必须在 `releaseGroup` 之前返回**。否则「把 g-1 从 COM6 换到已被 g-2 占用的 COM7」会先把 COM6 释放掉，才发现换不成，白白丢掉一条好连接。
2. **同一分组重复 `claim` 同一端口是合法的**（重连场景），而换端口时要先释放自己的旧占用 —— 因此一个分组最多只持有一个端口。

四个接入点（**漏一处就会永久锁死端口**）：

| 位置 | 动作 | 漏掉的后果 |
| --- | --- | --- |
| `connect-serial` handler 开头 | `claim` 在**动本分组旧连接之前** | 换端口失败会先断掉原有连接 |
| `port.open` 的 `err` 分支 | `releasePort(groupId, path)` | 打开失败后该端口在应用内永远「被占用」 |
| `cleanupSerialConnection()` | `releaseGroup(session.groupId)` | 断开的端口不可再被其它分组使用 |
| `disconnect-serial` 找不到会话时 | `releaseGroup(groupId)` | 同上，且渲染层早已认为它断开了 |

错误协议：主进程抛 `SERIAL_PORT_IN_USE|<PORTKEY>|<ownerGroupId>|<英文原文>`；渲染层 `connectSerialFromUi()` 的 `catch` 用 `/SERIAL_PORT_IN_USE\|([^|]*)\|([^|]*)\|(.*)/` 解析，用 `getSerialGroupById(ownerGroupId)?.title` 取可读分组名，再 `trFallback('main.serialPortInUse', …)`。

不做自定义 token 直接展示异常是不行的：Electron 包装后用户看到的就是本轮取证里那向 `Error invoking remote method 'connect-serial': Opening COM6: Access denied`。

#### 四、验证

`verify-same-port-guard.js` **15/15**（`diag140`、`diag151` 重跑也 15/15），**用真实串口**：

```text
[verify-same-port-guard @ diag140] exit=0
  renderer-diag=clean
PASS real-ports-available  {"ports":["COM6","COM17","COM1","COM18","COM11"]}
PASS default-connects-to-real-port  {"default":true}
PASS second-group-picks-the-same-port  {"ok":true,"shown":"COM6"}
PASS second-group-blocked  {"default":true,"g-1":false}
PASS default-keeps-its-connection  {"default":true,"g-1":false}
PASS alert-is-localized-port-in-use  {"alerts":["Port COM6 is already open in Serial 1. Disconnect it there first."]}
PASS alert-is-not-the-raw-driver-error
PASS default-disconnected
PASS second-group-connects-after-release  {"default":false,"g-1":true}
PASS cleanup-second-group-disconnected
SUMMARY total=15 pass=15 fail=0 skip=0
```

**最有价值的一条对比**：`diag131`（改动前）同样的操作得到 `Opening COM6: Access denied`，说明当时是驱动挡住的；改动后得到的是应用层本地化文案，说明拦截已上移到应用层。

而 `second-group-connects-after-release` 是整个改动的核心证据：release 路径只要漏一处（端口进没释放），这条就必失败。

#### 五、本阶段踩到的两个工具坑

1. **Electron 的 `window.alert` 是模态框，会阻塞渲染进程**，导致后续 `Runtime.evaluate` 永不返回。`diag-same-port.js` 第一版把 `alert` 包了一层但仍调了真实 `alert`，结果 `exit=2 / cdp timeout`。必须换成纯记录：`window.alert = (msg) => { window.__alerts.push(String(msg)); };`
2. **i18n 新增键必须补齐六种语言**。这一轮 `main.serialPortInUse` 先是只写了 `en`（而且那次 `File.Edit` 被 `unread_range` 拒掉后**根本没生效**），靠一个探针脚本才确认它一行都不存在。五种非英文语言的 `main` 是**整行压缩对象**（单行 1600~3100 字符），正确做法是「唯一锚点 + 匹配计数断言」的字符串替换，而不是整行重建。

**尚未验证**：用户环境里那类允许共享打开的驱动（本机没有这类设备，无法重现「两个分组都打开」）。

### 13A.11 显示类复选项的作用域开关与端口下拉框拔卡残留

**用户裁决**（逐字）：

> 第一点：show-timestamp / show-lineno / echo-sent-data / echo-sent-data-both / echo-sent-data-filter该按分组各一份，还是保持全局共享应该加入设置开关来设置这个。第二点可以改

我追问的是「该按分组隔离还是全局共享」，用户没有替我选一个值，而是要求**加一个设置开关让用户自己选**。这比任何一个单一取值都更合适：两种习惯都真实存在，而改造前只有一份全局值，强行改成按分组会静默改变所有存量用户的行为。

#### 一、背景：diag110 已经取证这五项会「串」

`diag110` 早就记录过 5 项 LEAK：切换分组后 `show-timestamp` / `show-lineno` / `echo-sent-data` / `echo-sent-data-both` / `echo-sent-data-filter` 都停在上一次改成的值，不像串口参数那 9 项会跟随分组。

代码层的根因很简单：这 5 个复选框的 `change` 处理器只写模块级全局变量并发 `update-display-settings`，**既不按分组存储**（`SerialGroupContextStore` 没有这五个字段），**也不在 `applyGroupSerialOptionsToSidebar()` 里回写**。读取时只用裸全局变量，因此「切到哪个分组都看同一个值」。

有利条件：两个读取点 `getPrefix()` 与 `renderSentRecord()` **本来就接收 `groupId`**，改成按组读取不需要新增管线。

#### 二、设计取舍

| 决策 | 值 | 理由 |
| --- | --- | --- |
| 默认作用域 | `global` | 改造前只有一份全局值；默认改成按分组会静默改变所有存量用户的行为 |
| 全局态的持久化位置 | 配置**顶层**同名键 | 与改造前完全一致，旧配置免迁移 |
| 每组态的持久化位置 | `serialGroups[i].uiPrefs` | 与 `portPath` / `serialOptions` 同层，随分组生命周期 |
| 组内未存过 | **继承全局值** | 打开开关那一刻屏幕效果不能跳变，也不能回到出厂默认 |
| 切回 global | 删除所有分组副本 | 否则日后重开开关又会飘出几天前的旧值 |

#### 三、实现

规则抽成纯逻辑模块 `serial-group-display-prefs.js`（`DISPLAY_PREF_SCOPES` / `DISPLAY_PREF_DEFAULTS` / `normalizeDisplayPrefScope` / `normalizeDisplayPrefs` / `readGroupDisplayPrefs` / `resolveDisplayPrefs` / `displayPrefsEqual`）。读取侧要的答案与侧栏回显侧要的答案必须同源，否则会出现「存到了组里、读还在读全局」这类只在特定操作顺序下才暴露的错位。

`renderer.js` 侧：`displayPrefScope` + `globalDisplayPrefs` 两个真源；`getGroupDisplayPrefs(groupId)` 带**失效式缓存**（它在逐行渲染热路径上，不缓存会让每行多一次 `Array.find` + 对象构造）；`setGroupDisplayPrefs()` 里**必须先失效再读**，否则调用方拿到的是写入前的偏好作为合并基底；`applyDisplayPrefScope()` 负责切换收尾（global → per-group 时给所有分组种入当前全局值，per-group → global 时删除所有分组副本）。

**两处容易漏的持久化**：

1. `serial-groups-config.js` 的 `normalizeSerialGroup()` **必须保留 `uiPrefs`**。主进程每次存盘都会 `normalizeConfig → migrateSerialGroupsConfig` 重建整个分组对象，不保留就会在用户下一次任意保存时静默抹掉分组级设置，而且没有任何报错。
2. `serial-groups-model.js` 的 `cloneGroup()` 必须**深拷** `uiPrefs`；`...group` 只搬引用，之后改一个分组会连带改到快照里的同名对象。

**`uiPrefs` 必须是可选字段**：「字段缺失（继承全局）」与「字段存在但值恰好都是默认值（明确的组内值）」是两件不同的事。一旦把缺失补成默认值，「继承」语义就永久丢失。

**两个时序陷阱**：`applyConfig()` 里不能直接应用作用域（此时分组列表马上要被 `syncSerialGroupsFromConfig` 重建），先记入 `pendingDisplayPrefScope`，等分组重建完再由 `flushPendingDisplayPrefScope()` 落地；从磁盘恢复时用 `suppressDisplayPrefPersist` 包住应用过程，否则每次启动都多写一次配置。

设置页 `preferences.html` / `preferences.js`：Terminal 页新增「每个串口分组各存一份显示偏好」，默认关闭；保存时**只存作用域，不汇总五项具体值**，否则会用打开设置窗口时的旧值覆写主窗口的实时值。

#### 四、顺带修掉的端口下拉框拔卡残留

| 位置 | 旧行为 | 现在 |
| --- | --- | --- |
| `applyGroupSerialOptionsToSidebar()` 的 port | 目标不在 option 列表就保留旧值 | 列表**已就绪**但不含目标 → **显式清空**；列表只有占位项（尚未刷新完）→ 保留，避免启动阶段误清 |
| 同函数的 baud | 自定义波特率未渲染时静默保留上一组的值 | 先 `renderCustomBaudRates()` 补建选项再选中。波特率**不能清空**——它总有值，清空反而让 `<select>` 停在第一项、与分组实际参数不一致 |
| `refreshPorts()` | 首选值兜底到 `currentConfig.lastSerialOptions.path`（**默认分组**的端口） | 首选值取自**激活分组**的 `portPath`；重建后显式 `portSelect.value = hasPreferredPath ? preferredPath : ''` |
| `getSerialOptionsFromUi()` | `path` 兜底到默认分组端口 | 显式 `''`。原写法会让「停在未选端口的新分组 + 发生任何保存」把默认分组端口写进新分组，切一次分组就能静默破掉端口隔离 |

#### 五、验证

`verify-display-pref-scope.js` **24/24**（`diag168`，exit=0，renderer-diag=clean，`verify-display-pref-scope-out8.txt`）：

| 断言组 | 关注的事实 |
| --- | --- |
| `global-scope-shares-value` / `global-scope-writes-no-group-copy` | 全局态下改一项两组同时变，且**不产生**分组副本 |
| `switching-group-keeps-shared-checkbox` | 全局态下切分组，复选框状态不变 |
| `per-group-seeds-current-global-value` / `-every-group-copy` / `-is-persisted` | 开启时用当前全局值给每组种入，且真的落盘（`save-config` + `update-display-settings`） |
| `per-group-write-affects-only-its-group` / `-is-stored-on-the-group` | 只影响本组，且写进组对象 |
| `g1-terminal-prefix-has-timestamp` / `default-terminal-prefix-has-no-timestamp` | **数据路径**证据：`getPrefix()` 的真实 ANSI 输出里只有该组带 `[HH:MM:SS.mmm]` |
| `sidebar-follows-group-on-switch-back` / `-in` | 来回切分组时侧栏跟随 |
| `global-scope-clears-group-copies` / `-restores-shared-value` / `-sidebar-shows-shared-value` | 切回全局后副本清空、值回到共享、侧栏同步 |
| 端口三条 | `existing-port-still-selected` / `missing-port-is-cleared-not-inherited` / `refresh-does-not-restore-other-groups-port` |

第 5 组是关键：前面几组只证明「存对了」，只有 `getPrefix()` 的真实前缀输出能证明**渲染路径也跟上了**。

`test/serial-group-display-prefs.test.js` **10/10**；`npm test` **492/492、fail=0**；12 个 CDP 脚本全量回归（profile diag170–181）全部 `exit=0` + `renderer-diag=clean`，合计 221 项断言 0 失败。

#### 六、一次误判与两条踩坑

**误判：`missing-port-is-cleared-not-inherited` 首轮失败，但产品是对的。** 原因是脚本「切到 g-1」时 g-1 **已经处于激活态**，点击是空切换，侧栏回显根本没重跑。这是「断言全绿 ≠ 用户可用」的镜像版本：**断言失败也不一定是产品缺陷**。先用 `diag-port-clear.js`（`diag167`）取证再动手，是这一轮唯一正确的顺序。

**坑 1 —— `File.Edit` 的 replace 区间会静默删掉语句。** 修 `applyGroupSerialOptionsToSidebar()` 时，一次 `replace` 把注释块与函数体一起覆盖，导致 `clearGroupDisplayPrefs` 只剩声明；补回时又让 `serialGroups.forEach(group => {` 丢了闭包；更隐蔽的一次删掉了 `const previousGuard = isApplyingSessionGroups; isApplyingSessionGroups = true;` 与随后的 `try {`。

`node --check` 与 `scripts/check-renderer-module-load.js` **全部放过**：前者的函数体丢失后残留代码仍然语法合法；后者只在模块加载期执行一次，而 `previousGuard` 在函数体内。只有真实启动的 `[RENDERER DIAGNOSTIC]`（`previousGuard is not defined`，`renderer.js:3692`）才暴露。

固化的做法：结构性编辑后立刻 `node --check` 并**回读该函数全文**；凡只在校验回调、交互手势或运行时路径里执行的函数，**必须真实启动一次**并检查 `app-diagNN-err.log`。`applyGroupSerialOptionsToSidebar()` 的三段关键语句（捕获 `previousGuard`、置为 `true`、`try {`）与末尾 `finally { isApplyingSessionGroups = previousGuard; }` 必须成对存在——它保证回显写入控件时不反过来触发 `saveSerialModeConfig`。

**坑 2 —— `node --check` 检不出模板字符串内部。** CDP 脚本里把对象字面量直接塞进 `ev()` 的模板字符串里当函数调用（模板内容末尾写成 `({ scope: ... })()`），报 `{(intermediate value)...} is not a function`；正确写法是把整体包成 IIFE：`(() => ({ ... }))()`。随后写的批量修补脚本又把它改坏成缺调用括号的形式，报 `Unexpected end of input`——而 `node --check` 对此毫无感知。最后固化成 `check-ev-templates.js`：抽取每个 `ev()` 的模板内容，把 `${...}` 插值换成占位字符串，再用 `new Function(code)` 只解析不执行（`checked=34 bad=0`）。

#### 七、更正：`363abd2` 正文里的一句不成立

该提交正文声称「`preferences.html` 顺带修正：`id="echoSentDataInFilterTabs"` 的 `<small>` 帮助文本在 DOM 里缺失（截断在 `</label>`），已补回」。**这句话不成立，本轮已核实并纠正**：

- `git show HEAD:preferences.html` 里该复选框的 `</label>` 紧接下一行就是空的 `</div>`，**没有任何 `<small>`**；
- 工作区当前版本的 `preferences.html` 同样没有；
- `i18n.js` 六种语言均**不存在** `prefs.echoSentDataInFilterTabsHelp` 这个键——若真有补回的动作，`test/i18n.test.js` 的「只引用已定义键」会直接失败。

记录这一点不是为了重修一个缺陷，而是因为它本身是个教训：**提交正文会变成下一轮（包括 AI 自己）的事实来源，写进去的未验证声明会被当成已完成**。正文里每一句「已做」都必须有对应的编辑动作或断言能对得上。

**尚未验证**：per-group 作用域下两个分组**同时收数据**时各自的前缀与发送回显。现有证据只是 `getPrefix()` 的直接调用输出，没有真实双端口字节流。


### 13A.12 Shell 标签的两个布局缺陷：点不动分组标签 + 分屏多出一列

**用户实测报告**（逐字）：

> 两个问题：1. 创建shell标签后，上次的串口标签点不动了没法切换，并且选中shell标签后创建shell按钮就不可见了，因为他藏在了其他的串口标签栏中，shell新建按钮应该移入到上层标签栏
>
> 2. 当标签布局类似这样时，我让COM2进行左右分屏 …… 会变成下面这样 …… 正确的应该是下面这样

用户同时给了两张 ASCII 布局图：错误形态是「三列串口 + 一列 SHELL」，正确形态是「COM1 / SHELL1 / SHELL2 同一行，COM2 另起一列」。

#### 一、先取证，不猜（三个诊断脚本）

| 脚本 | profile | 确认的事实 |
| --- | --- | --- |
| `diag-shell-split.js` | `diag190` | 建一个 Shell 后开左右分屏，`#group-workspace` 下出现 **4 列**：`default`（隐藏）、`g-1`、`g-2`、`__shell__`。壳体形态与用户「会变成下面这样」完全一致 |
| `diag-shell-stuck.js` | `diag191` | Shell 创建后 `headerHidden=true`、`activePanes=['tab-shell-1']`；点当前激活分组标签后**两者都不变**；`elementFromPoint` 显示点击命中的确实是 `tab-group-default-button`（不是被遮） |
| `diag-shell-error.js` | `diag193` | 同一操作序列先切到 g-1 再建 Shell，随后点 default 标签可以切过去。差别就在于「点当前分组标签」走的是 `activateSerialGroup()` 的**同组分支**（`revealSerialGroupActiveTab`），而跨组走的是完整重排 |

三次取证各化了几分钟，但把「点不动」从「猜事件没绑上」直接推到「`reveal` 拿到的是 Shell 自己」，省掉了整轮盲目修改。

#### 二、三个根因

1. **点不动**：`createShellTab()` 结尾会 `switchPaneTab(pane-1, tab-shell-1)`，把布局层 pane-1 的 `activeTabId` 变成 Shell；而 `revealSerialGroupActiveTab()` 直接用这个值当「要抬回的串口标签」，于是 `hideStackedShellTabsIn(paneId, tab-shell-1)` 把 Shell 自己重新点亮。切到**另一个**分组能好，是因为那条路径走的是 `applyActiveSerialGroup()` 的完整重排。
2. **按钮看不见**：多分组时唯一入口是 pane-1 的 pane 行（`#pane-1-new-shell-tab-btn`），而 `syncGroupSubRowVisibility()` 在 `isUnownedShellActiveIn()` 为真时把**整条** pane 行 `hidden`，按钮连同过滤/图表入口一起消失。
3. **多出一列**：`isShellColumnActive()` 的判据是「分屏 + 有未归属 Shell」，`resolveShellTabHost()` 也把未归属一律映射成 `ownColumn`。两者都把「不归属」当成了「独立成列」。

#### 三、修法

| 缺陷 | 改法 |
| --- | --- |
| 点不动 | `revealSerialGroupActiveTab()` 增加「目标必须是串口标签」的断言，否则回退到 `lastSerialTabByPane`（由 `switchPaneTab` / `setActivePane` / `activateShellTabInHost` 维护）或主标签 |
| 按钮看不见 | `index.html` 静态分组行新增 `#add-shell-tab-btn`；`placeShellAddButton()` 让它跟随**可见**分组标签行（与 `placeGroupAddButton` 同一套锚点）；`reclaimShellAddButton()` 在关列前抢回；`syncShellAddButtonVisibility()` 保证单分组时只剩 pane 行那个。同时 `syncGroupSubRowVisibility()` 不再隐掉下层行 |
| 多出一列 | 新增逐标签 `tabState.detachedColumn`。只有**把 Shell 拖到分组标签行**才置真；`isShellColumnActive()` / `resolveShellTabHost()` 都按这个标记分流；`persistShellTabs` 一并保存（旧配置缺失按 `false`） |

还修了一处更隐蔽的问题：`resolveShellTabHost()` 尾部原先写 `const visibleColumn = groupWorkspaceSplit.enabled ? activeGroupId : activeGroupId`（两个分支完全相同），改成 `getSingleVisibleGroupId() || activeGroupId`，让「未分屏时 Shell 跟随唯一的可见列」不再依赖巧合。

#### 四、验证

`verify-shell-buttons-split.js` **13/13**（`diag195`、`diag242`）：

- 单分组建——pane 行按钮可见、分组行按钮隐藏；
- 建三个分组——标签数正确；
- 建 Shell——新建按钮**可见且在上层行**、Shell 标签在分组行；
- 点另一个分组——`activeGroupId` 真的变了；
- 点回默认——`activePanes` 回到 `tab-main`（不再停在 `tab-shell-1`），下层行可见；
- 左右分屏——`shellColumns === 0`、两列可见、每列一条可见分组行、未归属 Shell 只出现在其中一列的列首行。

全量：`npm test` **492/492**；13 个 CDP 脚本全量回归（`run-all-230.txt`）全部 `exit=0`，`renderer-diag=clean`。`verify-same-port-guard` 这次 `exit=2`——原因是 `COM6` 被其它进程占用，脚本按设计 `SKIP` 并给出 `fail=0 skip=1`，不是回归。

#### 五、四处过期断言（改断言，不改实现）

语义一变，四个脚本的旧断言立刻失败。判定标准仍是那条：**改动是否让被验证的行为本身变得更正确**——这里是用户明确要求改变布局，因此改断言并在注释里写明原因：

| 脚本 | 旧断言 | 新断言 |
| --- | --- | --- |
| `verify-user-paths` | `split-unowned-shell-gets-own-column` | `split-unowned-shell-stays-in-group-column-row` |
| `verify-group-columns` | `unowned-shell-gets-own-column-when-split` | `unowned-shell-stays-in-group-column-row` |
| `verify-shell-drag` | `split-unowned-shell-gets-own-column` | `split-no-extra-shell-column` + `split-unowned-shell-sits-in-a-column-top-row` |
| `verify-user-paths` / `verify-shell-switchback` | `shell-in-top-row-hides-sub-tab-row` | `...-keeps-sub-tab-row-visible` |

两个**脚本自身**的 bug 也一并修了（都是断言报错而非产品缺陷）：

1. `verify-group-columns.js` 的旧段落先 `layout()` 再引用一个根本没声明过的 `shellAfter`，被我第一次改动掩盖成 `shellAfter is not defined`。现改为「在已分屏状态下点 `#add-shell-tab-btn` 建 Shell，再断言宿主不在 `__shell__` 列」。
2. `verify-shell-drag.js` 原先拖到 id 为 `serial-group-tab-bar` 的**静态**行；分屏时那一行可能整行隐藏，改为「找当前真正可见的那条分组标签行」。

#### 六、本轮又一次自伤（必记）

改动 `buildGroupTabButton` 上方的注释时，`File.Edit` 的 replace 区间把 `function buildGroupTabButton(tab) {` 与紧随其后的 `const button = document.createElement('button');` 一并吞掉，只剩 `button.className = ...`。

- `node --check` **通过**（语法合法）；
- 模块加载门禁 **通过**（函数体不在模块加载期执行）；
- 只有真实启动后的 `[RENDERER DIAGNOSTIC]` 报 `Uncaught ReferenceError: button is not defined`（`renderer.js:4172`，在 `renderSerialGroupTabBar` 的 `model.tabs.forEach` 里被调）。

这是 **13A.11 坑 1 的第二次复现**。结论不变且要更严：结构性编辑后立刻 `node --check` **并回读被改函数的完整头部三行**；任何会新建按钮/元素的函数，必须真实启动一次并看 `app-diagNN-err.log`。

#### 七、仍未验证

- 「新建 Shell 后紧接着拖动另一个 Shell」的真实鼠标时序（现有证据是 API 级与合成事件）；
- 多个未归属 Shell 在分屏下的具体列选择——现为激活列，没有更优的确定性规则；
- 真实双端口字节流下 Shell 与串口终端共存时的 xterm `fit()` 尺寸。

### 13A.13 分屏的三个几何与宿主缺陷：Shell 跟随 / 分割线过宽 / 三列只有一条 / 最右列越界

**用户实测报告**（逐字）：

> 两个串口组左右分屏，点击任意一个串口组标签shell就会跟着跳过去；并且分屏的分割线过宽，并且在三分屏下只有一个，不能控制所有分屏的宽度；分屏后最右侧的分屏会超出窗口右侧边界

#### 一、先取证：一次几何诊断拿到全部四个数字

`diag-split-geometry2.js` @ `diag250`（exit=0、renderer-diag=clean，`diag-split-geometry2-out1.txt`）完全按用户路径复现：建两个分组 → 建 Shell → 右键左右分屏 → 点另一个分组标签 → 再建第三个分组。关键输出：

| 观测项 | 实测值 |
| --- | --- |
| `#group-workspace` | `width 799`（`left 201` / `right 1000`，`clientWidth 799`） |
| 两列 flex-basis | 各 `50%`，`flexGrow=0` / `flexShrink=0` |
| 分界条实宽 | `10px`（`computedFlex: 0 0 10px`） |
| 两列合计 | `799 + 10 = 809`，`scrollWidth 809`，`maxRight 1010` |
| **溢出右边界** | **恰好 10px** |
| 三列可见时的分界条数 | **1**（只有 default↔g-1 之间） |
| 点 g-1 后 Shell 的 `columnId` | `serial-group-workspace-default` → `serial-group-workspace-g-1` |
| 点 g-1 后 Shell 面板 `parentId` | `pane-1-tabs-content` → `pane-1-g-1-tabs-content` |

四条缺陷各自对应一个数字，不需要猜。

#### 二、四个根因

1. **Shell 跟随**：`resolveShellTabHost()` 的 `topRow` 分支写的是 `getSingleVisibleGroupId() || activeGroupId`，而 `getSingleVisibleGroupId()` 在「已分屏且可见列 > 1」时恒为 `null`。于是每次 `applyActiveSerialGroup()` → `renderSerialGroupTabBar()` → `syncShellTabLayer()` → `placeShellTabs()` 都把未归属 Shell 的按钮与面板 `appendChild` 到新的激活列。
2. **分割线过宽**：CSS 是 `flex: 0 0 10px`，而可见的只有 `::before` 那 1px 竖线，剩下 9px 是透明间隙；hover 时整条 10px 加 `rgba(0,122,204,0.08)` 底色，看起来就是一条粗蓝条。
3. **三列只有一条**：静态 DOM 里只有一条 `#group-workspace-splitter`，`placeGroupWorkspaceSplitter()` 只把它插到「第一个可见子元素」后面；`bindGroupWorkspaceSplitter()` 的 `flush()` 还写死了 `const leftId = participants[0]`，即使有多条也只会调第一对列。
4. **最右列越界**：`flex-basis` 写百分比、`flex-shrink: 0`，百分比合计 100% 而分界条自身还占 10px，于是列宽之和 = 容器宽 + 分界条总宽。

#### 三、修法

| 目标 | 改动 |
| --- | --- |
| Shell 不跳列 | 新增 `isVisibleColumnKey()` / `resolveShellTopRowColumn(tabState)`：先看 `tabState.topRowColumnId` 记忆的列是否可见，不可见才回落 `getSingleVisibleGroupId() \|\| activeGroupId` 并写回。拖到分组标签行时也写目标列。 |
| 分割线收窄 | `.group-workspace-splitter { flex: 0 0 4px }`；新增 `::after` 伪元素左右各溢 2px，只扩大命中区，**不占布局宽度**。 |
| 多条分割线 | 新增 `syncGroupWorkspaceSplitters()` / `getGroupWorkspaceSplitters()` / `getGroupWorkspaceVisibleColumnKeys()`；`placeGroupWorkspaceSplitter()` 改为「按可见列数保证 N-1 条」；每条用 `data-splitter-left` / `data-splitter-right` 声明夹住的两列。 |
| 拖动只改相邻两列 | `bindGroupWorkspaceSplitter()` 重写：`pointerdown` 时从 `data-splitter-left/right` 取 `dragLeftId`/`dragRightId`，`pointermove` 在**这两列自身宽度之和**内算比例，`flush()` 只重写这两个 key。 |
| 不越界 | `flex-basis` 改为 `calc(<比例>% - <比例×分界条总占位>px)`，且只统计未隐藏的分界条。 |

#### 四、两个只有全量回归才能抓到的缺陷

1. **上下分屏被 gutter 计算打死**。`gutterTotal` 起初统一用 `getBoundingClientRect().width` 求和，而 `.group-split-vertical` 下分界条是 `width: 100%`（799px）。两列各扣 799px → 列高算成 0。`verify-group-split` 首轮报：`vertical-split-two-visible` 与 `vertical-split-roughly-half-each` FAIL，三列 `height` 全为 0。改为按 `orientation` 取 `height` / `width` 后回到 **19/19**。
2. **验证脚本自己的 `requestAnimationFrame` 会被节流**。窗口被遮挡/最小化时 rAF 几乎不触发，`Runtime.evaluate` 里的 `await new Promise(r => requestAnimationFrame(r))` 会挂死到 CDP 超时（`diag257` / `diag273` / `diag281` 三次 `exit=2`）。改 `setTimeout(r, 60)` 后稳定。**这是脚本问题，不是产品问题**——但要记住：任何在无头/被遮挡窗口里等帧的断言都不可靠。

#### 五、本轮三次自伤（必记）

1. `File.Edit` 的 replace 区间再次吞掉相邻的 `}`：`node --check` 两次报 `SyntaxError: Unexpected token '}'`（`renderer.js:3584`、`:3624`）。
2. **更隐蔽的一次**：按数量裁剪分界条时写成 `splitters.pop().remove()`，而 `getGroupWorkspaceSplitters()` 每次都 `document.getElementById` + 兜底 `unshift`，于是**静态** `#group-workspace-splitter` 被删后又被塞回数组，下次访问 `splitters[index-1].dataset` 直接抛 `Cannot read properties of undefined (reading 'dataset')`。现在静态那条**永不 remove**，多出来的动态条才 `remove()`，静态的只 `hidden = true`。
3. `flush()` 里 `clamped` 在删行时被误删，`node --check` 与模块加载门禁**全绿**，只有 `app-diag254-err.log` 报 `ReferenceError: clamped is not defined`。这是 `13A.11` / `13A.12` 那两个坑的第三次同类复现。

#### 六、验证

新增 `verify-split-geometry.js` **26/26**（`diag258` / `diag282` / `diag303`）：

- `shell-stays-in-original-column` / `shell-still-in-original-column-after-back` / `shell-column-stable-before-click`；
- `splitter-width-narrowed`（≤ 6px，实测 4px）、`two-column-one-splitter`、`three-column-two-splitters`、`three-column-splitters-pair-adjacent-columns`；
- `drag-does-not-touch-first-column` / `drag-changes-seconds-column`（`diag-drag-state-out1.txt` 的逐帧轨迹显示 default 全程 `33.3333%` 不动，g-1 从 `35.48%` 递增到 `48.76%`，g-2 同步递减到 `17.91%`）；
- `two-column-no-right-overflow`（`overflowRight=0`、`widthSum=799=containerWidth`）、`three-column-no-horizontal-scroll`（`scrollWidth=799=clientWidth`）、`close-split-column-fills-container`。

全量回归 `run-all-290.txt`：14 个脚本全部 `exit=0` + `renderer-diag=clean`（`verify-same-port-guard` 因 `COM6` 被占用按设计 skip，`fail=0`）。`npm test` **492/492**（`full65.txt`）。

#### 七、仍未验证

- 真实鼠标拖动的手感与最小宽度（当前硬限 `MIN_SHARE = 0.1`）——现有证据是合成 `PointerEvent`；
- 四条以上分屏时每一条分界条的独立拖动；
- 窗口尺寸变化后旧比例是否仍然合理（比例是相对量，理论上自适应，但未实测）。

### 13A.14 「新建 Shell」按钮永久只在一层标签栏出现

**用户实测要求**（逐字）：

> 二层标签栏可以不再显示 打开shell按钮，永久移入一层标签栏

#### 一、先取证：五个产生点，只有一个受控

「新建 Shell」按钮在两处 HTML 里各有一个静态件，又在两个工厂函数里现造，再加多分组专用那一个，共五个产生点：

| # | 位置 | 说明 |
| --- | --- | --- |
| 1 | `index.html` `#pane-1-new-shell-tab-btn` | pane-1 的 pane 行 |
| 2 | `index.html` `#pane-2-new-shell-tab-btn` | pane-2 的 pane 行（组内上下分屏才显示） |
| 3 | `createPaneElement()` 的 `buttonSpecs`（`kind: 'shell'`） | 组内分屏新建 pane 时现造 |
| 4 | `createGroupPaneElement()` 的 `buttonSpecs`（`kind: 'shell'`） | 新建串口分组的 pane-1 时现造 |
| 5 | `#add-shell-tab-btn` | 多分组专用，住在 `.serial-group-tab-actions`（用户说的「一层」） |

旧的 `syncShellAddButtonVisibility()` 只有一行有效逻辑：

```js
addShellTabBtn.hidden = serialGroups.length <= 1;
```

它**只控第 5 个**。第 1–4 个从来不受任何可见性规则管，所以多分组时屏幕上同时存在「一层一个 + 二层每列各一个」。这就是用户看到重复入口的原因。

#### 二、单分组为什么必须保留二层那个

`describeGroupTabBar()` 里整条分组标签行是 `hidden: !isMultiGroup`——单分组时界面上只有 pane 行那一层。若也隐掉它，用户永远开不出第一个 Shell。

所以规则不是「一律只留一层」，而是「**恰好一个可见**，位置随层数切换」。

#### 三、修法

```js
function syncShellAddButtonVisibility() {
    const isMultiGroup = serialGroups.length > 1;
    if (addShellTabBtn) addShellTabBtn.hidden = !isMultiGroup;
    if (!isMultiGroup) return;
    // 按 id 后缀扫而不是逐个记引用：组内分屏与新建分组都会现造新 pane，
    // 一次性写死的清单会漏掉后来创建的那个（表现为「新分屏那列突然多出一个按钮」）。
    document.querySelectorAll('.pane-tab-actions > button').forEach(button => {
        if (!/-new-shell-tab-btn$/.test(button.id || '')) return;
        button.hidden = true;
    });
}
```

三个要点：

1. **用 id 后缀扫，不用固定引用清单**。`createPaneElement()` 与 `createGroupPaneElement()` 会在运行时现造按钮，写死清单必然漏。
2. **`createPaneElement()` 末尾必须补调**。它造完按钮就直接 `return paneEl`，不经过 `renderSerialGroupTabBar()` / `syncGroupSubRowVisibility()` 那次重绘，漏调就会出现「新分屏那一列凭空多出一个入口」。
3. **改的是 `hidden`，不是 DOM 结构**。第 3、4 处的 `kind: 'shell'` 项仍在 `buttonSpecs` 数组里，`index.html` 两个静态按钮也没动。

#### 四、一次误判（已撤回）

最初把需求理解为「二层不该有 Shell 入口」，直接删掉了 `createPaneElement()` 与 `createGroupPaneElement()` 的 `buttonSpecs` 里 `{ kind: 'shell', ... }` 项。这在单分组组内分屏（`pane-2`）下会让用户彻底失去新建 Shell 的能力——那一层没有分组标签行可挂。已全部恢复，改为只做可见性控制。

#### 五、验证

`verify-shell-buttons-split.js` 新增 3 条断言后 **16/16**（`diag312`，`renderer-diag=clean`）：

- `multi-group-pane-row-shell-buttons-hidden`——多分组下 `.pane-tab-actions` 里所有 `*-new-shell-tab-btn` 都 `shown === false`；
- `split-pane-row-shell-buttons-hidden`——分屏后同样全部不可见；
- `split-group-shell-button-still-visible`——此时 `#add-shell-tab-btn` 仍可见且能拿到 `rowId`（说明它确实挂在某条可见分组标签行里）。

原 13 条里 `single-group-pane-shell-button-shown` 仍 PASS，证明单分组未回归。

全量回归 `run-all-320.txt`：14 个脚本全部 `exit=0` + `renderer-diag=clean`。`npm test` **492/492**（`full66.txt`）。静态门禁：`node --check renderer.js` ok、模块加载门禁 ok、`scan-undefined` checked=95/missing=none、`git diff --check` ok。

#### 六、第四次同类自伤（必记）

恢复 `buttonSpecs` 时，`File.Edit` 的 replace 区间把

```js
    buttonSpecs.forEach(spec => {
        const button = document.createElement('button');
```

两行一起吞掉了，只留下后面的 `button.id = ...`。结果：

- `node --check renderer.js` **通过**（残留函数体仍然语法合法）；
- `node scripts/check-renderer-module-load.js` **通过**（`createGroupPaneElement` 不在模块加载期执行）；
- `scan-undefined.js` **通过**（它只查 require 与声明，不做作用域分析）；
- 只有真实启动的 `app-diag310-err.log` 报 `Uncaught ReferenceError: button is not defined`（`createGroupPaneElement`，`renderer.js:3509`）。

这是 `13A.11`（`previousGuard is not defined`）、`13A.12`（`button is not defined` @ `renderer.js:4172`）、`13A.13`（`clamped is not defined`）之后的**第四次同类复现**。固化结论不变：

- 结构性编辑后立刻 `node --check` **并回读被改函数完整头部三行**；
- 凡只在校验回调、交互手势或运行时路径里执行的函数，**必须真实启动一次**并检查 `app-diagNN-err.log`；
- 两层静态门禁对「吞掉函数体内的语句」基本无感。

另一次 `diag311` 的 `exit=2` 是**验证脚本自己**的笔误：插入新断言时 `const shellCols = ...` 被覆盖掉，与产品无关。

### 13A.15 切标签时整个窗口与标签栏闪一下：三处重绘源

**用户实测报告**（逐字）：

> 标签切换的时候整个窗口都会闪一下，标签栏也会闪

#### 一、先取证：不要猜渲染性能

`diag-tab-flash.js` @ `diag340`（exit=0、renderer-diag=clean，`diag-tab-flash-out1.txt`）在页面上装了一个采样器，点击前后逐帧记录 `getComputedStyle` 与 `document.getAnimations()`。三条硬事实：

1. **切完之后激活面板的 opacity 恒为 `0`**，`transform: matrix(1,0,0,1,0,5)`（即 `translateY(5px)`），而且点击后过了 12 帧（约 200 ms，已超过 0.2 s 动画时长）仍然是 0。
2. **标签按钮的 opacity 也是 `0`**，`document.getAnimations()` 里 `tabFadeIn` 正挂在 `tab-main-button` / `tab-filter-1-button` / `tab-group-*-button` 上。
3. **分组标签按钮没有被重建**：`groupTabSameNode: true` / `defaultTabSameNode: true`。所以标签栏闪不是“节点重建”，而是**动画在元素被搬移时重播**。

对应到代码，`style.css` 里三处：

| 选择器 | 动画 | 重播时机 |
| --- | --- | --- |
| `.main-tab` | `tabFadeIn 0.18s ease` | 切 pane 标签 / 切分组 / 建标签，元素一从 `display:none` 转显示就重播 |
| `.main-tab-pane.active` | `fadeIn 0.2s ease`（`from { opacity: 0; transform: translateY(5px) }`） | 同上，整个内容区从透明+下移 5px 淡入 |
| `.sidebar-tab-pane` | `fadeIn 0.2s` | 切侧栏 tab |

而 `appendChild` 是放大器：`applyLayoutToDom()` 每次都无条件把按钮与面板 `appendChild` 到目标容器。**即使目标父节点就是当前父节点，DOM 规范也是先摘再插**，动画每切一次就重放一次。

#### 二、修法

| 目标 | 改动 |
| --- | --- |
| 不再重播动画 | 删掉上述三处 `animation` 与 `@keyframes fadeIn` / `@keyframes tabFadeIn`（删前已确认全项目仅剩这两处定义 + 三处引用，无 JS 引用） |
| 不再无意义摘插 | `applyLayoutToDom()` 只在 `parentElement !== 目标容器` 时 `appendChild` |
| 不再重建分组标签 | `renderSerialGroupTabBar()` 改为按 `buttonId` 复用（新增 `updateGroupTabButtonState()`，直接复用 `describeGroupTab().className`），末尾按 `knownGroupIds` 反向移除已关分组的按钮 |
| 复用后事件仍正确 | 新增 `bindGroupTabListEvents(listEl)`，在列表上委托 click / contextmenu，从 `dataset.groupId` 现读 |

**为什么必须改成事件委托**：按钮不再重建后，“构造时用闭包绑 `groupId`”就会永久持有旧值。委托只挂一次，复用与新造走同一条路径。静态列表在模块加载时挂，动态列的列表在 `createGroupTabRowElement()` 里各自挂（用 `dataset.groupTabEvents` 去重）。

**为什举关闭按钮不用改**：它的监听绑在 `buildGroupTabButton()` 里新建的 `.main-tab-close` 子元素上，那个 `span` 每次构造都是新的，与按钮复用无关。

#### 三、验证

新增 `verify-no-tab-flash.js` **18/18**（`diag341`，renderer-diag=clean，`verify-no-tab-flash-out1.txt`）：

- `filter-pane-fully-opaque` / `main-pane-fully-opaque`：切完后 `opacity === '1'`；
- `filter-pane-not-translated` / `main-pane-not-translated`：`transform === 'none'`；
- `no-entrance-animation-running-on-filter` / `...-on-main` / `...-on-group-switch`：页面无 `fadeIn` / `tabFadeIn` 动画；
- `group-tab-nodes-reused` / `pane-nodes-reused`：切分组前后分组标签与面板是**同一个对象**；
- `switch-back-by-delegation` / `group-tab-context-menu-delegated` / `newly-added-group-tab-clickable`：委托路径可用（含新建第三分组后其标签能点，证明动态列表也挂上了）；
- `close-button-removes-group`：关闭按钮仍有效。

全量回归 `run-all-350.txt`：15 个脚本全部 `exit=0` + `renderer-diag=clean`。`npm test` **492/492**（`full67.txt`）。

#### 四、仍未验证

- 大量标签（数十个）下复用路径的相对顺序是否始终与 `pane.tabIds` 一致（未构造这种数据）。

---

### 13A.16 渲染层翻转后的三类组合形态补测（本轮）

`TAB_ARCHITECTURE.md` §11.6.6 之前写着三类形态“零覆盖”：未分屏多受托管叶、四列以上、多 Shell 混合。
本轮补上，并且它们真的抓到了三处模型缺陷（不是测试写错）：

| # | 缺陷 | 根因 | 修法 |
|---|---|---|---|
| 1 | 先把 Shell 挂进某组、再拖到分组标签行 → 同一叶同时进独立列与该组下层行（`.test` 层表现为独立列里 0 个按钮） | `setLeafColumnMode('ownColumn')` 只改 `columnMode`；反向的 `setLeafHostGroup` 会清 `columnMode`——互斥只做了一个方向 | 两个写入口**两向互斥**；`renderer.js` 的 `setShellColumnModeInModel` 也同步补 `hostGroupId = null` |
| 2 | 扁平 + pane 分屏 + 受托管叶 → 该叶同时出现在一级行与 pane-1 行 | 扁平分屏分支只排除容器 | `tabItems` 过滤器加 `!leafHostGroup(ws, tab)` |
| 3 | 残留第二个非空 pane 时（`paneSplit.enabled === false`），一个没有行的叶被点亮，面板搬不进任何内容区 | 未分屏分支直接返回焦点叶，不校验它是否在本列会画的行上 | 新增 `isShownInColumn(column, rows, tabId)`（行 ∪ 列首行），未命中回落 `rows[0]` |

**随机探针（不入库）**：300 种子 × 80 步随机操作，每步检查三条不变量——同一标签只定位一次 /
某列亮着的面板必住进该列 / 全局可见面板必属于某一列。修复前 1694 条违规，修复后 **0**。

**另一个只靠真实 DOM 才能发现的缺陷**：`isVisibleColumnKey()` 仍用“只有参与分屏的 `groupIds` 可见”
这条**已删除的旧语义**。屏幕上五列全在时它只认其中两列，于是记在 g-1 的未归属 Shell 被改成
当前激活列（实测 `shape-c-top-row-shell-in-group-row` 失败）。改为`isGroupColumnVisible()`（只看列容器是否存在且未隐藏）。

这是 `TAB_ARCHITECTURE.md` 里“重命名/翻转后残留旧判据”的又一例：删语义时要搜**它的判据函数**，不能只删调用点。

**验证证据**：单测 **564/564**（随后补列级比例归一化 3 条，现为 **567/567**）；`verify-tab-plan-shapes` **29/29**（`diag862`）；
回归 `verify-tab-plan-strict` **48/48**（`diag863`）、`verify-shell-drag` **24/24**（`diag864`）、
全量 `run-all-865.txt` **15 个脚本全部 exit=0 + renderer-diag=clean**。

---

### 13A.17 四项真实用户路径缺口的闭环（本轮）

`TAB_ARCHITECTURE.md` §11.6.7 列过四个“没有真实用户路径证据”的缺口。本轮逐项取证，
**其中两项抽出真实产品缺陷**，另有三处是测试脚本自己的前提错（产品代码一行未动）。

#### 13A.17.1 缺陷一：四级以上分屏时分界条根本拖不动

**观测**（`probe-fourcol-defects.js`，4 容器 → 屏幕 4 列 3 条分界条）：
三条分界条逐条拖动，列宽全程 `[171.75, 171.75, 171.75, 171.75]`，`groupWorkspaceSplit.sizes` 始终 `{}`。

**根因**：拖动逻辑把 `groupWorkspaceSplit.groupIds` 当参与者表。它只记录“分屏是围绕哪两组打开的”
（`setGroupWorkspaceSplit` 的默认分支 = 激活组 + 邻组，实测只有两项），而**列集合由容器数决定**
（`layoutColumns` 每个容器一列 + 可选共享独立列）。于是 `participants.indexOf(dragLeftId) < 0` 直接 return。

**对照取证**：仅在内存里把 `groupIds` 补到 4 项（不动产品文件），拖第 2 条立刻生效：
`[171.75, 294.25, 49.23, 171.75]`、`widthSum 698.98 ≈ 699`、`overflowRight -0.02`、`sizes` 四键齐全。
这是“根因锁定”，不是修法。

**修法**（`bindGroupWorkspaceSplitter` 的 `flush`）：

- 参与者改用 `getGroupWorkspaceVisibleColumnKeys()`（DOM 里真实可见的列，按顺序）；
- 旧比例改用**当前实际列宽**归一（不用可能只覆盖部分列的 `sizes` 表）；
- 写回时把每一列都写进 `sizes`，保证它是一份完整、和为 1 的快照。

#### 13A.17.2 缺陷二：列比例表只覆盖部分列 → 最右列溢出

**根因**：比例这份事实在两个地方各自补齐——模型原样转发 `ws.split.sizes`，渲染层对缺失列回落
`1 / plan.columns.length`；两者相加超过 1。

**修法**（`buildRenderPlan`）：新增 `domKeys` 与 `layoutSizes = normalizeSizes(ws.split.sizes, domKeys)`，
`columns[].size` 与 `columnLayout.sizes` 同源于它；未分屏时不产生比例（`{}` / `size: null`）。
`normalizeSizes` 是纯函数，不写回 `ws`。单测 +3 条（部分比例表 / 空比例表 / 关分屏不带比例），**567/567**。

#### 13A.17.3 三处“测不下去”的前提错（不是产品缺陷）

| # | 现象 | 真因 | 处置 |
|---|---|---|---|
| 1 | COM11 连上但终端没有任何 `Motor value reached` | UI 默认波特率 9600，设备侧是 **115200**。直开串口实测：115200 → 126 B / 5 s、3 条 Motor 行；9600 → 7 B 乱码、0 条 | 脚本先把侧栏波特率切到 115200（走真实 change 事件） |
| 2 | `<logPath>/COM11/` 目录在但空 | tab 日志先写 `tabLogBuffers`，由 `flushTabLogEntrySync` 在 `flush-tab-logs` / 断开 / 定时才落盘；连接中读盘必然是空的 | 脚本读盘前先发产品自己的 IPC `flush-tab-logs`，断言一字未改 |
| 3 | 字节已进渲染进程（`serial-output-bytes` 计数正常）但终端不显 | CDP 起的窗口 `document.visibilityState === 'hidden'` 时 **rAF 被完全节流**（500 ms 内 0 帧），字节压在 `serialOutputBuckets` 里（`pendingBytes` 持续增长、`flushScheduled=true`） | 脚本开头调 `Emulation.setFocusEmulationEnabled({ enabled: true })`：visibility 变 `visible`、rAF 恢复到约 52 帧 / 500 ms |

第 3 条的完整证据链：`probe-raf-starvation.js` @ `diag909` 记录 `before-connect { pendingBytes: 0 }` →
`after-6s { pendingBytes: 126, motor: 0, flushScheduled: true }` → 手动 `flushPendingSerialOutput()` 后
`motor: 3`；`probe-bringtofront.js` / `probe-focus-visibility.js` 证明 `Page.bringToFront` 与 Win32
`SetForegroundWindow`（`focus-app.ps1`）**都不能**让 visibility 变 `visible`；`probe-force-active.js` 证明只有
`Emulation.setFocusEmulationEnabled` 有效（`raf= 0` → `raf= 52`）。

这是**测试环境**问题：产品本来就设计成隐藏时缓冲、恢复可见时再分批上屏（与 `[Display output skipped ...]` 同源）。

#### 13A.17.4 原生右键菜单：探针假设被证伪

曾用 Win32 经典菜单窗口类 `#32768` 作判据，40 ms 采样恒为 0。这个 Electron（28.3.3 / Windows）的菜单
走 Chromium Aura，不是 HMENU。真正判据是**新出现一个可见的 `Chrome_WidgetWin_2`**（+ `SysShadow` 装饰窗），
Escape 后一起消失；`PrintWindow(hwnd, hdc, 2)` 能抓到菜单四项（Split Groups Left/Right、Top/Bottom、
Close Group Split、Add Serial Port）。属**探针假设错误**，不是产品缺陷，也没给产品加任何诊断钩子。

#### 13A.17.5 窗口尺寸：CDP 没有 setWindowBounds，innerWidth 会滞后

- 这个 Electron 的 CDP **没有实现** `Browser.getWindowForTarget` / `Browser.setWindowBounds`（页面级与
  browser 级 socket 都返回 -32601）→ 改用 Win32 `SetWindowPos`（`resize-app.ps1`），
  走的正是用户拖窗口边框那条路（`WM_SIZE` → renderer `window.resize`）。
- `window.innerWidth` **会滞后**：连续两次 resize 后仍报上一档。必须轮询到“等于目标值且连续两次一致”，
  不能固定 sleep。
- `probe-fit-gate.js` 确认 `workspaceFitFrame` 闸门不会卡死。

#### 13A.17.6 验证结果与未做项

| 项 | 结果 |
|---|---|
| `verify-four-column-drag-fit`（4 列真实拖拽 + 两档窗口 + fit 反向对照） | **39/39 PASS**（`diag889`） |
| `verify-native-context-menu`（可见 popup 窗口计数 + PrintWindow 内容） | **12/12 PASS**（`diag881`） |
| `verify-two-port-isolation`（单端口真实流 + 双端口同开隔离） | **21/21 PASS**（`diag913`） |
| 全量单测 | **567/567** |
| `run-all -Start 890` | 14 个 `exit=0` + `renderer-diag=clean`；`verify-same-port-guard` `exit=2` 为环境性 SKIP（幽灵 COM6） |

**未做：双端口收发回环**。本机 `SerialPort.list()` 只有 COM17 / COM1 / COM18 / COM11（另有幽灵 COM6），
12 个有序端口对全部试过均无回环，也没装 `com0com`；安装 `com0com` 或换到有互连串口对的机器才能补做。
文档与汇报一律不得把它说成“双端口端到端已验证”。

**另一个易踩的坑**：`verify-two-port-isolation` 的日志断言必须在 `flush-tab-logs` **之后**读盘；
连接中读端口目录必然是空的，别把它记成产品缺陷。


---

### 13A.18 三项真实用户分屏回归的闭环（本轮）

用户实测报告（逐字）：

> `只有一个分组的时候，右键点击标签分屏无反应，右键点击日志窗口分屏会出现分屏异常，出现空的分屏，并且不能调整分屏宽度；
> 多个串口分组时，右键点击串口2组分屏，会将串口2组和所有shell一起移到新分屏，并且shell无法拖回到原来屏，拖动后会跑到新建第三分屏；
> 分屏变化、窗口大小变化等情况，终端窗口内容显示大小没有实时跟随`

#### 13A.18.1 七条代码缺陷（全部有实测取证，没有一条是测试写错）

| # | 缺陷 | 根因 | 修法 |
|---|---|---|---|
| 1 | 单分组右键标签「分屏无反应」 | 普通标签右键恒发 `terminalType:'group'`；主进程分组菜单两项分屏 `enabled: isMultiGroup`，单分组时全灰不可点，组内 pane 分屏入口完全不可达（diag914 B0 实测 payload `isMultiGroup:false`） | 新增 `requestWorkspaceTabContextMenu`：单分组发 `terminalType:'tab'` 并带 `canSplit`；`main.js` 白名单加 `'tab'` 与对应模板；多分组仍走 `'group'` |
| 2 | 组内 pane 分界条从不显示 / 不能调宽 | `reconcileRows` 只写 pane 显隐与 `flex-basis`，**从不按 `column.splitEnabled` 设置本组 `workspace-splitter` 的 `hidden`**（静态与动态条初始都是 `hidden`）；`flex-basis` 也没扣 10px 占位（diag916：`splitEnabled:true` 但条仍 `hidden / 0×0`） | `splitterEl.hidden = !(column.splitEnabled && specs.length > 1)`，**先显示再读 rect 算 gutter**（顺序反了读到 0）；`flex-basis = calc(<ratio>% - <ratio × gutter>px)`；隐藏 pane 时清掉残留 inline `flex-basis` |
| 3 | 非激活分组的 pane 条拖不动 / 拖了改错组 | `bindWorkspaceSplitter` 整条拖动路径用模块级别名（`isSplitEnabled` / `getOrientation` / `setPaneSizes` / `persistWorkspaceLayout`），只指向**激活分组** | 按 `splitter.dataset.groupId` 取该组 manager，新增 `persistGroupWorkspaceLayout(groupId)`；`persistWorkspaceLayout` 降为薄封装 |
| 4 | 「空的分屏」：主标签被移到 pane-2 后投影又拽回 pane-1 | 投影器在 `index !== 0` 时对 `mainId` 直接 `continue`，末尾无条件 `unshift(mainId)`（diag918：layout 已 `pane-1=[shell] / pane-2=[main]`，投影却是 `pane-1=[main] / pane-2=[]`） | 新增 `declaredMain`：哪个 pane 声明了主标签就放哪；仅当**没有任何 pane 声明**时才补到 pane-1 队首（两条互为反向对照的单测） |
| 5 | 已开启的 pane 分屏完全不出行（焦点在未归属 Shell 上） | `layoutColumns()` 非分屏分支用 `rootOf(focused)` 定 `containerId`；焦点在 Shell 上时它的根是自己，`containerId` 变 `null` → `layoutRowsOf` 返回 0 条 → `splitEnabled` 恒 false（diag919：`containerPaneSplit.enabled:true` 而 `rawPlan.columns[0].splitEnabled:false / rows:[]`） | `containerId` 改为「焦点是容器→它自己；焦点是容器子项→`parentId`；焦点是根级叶→`resolveLeafColumnId` 指向的容器；仍无→第一个容器」 |
| 6 | Shell 跟着激活分组跑；分组级分屏把全部 Shell 搬进那一列 | `resolveShellTopRowColumn()` **写** `tabState.columnId`（被只读投影器调用，投影改变模型），且用「当前是否可见」否定已有列记忆，回落值就是激活组；`createShellTab` 初始 `columnId: null`（diag914 C1：**仅点一下 g-1 组标签**，两个 Shell 的 `columnId` 就从 `default` 变 `g-1`） | 改纯读：`isColumnKeyAlive(remembered)` 命中就用（**不看 `hidden`**）；新增 `isColumnKeyAlive`；创建 Shell 时就把 `columnId` 写成创建所在分组 |
| 7 | Shell 拖回原屏却新建第三列 | 落点存的是**行元素 id**（行上没有 `data-group-id`，反查恒 `undefined`），且分组行分支无条件 `setShellColumnModeInModel(tabId, 'ownColumn')`（diag915 F3：拖一下变三列，各 233px） | 落点存 `rowTarget.groupId`；分组行分支改为 `hostGroupId=null` + `columnMode='row'` + `columnId=该列`（旧 §8.2 语义作废） |

**另有 1 条产品裁决**（不是缺陷）：**组内 pane 分屏需要 ≥2 个可移动标签**。移走唯一标签后 `reconcileEmptyPanes` 必然折叠回一个 pane，
用户看到的就是「点了没反应」；而空 pane 又被用户明确视为缺陷。⇒ 菜单项按 `canSplit = totalTabs >= 2` 置灰，动作入口再兜底。
**不引入空 pane，不得复活。**

#### 13A.18.2 验证结果

| 项 | 结果 |
|---|---|
| `verify-split-regressions`（37 项，新增） | **37/37 PASS**，renderer-diag=clean（`diag923`） |
| `verify-split-resize-fit`（15 项，新增，真实窗口 resize） | **15/15 PASS**，renderer-diag=clean（`diag925`） |
| 全量单测 | **570/570 / 0 fail**（567 → 570） |
| 全量回归 `run-all -Start 954`（17 脚本，两支新脚本已纳入） | **17/17 `exit=0` + `renderer-diag=clean`** |

窗口 resize 的关键数字：1280×800 两列各 538px、面板各 536×609，`default` 67×35 / `g-1` 65×40；900×640 面板各 346×449，
`default` 42×26 / `g-1` 41×29；回到 1280×800 **完全复原**。同宽重复 `fitWorkspaceTerminals` 与同尺寸重复 resize 均不变（反向对照）。
**全程未手动调用 fit**，只靠 `window.resize` 处理器——这一条是本轮唯一新增的要素（用户原话的「窗口大小变化」）。

#### 13A.18.3 两处过期断言（不是产品缺陷，按新语义改写）

| 脚本 | 旧断言/步骤固化了什么 | 新判据 |
|---|---|---|
| `verify-shell-drag` | 「拖到分组标签行 = `ownColumn` 独立列」的 6 条断言（`group-tab-row-drag-creates-shell-column` 等） | 新语义 5 条：`group-row-drop-creates-no-shell-column` / `-keeps-column-count` / `-keeps-row-mode` / `-lands-on-target-column` / `-shell-stays-in-a-group-tab-row`（23/23，diag952） |
| `verify-shell-switchback` | `P6` 步骤按 `sidebar-active-group` 找列，固化了「Shell 借住在激活组列」的旧行为 | 判据不变（该列下层行必须可见），步骤改为取 **Shell 按钮所在列**（14/14，diag953） |

#### 13A.18.4 探针 / 编辑自身的 bug（9 处，全部未改产品代码）

| # | 症状 | 根因（探针或编辑自身） | 处置 |
|---|---|---|---|
| 1 | 一条 menu payload 都抓不到（`:: null`） | `window.ipcRenderer` 在 CDP 里恒 `undefined`（renderer 用 `require('electron').ipcRenderer`） | 改 `require('electron').ipcRenderer` 挂 send 探针 |
| 2 | 单测 `expected 2 actual 3` | `setPaneSplit(ws, id, true)` **自带 `addPane`**，测试里又手动加一次 | 删掉手动 `addPane`，并断言 `panes.length === 2` |
| 3 | `terms['g-1'] = null` | 非默认分组 runtime 惰性创建，未连接时 `serialRuntimes.get('g-1')` 为 `null` | 测 fit 前显式 `serialRuntimes.getOrCreate('g-1')` |
| 4 | 分界条显示后 pane 仍溢出 | 先读 splitter rect（当时 hidden）再写 `hidden=false`，gutter 读到 0 | 交换顺序：先写 hidden，再读 rect |
| 5 | `exit=1` 且结果文件 0 字节，`.err` 报 `SyntaxError: missing ) after argument list` | 探针模板字符串里嵌了反引号 | 改成 `require('electron')` 写法 |
| 6 | `scan-undefined.js` 报 `Unexpected token ']'` | 候选数组里多了一个 `]` | 改回正确结尾 |
| 7 | `renderer.js` 连续报 `missing )` / `Unexpected token '}'` / `Unexpected token 'function'` | 多次 `File.Edit` 分别留下多余的 `}`、重复的 `handlePointerUp` 段、重复的 `fitWorkspaceTerminals` 收尾 | 按 `node --check` 报的行号逐个删除，直到 `module body initialized without throwing` |
| 8 | `move-to-other-pane` 出现两个 `case` | 替换时旧分支未删 | 删除旧分支 |
| 9 | `verify-split-resize-fit` 首跑 `exit=2`，`Uncaught SyntaxError: Unexpected end of input` | `visibleColumns` 的箭头 IIFE 把长表达式链写成简写返回，括号层数不够 | 改成块体 `(() => { ... })()` |

**教训（可直接复用）**：同一份代码连续两次改动后输出字节完全相同 = 改动不在生效路径上；
UI 缺陷只认 `getBoundingClientRect` / `offsetParent` / `term.cols`，plan 与模型快照全对也可能界面是空的；
反过来，**断言失败也不一定是产品缺陷**——本轮两处都是步骤量错了列或固化了已作废语义。

#### 13A.18.5 旧 §8.2 语义被用户裁决修正（必须记住）

`TAB_ARCHITECTURE.md` §8.2 的落点表早期写着「拖到某列的分组标签行 → `setLeafColumnMode(ownColumn)` → 进共享独立列」。
该语义直接导致用户报告的「shell 无法拖回到原来屏，拖动后会跑到新建第三分屏」，**已作废**。现行规则：

- 拖到**普通分组列**的分组标签行 → `hostGroupId=null` + `columnMode='row'` + `columnId=该列`（停在那列列首行，**不新建列**）；
- 只有拖到**共享 Shell 独立列自身**或明确的独立成列动作才置 `ownColumn`；
- 两个写入口仍两向互斥（`ownColumn ⇄ hostGroupId` 不能同时成立）。

### 13A.19 四项多串口回归（Shell 按钮 / 第三个分屏 / 分组字体 / 发送路由）

用户实测报告（逐字）：`有些情况，两层标签栏都不会显示shell新建按钮，用户无法新建shell；开启两个串口分组并分屏，无法右键第三个串口组或者shell标签建立第三个分屏；新建的串口组的日志终端的字体没有使用设置的字体；发送链路都没有适配多串口组`。

#### 13A.19.1 五条代码缺陷 + 一条加载期崩溃

| # | 缺陷 | 根因 | 修法 |
|---|---|---|---|
| ① | 从多分组关回单分组后，两层标签栏都不显示「新建 Shell」 | `syncShellAddButtonVisibility` 在 `isMultiGroup` 为真时把 pane 行按钮置 `hidden = true`，然后 `if (!isMultiGroup) return;` **提前返回** | 删掉提前 return，改双向写（该双向写后来又因用户裁决改为恒显示，见 13A.20） |
| ②-a | 右键某分组建分屏时它没进参与者表；已分屏时再右键第三个组会把前两组踢出去 | 三跳各丢一次：`sendAction` 不回传 `groupId`、渲染侧不带 `groupIds`、`setGroupWorkspaceSplit` 直接覆盖 | 回传 `groupId` + 参与者表改为**并集累积**（`[...requested, ...previous]` 去重） |
| ②-b | 多分组时右键 Shell 标签拿不到「独立成列」 | ① `requestWorkspaceTabContextMenu` 在多分组时直接转分组菜单（`tabId` 丢）；② `bindGroupTabListEvents` 的 contextmenu 委托把行内非分组标签全交给分组菜单 | 按**标签自己的类型**分流：`isShellTabId` → `terminalType:'tab'` 带 `tabId`/`canDetach`/`shellOwnColumn`；`'tab'` 模板新增双向项 |
| ③ | 新建分组的日志终端不用设置里的字体 | 模板 `buildSerialTerminalOptions` 不含字体；`applyConfig` 只写默认分组与模块级 `filterTabs`，**不遍历 `serialRuntimes`** | 模板补齐字体/主题；`applyConfig` 遍历注册表逐组下发 |
| ③附带 | 模板补齐字体后 renderer 整个加载不起来 | 默认分组终端在模块加载期就建，`currentConfig` 还是 `null`，`getTerminalTheme` 读 `highlightColors.selection` 抛 `TypeError` | 模板先建基础 options，`if (!config) return options;` 才补字体与主题 |
| ④ | 发送链路没适配多分组 | `resolveSerialGroupId` 未登记一律回落默认组，四个调用点都没传 `groupId`；另两个解码器/缓冲是全局单例 | 四个入口补组 ID（快捷指令触发取**该批字节所属分组**）；`quickTriggerDecoders` / `quickTriggerBuffers` 改 `Map` 按组分桶 |

#### 13A.19.2 本轮教训

- **大文件里插新 case 时，把邻接的 `case 'close-group-split'` 整段覆盖掉了**，导致「关闭分组分屏」完全失效，被 `run-all` 四支脚本同时抓到。`node --check` 看不出语义丢失，必须数相邻 `case` / 函数个数。
- **一次假失败**：`verify-group-split @ diag1012` 报 4 条 FAIL（屏幕 3 列），根因是旧会话残留的后台循环让 **5 个 electron 进程争用 9222**，探针连到了别的实例。干净环境下 19/19。⇒ 出现「多列 / 多分组 / 按钮多出一个」这类不合常理的观测，**先查进程与端口**。
- **环境限制**：④ 段是「伪造注册表 `connected` + 包住 `serial-write`」取证，量的是**发给主进程的真实 payload**；本机无互连串口对、无 `com0com`，**没做双端口端到端回环**。不得说成真实串口收发已验证。

### 13A.20 两级添加图标永久显示、控件单一构造、右键新建入口（本轮）

用户实测报告（逐字）：

> `开启第二个串口组，点击第二串口组，再点击shell标签，一级标签栏的两个添加按钮都消失了，改了无数次还是有问题，你能力有限，还是做成一级二级都永久显示这些图标吧，并且在右键菜单页也加入新建各种标签；第一个串口组和第二个串口组的二级标签栏的两个添加标签页的按钮间距竟然不一样，说明两个明明可以复用的控件，还是单独实现，之前的工作都白做了；反思一下如何能做的更好`

#### 13A.20.1 缺陷 A：按钮自身没隐，隐的是它的宿主列

`probe-add-buttons2.js @ diag1051`（exit=0，renderer-diag=clean）按用户顺序逐步量：

| 步骤 | 按钮 `hidden` | 宿主行 | **宿主列** | shown | blockedBy |
|---|---|---|---|---|---|
| 加第二组 / 点第二组 | false | `serial-group-tab-bar-g-1`（可见） | `serial-group-workspace-g-1`（可见） | true | — |
| **点 Shell** | **false** | 同上（仍可见） | **`serial-group-workspace-g-1`（`hidden=true`）** | **false** | **`serial-group-workspace-g-1[hidden]`** |
| 点回 g-1 | false | 同上 | g-1（可见） | true | — |

根因：`placeShellAddButton()` / `placeGroupAddButton()` 都锚定 `getVisibleGroupRow(activeGroupId)`，而旧实现只判 `row.hidden`、**不判该行所在列**。点 Shell 后可见列切到 `default`，而 `activeGroupId` 仍是 `g-1`。

修法：`getVisibleGroupRow()` 改为无参扇描，同时要求「行未 hidden + 所在列未 hidden + rect 宽高 > 0」，都没有才回落静态行。

> **这条最值得记：`[hidden]` 是属性，可见性是祖先链的合成结果。只看按钮自身属性的断言，永远掍不到这类缺陷。**

#### 13A.20.2 缺陷 B：两组间距 8.39px vs 4px，因为控件真的写了两份

`probe-add-buttons3.js @ diag1052`（exit=0）：

| 来源 | `display` | `gap` | 空白文本节点 | 每按钮 `margin-right` | 实测相邻间距 |
|---|---|---|---|---|---|
| 单分组 `#pane-1-tab-actions`（index.html 手写） | block | normal | **6 个** | 4px | **8.39 / 8.39 / 8.39 px** |
| 多分组 `pane-1-g-1`（动态建） | block | normal | **0 个** | 4px | **4 / 4 px** |

双重根因：① `index.html` 的 pane-1/pane-2 与两个 pane 构造器里各写一份按钮构造；② `.pane-tab-actions` **完全没有 CSS**，容器退化成 `display:block`/`gap:normal`，间距 = `margin-right 4px` + **HTML 换行缩进渲染出的一个空格宽（≈4.39px）**。**布局依赖源码里的空白**，是最脆弱的一种。

#### 13A.20.3 修法：唯一构造路径 + 间距只由 CSS gap 决定

- `PANE_ACTION_BUTTON_SPECS` + `createPaneActionButtons(paneId)` + `fillPaneActionButtons(actionsEl, paneId)`；两处动态 pane 与静态 pane-1/pane-2 加载期重建**全部**走它。
- 按钮一律 DOM API 创建，**不插任何文本节点**；`.pane-tab-actions` 加 `display:flex; gap:4px; padding:0 8px`，`.pane-new-tab-btn` 删掉 `margin-right`。
- 不能用 `replaceChildren`（模块加载门禁的 DOM stub 只实现 `removeChild`/`appendChild`）。
- 新增按钮只改 `PANE_ACTION_BUTTON_SPECS`，不再改两处 DOM。

#### 13A.20.4 本轮我自己造成的三个回归（必须记住）

| # | 现象 | 根因 | 教训 |
|---|---|---|---|
| 1 | **一次点击创建两个标签**（`verify-user-paths` 报 4 个 shell） | `createPaneActionButtons` 已绑 click，文件末尾旧的 `pane-1-new-*-tab-btn` 手动绑定还在；静态按钮被重建后旧绑定落在新节点上再绑一次 | **把控件收敛成唯一构造路径时，必须同步删掉旧的手工事件绑定**，否则「复用」反而放大成双份副作用。`node --check` 与门禁都抓不到 |
| 2 | `SyntaxError: Unexpected end of input` @11053 | 删那段时 `end_line` 覆盖到了后续 `forEach(…` 的收尾 `)});`，并残留一行重复的 `querySelectorAll` | 大文件删整段时 `end_line` 必须取到**整段最后一行**；改完立即 `node --check` |
| 3 | 门禁报 `actionsEl.replaceChildren is not a function` | 门禁 DOM stub 没实现它 | **工具适配问题，不是产品缺陷** |

#### 13A.20.5 结构性反思：为什么这里「改了无数次还是有问题」

不是偶然失误，是三个结构问题叠加：

1. **同一个控件写了三份**：`index.html` 静态 pane-1/pane-2 + `createPaneElement` + `createGroupPaneElement`。改一份另两份不跟着变，而这种不一致只能靠「仔细看间距」发现。
2. **可见性判据散在三处**：`placeShellAddButton()` / `placeGroupAddButton()` 决定**放哪行**，`syncShellAddButtonVisibility()` 决定**自己是否 hidden**，`renderShellTabBar` 的调用顺序决定**什么时候算**。三者各自看起来都对，只在特定形态组合下出错——所以每次只修一处都会「看起来好了」。
3. **断言只盯属性不盯合成结果**：历史上多条断言只查 `button.hidden`，于是本轮缺陷 A（按钮 `hidden=false` 但宿主列 `hidden=true`）能穿过整套测试。

可执行的收敛做法（已落地）：删掉重复实现只留一条构造路径；把可见性判据收到「用户真正能看见的行」一处；用**反向对照**锁死（不只断言看得到，还断言「它没有 hidden 的祖先」、「两组几何逐项相等」）。

#### 13A.20.6 验证结果

| 项 | 结果 |
|---|---|
| `verify-add-buttons`（新增，21 项） | **21/21 PASS**，renderer-diag=clean（diag1054 / diag1138） |
| `verify-four-defects`（**45 → 47 项**） | **47/47 PASS**（diag1105 / diag1137）；A 段 6 条旧「恰好一个可见」改为 6 正向 + 6 反向对照 |
| `verify-shell-buttons-split`（16 项） | **16/16 PASS**（diag1104 / diag1132），两条断言按新裁决改写 |
| 全量回归 `run-all -Start 1120` | **19/19 `exit=0`**，19 个 `renderer-diag=clean` |
| 全量单测 | **570/570 / 0 fail** |
| 静态门禁 | `mod=0` / `checked=95 missing=none` / `blocks total=28 js=19 syntaxErrors=0 arityHints=0` |

**旧基线永久失效**：`verify-four-defects` 的 45/45（diag987）不得再引用。

**环境与手段限制（必须如实标注）**：CDP 合成输入 ≠ 真人手测；本机无互连串口对 / 无 `com0com`，**没做双端口回环**。

---

### 13A.21 分组分屏后原组标签点不动（click 根本没被合成）+ CDP 启动等待收敛（本轮）

用户实测报告（逐字）：

> `新建串口组分屏之后，原来的串口的主页面标签和过滤标签都点击不了了；另外run-all.ps1测试每次开启应用窗口后要等很久才开始测试操作，效率很低，能否在应用开启准备好后立即触发开始测试`

#### 13A.21.1 第一轮方向错了：以为是「写错分组」

第一轮沿用上一轮的模型（`switchPaneTab` 用模块级别名 `workspaceManager` = 当前激活分组的布局），
确实修对了一处真缺陷：未分屏/单列时焦点变了但布局 `activeTabId` 没变。但用户报告的是**分屏后点不动**，
而这个修法**不够**——因为真实鼠标点击根本没有产生 `click`。

教训：**「点了没反应」有四种完全不同的成因**——被遮挡 / 命中错 / 状态没写 / **事件没产生**。
前三种都能靠「直接 `element.click()` 好不好使」快速二分；本轮就是靠这条对照在 3 分钟内把方向纠正过来。

#### 13A.21.2 取证：一级行有 click，进入工作区就没有

| 文件 | 观测 |
|---|---|
| `geo-1157.txt` | 补齐 `buttons` 位后点二级标签，只有 `pointerdown` / `mousedown` / `mouseup`，**无 `click`**；同一次运行里 `dispatchEvent(new MouseEvent('click'))` 立刻生效 |
| `node-1158.txt` | 点静态「新建过滤页」按钮**同样无 `click`**，而点一级标签行（y≈40）有 `click` ⇒ 与标签类型无关，与**区域**有关 |
| `drag-1159.txt` | y=40 / 50（一级行）有 `click`；y=70~120（`#group-workspace` 内）没有 |
| `sweep-1160.txt` | 一级行 y=34~62 全部有 `click`；进入 `#group-workspace` 后全部没有 |
| **`blk-1163.txt`** | **决定性**：只在 capture 阶段 `stopPropagation` 拦掉 `.workspace-pane` 的 `mousedown`，同一坐标的 `click` **立刻恢复** |

#### 13A.21.3 根因与修法

两个 pane 构造器（`createPaneElement` / `createGroupPaneElement`）都在 `mousedown` 里做会重建 DOM 的事：
`setActivePane()` → `onLayoutChanged()` → `renderWorkspace()` 重排按钮、搬动面板；非激活分组还会走
`applyActiveSerialGroup()` 整组重渲染。**按下时把被点的按钮或其祖先换掉**，浏览器判定「按下与抬起不在同一节点」，
**不合成 `click`**。

```js
// ① workspace-manager.js：值没变就不请求渲染
function setActivePane(paneId, { persist = true } = {}) {
    const layout = getLayoutState();
    const paneIds = getPaneIds();
    const nextPaneId = paneIds.includes(paneId) ? paneId : (paneIds[0] || 'pane-1');
    if (layout.activePaneId === nextPaneId) return;
    layout.activePaneId = nextPaneId;
    if (persist) persistLayout();
    onLayoutChanged?.();
}

// ② renderer.js：两个构造器的时机从 mousedown 改到 click
paneEl.addEventListener('click', () => setActivePane(paneId, { persist: true }));
```

**必须两个构造器都改**——只改一处就会剩下一半区域继续吞 click。这与 §13A.20.5 第 1 条（同一控件写三份）完全同源。

#### 13A.21.4 四层判据 + 反向对照

| 层 | 读什么 | 修前 diag1141 | 修后 |
|---|---|---|---|
| L1 布局 | `plan.plan.columns[].rows[0].activeTabId` | `tab-main`（点过滤页后仍是） | 与目标一致 |
| L2 焦点 | `plan.sections.focusedTabId` | `tab-filter-1` | 与 L1 同步 |
| L3 模型 | `columns[].panelIds` | `["tab-main"]` | 与 L1 同步 |
| L4 DOM | `.main-tab-pane.active` | `["tab-main"]` | 与 L3 一致 |

反向对照：**R1** 点之前该列确实显示另一个标签；**R2** 另一列不受影响；**R3** 激活分组不被悄悄改掉。

#### 13A.21.5 本轮我自己造成的五个脚本级坑（全部不是产品缺陷）

| # | 现象 | 真因 | 处置 |
|---|---|---|---|
| 1 | `verify-split-tab-click` 报 10 条整齐假失败 | `realClick()` 漏传 **`buttons` 位**，Chrome 不合成 `click`（只有 pointerdown/mousedown/mouseup） | 补 `buttons:0/1/0` 三步序列 |
| 2 | `probe-click-path` 只输出 `STATE` + `no filter tab` | 夹具前提不满足，脚本静默跳过 | 废弃，重写为自包含夹具 |
| 3 | `probe-click-why` 报 `window is not defined` | Node 侧直接写 `window.__mark`（`window` 只在渲染进程） | 改为 `ev('(window.__mark = 1, true)')` |
| 4 | `probe-split-click` 报 `a-two-groups-exist :: ["default"]` | `.serial-group-tab` 上没 `dataset.groupId` | 改按按钮 id 解析 |
| 5 | `probe-which-move` 报 `POINT=null` | 夹具前提不满足（未加过滤页，取不到 `tab-filter-1-button`） | 脚本作废，改用 `blk-1163` 的阻断实验 |

**纪律**：以上一律只改探针，**不得记为产品缺陷**，也不得据此改产品代码。

#### 13A.21.6 一条旧判据失效（不是产品回归）

`verify-split-tab-click` 关分屏那一项原断言「默认列 `l4` 非空」。而此时激活分组是 `g-1`、默认列按设计 hidden
（未分屏时只显示激活分组那一列），`l4` 为空是**正确行为**。已改写为「可见列恰好 1 个且等于激活分组」+
「该可见列 `l4` 非空」。**不是为了让测试变绿而放宽期望。**

#### 13A.21.7 启动等待：先量后改，并如实报告瓶颈

```text
MEASURE: port=893ms ready=2018ms total=2753ms stableSamplesChanged=0/10
```

- `ready` 之后再观察 600 ms，列/按钮/pane/计划列数 **10 次采样 0 次变化** ⇒ 原来那 350 ms「稳定余量」没有依据；
- 三处收敛（均为测试基础设施，**五条就绪判据一条未动**）：`wait-ready.js` 的 `STABLE_MS` 350 → 0；
  `run-cdp.ps1` 新增 `Invoke-NodePiped`（`& node ... \| Out-File`，去掉 `Start-Process`）；`run-all` 19 → 20 支；
- 实测：每支 `wait-ready` 由 `2551–2619ms` 降到 `2051–2149ms`（**省 400–500ms/支**）。

**必须同时说清的边界**：启动等待本身只占每支约 2.0–2.2 秒（20 支约 45 秒），`run-all` 整体 14–16 分钟的
**主因是每支脚本内部的固定 `sleep`**（单支 25–136 s）。本轮**没有**把那些 `sleep` 改写成 `waitFor(条件)`。

#### 13A.21.8 一条 PowerShell 环境事实（新增）

Windows PowerShell 5.1 读取**无 BOM** 的 `.ps1` 时按 ANSI 解析；写进 UTF-8 中文注释会让解析器报
`意外的标记"}"`。⇒ **`.me/tmp` 下的 `.ps1` 必须纯 ASCII**。判据：
`[System.Management.Automation.Language.Parser]::ParseFile(...)` 的 `errors=0`。

#### 13A.21.9 验证结果

| 项 | 结果 |
|---|---|
| `verify-split-tab-click`（新增，19 项） | **19/19 PASS**，exit=0（diag1166 / diag1167 / diag1219） |
| 全量回归 `run-all -Start 1200`（20 支） | **20/20 `exit=0`**，20 个 `renderer-diag=clean`（`run-all-1200.txt`） |
| 全量单测 | **570/570 / 0 fail** |
| 静态门禁 | `mod=0` / `checked=95 missing=none` / `blocks total=32 js=22 syntaxErrors=0 arityHints=0` |
| 启动等待 | `wait-ready` 每支省 400–500 ms（前后对比已记录） |

**环境与手段限制（必须如实标注）**：CDP 合成输入 ≠ 真人手测；本机无互连串口对 / 无 `com0com`，
**没做双端口回环**。

---

### 13A.22 左边栏滚动条贴住控件（本轮）

用户实测报告（逐字）：

> `左边栏的滚动条太靠左边，导致会轻微到挡住其他元素，往右移一下`

#### 13A.22.1 取证：它不在左侧，问题是没有间隙

先量再改（`sbsb-1221.txt`，diag1221）：

| 容器 | 滚动条 X 区间 | 控件最右边界 | 两者间距 | 容器右边界 |
|---|---|---|---|---|
| `.sidebar-tab-pane#tab-settings` | 182..190 | 182 | **0** | 200 |
| `.sidebar-tab-pane#tab-search` | 182..190 | 182 | **0** | 200 |
| `.shell-sidebar-content`（对照） | — | 1190 | **10** | 1200 |

全局 `::-webkit-scrollbar` 是 `width:8px`，正常走容器右边缘——所以“太靠左”并不是它跑到了左边，
而是**右侧留白留在了滚动条外面**：`.sidebar-content { padding: 10px }` 把整个滚动容器往里推，
于是滚动条紧贴着控件（间距 0），而它右侧到边框又空出 10px。视觉印象就是“滚动条往左靠、压住了控件”。

佐证截图：`sb-before.png`（修前）、`sb-after2.png`（修后）。

#### 13A.22.2 修法：把右侧留白下放到滚动容器内部

```css
/* 修前：.sidebar-content { padding: 10px } .sidebar-tab-pane { /* 无 padding */ } */
.sidebar-content {
    padding: 10px 0 10px 10px;   /* 右侧不再在滚动器外面留白 */
}
.sidebar-tab-pane {
    overflow-y: auto;
    padding-right: 10px;          /* 留白进到滚动器内部，滚动条随之落到外缘 */
}
```

效果：滚动条由 `182..190` 移到 `192..200`（真正的外缘），控件与滚动条间距由 **0 → 10px**，
与 `.shell-sidebar-content` 的观感一致；控件左边界不变（仍为 10），没有把内容挤歪。

#### 13A.22.3 验证与反向对照

| 项 | 结果 |
|---|---|
| `verify-sidebar-scrollbar`（新增，11 项） | **11/11 PASS**，exit=0（diag1223） |
| 全量回归 `run-all -Start 1240`（21 支） | **21/21 `exit=0`**，21 个 `renderer-diag=clean`（`run-all-1240.txt`） |
| 全量单测 | **570/570 / 0 fail** |

11 项构成：设置页 5 条 + 搜索页 5 条（容器找到了 / 滚动条确实存在 8px / 滚动条贴容器外缘 /
控件与滚动条间距 ≥ 10px / 控件未被向左挤），加 Shell 侧栏 1 条不回归。

**反向对照（判据有区分力）**：`probe-negate-padding.js` 把旧内边距用 `!important` 注入回去后，
同一测量立刻回到 `contentGapToScrollbar=0`、`scrollbarLeft=182`。⇒ 判据不是恒真。

#### 13A.22.4 两条可复用的经验

1. **“滚动条位置不对”要先分清是「在左/在右」还是「有没有间隙」**。只想“往右移”很容易误改
   `::-webkit-scrollbar` 或 `direction`，而真正的原因是 padding 留错了层（在滚动器外面 vs 里面）。
2. **两个侧栏的滚动容器结构不一样**：`.shell-sidebar-content` 自己就是滚动容器（padding 天然在里面），
   `.sidebar-content` 是外层 + `.sidebar-tab-pane` 才是滚动容器（padding 落在了外面）。
   跨组件比对“同一指标的实际值”（这里是 10px vs 0）能一句话定位差别，比读十行 CSS 更快。


---

## 14. AI 接手时建议的工作流程


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
3. 明确本次修改属于串口收发、终端显示、过滤、图表、Shell、主输入、设置、多语言、日志、更新/发布、遥测服务或配置迁移中的哪一类。
4. 若改动输入框逻辑，必须验证：
   - 主终端逐键发送是否仍正常
   - 过滤输入焦点是否正常
   - 发送历史是否正常
   - 多语言是否正常
5. 若改动过滤逻辑，必须验证：
   - 主终端显示是否正常
   - 不会截断/缺失/错行
   - 过滤历史保存/恢复是否正常
6. 若改动图表逻辑，必须验证解析 Worker、数据保留、主图/时间轴同步、CSV、重连清空和关闭资源释放。
7. 若改动搜索逻辑，必须验证主/过滤/Shell 目标切换、选区快捷搜索、搜索历史和大 scrollback 响应。
8. 若改动更新或遥测服务，必须同时运行根测试与 `telemetry-server` 测试，并核对 README、workflow 和部署说明。
9. 若改动配置逻辑，必须验证：
   - 启动恢复
   - 保存 JSON 结构
   - 设置窗口/主窗口读取是否一致

---

## 15. 推荐后续改进方向

1. 按 `ToDo.md` 优先解决大 scrollback 搜索的同步阻塞，增加分批扫描、generation 取消和匹配上限。
2. 逐步把 `renderer.js` 中可独立测试的 terminal/filter/main-input/sidebar/i18n 编排拆出模块。
3. 补齐完整配置归一化、mock serialport IPC、Shell session 生命周期及图表长时间行为测试。
4. 逐步迁移 Electron 到 preload + contextBridge，并收窄 renderer 可调用 IPC。
5. 完成 Linux 打包、真实/虚拟串口矩阵和主窗口完整人工交互回归。
6. 继续补齐非英语语言的新功能键；CI 目前仅强制简中覆盖英语基线，其它语言允许回退英语。
7. 多串口支持：按 `MULTI_SERIAL_DESIGN.md` 的 P1–P5 推进，先把单串口单例改为 `Map<groupId, session>` 并用双端口真机验证并发可行性，再动渲染层与标签栏。

---


## 15A. 分屏工作区方案 A（历史实施记录，功能已落地）

> 本节保留最初设计与验收思路。当前实现以 `workspace-manager.js`、`renderer.js` 和测试为准，不要按本节“计划新增”的措辞重复实现。

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
- ~~自定义 shell 可执行路径~~ (已实现，见 shellProfiles)
- 将主输入框复用于 shell 发送
- 将 shell 输出接入串口高亮/过滤链路
- 多级 pane 嵌套

#### 15B.1.1 右侧 Shell 侧边栏

在主界面右侧新增 shell 侧边栏，通过左下角 `>_` 按钮切换显示。

- 侧边栏内按 `shellProfiles` 配置动态渲染"新建 Shell 会话"按钮列表
- 支持"管理配置文件…"按钮，可打开设置窗口编辑 shellProfiles
- 显示当前活跃 shell 会话列表，支持点击切换、关闭
- 提供 Shell 选项：回车时自动添加 CRLF、重启时清空

#### 15B.1.2 shellProfiles 自定义 Shell 配置

类似 Windows Terminal 的配置文件机制，允许用户配置多个 shell 配置文件：

```json
{
  "shellProfiles": [
    {
      "id": "git-bash",
      "name": "Git Bash",
      "executable": "C:\\Program Files\\Git\\bin\\bash.exe",
      "args": ["-i", "-l"],
      "shellType": "bash"
    }
  ],
  "defaultShellProfileId": "git-bash"
}
```

- `id`: 稳定且唯一的 profile 标识
- `name`: 显示名称
- `executable`: 可执行文件路径
- `args`: 启动参数数组
- `shellType`: shell 类型标识（cmd/powershell/bash/zsh 等）

`defaultShellProfileId`: 字符串，设为 profile 的 `id`，用作默认新建 shell tab 时使用的 profile。
- 面板中的 `>_` 按钮和右键菜单的"新建 Shell 标签页"均使用此默认 profile
- 若未设置或默认项已删除，则使用系统默认 Shell，不会静默改用其他 profile
- 渲染层侧边栏中默认 profile 带 ● 标记
- 设置窗口可选中设为默认 Shell

实现要点：
- `getDefaultShellPath(profileSelector)` 优先按 profile ID 查找，再兼容旧名称/类型，最后回退到系统默认
- `getShellLaunchArgs(shellPath, profileSelector)` 优先使用 profile 内的 args
- IPC `get-shell-profiles` 返回 profiles 列表给渲染层
- 渲染层 shell 侧边栏动态加载 profiles 并生成按钮
- "管理配置文件…"按钮发送 `open-prefs` 消息打开设置窗口

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
- 主输入框、串口快捷发送、自动发送仍仅作用于串口；右栏 `shellQuickCommands` 只作用于当前活动且已就绪的 Shell 标签

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
  - 已收敛为“搜索行号并高亮行号文本”的稳定方案，未继续保留 Decoration 整行高亮尝试
  - 已移除未使用的源日志映射逻辑，降低状态维护复杂度

## 14A. 单串口组下 Shell 不能分屏（2026）

### 14A.1 症状与先取证的价值

用户原话：`在只有一个串口组情况下，shell不能分屏`。

这句描述很容易被当成「菜单项被置灰」或「分屏后 Shell 不在任何一行」，两种推测都错了一半。
真实情况是**两层叠加**，只有分开量才能看清：

| 层 | 实测值 | 证据 |
|---|---|---|
| 菜单准入 | `canSplit: true`（**可点，不是置灰**） | `sgs-1261.txt` 第 10 行 |
| 动作执行 | 调 `split-horizontal` / `split-vertical` 后 `rowCount` 仍 0、`splitEnabled` 仍 false | `sgs-1261.txt` 第 15、17 行 |
| 根因 | `pane-1.tabIds = ["tab-main","tab-shell-1"]` —— Shell 被登记进了 pane | `sgsint-1262.txt` 第 86–90 行 |
| 拒绝点 | `splitWorkspaceTabIntoPane` 首行 `if (!tabId || isShellTabId(tabId)) return false;` | `renderer.js` |

⇒ 用户看到的「不能分屏」= **菜单能点、点了没反应**。若不做这一步取证就直接改 `canSplit`，
只会把「能点但无效」改成「置灰」，用户的诉求（真的能分屏）依然没实现。

### 14A.2 根因：一条注释与实现相反的 I2 违规

`createShellTab` 里原本写着：

```js
addTabToOwningGroupPane(tabId, resolvedPaneId, { activate: false, persist: false });
```

紧邻的注释却是「Shell 不在任何分组的 panes[].tabIds 里（I2）」「新 Shell 默认不归属任何分组」。
**注释是设计意图，实现是反的。**

为什么它能活很久：`tabs-workspace-projection.js` 的 `projectWorkspace` 会把 shell 重新提到根级
（那里明确写着「shell 不进 pane（I1/I2），无论真实 tabIds 里有没有它」）。于是：

- **模型投影后的 plan 是干净的**（`columns[].tabIds` 不含 shell）；
- **渲染层自己维护的 `groupWorkspaceLayouts` 是脏的**（`pane-1.tabIds` 含 shell）。

而右键菜单的 `canSplit` 数的正是渲染层那份布局 ⇒ 两份数据分叉的地方就是缺陷藏身之处。

**可复用经验**：投影层的容错不能当作「脏数据无害」的依据。凡是在渲染层私有布局对象上写东西，
必须同时满足 I1/I2，而不是指望投影把它洗干净。

### 14A.3 为什么最终没有放宽 I1/I2

要让 Shell「被搬到另一个 pane」，它必须成为那个 pane 的成员，也就必须进 `panes[].tabIds`——
而这正是 I1/I2 禁止的，且 `TAB_ARCHITECTURE.md` §5.5 语义 2 逐字写着「Shell 仍不进入任何
subRow」。这不是实现细节，而是已经写入架构、并带 11 条反向对照用例的硬约束。

因此停下来向用户确认，得到明确选择：**方案 1 —— 不改 I1/I2，Shell 自成第二列**。
这条路径不新造能力：`columnMode === 'ownColumn'` 早就存在，只是被列级分屏的总闸挡住了。

### 14A.4 修复要点（6 处）

| # | 位置 | 改动 |
|---|---|---|
| 1 | `buildLiveWorkspaceSections` | `split.enabled` 从 `groupIds.length > 1` 改为 `isColumnSplitActive()` |
| 2 | `detach-to-own-column` | 补调 `ensureColumnSplitForShellColumn` |
| 3 | `join-group-column` | 补调 `collapseColumnSplitIfSingleColumn` |
| 4 | `pruneGroupWorkspaceSplit` | 退出条件从「存活分组 < 2」改为「真实列 key < 2」 |
| 5 | `close-group-split` | 复位前只收回 `ownColumn && !hostGroupId` 的 Shell |
| 6 | `createShellTab` | 删掉 I2 违规登记；`switchPaneTab` 换成 `setFocusedTab` |

第 1 条是关键：`layoutColumns` 在 `ws.split.enabled === false` 时**只能返回一列**，
所以不论 `columnMode` 写得多对，单分组下都看不出任何变化。

第 6 条里 `switchPaneTab` → `setFocusedTab` 不是风格选择：前者一进门就
`if (!pane.tabIds.includes(tabId)) return;`，Shell 不再进 pane 后它会直接返回，
新 Shell 不会变成当前显示的那个。

### 14A.5 自己引入的两处回归（必须记住的模式）

| # | 症状 | 我写错的地方 | 正确做法 |
|---|---|---|---|
| 1 | `verify-four-defects` 的 `b6-column-count-restored`：`beforeJoin:4 → afterJoin:1` | `ensureColumnSplitForShellColumn` 把 `groupIds` **覆写**成 `[id]` | 必须**并入**：`[...previous, id]` 去重；且 `enabled` 要在读旧表之后写 |
| 2 | `verify-shell-drag` 3 条 `group-row-drop-*` FAIL | `close-group-split` 无条件对所有 Shell 回退 `row`，连带已停靠列的 Shell 也写一遍并重渲染，把紧接的拖拽落点测量打偏 | 只收 `columnMode === 'ownColumn' && !hostGroupId`，且必须在 `resetGroupWorkspaceSplit()` **之前** |

共同模式：**「把某个开关整体复位」的代码，在多参与者场景下几乎总是错。**
参与者不止一种（分组列 / 独立列），复位时只应该动自己那一种，并且要在清空状态**之前**判断。

### 14A.6 一处假失败（不是产品缺陷）

`verify-shell-drag @ diag1314` 报了 8 条 FAIL，包括 `single-group-shell-stays-in-pane-row`
这种在脚本第 2 步就该成立的项。原因是前一次 `diag1313` 的命令因**终端会话静默失效**
从未真正执行，profile 目录处于半初始化状态。换全新 `diag1320` 复跑 → `exit=0`。

**已固化的纪律：单脚本失败先换全新 profile 复跑，再定性是产品缺陷还是环境/脚本问题。**

### 14A.7 验证结果

| 项 | 结果 |
|---|---|
| `verify-single-group-shell-split`（新增 26 项） | **26/26**（`diag1267` / `diag1312` / `diag1421`） |
| 全量回归 `run-all -Start 1400`（22 支） | **22/22 `exit=0` + 22 个 `renderer-diag=clean`** |
| 单测 | **570/570 / 0 fail** |
| `check-renderer-module-load` | `mod=0` |
| `scan-undefined` | `checked=95 / missing=none` |
| `check-arch-doc` | `blocks total=32 js=22 / syntaxErrors=0 / arityHints=0` |

新脚本的 26 项覆盖：I2 恢复（新建 Shell 后 `paneTabIds` 仍只有 `tab-main`）、菜单 `canSplit:false`、
detach 后 `columnCount=2`、两列真实几何（`left=201/603`、`width=398`、`top=32` 并排无重叠）、
Shell 落在 `__shell__` 列且串口列 `rows[0]=["tab-main"]`、两列 `panelIds` 互不干扰、
以及 join 后可逆回一列。

### 14A.8 探针自身写错的两处（不是产品缺陷）

1. `d-serial-column-keeps-main` 拿 `column.tabIds` 断言主标签 —— 分屏后列的 `tabIds` 装的是
   **容器 id**（`["default"]`），主标签在 `rows[0].tabIds`。断言必须按 `rows[0]` 写。
2. `STATE` 快照的 `columns` 映射漏了 `rows` 字段，导致 `serialCol.rows.some(...)` 抛 TypeError、
   脚本 `exit=2`。补 `rows: c.rows || []` 后恢复。

### 14A.9 环境边界（如实标注）

- 本机无互连串口对、无 `com0com`，**没有做双端口收发回环**。
- 全部结论来自真实 Electron + CDP 合成输入，**不是真人手测**。
- `git push`、发版、打 tag 均未获授权，本轮只做本地提交。

---

## 14B. 从旧配置启动后空右分屏 + Shell 点不开 / 拖不进 / 右键无反应（2026）

### 14B.1 症状与用户命令

用户原话（逐字）：

> 从已有配置文件启动应用，启动后有一个串口组的主窗口和过滤窗口以及一个shell标签，
> 并且出现空右分屏，shell标签点击无法打开，无法拖动到空的分屏，右键分屏也无反应；
> `C:\Users\cuijingbo\AppData\Roaming\serialterminal\config.json`

四条症状：① 空右分屏；② Shell 标签点不开；③ Shell 拖不进那个空分屏；④ 右键分屏无反应。

**这份 `config.json` 是复现的唯一入口。** 用干净 profile 复现不出来不代表没有缺陷——
前一轮就踩过「用空 profile 跑测试恒真」的坑。因此新写 `run-cdp-seeded.ps1`（后来也
给 `run-cdp.ps1` 补了可选 `-SeedConfig`），把用户真实 config 复制进新 profile 再启动。

> 安全前提：`--user-data-dir` 确实重定向 `app.getPath('userData')`（`main.js:143` 读的就是
> 它；profile 目录里生成了自己的 `config.json` 与 `logs`）。用户真实 config 只被**读取并
> 复制**，未修改、未删除。

### 14B.2 上一轮的假设被实测推翻（本文档最值得记的一条）

上一轮结尾留下三条推断，全部指向「配置里有孤儿 shell id」：

```
推断 1  顶层 workspaceLayout.splitEnabled=true + pane-2 只有 tab-shell-3
        ⇒ 建两列，Shell 又按 I1 被提到根级 ⇒ 第二列为空
推断 2  serialGroups[0].pane-1.tabIds 里有 8 个 shell id，shellTabs 只有 1 条
        ⇒ 脏 id 留在布局里，让 activeTabId 指向不存在的标签
推断 3  pane-2 的 tabIds 为空 + 两份 paneSplit.enabled 不一致 ⇒ rows 里出现空行
```

实测结果（`rcd-1500.txt`）：

```
paneTabIds = ["tab-main", "tab-filter-2", "tab-shell-3"]
⇒ 没有孤儿 id。推断 2 / 3 的前提不存在。
```

真正的事实是：**顶层 `workspaceLayout.pane-2.tabIds` 里就直接写着 `tab-shell-3`**——
不需要孤儿、不需要不一致，一份脏数据就够了。

教训：**推断写得再自洽，只要没量过就是假设。** 这次三条假设里只有第一条的一半对
（确实读了顶层那份、确实建了两列），但「为什么第二列为空」的解释完全错了。

### 14B.3 根因：I2 只在投影层容错，没在归一化层强制

完整链路：

```
config.json 顶层 workspaceLayout.pane-2.tabIds = ["tab-shell-3"]      ← 违反 I2 的脏数据
  ↓ applyConfig 8082/8305 行（早于 8312 行的 syncSerialGroupsFromConfig）
normalizeWorkspaceLayout → normalizeWorkspaceLayoutShape → normalizeLayoutShape
  ↓ tabIds 过滤只校验「非空字符串 + 未重复」，不校验是不是合法 pane 成员
pane-2.tabIds = ["tab-shell-3"] 被原样接受
  ↓ reconcileEmptyPanes 看到 filled.length === 2 ⇒ 直接 return，不折叠
splitEnabled 保持 true、两个 pane 都在
  ↓ projectWorkspace 按 I1 把 shell 提到根级
rows[1].tabIds = []、activeTabId = null，但容器 paneSplit.enabled 仍为 true
  ⇒ layoutRowsOf 返回 2 行 ⇒ 渲染层画出 941px 的空 pane
```

四个症状各自的分叉点：

| 症状 | 具体断点 |
|---|---|
| ① 空右分屏 | `reconcileEmptyPanes` 的 `filled.length > 1` 分支把「pane 里有东西」当成「这个 pane 该留着」，但那个东西按 I1 根本不属于它 |
| ② 点不开 | `visiblePanelIdsOfColumn` 首行 `if (rows.length > 1) return rows.map(r => r.activeTabId)`——**完全不看列首行的根级叶**，Shell 在 `columns[0].tabIds` 里却永远进不了 `panelIds` |
| ③ 拖不进 | 空 pane 的 `#pane-2-tabs-list` 的 `rect.height === 0`，落点命中判定框不住它，只写成了 `hostGroupId` |
| ④ 右键无反应 | `canSplit` 数 `panes[].tabIds.length` 时把脏 shell id 也数了进去（2 + 1 = 3 ≥ 2），菜单可点；而 `splitWorkspaceTabIntoPane` 对 Shell 是无条件硬拒 |

**关键认知：这四条不是四个 bug，是一条数据缺陷的四个投影。** 如果分别去修 `canSplit`、
去修拖拽落点、去修 `visiblePanelIdsOfColumn`，就会得到四个补丁而脏数据依然存在，下一份
旧配置又会重新长出这四个症状。

### 14B.4 修复（4 处，全部在模型/归一化层）

| # | 文件 | 改动 |
|---|---|---|
| 1 | `workspace-layout-shape.js` | 新增并导出 `isShellTabId(tabId)`；`normalizeLayoutShape` 的 `tabIds` 过滤里剔除 shell id |
| 2 | `workspace-manager.js` | `collapseSplit()` 合并 pane 时不搬 shell id（`movedTabIds` 与 `hostPane.tabIds` 都过滤） |
| 3 | `tab-model.js` | `visiblePanelIdsOfColumn` 的 `rows.length > 1` 分支：焦点是本列根级叶时显示它 |
| 4 | `renderer.js` | `totalTabs` 只数非 shell 标签；`canSplit` 追加 `!isShellTabId(tabId)`；删重复的 `renderWorkspaceNow()` |

第 2 条为什么必需：`collapseSplit()` 的合并是**无条件**的，不拦就每点一次「关闭分屏」往
`pane-1.tabIds` 里批量塞 shell id——实测 `rca-1501.txt` 量到 `[tab-main,tab-filter-2,tab-shell-3]`。
也就是说这个功能本身在**持续制造**下一次启动的空分屏。

第 3 条的判据必须限定在本列：只判「`parentId === null`」会对每一列都成立，Shell 的面板就
会同时出现在所有列上。正确判据是 `column.tabItems` 里确实有这个叶。

### 14B.5 一处「修了一半」的教训

第 4 项第一次只改了 `totalTabs` 的过滤，就以为 `canSplit` 会自动变 false。实测 `diag1503`：

```
totalTabs = 2（tab-main + tab-filter-2）≥ 2  ⇒ canSplit 仍为 true
```

因为过滤掉 shell 之后**还剩两个合法标签**，条件依旧成立；而对**Shell** 右键时那两项分屏
永远被硬拒。所以必须再补一条「被右键的标签自己可移动」。补后 `diag1504` 才 `canSplit:false`。

教训：**过滤脏数据只能修好「计数」，不能修好「对被过滤对象本人的准入」。** 两者是两件事。

### 14B.6 一条把 I2 违规当预期的过期单测（必须改）

`test/workspace-manager.test.js` 里原本：

```js
// 输入 pane-2.tabIds = ['tab-main', 'tab-filter-1', 'tab-shell-1', 'tab-shell-1']
assert.deepEqual(layout.panes[1].tabIds, ['tab-shell-1']);   // ← 把 I2 违规当预期
```

这条断言的字面含义是「pane 里可以住 shell」，与 I1/I2 直接冲突。改为去重语义用例，并新增
两条：`drops shell ids from panes and collapses the pane left empty`（本次缺陷的精确回归）、
`keeps a legitimate split while still dropping shell ids`（正向对照：只剔 shell，合法分屏不受影响）。

单测 570 → **572/572**。**没有为了让测试变绿而放宽任何断言**：唯一被删的是那条本身就错的。

### 14B.7 验证

| 项 | 结果 |
|---|---|
| `probe-restore-config-defect`（修后，同 config） | `pane-2` `hidden:true` / 0×0；`paneSplit.enabled:false`；`rows:[]`；`subRowCount` 2 → 1；点 Shell 后 `activePanels` 与 `panelIds` 都变成 `["tab-shell-3"]`；`paneTabIds` 无 shell id；`canSplit:false` |
| 新 `verify-restore-from-config`（11 项） | **11/11**（`vrfc-1504` / `diag1542`） |
| 全量回归 `run-all -Start 1520`（23 支） | **23/23 `exit=0` + 23 个 `renderer-diag=clean`**，`seeded=1` |
| 单测 | **572/572 / 0 fail** |
| 静态门禁 | `mod=0` / `checked=95 missing=none` / `blocks total=32 js=22` / `syntaxErrors=0` / `arityHints=0` |

新回归脚本的 11 项里，第 9–11 项（`shell-own-column-actually-splits` / `-is-visible-and-lit` /
`shell-returns-to-group-column`）同时证明了一件事：**用户抱怨「右键分屏无反应」的那个诉求，
在不动 I1/I2 的前提下依然有可用且可逆的入口**（独立成列）。所以这次不是「把菜单置灰了事」。

### 14B.8 环境边界（如实标注）

- 四条症状均由 CDP 合成输入 + 真实 `getBoundingClientRect` / `offsetParent` 量得，**不是真人手测**。
- 本机无互连串口对，未验证串口数据链路；本轮缺陷不涉及数据链路。
- 拖拽探针用的是合成 `PointerEvent` 序列，不是 OS 级拖放；它能改变模型状态说明事件确实到达，
  但不等同于真人手感。
- 用户真实 config 未被修改；测试写入全部落在 `.me/tmp/.../userdata-<Profile>/` 内。
- `git push`、发版、打 tag 仍未获授权，本轮只做本地提交。
- **一处探针自身缺陷不得记成产品缺陷**：`probe-restore-actions.js` 先执行 `close-split`
  （pane-2 消失）**之后**才测拖拽，`#pane-2` 的量已经为 0，那条 `PASS` 是无效结果；
  重写为只测拖拽的 `probe-restore-drag.js` 才拿到真正结论。**操作顺序会影响前提是否成立，
  必须把相互影响的步骤拆到不同 profile 上。**


## 15. 上下分屏后下方 pane 的标签不能右键（含「到底有没有复用」的正面回答）

### 15.1 用户原话

> 串口过滤页和主终端页上下分屏后，下面的标签不能右键点击，到底有没有复用啊，事件还是一个一个加的吗？

这句话里有两个必须同时回答的问题：一是「下方标签为什么不能右键」，二是「事件到底有没有复用」，
后者是对代码质量的直接质疑，不能只报「已修好」。

### 15.2 正面回答：机制复用了，「绑定这件事」没有复用

**右键机制本身是事件委托，确实是一个函数复用到底的。** `bindPaneTabListEvents(listEl)`
（`renderer.js:2199`）对一个 `.pane-tabs-list` 容器挂**一次** `contextmenu`，靠
`event.target.closest('.main-tab')` 反查被点的按钮。所以：

- 标签按钮后来被 `appendChild` 进来也能响应（不依赖按钮那时是否存在）；
- 不是给每个标签按钮逐个 `addEventListener`；
- 函数自带幂等保护：`if (listEl.dataset.paneTabEvents === '1') return;`。

**但把「哪些列表需要绑」这件事是一件一件补的。** 绑定入口原本散在四处：

| 位置 | 覆盖范围 |
|---|---|
| `createPaneElement` 内（2359 行） | **只覆盖新建 pane** —— 首行 `if (!paneId || getPaneDom(paneId)) return null;` |
| `createGroupPaneElement` 内（3989 行） | 非默认分组的动态 pane |
| `ensureShellColumnDom` 内（3827 行） | Shell 独立列 |
| 模块加载期手写（5206 / 5208 行） | **只有 `pane-1`**，而且写了两次 |

`index.html:327` 的 `<div class="workspace-pane" id="pane-2" hidden>` 是**静态写死**的，于是它恰好
落在四个入口的缝隙里：静态（不走 `createPaneElement`）、不是 `pane-1`（没被手写补）、不是分组/Shell 列。
**这就是「事件还是一个一个加的吗」的诚实答案：委托不是逐个加，但绑定点确实是一处一处补的，所以漏了一个。**

### 15.3 实测复现

用产品真实动作 `__handleContextMenuAction({ action: 'split-vertical', tabId: 'tab-filter-1' })`
把过滤页移入第二个 pane（`probe-pane-context-menu @ diag1600` → `pcm-1600.txt`）：

```
split: true   orientation: "vertical"
pane-1  rect {w:799, h:288, left:201, top:32}   tabs ["tab-main"]
pane-2  rect {w:799, h:288, left:201, top:330}  tabs ["tab-filter-1"]   p2List: true
```

确实是「主终端在上、过滤页在下」，`#pane-2-tabs-list` 元素也存在。右键结果：

| pane | `show-terminal-context-menu` 次数 | payload |
|---|---|---|
| `pane-1` | **1** | `{tabId:"tab-main", paneId:"pane-1", canSplit:true}` |
| `pane-2` | **0** | `[]` |

⇒ 用户症状精确复现：下方 pane 的标签行在整个生命周期里没有收到过任何 `contextmenu` 监听。

### 15.4 一处我自己的静态误判（必须记下来）

一开始读到 `renderer.js:5206` 与 `5208` 是两次逐字相同的调用，就判为「`pane-1` 的 contextmenu
被挂了两遍 ⇒ 右键会发两次 `show-terminal-context-menu`」。**这个判断是错的。**

核对第 2200–2201 行：

```js
if (!listEl || listEl.dataset.paneTabEvents === '1') return;
listEl.dataset.paneTabEvents = '1';
```

第二次调用直接 `return`。实测 `pane-1` 右键恰好 **1** 次也印证了这一点。

⇒ 那两行是**冗余但无害的死调用**，**不是**行为缺陷。定性必须靠实测行为，不能靠「看起来重复」。
**冗余代码 ≠ 行为缺陷** —— 这条现在写进 `TAB_ARCHITECTURE.md` §6.1.2 的判读提醒里。

### 15.5 修复

只改 `renderer.js` 一处（模块加载期）：

```js
// 旧：只硬写 pane-1，且重复了一行
bindPaneTabListEvents(document.getElementById('pane-1-tabs-list'));
bindPaneTabListEvents(document.getElementById('pane-1-tabs-list'));

// 新：覆盖所有已存在的 pane 标签行
document.querySelectorAll('#group-workspace .pane-tabs-list').forEach(listEl => {
    bindPaneTabListEvents(listEl);
});
```

为什么选扇描而不是再补一行 `pane-2`：

1. `#group-workspace` 是所有分组列的公共父容器（含非默认分组的静态列），一次扇扫同时覆盖
   默认分组的 `pane-1` / `pane-2` 与其它分组列里已存在的静态列表；
2. 以后再往 `index.html` 里加静态 pane、或者哪个构造路径忘了自己绑，扇扫都能补上；
   再补一行 `pane-2` 只是把眼前的缝填了，下一条缝依旧。
3. 函数幂等，所以扇扫与构造器重复调用**安全**，不需要也不应该维护「哪些已经绑过」的名单。

动态新建的 pane（`createPaneElement` / `createGroupPaneElement`）与 Shell 独立列
（`ensureShellColumnDom`）**保留**各自的绑定——新节点产生时必须有个绑定点，那不是重复。

### 15.6 修前后对比

| | 修前 `pcm-1600` | 修后 `pcm-1601` |
|---|---|---|
| 场景 | `split:true` / `vertical` / pane-2 @top330 装 `tab-filter-1` | 逐字相同 |
| `pane-1` 右键 | 1 次 | 1 次（没因扇描而重复） |
| `pane-2` 右键 | **0 次** | **1 次** |
| payload | `[]` | `{tabId:"tab-filter-1", paneId:"pane-2", canSplit:true}` |
| 结果 | `total=3 pass=2 fail=1` | **`total=3 pass=3 fail=0`** |

### 15.7 新回归 `verify-pane-context-menu`（7/7，`vpcm-1602` / `diag1602`）

| # | 断言 | 关键值 |
|---|---|---|
| 1 | `nonexistent-pane-yields-zero`（**反向对照**） | `{count:0, error:"no-pane"}` ⇒ 证明 `count===1` 不是恒真 |
| 2 | `pane-1-context-menu-exactly-once` | count 1 |
| 3 | `fixture-vertical-split-with-filter-below` | `split:true`、`orientation:"vertical"`、pane-2 的 `rect.top` > pane-1 的、pane-2 含 `tab-filter-1` |
| 4 | `lower-pane-context-menu-exactly-once` | count 1 |
| 5 | `lower-pane-payload-carries-its-own-tab` | `{tabId:"tab-filter-1", paneId:"pane-2", terminalType:"tab"}` |
| 6 | `upper-pane-still-exactly-once` | count 1（未因扇描而重复） |
| 7 | `lower-pane-context-menu-works-horizontally-too` | `close-split` 后再 `split-horizontal`，下方 pane 仍 count 1 |

已纳入批跑（`run-all.ps1` 23 → 24 支）。

### 15.8 验证

| 项 | 结果 |
|---|---|
| 全量回归 `run-all -Start 1620`（24 支） | **24/24 `exit=0` + 24 个 `renderer-diag=clean`**，`seeded=1` |
| 单测 | **572/572 / 0 fail** |
| 静态门禁 | `mod=0` / `checked=95 missing=none` / `blocks total=32 js=22` / `syntaxErrors=0` / `arityHints=0` |

### 15.9 环境边界（如实标注）

- 右键菜单是 Chromium Aura 原生窗口（`Chrome_WidgetWin_2`），CDP **读不到菜单项**。验证的是真实
  `contextmenu` 派发后捕获的 IPC payload（旁路 patch `ipcRenderer.send`），**不是**菜单渲染本身。
- CDP 合成 `contextmenu` **不等于**真人手测；本轮未做人工右键验证。
- 本机无互连串口对，未验证串口数据链路；本缺陷不涉及数据链路。
- `git push`、发版、打 tag 仍未获授权，本轮只做本地提交。

### 15.10 可复用的判读纪律

1. **「点了没反应」有四种成因**：被遮挡 / 命中错 / 状态没写 / **事件没产生**。这次是第四种——
   `pane-2` 上压根没有监听。先去数事件个数，比读代码猜快得多。
2. **冗余代码 ≠ 行为缺陷**。幂等保护、去重逻辑能让一份看起来错的代码完全无害。
3. **「按容器扇描」优于「逐个写 id」**：只要控件是同一类，就应当一次扇扫覆盖；逐个点名必然补漏。
4. **幂等保护与扇扫是配套的**：有了幂等，扇扫可以与构造器叠加而无需维护「已绑名单」。
5. **静态标记里的控件必须单独想到**。`index.html` 里已经存在、而构造器又因 `getPaneDom` 早退的节点，
   是「入口缝隙」的高发区。


---


## 16. 单串口组自由分屏 / 多串口组按组归属（`hostPaneId`）

### 16.1 两次用户裁决（逐字保留）

第一句是需求本身：

> 串口标签拖到 Shell 列之后，应该变成什么？当只有一个串口组时，串口标签页应该要可以随意分屏拖动，
> 有多个串口组，每个组的标签不能脱离组

第二句是在我把冲突报告上去之后拍的板：

> 单串口组时所有标签都在一级栏，所以「把 shell 标签可拖到二级标签栏的需求删除，
> shell 标签只能在一级栏」也是没问题的；**A. 旧裁决只管多组更贴切**

### 16.2 一处必须先停下来问的裁决冲突

pane 行**就是**二级标签栏。旧裁决「Shell 只能在一级栏」若全面有效，单组下 Shell 就不能进 pane 行，
「所有标签等价」做不到；若本轮裁决全面有效，旧裁决就失效。这是产品语义，不能由实现者选。

我当时给三个候选解释并停了工：**A 旧裁决只管多组** / B 旧裁决全面有效 / C 旧裁决作废。
用户选 A，并补了一句关键澄清「单串口组时所有标签都在一级栏」。

**这句话推出一个决定性结论**（它把最难的技术障碍直接消掉了）：

> 单串口组时**不该存在 Shell 独立列**。单组只有一个容器，它的「分屏」只能是 pane 分屏；
> 「独立列」是多组才需要的东西。

原先最麻烦的两个障碍随之消失：①「Shell 独立列没有 `.pane-tabs-list`，落点枚举不覆盖它」——单组不再有那一列；
②「串口标签进 Shell 列要写什么模型」——不存在这个问题，它是「进另一个 pane」，`moveTabToPane` 是现成代码。

### 16.3 我自己的两次错误判断（已撤回，必须留记录）

这两条都是我先写进工作记录、随后自己核对代码推翻的。**成本是一轮返工**。

**误判 ①：「要做单组自由分屏，就必须修改不变式 I1/I2」**

- 错误论断：单组所有标签等价 ⇒ Shell 必须进 `panes[]` ⇒ 与 I1/I2 直接冲突。
- 核对后的事实：I1 判 `parentId`；I2 判 `panes[].tabIds` 是否含 shell id。
  「Shell **显示**在某条 pane 行里」早就存在（走 `hostGroupId` + `layoutRowsOf` 合并进**派生的** `rows[].tabIds`），
  `panes[].tabIds` 一个字不动。
- 结论：不需要推翻任何不变式。全程 `panes[].tabIds` 不含 shell id，回归实测 `offenders:[]`。

**误判 ②：「Shell 独立列没有 pane 可分 ⇒ 单组自由分屏在 Shell 列上会遇到模型边界」**

- 这句本身对（`layoutRowsOf` 对 `containerId === null` 返回 `[]`），但**不构成对方案的阻碍**——
  用户裁决直接推出「单组不产生独立列」，那条边界自然消失。

教训：**推断写得再自洽，只要没核对判据就是假设。** 两次都是「先按直觉给结论，再读代码推翻」。

### 16.4 设计：只加一条叶级事实

| 事实 | 粒度 | 含义 |
|---|---|---|
| `hostGroupId`（已有） | 容器级 | 挂靠在哪个分组的下层行 |
| **`hostPaneId`（新增）** | **pane 级** | 住进该容器的**哪一条** pane 行 |
| `columnId`（已有） | 列级 | 停在哪一列的列首行 |
| `columnMode`（已有） | 列级 | 是否自成独立列 |

为什么只加这一条就够：串口标签本来就能进 `panes[].tabIds`（`moveWorkspaceTab` 就是跨 pane 移动），
缺的只是 Shell 分不到 pane。`hostPaneId` 与 `hostGroupId` **完全同构**，是同一模式的下一层精度。

两个不变：**`panes[].tabIds` 不动**（I2 不破）、**旧配置零迁移**（没这个字段就 `null`，回落 pane-1，行为同升级前）。

### 16.5 一次必须显式写明的断言改写

`TAB_ARCHITECTURE.md` §6.1.1 规则 3 原本是全局判据：

```js
canSplit = totalTabs >= 2 && !isShellTabId(tabId)
```

单组放开 Shell 后，这会让 Shell 的菜单项**恒置灰**。现改为按 `multiGroup` 分叉：多组保持旧判据原样，
单组把「受托管但不在 `panes[].tabIds` 里的 Shell」另算一份。

**旧断言不是作废，只是适用范围被收窄到多组**。多组下的反向对照用例仍必须全绿——这一点写在 §6.1.3 里。

同样地，两条旧回归的过期断言也显式改写并注明了原因：

| 脚本 | 旧断言（旧值） | 新断言（新值） | 为何失效 |
|---|---|---|---|
| `verify-single-group-shell-split` | `canSplit === false` | `canSplit === true` | 旧值基于「Shell 不能进 pane」，该前提已被裁决推翻 |
| 同上 | `canDetach === true` | `canDetach === false` | 单组只有一个容器，独立列该不该存在 |
| 同上（C/D 段） | detach 后必须变两列 | detach 必须被拒、仍是一列、Shell 仍 `row` | 同上 |
| `verify-restore-from-config` | 4 条（`canSplit:false` / `canDetach:true` / split 无效 / detach 生效） | 4 条反向 + 新增「I2 不含 shell id」「列数不变」 | 同上 |

**这不是为了让测试变绿而改期望值**：旧期望来自已被推翻的前提，且新断言同时加了更强的约束，不是单纯放宽。

### 16.6 三个必须同时做的实现细节

1. **UI 置灰不够，还要逻辑兜底**。`canDetach:false` 只让菜单变灰，直接发
   `detach-to-own-column` 仍会建 `__shell__` 列。所以 handler 首部再判一次 `isMultiGroupLayer()`。
2. **存在性校验不能用会回落的函数**。我第一版用 `getTabPaneId(tabId)` 判存在性，
   但它对找不到的 id 会**回落到 `'pane-1'`**，恒为真；要用 `isLiveWorkspaceTabId(tabId)`。
3. **多组跨组拦截只放一处**：`finishWorkspaceTabDrag` 入口判源组与目标组是否一致，不一致就静默 `return`。
   单组时两者相等，这道门恒开，不需要额外分支。

### 16.7 一个跨层丢字段的教训（花了最长时间）

现象：`hostPaneId` 在 `sections.shellTabs` 里**是对的**（实测 `hostPaneId:"pane-2"`），但渲染出的 `rows` 仍把 Shell 放在 pane-1。

```
sections.shellTabs[0].hostPaneId = "pane-2"      ← 投影输入正确
        ↓ normalizeTabIds 白名单重建时丢字段
ws.tabs["tab-shell-1"].hostPaneId = undefined  ← 模型叶上没有
        ↓ layoutRowsOf 回落 base[0]
Shell 仍在 pane-1
```

真因：`projectWorkspace` 不在 `tab-model.js`，而在 **`tabs-workspace-projection.js`**；它的 `normalizeTabIds()`
是**白名单重建**，没列出的键一律静默丢掉。

**教训**：往这个投影器加任何新字段，必须同时改两处（`normalizeTabIds` 的字段表 + shell 叶构造处的赋值），
否则它在下游的表现是「完全不像字段丢了的行为」（是布局位置回退了，不是报了 undefined）。
上一轮的工作记录还写错过这个函数的文件位置，本轮先定位再改才修对。

### 16.8 反查出的两个真实产品缺陷（不是本轮引入，但本轮暴露）

**① 幽灵 tabId 会真的改布局**：`splitWorkspaceTabIntoPane` 原先只判 `if (!tabId) return false`，
对非 shell 的非空 id 不验证存在性。实测 `sgf-1731`：对 `tab-filter-99999` 发 `split-vertical`，
结果 `pane-2.tabIds = ["tab-filter-99999","tab-shell-1"]`、`activeTabId = "tab-filter-99999"`
——用户看不到任何变化，布局却已被改过一次。

**② 单组独立列可绕过 UI 造出来**：见 16.6 第 1 条。

### 16.9 我自己的三次操作失误（当场修正，不得记成产品缺陷）

| 失误 | 现象 | 修正 |
|---|---|---|
| 编辑 `case 'detach-to-own-column'` 只换了头部注释、保留了原 `case` 行 | `SyntaxError: Unexpected token 'case'`（`r=1` / `m=1` / 测试 `exit=3`） | 删重复段 |
| 改写探针时误删 `const payload = await ev(...)` 整段 | 探针 `exit=2` / `PROBE ERROR: [payload is not defined]` | 补回 |
| 补回时又留下**重复行** `})()`, 'shell-menu');` | 探针 `SyntaxError`（`c=1`） | 删重复行 |

**教训**：对 `case` 块、`await ev(...)` 这类「首行即结构」的片段做替换，必须把整块（含结尾 `})()`, label);`）
一起选中，不能只换一行。三次都是同一类错误。

### 16.10 验证

| 项 | 结果 |
|---|---|
| `node --check renderer.js` / `tabs-workspace-projection.js` / `tab-model.js` | `r=0` / `p=0` / `t=0` |
| `check-renderer-module-load` | `m=0`（`renderer.js module body initialized without throwing`） |
| 单测 `node scripts\run-tests.js` | **572/572 / 0 fail** |
| 新 `verify-single-group-free-split` | **9/9**（`sgf-1732`，`diag1732`） |
| `verify-single-group-shell-split` | **19/19**（`vsgss-1737`，`diag1737`） |
| `verify-restore-from-config`（种子） | **12/12**（`vrfc-1743`，`diag1743`） |
| `verify-pane-context-menu` | `exit=0`（`diag1733`） |
| `verify-four-defects` | `exit=0`（47 项，`diag1738`） |
| `verify-shell-drag` | `exit=0`（`diag1739`） |
| 全量回归 `run-all -Start 1750` | **25 个不同脚本全部 `exit=0`，逐个 `renderer-diag=clean`，`exit=[1-9]` 计数 = 0**（`run-all-1750.txt`） |
| `scan-undefined.js` | `checked=95 / missing=none` |
| `check-arch-doc.js` | `blocks total=32 js=22 / syntaxErrors=0 / arityHints=0` |

> 该批次实跑 **26 次**，因为 `run-all.ps1` 的脚本清单里 `verify-restore-from-config` 被写了两次（我上一次替换时留下的，**只影响测试基础设施**）。
> 两遍均 `exit=0` 且均带种子。重复行已删，`Parser::ParseFile` 复核 `ps1err=0`、清单数 `25`。

`sgf-1732` 关键观测：

```
after-split-main   rows: pane-1=[tab-filter-1]  pane-2=[tab-main]
after-shell-split  shells[0] = {hostGroupId:"default", hostPaneId:"pane-2", columnMode:"row"}
                   rows:    pane-2=[tab-shell-1]
                   paneLists: pane-2-tabs-list=["tab-shell-1"]
no-shell-id-in-panes-tabIds  offenders:[]      ← I2 未破
ghost-action                 changed:false
```

### 16.11 环境边界（如实标注）

- 全部通过 CDP 合成输入与真实 DOM 几何测得，**CDP 合成拖拽 ≠ 真人手测**。
- 本机无互连串口对、无 `com0com`，**没有做**双端口收发回环；本轮改的是布局模型，不涉及数据链路。
- 用户真实 `config.json` 仅被**读取并复制**进临时 profile，未修改；已核实 `--user-data-dir` 重定向 `app.getPath('userData')`。
- `git push`、发版、打 tag 仍未获授权，本轮只做本地提交。

### 16.12 可复用的判读纪律

1. **新字段穿不过投影层时，症状不是「字段丢了」，而是「位置回退了」**。先比投影输入与模型叶，再往下游找。
2. **“UI 置灰”不等于“动作被禁”**。每个入口都要问：除菜单之外，还有谁能发这个 action。
3. **存在性校验不能用会回落默认值的查询函数**。回退默认值是为了「总得有个位置」，不能当「存不存在」用。
4. **裁决冲突时不要自己选**。把候选解释写清楚停下问，比事后返工便宜得多。
5. **改过的断言必须注明为何失效**，否则下一个接手的人会以为是「为了让测试变绿而改期望值」。
