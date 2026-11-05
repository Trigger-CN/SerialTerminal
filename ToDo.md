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

## P3 - 多串口支持（P1–P5 全部完成；剩余为验证缺口）

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
  - **接线状态（2026-11-05 更正）**：上述「未接入 renderer」已不成立。实际接 DOM 用的是下面新增的 `serial-group-tab-bar.js`（分组栏作为独立一行）+ `serialGroups` 状态 + `ensureSerialGroupMainTabDom`。但 `serial-group-tabs.js` 的双层模型**仍未驱动 DOM**：当前分组栏只列分组，Shell 仍在 pane 标签行，因此「Shell 与分组标签同级」的两层形态尚未实现。

- [x] **P3：分组标签栏结构描述层**（可独立验证）
  - 新增 `serial-group-tab-bar.js`：`GROUP_TAB_BAR_ID`/`GROUP_TAB_LIST_ID`/`ADD_GROUP_BUTTON_ID`、`groupTabId`/`groupTabButtonId`/`groupCloseButtonId`、`describeGroupTab`/`describeGroupTabBar`/`describeAddGroupButton`/`describeGroupVisibility`。配套 `test/serial-group-tab-bar.test.js` 15 项全通过。
  - 五条非显然规则：分组标签与主终端标签 id 永不相交；默认分组也带 `-default` 后缀；默认分组不可关闭但**仍渲染关闭按钮**（置灰，否则标签宽度跳变）；`groupId` 放 `dataset`；未知激活分组全部隐藏。
  - 显示判据是 **`isMultiGroup === true` 且 `groups.length > 1`**，两者缺一不可；`canAdd` 恒为真（否则用户永远开启不了多分组）。

- [x] **P3：渲染层输出分桶纯逻辑**
  - 新增 `serial-output-buckets.js`：`SerialOutputBuckets`（`push`/`drain`/`drainGroup`/`pendingBytes`/`totalPendingBytes`/`pendingGroupIds`/`hasPending`/`clear`/`clearAll`）。配套 `test/serial-output-buckets.test.js` 12 项全通过。
  - **`drain()` 的每一项严格只含一个 groupId 的字节**——这是整份改造唯一的硬指标。水位（默认 1 MiB）按分组独立判断；缺失或非法 groupId 回落默认而不是丢弃。

- [x] **P3：渲染层数据面按 groupId 路由**
  - 新增 `resolveSerialGroupId`（未登记回落默认）/ `isActiveSerialGroup` / `getGroupSessionId` / `serialGroupIo: Map<groupId, {textDecoder, hexFormatter}>` / `getSerialRuntime` / `getSerialTerm` / `resolveGroupIdForMainTab`。
  - 全部写入路径改为带 `groupId`：`writeTextLines` / `writeHexLines` / `renderSentRecord` / `flushTextReceive` / `resetTextReceive` / `createTextDecoder` / `writeMainTabLog` / `writeFilterTabLog` / `writeTabLog` / `connectSerialFromUi({groupId})` / `sendSerialRequest` / `serial-output-bytes` / `serial-error` / `serial-disconnected` / `clearTerminalByTabId`。`main.js` 的 `write-tab-log` 透传 `payload.groupId`。
  - **四条必须保留**：① `serialSessionId` 只在默认分组时同步；② `serial-disconnected` 只在默认分组时改全局连接状态；③ `clearTerminalByTabId` 必须清 `serialOutputBuckets`；④ 默认分组 `getMainTabTitle` 仍返 `'Main_Terminal'`。

- [x] **P3：分组标签栏 DOM 接入与容器创建/关闭**
  - `index.html` 新增 `#serial-group-tab-bar`（默认 `hidden`）+ `#serial-group-tab-list` + `#add-serial-group-btn`；`style.css` 补齐样式（36px 高、active 下边线、已连接小圆点、默认分组关闭按钮 `.disabled`）。
  - `renderer.js` 新增 `serialGroups`/`activeGroupId`/`isApplyingSessionGroups` 与 `syncSerialGroupsFromConfig`/`ensureSerialGroupMainTabDom`/`renderSerialGroupTabBar`/`applyActiveSerialGroup`/`addSerialGroupFromUi`/`closeSerialGroup`。
  - **`syncSerialGroupsFromConfig` 必须调 `ensureGroup` + `ensureContext`**：缺这两步会让 `serial-output-bytes` 以 `unknown-group` 静默丢弃这些分组的全部字节。
  - 新分组 **status=disconnected，不自动连接**（用户已确认的产品决定）。
  - **真实点击验证 19/19 PASS**：单分组时分组栏隐藏、点「添加串口」后建出 `serial-container-g-1`/`tab-main-g-1`/`tab-main-g-1-button` 且新分组成为 active、切回默认分组高亮正确、关闭后分组栏回 `hidden` 且容器与主标签均移除、默认分组不受影响、渲染进程无未捕获错误。
  - **过程中修掉一个只有真实点击能暴露的缺陷**：`renderSerialGroupTabBar()` 把 `describeGroupTabBar()` 的 `tabs` 又喂回 `describeGroupTab()`，而后者用 `source.id` 取 groupId（spec 上只有 `groupId`），导致所有分组回落 `'default'`——两个标签同一 id、新分组不高亮、`tab-group-g-1-close` 不存在、关闭流程完全点不到。修复：直接消费 `tabs`，不再二次描述。

- [x] **P3：Shell 标签与分组标签同级的两个层次投影**
  - `renderer.js` 新增 `syncShellTabLayer()`：多分组时把 Shell 按钮搬到 `#serial-group-tab-list`（排在分组标签之后），单分组时按 `pane.tabIds` 相对顺序 `insertBefore` 落回 pane 标签行。**只移动节点、不重建**（监听与 xterm 实例全部保留）。
  - `workspace-manager.js` 新增两个**可选注入**：`resolveTabButtonHost`（按钮挂哪个容器）与 `findTabButton`（放宽按钮查找范围）。不注入时行为与改造前逐字一致。
  - 两条不改就会错的细节：① 不补 `findTabButton`，被搬走的 Shell 会被 `prunePaneTabIds()` 判为不可渲染并从 `tabIds` 删除（**标签彻底消失**）；② 不补 `resolveTabButtonHost`，`applyLayoutToDom()` 会把按钮强制拽回 pane 行。
  - `applyActiveTabToPane()` 的 `active` 清理改为按 `dataset.paneId` 全文档清，否则被搬走的 Shell 会残留激活态（「两个标签同时亮」）。
  - CDP 实测：单分组 `inPaneRow:true`；多分组顺序 `[分组标签..., Shell]`；点击后终端切到该标签且仍在分组层；关闭多分组后回落 pane 行；`shellCount` 恒为 1。
- [~] P2：渲染层分组上下文对象化（`isConnected`/`serialTerm`/`dataParser`/`hexFormatter`/`textDecoder`/`filterTabs`/`chartTabs`/`workspaceLayout` 收进分组对象，消费侧丢弃不匹配会话的字节）
  - [x] 第一步：新增 `serial-group-registry.js` 分组注册表，`accepts()` 作为「这条字节该不该进本分组终端」的唯一判定入口（带 `reason` 区分丢错与本该丢）；`renderer.js` 的 `serial-output-bytes` 归属性判定、`beginSession`/`invalidateSession` 已接入。配套 `test/serial-group-registry.test.js` 10 项全通过。
  - [x] 第二步：新增 `serial-group-context.js` 分组上下文（`SerialGroupContextStore`），提供 `serialLineCounter`/`logLineCounter`/`serialNewLine` 与四个收发显示参数。**本阶段只有三个计数器真正生效**（`getPrefix()`、`getLogPrefix()`、连接成功重置均改走它）；四个显示参数的真正下沉在 **P4** 完成（`setDisplay()` 到那时才首次被调用）。配套 `test/serial-group-context.test.js` 8 项全通过。
  - [x] 第三步：抽处 `serial-data-parser.js`，并修复其内部直接调全局 `getPrefix()` 导致多实例行号串用的缺陷（改为注入 `prefixProvider`）。配套 `test/serial-data-parser.test.js` 10 项全通过；`test/markup.test.js` 的相应断言改指向新文件。
  - [x] 第四步：新增 `serial-group-runtime.js` 分组终端运行时注册表（`has`/`get`/`attach`/`getOrCreate`/`release`/`releaseAllExceptDefault`/`assertDefaultAttached`）。配套 `test/serial-group-runtime.test.js` 19 项全通过。
  - [x] 注册表的三条硬约束：**惰性创建**（xterm 的 `open()` 需要真实 DOM，标签未渲染不能构造）；**默认分组不可释放**（释放后无路径恢复，用户看到空白终端）；**释放前必须 dispose**（只删引用会让 canvas/textarea 与滚动缓冲挂在 DOM 上，长用越来越卡）。
  - [x] `attach()` 用于改造初期：默认分组的终端已在模块加载期建好并 open，再让注册表构造会得到**两个绑在同一容器的 xterm 实例**（互相抢输入、画面覆盖），比不接入更糟；对已登记分组返回 `false` 而不覆盖。
  - [x] 第五步：新增 `serial-group-dom.js` 分组 DOM 标识契约（`groupDomSuffix`/`mainTabId`/`mainTabButtonId`/`serialContainerId`）。把 `tab-main` 与 `serial-container` 从两处独立字面量变成可计算的 id。**默认分组无后缀**（算出仍是 `tab-main` / `serial-container`，与改造前逐字一致），非默认分组为 `serial-container-g-1`；后缀在尾部以保留前缀便于批量查找；`[^A-Za-z0-9_-]` 净化（脏 id 进 `querySelector` 会抛 `SyntaxError`），空 id 回落默认分组。`pane-layout-dom.js` 的两处字面量改为委托本模块；`renderer.js` 三处容器查找（open / context menu / wheel）改为 `serialContainerId(REGISTRY_DEFAULT_GROUP_ID)` 并合并为一次解析。配套 `test/serial-group-dom.test.js` 8 项全通过（其中一项直接读 `index.html` 校验三个 id 真实存在）。
  - [x] 第六步：**终端构造改为工厂 + 注册表托管**。新增 `buildSerialTerminalOptions()`（唯一构造模板）与 `createSerialRuntime(groupId)`（返回 `{ groupId, term, fitAddon, searchAddon, dataParser, container, dispose }`）；`serialRuntimes = new SerialTerminalRuntimeRegistry(...)`；默认分组经 `serialRuntimes.getOrCreate()` 构造，`serialTerm`/`serialFitAddon`/`serialSearchAddon` 从运行时取出。**工厂因此不再是死代码。** 两条必须保留的细节：`dataParser` 由运行时持有（同一分组两个解析器时只有一个被写入，行号会「不涨」）；**不得在工厂外再调 `serialTerm.open()`**（xterm 重复 open 会重建 DOM 并静默丢掉已写内容）。
  - [x] 第七步：新增 `serial-group-workspace.js` 分组工作区形状（15 项）：`describeGroupWorkspace` / `describeGroupWorkspaceEntry` / `findMissingGroupContainers` / `attributeSelector`。算出每组应有的容器 id 与属性选择器（`[id="serial-container-g-1"]`，避免 `#1a` 这类合法 id 在 `querySelector` 里报语法错）。仍是纯数据，不建节点。
  - [x] **新增 renderer 模块加载门禁**：`scripts/check-renderer-module-load.js` + `test/renderer-module-load.test.js`（4 项，含 TDZ 反向对照与「serialTerm 必须取自运行时」断言）。工厂在模块顶层被立即调用，顺序写错会启动即白屏，而 `node --check` 与源码正则都看不见。门禁在**独立子进程**里只对同步顶层求值负责：renderer 顶层会排入依赖真实布局的异步回调，同进程执行会让这些拒绝把整个文件判红。
  - [x] markup 计数断言已按预期改写：`enableTerminalUnicode11(term);` 由 2 → **3**（串口工厂/过滤/Shell）；另有一条改为断言 `buildSerialTerminalOptions()` 模板与工厂调用（模板才是唯一真相源）。
  - [x] **阻塞项已解除**：`#serial-container` 不再全局唯一——`ensureSerialGroupMainTabDom()` 为每个非默认分组建出 `serial-container-<groupId>`，并由 `serialRuntimes.getOrCreate(groupId)` 惰性构造终端；`getSerialRuntime(groupId)` / `getSerialTerm(groupId)` 已按分组取用且未登记回落默认。
- [~] P3：双层标签栏与「添加串口」按钮（多分组两层，Shell 标签始终在分组层；只剩一组时回到单层）
  - 已完成的子项见上方 P3 各条（标签归属/结构描述/输出分桶/数据面路由/DOM 接入与容器创建关闭/Shell 两层升降）。
  - **仅剩的边界**：`filterTabs` / `chartTabs` 仍按全应用单例处理，只跟随激活分组。
- [x] P4：设置侧栏跟随 `activeGroupId`（串口参数按组，显示类与快捷指令保持全局）
  - [x] 四个显示参数真正下沉：新增 `getGroupDisplay()` / `setGroupDisplay()`，`SerialGroupContextStore.setDisplay()` 成为唯一写入路径；模块级 `let` 降为「默认分组缓存」。
  - [x] 按分组读取的 7 类消费点：`dispatchSerialBatch`（hex/text 判定，最实质）、`createTextDecoder`、`clearTerminalByTabId`、`serial-disconnected` 的 flush 判据、`sendSerialRequest`、`getMainInputRequest`、新建过滤页的 `dataMode`、右键菜单的 `receiveDisplayMode`。
  - [x] 三个 `switch*` 新增 `groupId` 参数，且只在 `id === activeGroupId` 时才改侧栏控件与 `refreshSendConsumers()`。
  - [x] 侧栏回显：`applyGroupSerialOptionsToSidebar()` 回显 9 个控件（含接收编码 `disabled` 同步）+ `refreshConnectButtonState()` 同步连接按钮。**全部用 `document.getElementById`**（避开加载早期的 TDZ）。
  - [x] 双写持久化：`persistActiveGroupSerialOptions()` 同时写 `serialGroups[activeGroupId].serialOptions` 与 `lastSerialOptions`。
  - [x] 新增 `isGroupConnected(groupId)`：读注册表而非全局 `isConnected`。
  - [x] 保留的例外（已锁定决策）：快捷指令与自动发送的 `sendEncoding` 仍为全局（默认分组）。
  - [x] 验证：CDP 真实点击 **37/37 PASS、exit=0**；其中 P4 新增 6 项（含「g-1 改成 gbk → 切回默认仍 utf8 → 再切 g-1 回显 gbk」与「关闭 g-1 后默认分组未被污染」）。
  - [ ] 未验证：真实双端口字节流下「A 组 text / B 组 hex 同时接收」的渲染结果（字节级证据缺失）。
- [x] P5：两级分屏（`workspace-manager.js` 从固定两 pane 扩展为 N pane，外层分组级 + 内层组内级）——**已完成并提交（`f65fb98` + `a31ee20`）**
  - [x] 纯数据层：新增 `workspace-layout-shape.js`（`normalizePaneSizes` / `reconcileEmptyPanes` / `normalizeLayoutShape` / `createDefaultLayout` / `createDefaultLayoutFor`），`workspace-manager.js` 的同名函数改为委托调用。**硬约束：pane 数为 2 时输出必须与改造前逐字段一致**，由测试内嵌的 `legacyNormalize()` 用 10 组用例做 `assert.deepEqual` 对比。配套 `test/workspace-layout-shape.test.js` 16 项全通过。
  - [x] 过程中修掉四处真实问题：缺项补位不能有 `1/n` 回退（否则把已占满的 pane 缩小）；只在「全空」或「只剩一个非空」时收敛（否则拆散合法三 pane 布局）；宿主 pane 选择按 pane 数分叉（两 pane 选 `pane-1` 保证等价，N>2 选有内容的）；收敛时必须保留被搬 pane 的 `activeTabId`。
  - [x] 另一个隐蔽判定错误：`moveWorkspaceTab` 搬空某 pane 后会残留陈旧 `activeTabId`，合并时若用合并**后**的列表判定会让它错误通过；现改为用合并前记录的 `primaryTabIdsBefore` 判定。
  - [x] DOM 层：`workspace-manager.js` 的 12 处 `pane-1`/`pane-2` 字面量全部改为由布局驱动——`resolvePaneId` 只要求「存在于当前布局」、`getOtherPaneId` 按列表循环、`reconcileEmptyPanes` 宿主取 `layout.activePaneId`、`updatePaneVisibility` 对 index>0 的 pane 统一跟随分屏、`applyPaneSizes` 改为写各 pane 内联 `flexBasis`（不再用两个 CSS 变量）、`collapseSplit` 合入除首个 pane 外的全部 pane、`setPaneSizes` 支持 >2 pane。配套改 `style.css`（删除 `#pane-1`/`#pane-2` 选择器）与 `renderer.js`（`transitionend` 按类名判断）。
  - [x] pane 节点：新增 `pane-layout-dom.js`（纯数据描述，9 项单测）、`workspace-manager.js` 的 `ensurePaneElements()`（先补节点再布局，防 `appendChild(null)` 静默丢标签页）、`renderer.js` 的 `createPaneElement(paneId)`。第 3 个及以后的 pane 可按需创建。
  - [x] **分组级布局的 DOM 标识契约**：新增 `serial-group-layout-dom.js`（17 项单测，`groupWorkspaceRootId` / `groupPaneId` / `groupSplitterId` / `groupWorkspaceContainerId` / `groupWorkspaceEntryId` / `resolveGroupWorkspaceEntries` / `describeGroupPanes` / `describeGroupWorkspace`）。**默认分组的三个 id 与静态标记逐字一致**（启动时序要求，由一条用例直接读 `index.html` 断言）。
  - [x] **外层容器与可注入作用域**（`f65fb98`）：`index.html` 新增 `#group-workspace` 包住静态 `#workspace-root` + `#group-workspace-splitter`；`workspace-manager.js` 新增可选注入 `getWorkspaceRoot` / `getSplitter` / `getPaneElements`，三处全局硬编码改走解析器（不注入时逐字沿用旧写法）。
  - [x] **每分组独立布局与布局管理器**（`a31ee20`）：`groupWorkspaceLayouts` / `groupWorkspaceManagers` + 模块级别名，`setActiveGroupWorkspace()` 统一切换；标签登记按 pane id 反推分组（`addTabToOwningGroupPane` / `resolveGroupIdFromPaneId`）；Shell 始终走默认分组（`switchShellTab`）；标签拖动与分界条拖动改事件委托；`applyConfig` 三处 pane 硬编码改为按布局枚举。
  - [x] 修掉 `applyLayoutToDom()` 用全局选择器清激活态的真实缺陷（一个分组重排会把另一个分组已激活的标签清空，且后者布局未变不会重算）。
  - [x] 说明：原计划的「`index.html` 静态 `pane-1`/`pane-2` 也改为动态创建」**已出于启动时序原因放弃**——默认分组沿用静态 id 才是正确做法，重排会面临「xterm 重复 open 丢内容」的真实风险。
  - [ ] 未验证：两级分屏的 `fit`（切回 `display:none` 容器时是否被压扁/裁切）；分组级拖动分界条的实际比例换算；拖动非默认分组的标签；两个分组同时收数据时各自的终端渲染。

P1–P5 的功能已全部落地。上表剩余的 `[ ]` 项都是**验证缺口**（需真实双端口 / 人工 GUI），不是待实现的代码。其它阶段已完成，不再需要并行推进的约束。

## 验证基线

- [x] 所有项目 JavaScript 文件通过 `node --check`。
- [x] `git diff --check` 通过。
- [x] `npm test` 当前 **492/492 通过、0 失败**（含 `test/workspace-layout-shape.test.js` 16 项、`test/workspace-manager.test.js` 11 项、`test/workspace-pane-n.test.js` 8 项、`test/pane-layout-dom.test.js` 9 项、`test/serial-groups-config.test.js` 14 项、`test/serial-group-tabs.test.js` 17 项、`test/serial-groups-model.test.js` 17 项、`test/serial-group-runtime.test.js` 19 项、`test/serial-group-dom.test.js` 8 项、`test/serial-group-workspace.test.js` 15 项、`test/serial-group-tab-bar.test.js` 15 项、`test/serial-group-layout-dom.test.js` 19 项、`test/serial-group-tab-lists.test.js` 13 项、`test/serial-output-buckets.test.js` 12 项、`test/serial-port-claims.test.js` 13 项、`test/serial-group-display-prefs.test.js` 10 项与 `test/renderer-module-load.test.js` 4 项）。
- [x] **renderer 模块加载门禁**：`node scripts/check-renderer-module-load.js` 退出码 0；反向对照（故意 TDZ）确实非零退出。**边界**：它的 `document.getElementById` 每次返回新 stub，**无法表达 id 重复或真实 DOM 交互**（本轮已实际踩到）；也**覆盖不到异步回调**（`applyConfig` 里的 `ReferenceError` 只能靠真实启动窗口暴露）。第 9 项又亲眼看到一次：`GROUP_TAB_BAR_ID is not defined` 在 `node --check` 与加载门禁下均全绿，只有真实启动的 `[RENDERER DIAGNOSTIC]` 才暴露。
- [x] **静态未定义标识符扫描**：`.me/tmp/*/scan-undefined.js` 扫 **95** 个候选标识符，`checked=95 / missing=none`。它是第三层保险，**不做真正的作用域分析**，用途只是「新写的代码里漏了 require 或漏了声明」。
- [x] **CDP 真实点击验证**：带 `--remote-debugging-port=9222` 与独立 `--user-data-dir` 启动实例，用手写的最小 CDP 客户端（仅 Node 内置模块，未引入依赖）真实点击并断言 DOM。现为 **15 个脚本全绿、退出码均为 0**（合计 281 项断言，0 失败）：

| 脚本 | 项数 / 结果 | profile |
| --- | --- | --- |
| `verify-user-paths.js` | **15/15** | `diag350` |
| `verify-group-columns.js` | **37/37** | `diag351` |
| `verify-shell.js` | **16/16** | `diag352` |
| `verify-group-split.js` | **19/19** | `diag353` |
| `verify-sidebar-groups.js` | **14/14** | `diag354` |
| `verify-titles.js` | exit=0 | `diag355` |
| `verify-context-menu-and-highlight.js` | **17/17** | `diag356` |
| `verify-shell-drag.js` | exit=0 | `diag357` |
| `verify-shell-switchback.js` | **14/14** | `diag358` |
| `verify-connect-group.js` | exit=0 | `diag359` |
| `verify-same-port-guard.js` | 3 通过 + 1 skip | `diag360` |
| `verify-display-pref-scope.js` | exit=0 | `diag361` |
| `verify-shell-buttons-split.js` | **16/16** | `diag362` |
| `verify-split-geometry.js` | **26/26** | `diag364` |
| `verify-no-tab-flash.js`（新增） | **18/18** | `diag365` |

  全部 `app-diagNN-err.log` 无 `[RENDERER DIAGNOSTIC]`（`run-all-350.txt`）。`verify-same-port-guard` 在端口被其它进程占用时按脚本设计 `SKIP` 并输出 `fail=0 skip=1`（不是回归）。
- [x] **分屏的三个几何与宿主缺陷**：用户实测报告 `两个串口组左右分屏，点击任意一个串口组标签shell就会跟着跳过去；并且分屏的分割线过宽，并且在三分屏下只有一个…分屏后最右侧的分屏会超出窗口右侧边界`。实测（`diag-split-geometry2` @ `diag250`）：容器 `799px`、两列各 `50%`、分界条 `10px` → `widthSum 809`、`maxRight 1010` 对容器 `right 1000`，**溢出恰好 10px**；三列可见时分界条仍只有 1 条；点 `g-1` 后 Shell 的 `columnId` 与面板 `parentId` 全部跨列变化。四处根因与修法：(a) `resolveShellTabHost` 的 `topRow` 分支用 `getSingleVisibleGroupId() || activeGroupId`，而前者在「已分屏且列 > 1」时恒为 `null` —— 改为 `resolveShellTopRowColumn()`，用 `tabState.topRowColumnId` 记忆所在列，只有不可见时才重选；(b) `.group-workspace-splitter` 由 `flex: 0 0 10px` 收窄到 `4px`，`::after` 左右各溢 2px 只扩大命中区；(c) 新增 `syncGroupWorkspaceSplitters()` 按可见列数保证 N-1 条，每条用 `data-splitter-left/right` 声明夹住的两列，`bindGroupWorkspaceSplitter()` 改为在**被夹两列自身宽度之和**内换算比例；(d) `flex-basis` 改为 `calc(<比例>% - <比例×分界条总占位>px)`。**顺带修掉一个既有缺陷**：`gutterTotal` 原统一用 `width` 求和，而 vertical 下分界条是 `width: 100%`，两列各扣 799px → 上下分屏 `height` 全为 0、彻底不可用，改为按 `orientation` 取 `height`/`width`。新增 `verify-split-geometry.js` **26/26**（`diag303`）。
- [x] **新建 Shell 按钮永久只在一层标签栏出现**：用户实测要求 `二层标签栏可以不再显示 打开shell按钮，永久移入一层标签栏`。全项目共五个产生点（`index.html` 的 `#pane-1-new-shell-tab-btn` / `#pane-2-new-shell-tab-btn`、`createPaneElement()` 与 `createGroupPaneElement()` 的 `buttonSpecs`、多分组专用的 `#add-shell-tab-btn`），而旧的 `syncShellAddButtonVisibility()` 只有 `addShellTabBtn.hidden = serialGroups.length <= 1;` 一行，只控第五个——多分组时屏幕上同时存在「一层一个 + 二层每列各一个」。现在规则改为「**恰好一个可见**，位置随层数切换」：多分组时 `#add-shell-tab-btn` 是唯一入口（未分屏跟随激活列，分屏由 `placeShellAddButton()` 搬到激活列列首行），`document.querySelectorAll('.pane-tab-actions > button')` 里所有 `/-new-shell-tab-btn$/` 全部 `hidden = true`；单分组时分组标签行整体 `hidden`（`describeGroupTabBar()` 的 `hidden: !isMultiGroup`），保留 pane 行那个作为唯一入口——否则用户永远开不出第一个 Shell。按 id 后缀扫而不是写死引用清单（组内分屏与新建分组会现造按钮），并在 `createPaneElement()` 末尾补调（新造按钮不经过重绘，漏调会让新分屏那列凭空多出一个入口）。改的是 `hidden`，不改 DOM 结构：两处 `buttonSpecs` 的 `kind: 'shell'` 项必须保留（单分组组内分屏 `pane-2` 依赖它）。`verify-shell-buttons-split.js` 增至 **16/16**（`diag312`，新增 `multi-group-pane-row-shell-buttons-hidden` / `split-pane-row-shell-buttons-hidden` / `split-group-shell-button-still-visible`），全量回归 `run-all-320.txt` 14 个脚本全部 `exit=0` + `renderer-diag=clean`，`npm test` **492/492**。
- [x] **切标签时整个窗口与标签栏闪一下**：用户实测报告 `标签切换的时候整个窗口都会闪一下，标签栏也会闪`。`diag-tab-flash.js` @ `diag340` 逐帧采样拿到三条事实：切完激活面板 `opacity` 恒为 `0`、`transform: translateY(5px)`（过了 12 帧仍是 0）；标签按钮 `opacity` 也是 `0`；分组标签节点身份 `groupTabSameNode: true`（**没有被重建**）。因此不是渲染性能问题，而是两处确定的重绘源：(a) `style.css` 里 `.main-tab` 的 `tabFadeIn`、`.main-tab-pane.active` 与 `.sidebar-tab-pane` 的 `fadeIn` —— 这些元素在同一个会话里反复显隐，动画每次都从头重播；(b) `applyLayoutToDom()` 无条件 `appendChild`，即使目标父节点就是当前父节点，DOM 也会先摘再插，把动画再触发一次并引起整行重排。另外 `renderSerialGroupTabBar()` 先 `replaceChildren()` 再逐个 `buildGroupTabButton()`，每次切分组换一批新按钮。修法：删掉三处 `animation` 与 `@keyframes fadeIn` / `tabFadeIn`（删前确认无其它引用）；`applyLayoutToDom()` 只在 `parentElement !== 目标容器` 时搬节点；`renderSerialGroupTabBar()` 改为按 `buttonId` 复用节点 + `updateGroupTabButtonState()` 就地更新，末尾按 `knownGroupIds` 反向移除已关分组的按钮。因为按钮不再重建，原先“构造时用闭包绑 groupId”会永久持有旧值，分组标签的点击与右键菜单改为在列表上**事件委托**（`bindGroupTabListEvents`，静态列表模块加载时挂一次、动态列的列表在 `createGroupTabRowElement()` 里各自挂）。新增 `verify-no-tab-flash.js` **18/18**（`diag341`），全量回归 `run-all-350.txt` 15 个脚本全部 `exit=0` + `renderer-diag=clean`，`npm test` **492/492**。
- [x] **Shell 标签的两个布局缺陷（`10f3bd5`）**：用户实测报告 `创建shell标签后，上次的串口标签点不动了没法切换…创建shell按钮就不可见了` 与 `让COM2进行左右分屏…会变成下面这样`（错误图：三列串口 + 一列 SHELL）。三处根因：(a) `createShellTab` 结尾会把 Shell 切为 pane-1 激活标签，而 `revealSerialGroupActiveTab` 直接把它当作「要抬回的串口标签」，于是「点当前分组标签」等于把 Shell 重新点亮——现在增加「目标必须是串口标签」的判断，否则回退到上次的串口标签（新增 `lastSerialTabByPane`，由 `switchPaneTab` / `setActivePane` / `activateShellTabInHost` 维护）；(b) 多分组时唯一的新建 Shell 入口在 pane 行，而这一条在显示上层 Shell 时被整条隐藏——现在 `index.html` 静态分组行新增 `#add-shell-tab-btn`（`placeShellAddButton` 跟随可见行、`reclaimShellAddButton` 关列前抢回、`syncShellAddButtonVisibility` 与 pane 行那个互斥），且下层行改为**常任显示**；(c) `isShellColumnActive` / `resolveShellTabHost` 原先把「未归属」一律映射为独立列——现在新增逐标签 `tabState.detachedColumn`，只有拖到分组标签行才独立成列，新建的未归属 Shell 与分组标签同级留在列首行。新增 `verify-shell-buttons-split.js` **13/13**（`diag242`）。
- [x] **连接/断开按钮必须作用于当前串口分组（用户实测缺陷）**：`选择串口2组，点击链接串口，串口1组会链接…串口2组的处于断开状态`。根因是整条连接链路写死默认分组：`toggleSerialConnection()` 不传 `groupId`、`disconnectSerial()` 写死 `REGISTRY_DEFAULT_GROUP_ID`、`connectSerialInProgress` 与 `isConnected` 都是全局单值。现在：`toggleSerialConnection()` 以 `activeGroupId` 为对象；`disconnectSerial(groupId)` 按分组断开且只对默认分组清理 `serialSessionId` / `serialWriteChain` / 自动发送 / `chartTabs`；两个布尔锁改成按分组 Set；`waitForSerialDisconnected(groupId)` 与 `serialDisconnectWaiters` 改为按分组等待；`refreshConnectButtonState()` 按激活分组重算并带 busy 禁用态；主终端键盘输入改为 `bindGroupTerminalInput()` 逐分组绑定；`sendSerialRequest()` 的身份门禁改按目标分组。新增 `verify-connect-group.js` **23/23**（`diag129`），在真实渲染进程旁路记录 IPC、不打开真实串口，覆盖双向分组切换、按钮跟随、断开只断自己、连接提示不污染另一分组终端、端口不跨分组继承。
- [x] **同一物理端口只允许一个串口分组占用**：用户报告 `两个组选择相同的端口居然都能打开`。在本机（最新构建 + `COM6`）**无法复现**：底层探针与真实渲染进程双重取证，第二次打开都被驱动拒绝（`COM6 => first:OK | second:Opening COM6: Access denied`；`diag-same-port-out2.txt` 里 `g-1` 保持 `connected:false`、`both-claim-connected:false`）。所以这不是修复一个被复现的缺陷，而是把原本只由驱动提供的保证提升为应用保证 —— 部分虚拟串口 / USB 复合设备 / 带共享模式的驱动确实允许第二次打开，届时两个分组各持一个句柄、同一份字节流被两边消费、日志写两份，不报错只出错乱数据。新增纯逻辑模块 `serial-port-claims.js`（`claim` / `releaseGroup` / `releasePort`，端口键统一大写），在 `connect-serial` 开头（**在动本分组旧连接之前**）、`port.open` 错误分支、`cleanupSerialConnection()`、`disconnect-serial` 四处接入；错误以 `SERIAL_PORT_IN_USE|<PORTKEY>|<ownerGroupId>|<英文原文>` 回传，渲染层解析后走 `main.serialPortInUse` 给本地化提示。新增 `test/serial-port-claims.test.js` 13 项与 `verify-same-port-guard.js` **15/15**（`diag140`/`diag151`，**用真实串口**）：`default` 打开 `COM6` 后 `g-1` 抢同一端口被拦下、提示是本地化文案而非 `Access denied`、`default` 连接不受影响，**断开 `default` 后 `g-1` 立刻能连上**（证明占用已释放，端口不会被永久锁死）。


- [x] **显示类复选项的作用域由设置开关控制（`363abd2`）**：`diag110` 取证显示 `show-timestamp` / `show-lineno` / `echo-sent-data` / `echo-sent-data-both` / `echo-sent-data-filter` 切换分组后仍停留在上一次改成的值（原来只写模块级全局变量并经 `update-display-settings` 持久化）。现在设置 > 终端新增「每个串口分组各存一份显示偏好」，**默认关闭**＝全局共享，行为与改造前完全一致（仍写配置顶层同名键，旧配置免迁移）；开启时用当前全局值为每个分组种入一份，此后每组各存一份，切换分组时侧栏五个勾选框跟随切换，`getPrefix()` 与 `renderSentRecord()` 按本分组偏好渲染；切回全局会删除所有分组副本以免日后重开开关飘出旧值。规则抽成纯逻辑模块 `serial-group-display-prefs.js`，两侧共用同一答案；`uiPrefs` 是**可选字段**（缺失＝继承全局，不能补成默认值，否则继承语义永久丢失），`serial-groups-config.js` 必须保留它（主进程每次存盘都会重建分组对象），`serial-groups-model.js` 必须深拷它。新增 `test/serial-group-display-prefs.test.js` **10/10** 与 `verify-display-pref-scope.js` **24/24**（`diag181`），其中只有 `getPrefix()` 的真实 ANSI 输出能证明渲染路径也跟上了（仅该组前缀带 `[HH:MM:SS.mmm]`）。

  - 仍需注意的边界：`search-regex` / `search-case` / `search-word` 同属侧栏显示偏好，尚未取证是否需要按分组。串口参数类 9 项经实测已正确跟随分组，不要重复改。快捷指令整套与 `auto-send-enable` / `auto-send-interval` / `quick-send-auto-trigger-enable` 保持**全局共享**，不得顺手改成按分组。

- [x] **端口下拉框不再残留上一组的端口（`363abd2`）**：设备被拔掉后 `group.portPath` 不在端口列表里，`applyGroupSerialOptionsToSidebar()` 原来只在 option 存在时赋值，于是把上一组的端口显示给用户。现在列表**已就绪**但不含目标值时**显式清空**（列表只有占位项、尚未刷新完时保留，避免启动阶段误清）；`refreshPorts()` 的首选端口改为取**激活分组**的 `portPath`（原来兜底到默认分组的 `lastSerialOptions.path`，拔卡后刷一次列表就把默认组端口选回来）；`getSerialOptionsFromUi()` 的 `path` 不再兜底到默认分组端口（原来「停在未选端口的新分组 + 发生任何保存」会把默认组端口写进新分组，切一次分组就能静默破掉端口隔离）。波特率不能清空（它总有值），改为先 `renderCustomBaudRates()` 补建自定义选项再选中。

- [x] **从上层 Shell 切回串口终端（用户实测缺陷）**：`打开shell标签，再点击串口标签，窗口显示的还是shell`。根因是缺陷 E 的副作用——Shell 在上层时下层标签行被隐掉，屏幕上唯一能点的「串口标签」只剩分组标签，而 `activateSerialGroup()` 对当前分组直接 `return`。新增 `revealSerialGroupActiveTab()`，并在 `applyActiveSerialGroup()` 末尾统一把串口终端抬回最上面（也改走本分组布局管理器，避免模块级别名因「同一个标签」早退）。新增 `verify-shell-switchback.js` **14/14**（`diag108`），覆盖点当前分组标签 / 另一个分组标签 / 主标签三条真实路径，并断言 Shell 仍可点开、缺陷 E 仍然成立。
- [x] **两层入口互斥（`a4dac1f` 之后的修复）**：单分组亮 `#add-serial-group-inline-btn`，多分组亮 `#add-serial-group-btn`。根因不是 JS——`style.css` 全局 `button { display: inline-flex }` 覆盖了 `[hidden]`，导致 `el.hidden = true` 对按钮无效；已在 `button` 规则后补 `[hidden] { display: none !important }`，并用 `probe-hidden-regression.js` 逐项复验 14 个依赖 `[hidden]` 的元素（`violations=[]`）。
- [x] **分组工作区可见性模型（`bf016a4`）**：未分屏时**只显示激活分组**（`resolveVisibleGroupWorkspaceEntryIds()`）；已分屏时显示参与分屏的分组并强制加入激活分组；仅当 `isShellColumnActive()`（已分屏 + 多分组 + 存在未归属 Shell）时额外加入 Shell 独立列。实测：三组时从 `visibleLabelRows: 3`（三套各 387px 并排）变为 `visibleLabelRows: 1`（占满 799px），关中间组仍为 1，关激活组正确回落默认分组。
- [x] **标签归属与层级联动（用户报告的五个缺陷）**：Shell 归属下沉到 `tabState.ownerGroupId`（两态）、新增单一宿主判定入口 `resolveShellTabHost()`、删除 `shellWorkspaceOverride` 与「归属在另一列就点亮那一列」整段、`isShellColumnActive()` 补上 `groupWorkspaceSplit.enabled` 前提、新增 `getVisibleGroupRow()` / `isUnownedShellActiveIn()` / `syncGroupSubRowVisibility()` / `activateShellTabInHost()` / `stackShellTabOverHostGroup()` / `hideStackedShellTabsIn()` / `resolveDisplayedTabIdInPane()`。详见 `agent_notes.md` 的「Shell 归属改为逐标签」一节与 `MULTI_SERIAL_DESIGN.md` 的 §6A。
- [x] **布局规范与标签逻辑流程图已入文档**：`MULTI_SERIAL_DESIGN.md` §6A 包含层级规范、宽度/方向规则、Shell 两态归属、**七行显隐矩阵**（M1–M7）、四张 Mermaid 流程图（宿主判定 / 分组增删与层数回落 / 点击分派 / 拖动落点）、状态变量与不变式表。
- [x] **Shell 回归修复（未提交时的验证）**：`verify-shell.js` **16/16 PASS、exit=0**（`verify-shell-out2.txt`，隔离实例 `userdata-diag4`）。覆盖：单分组建 Shell → 加分组切到 g-1（默认分组 `display:none` 且 rect 为 0）→ 点分组层 Shell 标签（ `#workspace-root` 重新有尺寸、Shell 面板 `.active` 且 w/h > 0）→ **`activeGroupId` 仍为 g-1** → 点回 g-1 主标签（默认分组重新隐藏，override 已清空）。
- [x] **主标签文案与侧栏分组名**：`verify-titles.js` **6/6 PASS**，实测 `default → "Serial 1"`、`g-1 → "Serial 2"`，且 `hasI18n === false`。
- [ ] **`verify-groups.js` 的 54 项断言已部分过期**：凡假设「多分组 ⇒ 多工作区同时可见」的项都因 `bf016a4` 的语义变更而失败——**失败原因是断言过期（「两组工作区同时可见」已不再是默认行为），不是产品缺陷**。重跑前必须先更新这些断言。
- [x] **分组级分屏的 UI 入口已落地并验证**：入口在分组标签的右键菜单（左右分屏 / 上下分屏 / 关闭分组分屏 / 添加串口）。CDP `verify-group-split.js` **19/19 PASS、exit=0**（`verify-group-split-out2.txt`，`userdata-diag6`）：两分组基线 → 左右分屏（2 条可见、`row`、分界条显示且位置正确、宽度约等分）→ 上下分屏（2 条可见、`column`、高度约等分）→ 关闭分屏（1 条可见、分界条隐藏、类名清空、无残留 flex-basis）。同时修掉两处只有真实点击能发现的静默缺陷：关闭分屏不重写 DOM 导致方向类名残留；CSS 写 `.split-vertical` 而 JS 切 `group-split-vertical`，类名不匹配导致上下分屏完全不生效。
- [ ] **分组级分界条的真实鼠标拖动未验证**：`bindGroupWorkspaceSplitter()` 的比例换算依赖真实 `getBoundingClientRect` 与 pointer capture，现有 CDP 脚本未覆盖，拖动逻辑仍只有静态审查。
- [x] **侧栏控件按当前分组分发**：`verify-sidebar-groups.js` **14/14 PASS、exit=0**（`verify-sidebar-groups-out1.txt`，`userdata-diag7`）。两个分组各写一份哨兵，g-1 激活时点「清空当前终端」只删 g-1 的、保留默认的；切回默认再清空则方向相反；搜索目标与「保存当前标签」也跟随激活分组。修掉四处按默认分组分发的缺陷（清空当前终端 / 清空所有 Log 标签页 / 保存当前标签 / 搜索目标）与静态主标签按钮的点击失效。
- [x] **新建分组的终端右键菜单**：`verify-context-menu-and-highlight.js` **17/17 PASS、exit=0**（`verify-ctx-highlight-fix4.txt`，`userdata-diag31`）。旁路记录 `ipcRenderer.send` 后，在**新分组**终端上派发真实 `contextmenu`，断言发出 `show-terminal-context-menu` 且 payload 为 `terminalType:'main' / tabId:'tab-main-g-1' / paneId:'pane-1-g-1'`；默认分组做对照组（`tab-main` / `pane-1`）。写断言时发现一个必须记住的事实：**非默认分组的 runtime 在生产代码里只在连接串口时才建**（`serialRuntimes.getOrCreate` 全局只有默认分组与验证钩子两处调用），脚本必须先用 `window.__seedGroupSentinel()` 建出 runtime，否则 `getSerialTerm('g-1')` 会走回落分支拿到默认分组 term，断言就变成恒真。
- [x] **点分组后只有激活组的标签高亮（第 6 项）**：同一个脚本（`verify-ctx-highlight-fix4.txt`）覆盖。未分屏时断言「带 `.active` 的分组标签恰好一个 + 其 groupId 等于激活分组 + 它**可见**」；分屏后（两列的行同时可见，最容易「都亮」）再断言同样三条，并额外断言非激活列的分组标签**不带** `.active`。
- [x] **分组标签行归位到各分组列上方（第 9 项）**：`verify-group-columns.js` **39/39 PASS、exit=0**（`verify-group-columns-out4.txt`，`userdata-diag11`）。`#group-workspace` 直接子元素改为「分组列」（`.group-column`），每列首行是本组自己的分组标签行；静态 `#serial-group-tab-bar` 只一份，在列之间搬移（未分屏时属于激活列并列出全部分组标签，已分屏时留在默认列只列自己那一个）。断言覆盖静态列与首行位置、`#serial-container` 祖先链、单分组基线、切分组后行跟随搬移、分屏时每列各一条行且行内仅自己、Shell 落在默认列组行且不新开列、关闭分屏回单列、关组后静态行与按钮存活。
  - 过程中修掉一处只有真实启动才能发现的缺陷：`renderSerialGroupTabBar()` 引用了未 require 的 `GROUP_TAB_BAR_ID` / `GROUP_TAB_LIST_ID`，`node --check` 与模块加载门禁均看不见（该函数只在 `applyConfig` 的 Promise 回调里调），只有 `[RENDERER DIAGNOSTIC]` 暴露。`scan-undefined.js` 候选表已相应扩到 83 项。
  - `verify-shell.js` 两处断言因结构变更而失效（`#workspace-root` 不再是外层条目），已改为量 `#serial-group-workspace-default` 列容器，回到 **16/16**。
- [x] **Shell 标签跨层拖动（第 8 项）**：`verify-shell-drag.js` **24/24 PASS、exit=0**（`verify-shell-drag-fix1.txt`，`userdata-diag24`），用 `Input.dispatchMouseEvent` 合成真实拖动手势（mousePressed → 8 步 mouseMoved → mouseReleased），全部 id 由 `serial-group-layout-dom` 契约函数算出。`shellOwnerGroupId` 为三态：`null` = 停在**上层共享行**（面板在**激活列**，不凭空多出一列）；`'__shell__'` = 拖到 `.group-tab-row` 后**独立成组**，该列只有一行标签栏且无 pane 标签行；`<groupId>` = 拖到 `.pane-tabs-list` 后归入该组，标签进那组下层 pane 标签行、面板进那组 `pane-1` 并成为激活标签。拖动全程不改 `activeGroupId`（双向各一条断言）。修掉四个只有真实拖动才能发现的缺陷：面板留在隐藏列、布局归属不同步（面板被拽回或被 prune）、归入分组后未激活、无限递归（`isSyncingShellLayer` 重入闸）。
  - 回归中又修掉一处第 8 项自己引入的缺陷：`closeSerialGroup()` 里的 `document.getElementById(groupWorkspaceContainerId(id))?.remove()` 被误删，导致关组后列容器永远留在 DOM（只是 `hidden`）。诊断脚本 `diag-columns2.js` 证实残留的是 `serial-group-workspace-g-1`（且 `shellTabs: 0`，**不是**原先推断的残留 shell 列），已补回；`verify-group-columns` 回到 39/39。
  - `verify-shell.js` 的「点 Shell 后默认分组被亮出」因实现变更失效，已改为「点 Shell 后面板所在列可见」（面板现在渲染在激活列，这是设计使然），回到 16/16。
  - 全量回归（每个脚本一个全新 `--user-data-dir`，`app-diagNN-err.log` 全部无 `[RENDERER DIAGNOSTIC]`）：`verify-group-columns` 39/39、`verify-shell` 16/16、`verify-shell-drag` 24/24、`verify-group-split` 19/19、`verify-sidebar-groups` 14/14、`verify-titles` 6/6。
  - **仍未验证**：Shell 归入某分组后的长期行为（关组回落、多次切分组）只有 DOM 层证据，没有真实双端口端到端验证。
- [ ] **两级分屏的拖动与 fit 未覆盖**：分界条的实际比例换算与「拖动非默认分组的标签」只有静态审查；切回 `display:none` 容器后的 `fit()` 未肉眼确认。
- [x] 配置迁移磁盘验证：独立 `--user-data-dir` 连启两次，`config.json` 均为 v15 + 1 组，旧字段保留，`config.v14.backup.json` 保持 21667 字节的 v14 原件且第二次启动未覆盖。
- [x] 实机启动：主窗口正常出现，`main.log` 与渲染进程 stderr 均无 JS 错误，electron 进程清理后 `remaining: 0`。
- [ ] **多串口行为的人工 GUI 验证**：连接、收发、日志写入从未在真实窗口中手工跑过；现有结论来自单测、源码断言与 CDP DOM 断言，**没有任何字节流层面的端到端证据**。
- [ ] Windows 和 Linux 打包通过（Windows NSIS 已有成功记录，Linux 仍待验证；不再生成 portable 版本）。
- [ ] 真实或虚拟串口覆盖 Text/Hex、UTF-8/ASCII/GBK、自动发送、快捷发送、Raw 日志和重连。
- [ ] 主终端、过滤标签、图表标签、Shell 标签、分屏、壁纸、搜索历史和侧边栏收起/展开进行人工交互回归。
- [x] `npm audit --registry=https://registry.npmjs.org --omit=dev` 无 High/Critical。
