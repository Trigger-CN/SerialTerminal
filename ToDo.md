# SerialTerminal ToDo

本文档记录 2026-07-29 全仓库代码审查后确认的待办事项。实施时优先处理行为缺陷和安全问题，再处理性能、测试和长期架构优化。

## 当前状态

- 已完成项保留为审查和实施记录；未勾选项才是当前工程待办。
- 专项硬件、跨平台和长时间验证分别记录在 `HEX_FEATURE_TODO.md` 与 `CHART_TAB_IMPLEMENTATION_PLAN.md`，多串口设计基线记录在 `MULTI_SERIAL_DESIGN.md`，本文件只保留全局门禁。
- 当前配置 schema 为 **v15**（版本号由 `serial-groups-config.js` 的 `SERIAL_GROUPS_CONFIG_VERSION` 统一提供，`main.js` 只做引用）；开发与 CI 使用 Node.js >=22.12.0；`npm test` 同时运行根项目和 `telemetry-server` 测试。


## P0 - 优先修复

- [x] 修复 Shell 标签快速关闭时的 PTY 会话泄漏
  - 位置：`renderer.js` 的 `createShellTab()`、`closeShellTab()`。
  - 问题：创建 Shell session 使用 50ms 延迟；标签在延迟结束前关闭时，定时任务仍可能创建一个没有对应 UI 的 PTY。
  - 方案：将 timer ID 和 closed/generation 状态保存到 `tabState`；关闭时取消 timer；异步创建完成前后检查标签仍存在，否则立即关闭 session。
  - 验收：连续快速新建/关闭 Shell 标签后，主进程 `shellSessions` 数量与可见 Shell 标签数量一致，无残留子进程。

- [x] 降低配置保存触发的全量 UI 重放开销
  - 位置：`main.js` 的 `save-config` / `save-config-request`，`renderer.js` 的 `applyConfig()`、`persistFilterTabs()`。
  - 问题：每次保存都广播完整 `config-updated`；过滤输入每个字符都会同步写盘并重设终端、fit、刷新串口、重绘快捷发送和加载 Shell profiles。
  - 方案：过滤状态保存 debounce；区分当前窗口保存确认和外部配置更新；按字段增量应用配置；只有字体、主题、scrollback 变化时更新 xterm options。
  - 验收：过滤输入期间不逐字符写配置文件或刷新串口；多个终端标签下输入保持流畅且无闪烁。

- [x] 修复生产依赖高危漏洞
  - 位置：`package.json`、`package-lock.json`、`.npmrc`。
  - 问题：官方 registry 的生产依赖审计报告 3 个 High，涉及 `electron-updater`、`builder-util-runtime` 和 `js-yaml`。
  - 方案：升级到不受影响版本并重新生成 lockfile；CI 增加 `npm audit --registry=https://registry.npmjs.org --omit=dev`。
  - 验收：生产依赖审计无 High/Critical；Windows/Linux 构建和在线更新流程通过。
  - 结果：`electron-updater` 已升级至 `^6.8.9`，生产依赖使用 `builder-util-runtime 9.7.0` 并通过 npm override 固定 `js-yaml ^5.2.3`；生产依赖审计为 0 漏洞。打包和在线更新仍需发布前人工验证。

## P1 - 行为与性能

- [x] 统一主终端、过滤标签和 Shell 标签的清空行为
  - 位置：`renderer.js` 的 `clearActiveTerminal()`、`clearTerminalByTabId()`、`handleTerminalContextMenuAction()`。
  - 问题：活动 Shell 标签下清空按钮不生效；Shell 右键清空会错误清空主终端。
  - 方案：所有入口统一按实际 `tabId` 调用 `clearTerminalByTabId()`。
  - 验收：主按钮、窄工具栏、快捷键和右键菜单均只清空当前目标终端。

- [x] 在侧边栏宽度动画结束后重新 fit 终端
  - 位置：`renderer.js` 的 `setSidebarCollapsed()`、transition 监听；`style.css` 的 `.sidebar`。
  - 问题：侧边栏宽度有 180ms 动画，但当前只在动画开始时 fit，xterm cols/rows 可能与最终宽度不一致。
  - 方案：监听 sidebar `transitionend` 的 `width`，或使用 `ResizeObserver` 统一观察终端容器。
  - 验收：收起、展开和 `Ctrl+F` 自动展开后无空白、裁切或错误换行，Shell PTY cols/rows 正确。

- [x] 合并重复的终端 fit 请求
  - 位置：`renderer.js` 的 `fitWorkspaceTerminals()`。
  - 问题：每次调用都创建新的 `setTimeout(0)`；resize、配置更新、tab 切换和 splitter 操作会堆积重复测量与 Shell resize IPC。
  - 方案：使用共享 `requestAnimationFrame` 或单一 timer 合并请求；只 fit 可见活动终端；仅在 cols/rows 改变时发送 Shell resize。
  - 验收：连续调整窗口和分屏时每帧最多执行一次 fit，无重复 PTY resize 风暴。

- [x] 拒绝 Text 编码中的不可表示字符
  - 位置：`serial-codec.js` 的 `buildSerialWriteBuffer()`。
  - 问题：ASCII/GBK 会把无法表示的字符静默替换为 `?`，但仍报告发送成功。
  - 方案：编码后按相同编码解码并校验，返回 `UNREPRESENTABLE_CHARACTER` 和字符位置；或明确显示替换警告。
  - 验收：ASCII 发送中文、GBK 发送 emoji 时不会静默发送 `3F`。

- [x] 优化超大 Hex 输入的解析上限
  - 位置：`serial-codec.js` 的 `parseHexInput()`。
  - 问题：解析器在检查 `maxBytes` 前会完整扫描、保存 token 并拼接全部 Hex 文本，大粘贴可能冻结 renderer。
  - 方案：扫描时累计有效数字，超过 `maxBytes * 2` 立即返回；减少 token 和完整字符串副本。
  - 验收：远超 1 MiB 的输入能快速失败，内存占用不会随完整输入产生多份副本。

- [x] 修复 Shell profile 参数的往返保存
  - 位置：`preferences.js` 的 Shell profile 参数编辑器。
  - 问题：参数先用空格 join，保存时再按空格 split，带空格或引号的参数会损坏。
  - 方案：改为逐项参数列表；配置继续保存字符串数组。
  - 验收：`--rcfile` 与包含空格的路径保存、重开设置后保持原始 argv。
  - 结果：设置窗口改为逐项编辑 argv，每个输入框直接对应数组元素，不再进行空格拼接或拆分。

- [x] 为 Shell profile 使用稳定 ID
  - 位置：`preferences.js`、`main.js` 的 `defaultShellProfile` 与 profile 查找。
  - 问题：默认 profile 以名称引用；重命名或删除后引用悬空并静默回退第一个 profile。
  - 方案：profile 增加稳定 ID，默认值保存 ID；删除默认项时明确选择新默认项或清空。
  - 验收：重命名默认 profile 不改变默认选择；删除时不会静默启动其他 Shell。
  - 结果：配置版本升级到 4，旧名称引用自动迁移到 `defaultShellProfileId`；删除默认项会清空引用，侧边栏按 profile ID 精确启动。

- [x] 在主进程统一校验设置数值范围
  - 位置：`main.js` 的 `normalizeConfig()`，`preferences.js` 的保存逻辑。
  - 问题：字体大小、scrollback、历史缓冲区和滚轮行数等字段可能保存负数、超大数或 `null`。
  - 方案：主进程统一做 finite/integer/range 校验；设置窗口用相同规则阻止无效提交。
  - 验收：手工修改配置或输入越界值后均回退到合法范围，不会传入异常 xterm options。
  - 结果：新增共享数值规则，主进程与设置窗口统一校验字体、scrollback、历史缓冲、滚轮、输入历史、Hex flush 和日志 flush 数值。

- [x] 修复工作区布局中的重复 tab 归属
  - 位置：`renderer.js` 的 workspace 标准化，`workspace-manager.js` 的 `hasRenderableTab()` 与恢复逻辑。
  - 问题：异常配置可能让 `tab-main` 同时属于两个 pane，导致空白 pane 或逻辑双 active。
  - 方案：标准化时全局去重 tab ID，并强制 `tab-main` 只属于 pane-1；可渲染检查应验证目标 pane 内的 DOM 归属。
  - 验收：损坏/旧版布局恢复后每个 tab 只属于一个 pane，活动 pane 与 DOM 一致。
  - 结果：布局标准化会全局去重并固定主标签归属，空 pane 自动修复；manager 只接受目标 pane 内同时存在按钮和内容的 tab。

## P2 - 测试、发布与维护

- [x] 建立自动化测试和 CI 门禁
  - `npm test` 通过 `scripts/run-tests.js` 运行根项目 Node 测试及 `telemetry-server` 测试。
  - 当前覆盖 codec、formatter、图表解析/Worker/数据模型/视图/CSV、搜索历史、日志、工作区、i18n、遥测和发布链路。
  - GitHub Checks 执行干净安装、测试、全仓库 JavaScript 语法检查和生产依赖审计；发布 workflow 在打包前重复执行测试。
  - 完整配置归一化、mock serialport IPC、Shell session 生命周期集成测试和长时间图表性能测试仍待补齐。

- [x] 发布安装改为可复现流程
  - 位置：`.github/workflows/release.yml`。
  - 将 `npm install` 改为 `npm ci`；统一 lockfile registry URL；native rebuild 保持显式步骤。
  - 验收：Windows/Linux 使用同一 lockfile 安装，构建后 lockfile 不变化。
  - 结果：新增 tag 发布 workflow，Windows/Linux 共用 Node 22.12 和同一 lockfile，安装使用 `npm ci --ignore-scripts`，显式执行 native rebuild、测试、打包和 lockfile 不变检查。

- [x] 修正文档和 Node 版本约束
  - 审查时 `README.md` 仍写 Node.js 16+，但 `serialport@13` 和当前构建链要求更高。
  - README、`package.json.engines` 与 CI 统一声明 Node `>=22.12.0`。
  - 结果：当前构建工具链要求 Node `>=22.12.0`，README、package engines 和 CI 已统一到该版本。

- [ ] 限制大 scrollback 搜索对 UI 的阻塞
  - 位置：`renderer.js` 的搜索计数扫描。
  - 分批扫描并支持取消旧 generation；限制正则长度、匹配数和高风险表达式；避免一次同步扫描 100000 行。

- [x] 移除主终端 tab 的重复点击绑定
  - 位置：`index.html` 的 inline `onclick` 和 renderer 中的 listener。
  - 保留 renderer 的统一事件绑定，避免一次点击重复持久化、事件派发和 fit。
  - 结果：主终端 tab 仅保留 renderer listener；删除 inline 切换函数，定位搜索也直接调用 workspace manager。

- [x] 提升窄工具栏在低高度窗口中的可达性
  - 工具栏加入 RX/TX 和多个按钮后，低高度窗口可能裁掉最底部展开按钮。
  - 方案：将展开按钮固定在不滚动区域，或让中间工具区可滚动。
  - 结果：吞吐区固定在顶部，操作按钮放入隐藏滚动条的可滚动中间区，展开按钮固定在底部不参与滚动。

- [x] 完善键盘可访问性
  - 将可点击 `div` 改为 `button`，为 tab 增加 `role="tab"` / `aria-selected`，提供 `button:focus-visible` 焦点样式。
  - 结果：sidebar/footer 与 workspace tab 已使用原生 button，tab/panel 建立 ARIA 关联并同步选中状态，键盘焦点清晰可见。

- [x] 保持多语言 key 完整覆盖
  - 自动化测试已确认全部配置语言覆盖 English 基线并保留插值参数；新增或修改文案时必须同步所有语言，并继续人工检查不同语言下的布局与截断。

- [ ] 逐步迁移 Electron 安全模型
  - 当前主窗口和设置窗口使用 `nodeIntegration: true`、`contextIsolation: false`。
  - 长期迁移到 preload + context bridge，并限制 renderer 可调用 IPC。

- [ ] 扩大高风险集成测试
  - 覆盖完整 config v12 归一化与历史迁移、mock serialport `serial-write`/session 隔离、Shell 快速创建关闭及图表 Worker 超时/资源释放。

- [ ] 控制大型维护文档漂移
  - 行为变化同步更新 `README.md` 和 `agent_notes.md`；专项计划只记录设计基线与剩余验证，已落地模块不再使用“计划新增”的当前时态。

## P3 - 多串口支持（P1 已完成；配置 v14 → v15 迁移已完成；P2 完成三步；P3 纯逻辑层已实现；P5 纯数据层与 DOM 层已落地）

完整设计见 [`MULTI_SERIAL_DESIGN.md`](MULTI_SERIAL_DESIGN.md)。已定决策：快捷指令全局共享；分屏首版分组级 + 组内级同时做。

- [x] **P1：主进程多实例化**（已完成并验证）
  - 结果：`currentSerialPort` 及 `serialSendEncoding`/`serialNewlineMode`/`serialCleanupComplete`/`serialConnectInProgress`/全局 `throughputState`/全局 `serialOutputQueue` 全部删除，改为 `serialSessions = new Map()`（默认分组 `DEFAULT_SERIAL_GROUP_ID = 'default'`）。
  - `connect-serial` 接受 `options.groupId`且**不再关闭其他分组端口**；`disconnect-serial` 接受 `{ groupId }`；三个串口事件均携带 `groupId`。
  - `cleanupSerialConnection(message, port, groupId)` 改为按本会话端口判定，不再丢弃他组真实数据。
  - `flushSerialOutputQueue()` 改为按**会话 + sessionId 双维度分桶**，消除了原 `queued[0].sessionId` 整批标注导致的串流。
  - 日志目录层级：`<logPath>/[日期]/<端口号>/`（日期在外层，与 `log-cleanup.js:35` 的日期正则兼容），端口名用 `path.basename()` 并去尾部 `.`/空格，Shell 用 `_shell`。`connect-serial` 现在会重置 `mainLogFilePath`/`activeMainLogGroupId`/各 tab entry 的 `filePath`。
  - 门禁结果：双端口真机（COM6 + COM1）同时打开、各自可写、关闭一个另一个不受影响。
  - 验证：`npm test` 252/252；沙箱行为验证 19 项全通过；双端口端到端 9 项全通过；`git diff --check` 干净。
  - 仍不做：任何 UI 改动、双层标签栏、分屏改造、设置侧栏跟随、日志写入去同步化。

- [~] ~~P1.5：日志落盘去同步化~~ **已实测裁定不做**。实测：56 KB（115200 bps × 5 秒刷盘）单次 `appendFileSync` 仅 0.39 ms、450 KB 为 0.69 ms、1 MB 为 0.93 ms，而 Windows 定时器分辨率本身就是 15.6 ms；只有 10 MB 阈值批次才 12.72 ms。真实数据量下同步写盘比系统定时器还快，Worker 化买不到可感知收益，而那种量级下真正的瓶颈是终端渲染。保留 `fs.appendFileSync`；若将来真出现高吞吐卡顿，先查 `terminal-output-buffer` 与分批写入。

- [x] **配置迁移 v14 → v15：引入 `serialGroups`**（P3 的数据前置，已完成并实测）
  - 新增 `serial-groups-config.js`（纯逻辑，不碰 fs/Electron）：`SERIAL_GROUPS_CONFIG_VERSION` / `migrateSerialGroupsConfig` / `needsSerialGroupsMigration` / `normalizeSerialGroups` / `normalizeGroupSerialOptions` / `buildMigratedDefaultGroup` / `normalizeSerialGroup`。配套 `test/serial-groups-config.test.js` 14 项全通过。
  - `main.js`：`const CONFIG_VERSION = SERIAL_GROUPS_CONFIG_VERSION;`；`normalizeConfig()` 末尾 `return migrateSerialGroupsConfig(normalized);`；新增 `configBackupPath`，`loadConfig` 在归一化前备份（仅在未迁移且备份不存在时）。
  - **两个不可改的设计决定**：默认分组 id 固定为 `'default'`（随机会破坏幂等、日志目录归属会漂移）；迁移判据用 `hasOwnProperty('serialGroups')` 而非数组长度（`serialGroups: []` 是合法状态，用户可关光分组只留 Shell，绝不能被当成未迁移重新播种）。
  - 其余保证：旧字段全保留可降级回 v14；`sessionId` 归一化为 `null`；缺 id 补位序 id、重复 id 派生确定性后缀；端口为空时标题给 `Serial 1` 而不是空串。
  - 实测（真实 v14 配置 + 独立 `--user-data-dir`，连启两次）：config.json 21667→23284 字节、version=15、groups=1、g0=`default/COM6/921600`，旧字段保留；第二次仍 15/1 组，备份 mtime 未变（未被覆盖）。
  - **踩过的坑**：开发版与已安装版共用 `%APPDATA%\serialterminal`，旧版已安装程序会用旧 `saveConfig` 把 v15 覆盖回 v14，表现为「迁移没生效」。验证前必须查 `resources/app.asar` 是否含 `serialGroups`，或全程用独立 `--user-data-dir`。

- [x] **P3：标签归属纯逻辑层**（可独立验证，不碰 DOM）
  - 新增 `serial-group-tabs.js`：`buildTabBarModel()` 输出两层内容；`normalizeGroups` / `resolveActiveGroupId` / `resolveGroupAfterAdd` / `resolveGroupAfterClose` / `didLayerCountChange`。配套 `test/serial-group-tabs.test.js` 17 项全通过。
  - 三条硬规则：Shell 永不归属分组；分组数 ≥2 双层、=1 塌回一层；切换分组只换下层集合不销毁 DOM。
  - 已固定的非显然行为：`activeGroupId` 不存在退回第一个分组（否则下层整层空且无法恢复）；`activeTabId` 失效退回该组第一个标签；重复分组 id 去重；空标题给 `Serial N`；关闭当前分组优先选**右邻**；关闭非当前分组保持原选择；单分组时串口标签排在 Shell 之前。
  - **未接入 renderer**：DOM 层依赖「一组一个 Terminal 容器」（= P2 剩余），而 `serialTerm` 在模块加载时即 `open(#serial-container)`，全文 40 处引用，必须先解容器契约。

- [x] **P3：分组增删改数据层**（可独立验证）
  - 新增 `serial-groups-model.js`：`nextGroupId` / `addSerialGroup` / `removeSerialGroup` / `renameSerialGroup` / `findSerialGroup`。配套 `test/serial-groups-model.test.js` 17 项全通过。
  - 新分组继承边界：**只继承 `serialOptions`**；`portPath` 必须清空（否则会去抢已占用的口）；`title` 给 `Serial N`；`filterTabs`/`chartTabs`/`workspaceLayout` 一律清空（属于具体端口的数据视图）。
  - `nextGroupId` 取当前未被占用的最小 `g-<n>`：用「长度+1」会在删过中间分组后撞车（`[g-1,g-3]` → `g-3`）；不能用随机或时间戳（会破坏幂等与日志目录归属）。
  - `removeSerialGroup` 对不存在的 id 不抛错（关闭按钮可能连点），并返回被删分组供断串口/销毁子标签。`renameSerialGroup` 空标题回落原标题，上限 60 字符。

- [~] P2：渲染层分组上下文对象化（`isConnected`/`serialTerm`/`dataParser`/`hexFormatter`/`textDecoder`/`filterTabs`/`chartTabs`/`workspaceLayout` 收进分组对象，消费侧丢弃不匹配会话的字节）
  - [x] 第一步：新增 `serial-group-registry.js` 分组注册表，`accepts()` 作为「这条字节该不该进本分组终端」的唯一判定入口（带 `reason` 区分丢错与本该丢）；`renderer.js` 的 `serial-output-bytes` 归属性判定、`beginSession`/`invalidateSession` 已接入。配套 `test/serial-group-registry.test.js` 10 项全通过。
  - [x] 第二步：新增 `serial-group-context.js` 分组上下文（`SerialGroupContextStore`），提供 `serialLineCounter`/`logLineCounter`/`serialNewLine` 与四个收发显示参数；**其中只有三个计数器真正生效**（`getPrefix()`、`getLogPrefix()`、`clearTerminalByTabId`、连接成功重置均改走它），`receiveDisplayMode`/`receiveEncoding`/`sendEncoding`/`newlineMode` 仍由 `renderer.js` 自己的模块级 `let` 持有，`setDisplay()` 尚未被调用。配套 `test/serial-group-context.test.js` 8 项全通过。
  - [x] 第三步：抽处 `serial-data-parser.js`，并修复其内部直接调全局 `getPrefix()` 导致多实例行号串用的缺陷（改为注入 `prefixProvider`）。配套 `test/serial-data-parser.test.js` 10 项全通过；`test/markup.test.js` 的相应断言改指向新文件。
  - [ ] **阻塞项**：`serialTerm`/`filterTabs`/`chartTabs`/`workspaceLayout` 每个分组一份无法单独完成——`#serial-container` 是全页唯一串口终端容器。P5 的布局层已不再假设两个 pane，但 `index.html` 的动态 pane 创建归 P3（pane 数量由分组数驱动）。
- [ ] P3：双层标签栏与「添加串口」按钮（多分组两层，Shell 标签始终在分组层；只剩一组时塌回一层）
- [ ] P4：设置侧栏跟随 `activeGroupId`（串口参数按组，显示类与快捷指令保持全局）
- [~] P5：两级分屏（`workspace-manager.js` 从固定两 pane 扩展为 N pane，外层分组级 + 内层组内级）；**也是 P2 剩余部分的前置条件**
  - [x] 纯数据层：新增 `workspace-layout-shape.js`（`normalizePaneSizes` / `reconcileEmptyPanes` / `normalizeLayoutShape` / `createDefaultLayout`），`workspace-manager.js` 的同名函数改为委托调用。**硬约束：pane 数为 2 时输出必须与改造前逐字段一致**，由测试内嵌的 `legacyNormalize()` 用 10 组用例做 `assert.deepEqual` 对比。配套 `test/workspace-layout-shape.test.js` 16 项全通过。
  - [x] 过程中修掉四处真实问题：缺项补位不能有 `1/n` 回退（否则把已占满的 pane 缩小）；只在「全空」或「只剩一个非空」时收敛（否则拆散合法三 pane 布局）；宿主 pane 选择按 pane 数分叉（两 pane 选 `pane-1` 保证等价，N>2 选有内容的）；收敛时必须保留被搬 pane 的 `activeTabId`。
  - [x] 另一个隐蔽判定错误：`moveWorkspaceTab` 搬空某 pane 后会残留陈旧 `activeTabId`，合并时若用合并**后**的列表判定会让它错误通过；现改为用合并前记录的 `primaryTabIdsBefore` 判定。
  - [x] DOM 层：`workspace-manager.js` 的 12 处 `pane-1`/`pane-2` 字面量全部改为由布局驱动——`resolvePaneId` 只要求「存在于当前布局」、`getOtherPaneId` 按列表循环、`reconcileEmptyPanes` 宿主取 `layout.activePaneId`、`updatePaneVisibility` 对 index>0 的 pane 统一跟随分屏、`applyPaneSizes` 改为写各 pane 内联 `flexBasis`（不再用两个 CSS 变量）、`collapseSplit` 合入除首个 pane 外的全部 pane、`setPaneSizes` 支持 >2 pane。配套改 `style.css`（删除 `#pane-1`/`#pane-2` 选择器）与 `renderer.js`（`transitionend` 按类名判断）。配套 `test/workspace-pane-n.test.js` 6 项全通过。
  - [x] pane 节点：新增 `pane-layout-dom.js`（纯数据描述，9 项单测）、`workspace-manager.js` 的 `ensurePaneElements()`（先补节点再布局，防 `appendChild(null)` 静默丢标签页）、`renderer.js` 的 `createPaneElement(paneId)`。第 3 个及以后的 pane 可按需创建；`test/workspace-pane-n.test.js` 补至 8 项全通过。
  - [ ] 剩余：`index.html` 的静态 `pane-1`/`pane-2` 也改为动态创建——**阻塞于** `serialTerm` 在模块加载时就 `open(#serial-container)`，需与 P2 剩余部分一并做。

P2 剩余部分必须先解 P3 的动态 pane 创建（P5 的布局层前置已完成），否则做出来是伪多实例。其它阶段逐个开工，不得并行。

## 验证基线

- [x] 所有项目 JavaScript 文件通过 `node --check`。
- [x] `git diff --check` 通过。
- [x] `npm test` 当前 **364/364 通过、0 失败**（含 `test/workspace-layout-shape.test.js` 16 项、`test/workspace-pane-n.test.js` 8 项、`test/pane-layout-dom.test.js` 9 项、`test/serial-groups-config.test.js` 14 项、`test/serial-group-tabs.test.js` 17 项与 `test/serial-groups-model.test.js` 17 项）。
- [x] 配置迁移磁盘验证：独立 `--user-data-dir` 连启两次，`config.json` 均为 v15 + 1 组，旧字段保留，`config.v14.backup.json` 保持 21667 字节的 v14 原件且第二次启动未覆盖。
- [x] 实机启动：主窗口正常出现，`main.log` 与渲染进程 stderr 均无 JS 错误，electron 进程清理后 `remaining: 0`。
- [ ] **多串口行为的人工 GUI 验证**：连接、收发、日志写入从未在真实窗口中手工跑过；现有结论均来自单测与源码断言。
- [ ] Windows 和 Linux 打包通过（Windows NSIS 已有成功记录，Linux 仍待验证；不再生成 portable 版本）。
- [ ] 真实或虚拟串口覆盖 Text/Hex、UTF-8/ASCII/GBK、自动发送、快捷发送、Raw 日志和重连。
- [ ] 主终端、过滤标签、图表标签、Shell 标签、分屏、壁纸、搜索历史和侧边栏收起/展开进行人工交互回归。
- [x] `npm audit --registry=https://registry.npmjs.org --omit=dev` 无 High/Critical。
