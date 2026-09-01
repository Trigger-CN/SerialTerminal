# SerialTerminal 项目接手说明 / AI 记忆文档

> 当前权威状态：以本文第 0 节、`main.js` 的 `CONFIG_VERSION`/`normalizeConfig()`、实际模块和测试为准。后文 15A、15B、17 节及独立计划文档保留历史设计背景，不代表尚未实现。

## 0. 当前状态快照（维护入口）

- 当前配置 schema：v11；任何迁移判断必须读取 `main.js`，不要复用本文历史示例中的旧版本号。
- 当前工作区标签类型：主 Log、过滤 Log、实时图表和 Shell；最多两个 pane，支持左右/上下分屏、拖动排序和跨 pane 移动。
- 当前发送模型：`sendEncoding` 为共享 Text 编码；底部输入框保存自身 `mode`/`appendCrLf`，快捷指令各自保存 `mode`/`appendCrLf`，自动发送、主终端输入和右键串口发送固定为 Text。所有入口最终调用 `sendSerialRequest()` / `serial-write`。
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
- 当前主界面形态：可折叠左侧侧边栏 + 最多双 pane 工作区 + 主输入框 + 过滤/图表/Shell 标签页 + 可切换右侧 Shell 侧边栏

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
- 波特率、数据位、停止位和校验位控件变更时需立即保存 `lastSerialOptions`，避免后续配置回填把未连接时选择的新串口参数覆盖成旧值；自定义波特率只在输入框有值时保存。串口已连接时切换波特率应先走 `disconnectSerial()`，等待 `serial-disconnected` 事件完成后再复用手动连接路径按当前 UI 参数重连，避免旧断开事件覆盖新连接状态。
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
├─ scripts/                    测试、发布、镜像和 native 准备脚本
├─ test/                       Node 自动化测试与 Python 串口联调脚本
├─ telemetry-server/           匿名活跃统计与动态更新 manifest 服务
├─ index.html                  主窗口 HTML
├─ renderer.js                 主窗口渲染与业务编排
├─ workspace-manager.js        pane/tab 状态、恢复和 DOM 编排
├─ serial-codec.js             严格 Hex 解析与统一发送 Buffer 构造
├─ serial-text-stream.js       图表独立文本流解码和分行
├─ hex-formatter.js            流式 Hex dump 格式化
├─ chart-parser.js             图表三级解析与字段发现
├─ chart-parser-worker*.js     图表 Worker 与客户端
├─ chart-data-model.js         图表保留、统计和降采样
├─ chart-view.js               主图、时间轴和视口交互
├─ chart-csv.js                UTF-8 BOM CSV 导出
├─ search-history.js           搜索历史归一化、置顶和淘汰
├─ config-values.js            共享数值范围归一化
├─ shell-profiles.js           Shell Profile 迁移与查找
├─ main.js                     窗口、配置、串口、日志、更新和 Shell PTY
├─ preferences.html/js         设置窗口
├─ i18n.js                     多语言字典与翻译函数
├─ README.md                   对外项目说明
├─ ToDo.md                     全局工程待办与验证基线
└─ agent_notes.md              本文档
```

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
- 主按钮、快捷键、右键菜单和窄工具栏清空动作统一按活动/目标 `tabId` 调用 `clearTerminalByTabId()`，Shell 标签不得回退清空主终端
- `fitWorkspaceTerminals()` 使用单一 `requestAnimationFrame` 合并请求，Shell 仅在 cols/rows 变化时发送 resize；pane `flex-basis` 和 sidebar `width` 过渡结束后均需触发 fit
- Text 发送校验与最终发送均复用 `buildSerialWriteBuffer()`；ASCII/GBK 对无法表示的字符返回 `UNREPRESENTABLE_CHARACTER`，不得静默替换为 `?`。`parseHexInput()` 在扫描/累计超过 `maxBytes` 时应提前失败，避免超大输入构造完整副本
- `npm test` 通过 `scripts/run-tests.js` 执行根项目 Node 测试与 `telemetry-server` 测试；codec、formatter、图表、搜索历史、日志、工作区、i18n、发布链路等行为变化必须同步相关测试
- Shell profile 参数在设置窗口中逐项编辑并始终以 argv 字符串数组保存；不得通过空格 join/split 往返转换
- 配置版本为 11；历史配置统一由 `normalizeConfig()` 迁移并在变化后写回。Shell profile 使用稳定 `id`；主输入与快捷指令发送模型、搜索历史、图表、壁纸和遥测字段均以当前 schema 为准
- 字体大小、scrollback、历史缓冲、滚轮行数、输入历史上限、Hex 空闲刷新和日志自动刷盘大小统一通过 `config-values.js` 的整数范围规则校验；主进程和设置窗口不得各自维护不同 clamp 逻辑
- 工作区布局通过 `workspace-manager.js` 的 `normalizeWorkspaceLayoutShape()` 全局去重 tab ID；DOM 可渲染检查必须在目标 pane 内同时找到 tab 按钮和内容。任一 pane 变空时自动关闭分屏，若唯一非空的是 `pane-2`，需按原顺序整体迁移到 `pane-1` 并保持活动标签和 pane 内 index 不变
- 开发、测试和打包使用 Node.js `>=22.12.0`，与当前 electron-builder 间接依赖的 engine 要求一致；CI 固定 Node 22.12
- `.github/workflows/checks.yml` 在 push/PR 上执行 `npm ci --ignore-scripts`、`npm test`、全仓库 JavaScript 语法检查和官方 registry 生产依赖审计；简中 i18n 必须覆盖英语基线键，其他语言允许回退英语
- `.github/workflows/release.yml` 仅响应 `v*` tag；Windows/Linux 使用同一 Node 22.12、官方 registry lockfile、`npm ci --ignore-scripts`、显式 `npm run rebuild` 和打包命令，并检查构建不修改 lockfile
- Windows 客户端自动更新先请求 `https://trigger-cn.top/serialterminal/latest.yml`，仅该请求附带客户端版本和 `stable` 渠道；服务端按数据库策略返回规范化 manifest。动态入口失败时按 Gitee、腾讯云 COS、GitHub 回退，并且只有版本、目标安装包类型和 SHA-512 与选定版本一致的来源可参与下载；`DebUpdater` 校验 `.deb`，其他 Linux updater 校验 `.AppImage`，Windows 校验 `.exe`。Linux 客户端直接使用 GitHub `latest-linux.yml`。COS 和 Gitee 均保存 Windows 自动更新必需的 `.exe`、`.exe.blockmap` 和 `latest.yml`，Linux 产物只保留在 GitHub Release。严格 SemVer 预发布 Tag 不得覆盖 COS `releases/latest/`，稳定客户端也必须拒绝预发布 manifest。GitHub Actions 先上传 draft Release，再发布并验证 COS 版本化对象，最后重新按大小和 SHA-512 校验全部 GitHub 资产并发布 draft；稳定版只在该阶段成为 GitHub latest。GitHub、COS、Gitee 的同 Tag 资产不可覆盖，重试只能复用完全一致的对象或附件。之后工作流以非强制方式同步 main/Tag 到 Gitee；Gitee Tag 流水线运行 `scripts/mirror-github-release-to-gitee.js`，EXE 优先从 COS 下载，blockmap 和元数据使用 GitHub 原始资产，每个来源首次请求后按 `2s/5s/10s` 再重试三次，COS 全部失败才回退 GitHub，并按元数据版本、文件大小和 SHA-512 校验 EXE。Gitee 已存在附件使用无令牌下载并手动跟随最多三次重定向，只允许 `gitee.com` 及其子域名。Gitee 流水线需单独配置加密变量 `CI_GITEE_ACCESS_TOKEN`，调用脚本时映射为 `GITEE_ACCESS_TOKEN`，发布后必须重新下载 manifest 和 EXE 做 SHA-512 校验，并确认 blockmap 可公开下载。Gitee 当前忽略 Range 请求，因此客户端在 Gitee 源直接下载完整 EXE，COS/GitHub 仍可使用差分更新。最后的 `--prune-only` 永久保留 `releases/latest/`，分别保留最新三个稳定和三个预发布前缀，并保护当前稳定 latest 引用的版本；COS CAM 身份需具备 `cos:GetBucket` 和批量删除对象权限。
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
- 主终端 / 过滤 tab / Shell tab 的独立日志采集与关闭时 flush
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
- `chart-view.js`：uPlot 主图、完整时间轴、视口平移/缩放和实时跟随
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

配置由 `main.js -> loadConfig()` 提供默认值，`normalizeConfig()` 按 schema v11 归一化和迁移，`saveConfig()` 合并写回。不要复制整份默认配置到文档；字段增加或语义变化时，应同时更新默认值、归一化、设置窗口、测试和本节。

### 5.1 主要配置分组

- 外观：`fontSize`、`fontWeight`、字体、前景/背景色、`highlightColors`、`highlightRules`、`terminalWallpaper`。
- 终端：`showTimestamp`、`showLineNumbers`、`scrollbackLimit`、`historyBufferSize`、`mouseWheelScrollLines`。
- 串口：`lastSerialOptions` 保存端口、物理参数、RX 模式/编码、TX Text 编码和终端换行模式。
- 底部输入：`mainInputSettings` 保存可见、Enter 发送、Text/Hex 模式、追加 CRLF 和历史上限；`mainInputHistory` 仅保存 `{ mode, content }`。
- 搜索：`searchSettings.historyLimit` 默认 20、范围 0-200；`searchHistory` 保存查询、三个选项、置顶和时间元数据。
- 快捷发送：`quickSendList` 每项保存稳定 ID、分组、`mode`、`appendCrLf`、内容、窄侧栏入口和自动触发；分组与两个侧栏顺序分别持久化。
- 自动发送：`autoSendSettings` 仅保存 enabled、interval、content；当前自动发送固定为 Text。
- 标签与工作区：`filterTabs`、`shellTabs`、`chartTabs` 与 `workspaceLayout` 分别保存 tab 配置和 pane 布局。
- 日志：普通/全部 tab/Raw 开关、独立前缀、缓存阈值、目录、日期子目录、保留天数、文件名、编码和手动导出目录。
- Shell：`shellProfiles` 使用稳定 ID 和 argv 数组，`defaultShellProfileId` 精确引用默认项。
- 应用状态：窗口大小、侧边栏状态、快捷键、欢迎/更新提示版本和跳过版本。
- 遥测：开关、随机安装 ID、上次成功上报日期与版本。

### 5.2 关键当前结构

```json
{
  "configVersion": 11,
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

## 8. 串口收发实现原理（config v11 / 原始字节架构）

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
- 遇到 `\r\n / \r / \n` 再切分成完整行对象
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

### 8.6 config v11 与迁移
- `CONFIG_VERSION = 11`；`loadConfig()` 调用 `normalizeConfig()`，类型错误回退默认值，规范化结果变化时写回磁盘。
- 旧 `lastSerialOptions.encoding` 仍迁移为 RX 模式/编码与 TX Text 编码；当前主输入模式和追加选项归属 `mainInputSettings`。
- config v7 之前快捷指令的追加语义会迁移为每条 `appendCrLf`；快捷项补齐稳定 ID、分组、模式、侧栏入口和自动触发。
- Shell profile 缺失或重复 ID 会生成稳定 ID；旧默认名称引用迁移为 `defaultShellProfileId`。
- 旧 100000 默认 scrollback 在 v5 迁移为当前默认 20000；数值字段统一经 `config-values.js` 限制。
- 搜索历史、图表配置、终端壁纸、遥测、日志保留与日期目录等后续字段均由当前归一化逻辑兜底。
- 关闭 Raw 日志或修改日志目录/文件名配置前必须先刷盘；失败时保留设置窗口并提示。
- 配置迁移必须向前兼容历史用户文件；修改 schema 时递增版本并补自动化测试。


---

## 9. 日志显示、前缀与高亮原理

### 9.1 前缀生成
`getPrefix()` 负责生成：
- 时间戳（若启用）
- 行号（若启用）

### 9.1A 日志文件命名与多 tab 日志

#### 日志数据来源
- **主终端显示日志**（`tab-main`）：renderer 在 `writeTextLines()` / `writeHexLines()` 中生成与当前显示模式一致的文本，通过 `writeMainTabLog()` → `write-tab-log` 发送到主进程
- **过滤 tab 日志**：renderer 将匹配后的格式化行通过 `writeFilterTabLog()` → `write-tab-log` 发送到主进程
- **Shell tab 日志**：renderer 将 shell 输出通过 `writeShellTabLog()` → `write-tab-log` 发送到主进程
- **通用主日志**：未启用 `saveAllTabsLogToFiles` 时，`main.js::writeTabLog()` 将 `tab-main` 内容转交 `writeLog()`；启用后，主终端与其他 tab 一样进入独立条目
- **RX Raw 日志**：仅 `port.on('data')` 的原始 Buffer 进入 `bufferRawSerialBytes()`，与上述显示日志完全独立

#### 缓冲与落盘机制
- 显示日志经主进程 `writeTabLog()` 统一按 `stripAnsiInLog` 配置处理 SGR 序列，再写入 `logBuffer` 或 `tabLogBuffers`；字节数使用 `Buffer.byteLength()` 统计
- `tabLogBuffers` 的每个条目包含 `{ title, buffer[], filePath, byteCount }`；`logBuffer` 保存未启用全部 tab 日志时的主终端显示日志
- `rawBinaryBuffers` 保存 RX-only Buffer，并用 `rawBinaryByteCount` 按真实字节数计数；达到阈值后由 `flushRawBinaryLogSync()` 追加到 `.bin`
- 各显示日志缓冲达到 `getAutoFlushThreshold()` 后同步追加落盘；5 秒定时器还会静默刷盘所有待处理日志，降低异常退出的丢失窗口
- `ensureMainLogFilePath()`、`ensureTabLogFile()` 和 `ensureRawBinaryLogPath()` 按日志会话延迟创建并缓存路径，后续持续追加，避免产生碎片文件
- `connect-serial` 在启用全部 tab 日志时预注册 `tab-main` 条目；实际文件路径仍在首次写入时创建

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

#### ANSI 剥离
- `stripAnsi()` 仅剥离 SGR 序列（`\x1b[数字;数字m`），不触碰其他 CSI 命令
- 可通过设置页 `stripAnsiInLog` 选项关闭此行为
- 主进程对所有经 `write-tab-log` 到达的显示日志统一调用；RX Raw `.bin` 不经过字符串处理

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
- 主终端、过滤 tab、shell tab 可分别保存为独立日志文件
- `logFileSuffix` 已废弃，`logFileNameFormat` 现在完整控制输出文件名

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
- 主终端、过滤 tab、shell tab 的日志标题取各自当前 tab 标题，用于 `%tab` 文件名替换
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
- `normalizeConfig()`：config v11 归一化、历史迁移、快捷/搜索/图表/壁纸/遥测及日志字段校验
- `loadConfig()`：配置默认值来源
- `saveConfig()`：配置合并写回
- `bufferRawSerialBytes()` / `flushRawBinaryLogSync()` / `ensureRawBinaryLogPath()`：RX-only Buffer 缓冲、追加刷盘和单连接文件路径
- `writeSerialPayload()`：主进程发送最终校验、`SerialPort.write()` 和真实字节吞吐量统计
- `createWindow()`：主窗口大小恢复与 resize 持久化
- `queueSerialOutput()` / `port.on('data')`：保留原始 RX Buffer、统计吞吐、Raw 缓冲并批量发送 `serial-output-bytes`
- `stripAnsi(str)`：按配置剥离显示日志中的 ANSI SGR 序列
- `formatFileName(format, extra)` / `buildLogFileName(extra)`：格式化日志文件名并处理 `%tab`
- `ensureMainLogFilePath()` / `ensureTabLogFile(tabId)` / `ensureRawBinaryLogPath()`：为三类日志延迟创建并缓存路径
- `flushTabLogEntrySync()` / `saveAllTabLogs()`：追加刷盘并管理各 tab 日志条目
- `writeLog(data)` / `saveLog()`：维护未启用全部 tab 日志时的通用主日志缓冲
- `writeTabLog(tabId, title, data)`：接收 renderer 的显示日志，统一处理 ANSI，并分流到通用主日志或 `tabLogBuffers`
- `flushPendingLogs()` / `startLogAutoFlushTimer()`：每 5 秒静默刷盘显示日志与 RX Raw 日志
- `cleanupSerialConnection()`：清理串口状态并刷盘 RX Raw；显示日志由 renderer 的断开事件处理继续触发 flush
- `ipcMain.handle('connect-serial')`：串口连接入口；启用全部 tab 日志时预注册 `tab-main`
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
- `SerialDataParser`
- `switchReceiveMode()` / `switchReceiveEncoding()`：flush 旧 RX 链路并切换 Text decoder/Hex formatter
- `writeTextLines()` / `writeHexLines()`：分别写主终端、同模式过滤 tab 和显示日志
- `validateSendContent()` / `formatValidation()`：渲染层实时校验和本地化状态
- `sendSerialRequest()`：所有现代发送入口的串行 IPC 包装
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
- `applyConfig()`

### 图表与搜索模块
- `serial-text-stream.js`：图表文本记录流
- `chart-parser.js` / `chart-parser-worker*.js`：字段发现与隔离解析
- `chart-data-model.js`：原始样本、统计和降采样
- `chart-view.js`：uPlot 主图与时间轴
- `chart-csv.js`：CSV 生成
- `search-history.js`：搜索历史纯逻辑

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
