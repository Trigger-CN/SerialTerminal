# SerialTerminal ToDo

本文档记录 2026-07-29 全仓库代码审查后确认的待办事项。实施时优先处理行为缺陷和安全问题，再处理性能、测试和长期架构优化。

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
  - 结果：`electron-updater` 已升级至 `^6.8.9`，通过 npm override 固定 `js-yaml ^4.3.0`；生产依赖审计为 0 漏洞。打包和在线更新仍需发布前人工验证。

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
  - 使用 Node 内置 `node:test` 覆盖 `serial-codec.js`、`hex-formatter.js`、配置归一化和 i18n key 完整性。
  - 增加 mock serialport 的 IPC 写入测试，以及 Shell/session 生命周期测试。
  - 发布 workflow 在打包前必须执行测试。
  - 进度：已增加 `npm test`，覆盖 codec、formatter、Shell profile ID、设置数值边界、损坏工作区布局恢复和 i18n 基线；GitHub Checks 已执行干净安装、测试、语法和生产审计。完整配置归一化、IPC 与 Shell 生命周期集成测试仍待补齐。

- [x] 发布安装改为可复现流程
  - 位置：`.github/workflows/release.yml`。
  - 将 `npm install` 改为 `npm ci`；统一 lockfile registry URL；native rebuild 保持显式步骤。
  - 验收：Windows/Linux 使用同一 lockfile 安装，构建后 lockfile 不变化。
  - 结果：新增 tag 发布 workflow，Windows/Linux 共用 Node 22.12 和同一 lockfile，安装使用 `npm ci --ignore-scripts`，显式执行 native rebuild、测试、打包和 lockfile 不变检查。

- [x] 修正文档和 Node 版本约束
  - `README.md` 当前写 Node.js 16+，但 `serialport@13` 要求 Node 20+。
  - README 与 `package.json.engines` 统一声明 Node `>=20`，CI 固定受支持版本。
  - 结果：当前构建工具链要求 Node `>=22.12.0`，README、package engines 和 CI 已统一到该版本。

- [ ] 限制大 scrollback 搜索对 UI 的阻塞
  - 位置：`renderer.js` 的搜索计数扫描。
  - 分批扫描并支持取消旧 generation；限制正则长度、匹配数和高风险表达式；避免一次同步扫描 100000 行。

- [ ] 移除主终端 tab 的重复点击绑定
  - 位置：`index.html` 的 inline `onclick` 和 renderer 中的 listener。
  - 保留 renderer 的统一事件绑定，避免一次点击重复持久化、事件派发和 fit。

- [ ] 提升窄工具栏在低高度窗口中的可达性
  - 工具栏加入 RX/TX 和多个按钮后，低高度窗口可能裁掉最底部展开按钮。
  - 方案：将展开按钮固定在不滚动区域，或让中间工具区可滚动。

- [ ] 完善键盘可访问性
  - 将可点击 `div` 改为 `button`，为 tab 增加 `role="tab"` / `aria-selected`，提供 `button:focus-visible` 焦点样式。

- [ ] 完善多语言 key
  - 以 English key 集合为基准增加完整性测试；补齐简中及其他语言的新侧边栏、Shell、分屏和更新文案。

- [ ] 逐步迁移 Electron 安全模型
  - 当前主窗口和设置窗口使用 `nodeIntegration: true`、`contextIsolation: false`。
  - 长期迁移到 preload + context bridge，并限制 renderer 可调用 IPC。

## 验证基线

- [x] 所有项目 JavaScript 文件通过 `node --check`。
- [x] `git diff --check` 通过。
- [ ] Windows 和 Linux 打包通过（Windows NSIS/portable 已通过，Linux 待验证）。
- [ ] 真实或虚拟串口覆盖 Text/Hex、UTF-8/ASCII/GBK、自动发送、快捷发送和重连。
- [ ] 主终端、过滤标签、Shell 标签、分屏、侧边栏收起/展开进行人工交互回归。
- [x] `npm audit --registry=https://registry.npmjs.org --omit=dev` 无 High/Critical。
