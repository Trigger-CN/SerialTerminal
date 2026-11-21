# 多串口组标签修复计划

当前状态：统一布局内核代码及自动化已接入，规范与用户手测见 [WORKSPACE_LAYOUT_KERNEL.md](WORKSPACE_LAYOUT_KERNEL.md)。根项目 774/774、0 skipped，16 项语法/module-load/diff 检查通过（Node20.16.0）；Node>=22.12.0、telemetry-server、原生交互、实际重启及真实双端口/长时待验。下文 F1–F5/M1–M2 与旧结构修补为历史证据，不能当作新内核的原生通过记录。

关联文档：[多串口重构方案](MULTI_SERIAL_REFACTOR.md)、[维护快照](agent_notes.md)。本文补充当前实现的缺陷闭环，不替代既有产品约束。

## 本轮：替换几何内核

- 直接根因：旧 close-group-split 接全局 column-split:false；Shell 共用特殊列且没有明确左右位置。现在局部 merge 与显式 collapse-all 分离，组/Shell 使用同一四向 Split/Stack 事务。
- 根与组内几何共享，唯一运行态仍为 workspaceModel；删除旧全局列写对象与 Shell placement 执行路径。递归 DOM 保留业务资源，实际菜单/IPC/drag/创建/fit/保存都接同一模型。
- schema17/layout2，导入 v1 显式/隐式列及 pane 投影、Shell-only 区域；v2 按合法业务清单去重补漏，分配身份避冲突。备份/未知版本/迁移失败保护原配置且提示本次不保存。
- 自动化保留独立 I1–I10 和原随机规模，覆盖三域局部合并、四向/嵌套、单多往返、顺序/active、资源引用、gutter/final fit、创建路由及恢复。旧“取消一个组后只剩一列”错误断言已改正，不用恢复缺陷来求绿。
- 收起栏保留首条展开控件；同格多锚点回单组保完整内部几何，新增横向等比例外层。非相邻/混合轴合并不承诺所有绝对坐标不变。
- 本轮不截图、不启动或操作应用、不改真实配置；请按内核契约 §8.1 手测原生菜单/拖拽、正常关闭重启及可选硬件。

## 1. 范围与证据边界

本节为 F/M 历史审查范围与起始证据。后续实施与最新结果以本文顶部和统一内核契约为准；历史探针/桌面记录不得跨版本算作新内核验收。

保持以下语义：

- 单组时 main/filter/chart/Shell 可在组内分屏之间移动；多组时串口叶不得脱离 owner，Shell 位于根级。
- 每个可见格独立保留活动标签；全局焦点决定当前终端操作，控制组决定串口设置及发送目标。Shell 获焦不改变串口控制组。
- 移动和分屏复用既有终端、parser、图表及 PTY；关闭组保留 Shell，默认组不可关闭。
- 运行态布局由 `workspaceModel` 唯一写入。当前配置 v17、布局快照 v2；旧 v16/v1 通过单向迁移消费，不复活旧运行态几何。
- 本次不扩展发布、遥测、安全模型或搜索性能改造范围。

## 2. 问题清单

行号为审查时定位，实施时以函数名和调用链为准。

| ID | 优先级 | 问题及证据 | 主要定位 |
| --- | --- | --- | --- |
| F1 | 高 | 关闭控制组后 activeGroupId 已变化，但未完整同步侧栏和别名。实际关闭函数探针中同步次数为 0；连接前会把旧控件值写入剩余组，错误端口后果来自调用链，尚未实机验证 | renderer.js：closeSerialGroup（5810）、applyActiveSerialGroup（4570）、persistActiveGroupSerialOptions（8298）、getGroupSerialOptionsForConnect（9355） |
| F2 | 高 | 整组关闭仅删除 filter/chart 清单，遗漏子资源释放。探针中终端 dispose、Worker close 均为 0 | renderer.js：closeSerialGroup、closeFilterTab、closeChartTab；serial-group-tab-lists.js：removeList；chart-parser-ipc-client.js：close |
| F3 | 中 | 多组激活根 Shell 后搜索仍返回 tab-main；导出也按控制组活动格取目标，清空却按全局焦点 | renderer.js：setFocusedTab（4713）、getActiveSearchTarget（9598）、getActiveTerminalExport（9309）、clearActiveTerminal |
| F4 | 中 | split-tab 后焦点与目标格 active 已变化，container.activePaneId 仍为旧格；探针已复现 | tab-model.js：activateTab、moveTabToPane、split-tab；workspace-model-manager.js：activePane |
| F5 | 中 | 关闭非活动过滤页强制激活回退标签，探针焦点由 Shell 变为主终端；图表关闭有相同代码模式，须补独立用例 | renderer.js：closeFilterTab（6610）、closeChartTab（7063） |
| M1 | 防御性 | 纯模型允许单组串口叶进入根行，新增组后未收回且无法移回 owner；保存恢复不等价。正常拖拽入口目前仅允许 Shell 进入根行，未确认普通 UI 可达 | tab-model.js：moveTabToRoots、add-group、moveTabToPane；workspace-layout-state.js：恢复根叶 |
| M2 | 防御性 | 共享列 add-leaf 可更新焦点但未更新列 activeTabs，使焦点叶不可见；当前创建入口额外 activate 通常补正 | tab-model.js：add-leaf、activateTab、layoutColumns |

## 3. 状态与生命周期约束

### 3.1 激活与查询

统一模型内部的激活更新路径：需要激活的 add/move/split/activate 动作同步叶焦点、所属格 active、所属组 activePaneId 和所属共享列 activeTabs。纯重排及 activate:false 操作不得隐式抢焦点。

不要求所有格都跟随全局焦点：其他格继续显示自己的活动标签。活动格必须属于组；当动作把焦点移入某组格时，该组活动格应指向此格。恢复时保留有效局部激活并修复失效引用。

提供统一的当前操作目标解析入口，返回明确的 tabId/kind/owner/terminal 能力；搜索、选区搜索、导出、清空共用身份解析，能力不足时明确禁用或提示。焦点在图表时不得静默操作另一串口终端。串口发送仍显式使用控制组，不能因为当前终端是 Shell 就改变发送对象。

### 3.2 关闭流程

区分模型移除与业务实例销毁。单标签、关闭组和 reset 复用按类型销毁流程；销毁不得再次激活、发布布局动作或逐标签保存。幂等清理应覆盖：

- filter：日志 flush、搜索监听、document listener、延迟回调、xterm、按钮及面板。
- chart：closed 标记、render frame、stream、parser IPC listener/Worker、view、异步发现及设置/导出引用。
- main：本组终端、输入绑定、解析器、输出队列及上下文。
- 组运行态：断开请求、路由、连接中回调、发送链与触发状态；旧异步完成不得复活已关闭组。

先校验关闭合法性并记录待销毁身份，再统一移除模型、清理资源、更新业务清单和控制上下文，最后渲染与合并保存。不得在清理开始前发布包含幽灵业务身份的快照。Shell 必须在删除旧列之前搬到合法宿主。

具体实现需核对断开/日志刷盘协议：本计划不假定发送 disconnect IPC 等于端口已关闭，也不把日志写失败后的丢弃当作成功清理。

## 4. 实施阶段

所有阶段先建立能暴露缺陷的行为回归，再修复。以下检查框作为完整验收门槛保留；代码实施和自动化结果已更新至第 7 节，未覆盖的人工/硬件/工具链门槛不提前勾选。

### P1：控制组切换与关闭资源（F1、F2）

- [ ] 建立显式控制组同步入口，覆盖 registry、标签/manager 别名、串口参数、显示开关、组标识及连接按钮。
- [ ] 关闭控制组后同步选定的剩余组，不额外覆盖模型已经选定的焦点；关闭后台组不改变控制组。
- [ ] 提取并接入统一业务销毁流程，逐项对照单标签关闭、整组关闭和 reset，保持日志归属与 Shell 存活。
- [ ] 覆盖 opening 中关闭、迟到回调、重复关闭、关闭后同名组 ID 复用；确认旧事件不会污染新组。

退出条件：A/B 使用不同端口及参数，关闭 B 后侧栏与控制组 A 完全一致；连接 IPC 只携带 A 参数。重复创建/关闭组后子资源与监听计数回到基线，其他组收发及 Shell 不受影响。

### P2：模型激活一致性（F4、M2）

- [ ] 让 activate/add/move/split 共用激活更新规则，明确 activate:false 与重排行为。
- [ ] 补充动作后校验：引用有效、焦点叶可见、所属格/列选择一致；不破坏其他可见格的 active。
- [ ] 比较菜单、拖拽、程序动作、manager 和恢复入口的完整链路，避免依赖 renderer 再 activate 补救。

退出条件：三组共享列与独立列中，新建/移动/拆格后焦点叶立即可见，activePaneId 正确；保存重启后位置、局部激活、焦点和比例等价。

### P3：统一操作目标与关闭焦点（F3、F5）

- [ ] 搜索、导出、清空及快捷键统一解析焦点目标；保留串口控制组语义。
- [ ] 关闭非焦点标签保持焦点和其他格 active；关闭焦点标签只接受模型计算的合法回退，不再次强制切标签。
- [ ] 核对标签事件、延迟 fit、内容 click/focusin 和搜索刷新，删除竞争性激活。

退出条件：Shell 有焦点时搜索、选区、导出与清空均针对同一个 Shell；关闭另一格标签不会抢焦点，关闭当前标签后的回退可见且属于合法位置。

### P4：准入、恢复与集成收口（M1 及全量回归）

- [ ] 统一业务 owner 准入。拒绝新产生的根级串口叶；旧异常状态在导入/恢复时按 owner 收回，保留合法相对顺序。
- [ ] 补单→多→单、根 Shell 混排、异常/缺失 ID、未知快照版本和序列化往返测试。
- [ ] 如修复无需改变持久化格式，保持 v16/v1；若确需格式变化，先补迁移、备份及回退方案再变更版本。
- [ ] 更新维护快照与本计划验收记录，区分自动化通过、实际 UI 通过和硬件待验。

## 5. 必须覆盖的回归矩阵

| 场景 | 核心断言 |
| --- | --- |
| 关闭控制组/后台组；相邻组与模型回退不同 | 控制组、焦点、侧栏及连接 payload 各自合法且一致，无旧参数回写 |
| 带过滤页/已配置图表的组反复开关 | dispose/close 各一次；无 parser listener、Worker、frame、document listener 残留 |
| pending 图表回调、Shell、日志待刷、opening 时关闭 | 无复活、无错组写入；保留 Shell；失败有可观察结果 |
| 两格/三格移动、拆格、同栏重排 | 焦点可见，组/列 active 正确，其他格内容和实例引用保持 |
| 三组共享列中向非当前组 add-leaf | 无需额外 activate 即显示焦点叶；activate:false 不改变焦点 |
| 根 Shell 搜索/选区/导出/清空 | 目标身份一致，串口发送仍使用控制组 |
| 关闭非活动及活动 filter/chart/Shell | 前者不抢焦点，后者仅执行一次合法回退 |
| 单多组转换及异常根串口叶恢复 | 不跨 owner，无重复/幽灵叶，规范化幂等 |
| 保存→正常关闭→重启 | 位置、顺序、每格 active、焦点、比例等价；无恢复期半成品保存 |

## 6. 验证与完成门槛

1. 使用 Node >=22.12.0 运行新增定向测试，再运行根 `npm test`；新增测试文件须匹配 `test/*.test.js`，不能留在默认入口外。根命令当前不包含 telemetry-server 测试。
2. 对变更 JS 执行 `node --check`，运行 `node scripts/check-renderer-module-load.js` 和 `git diff --check`。不仅断言源码字符串，还要执行真实模型、manager 与 renderer 生产函数。
3. 隔离 profile 验证真实面板 active、祖先可见、非零几何、xterm/parser/PTY 引用复用及正常重启恢复；遵循现有手动 UI 验收方式，不以截图替代交互测试。
4. 用户手动覆盖原生菜单、真实拖拽、侧栏目标、Shell 操作和多格关闭；实际双端口并发、日志归属、异常断开及长时运行单独记录，未执行不得标通过。
5. 正常关闭测试不代表崩溃/断电安全。完整报告列出命令、环境、结果及剩余风险，不以历史测试数量替代本轮证据。

## 7. 实施与验收记录

### 后续缺陷：新增第二组破坏单组 Shell 分屏

- 用户复现：只有一个串口组时已有 Shell 分屏，新增第二组立即破坏原布局。首批左右、上下、两个 Shell 格的回归修前 0/3。根因是 `promoteShellsToRoots` 提升 Shell 后删除 Shell-only pane，未把原区域几何及局部选择转交给根布局。
- 在 `add-group` 创建第二组前转换原格为显式根区域，保留格顺序、方向、比例、各格 active；串口叶继续属于原组，Shell 在多组时只提升至一级栏，不合并不同 Shell 格。新组加入原串口区域，随后激活新组只替换该区域；业务创建保持 disconnected。已有外层 Shell 独立列先固化当前列集合，新增组不额外挤占一列。
- 快照 v1 的显式列新增可选 `containerId`/`paneIds` 表示原组 pane 的区域投影，无假串口组、无第二份可写布局状态。恢复过滤重复列/重复 pane/无效引用；移动或关闭后统一收敛空区域及比例，新 pane 纳入唯一投影，拆原组时只迁移该区域引用。回到单组把转换区域还原为普通 panes，恢复自由拖动与再次单→多转换。
- renderer 的列/行/按钮/可见性协调器接收根区域标记，复用单行 Shell 列构造及现有 button/panel，不重建 xterm/parser/PTY。真实生产函数 VM 回归验证引用复用、正确宿主、可见性、重复渲染不重复 ID、区域拖放 key 及 N−1 相邻外层分隔条。此证据是限定 fake DOM，不代表已验证原生交互。
- 新增 `test/single-to-multi-shell-layout.test.js` 17 项及 renderer 2 项。覆盖左右/上下、多个 Shell 格、Shell 前置与同格局部选择、main/filter 混合格、关闭回单组/再次新增、已有外层 Shell 列、空区域清理、新 pane/合并、损坏恢复、关闭外层分屏及原组再次拆列。往返比例按 1e-12 容差比较，其余身份与布局字段完整比较。
- 最终验证：`node scripts/run-tests.js` **759/759**；模型/codec/renderer/菜单相邻专项 **120/120**；model、codec、renderer 三份 `node --check`、renderer module-load、`git diff --check` 全部退出 0。环境 Node **20.16.0**，Node >=22.12.0 与 telemetry-server 未验证。保持配置 v16 / 快照 v1，无依赖、线程或发布流程变化。外层仍共用一个方向，未实现任意不同方向的独立嵌套布局。
- 人工待验（未截图、未启动/操作用户应用）：单组 Shell 左右/上下分屏并调比例后新增组，检查原 Shell 位置、方向、比例及局部选择；两个 Shell 格不得合并，切换新组不得带走 Shell；关闭新增组后自由拖动再添加组；正常关闭重启后布局恢复。原菜单、排序/控制组复测和真实双端口/长时异常证据仍待反馈，R5 不标整体完成。

### 后续缺陷：串口组分屏破坏既有 Shell 列

- 已复现范围：已有根级独立 Shell 列后执行串口组 `split-group`，隐式列被误作未分屏而重新合并，Shell 列移位、比例重置或局部活动内容丢失。修复前新增首批 5 项回归全部失败。
- 统一模型事务中保留既有列：未显式记录的串口列按当前布局固化，不重新合并。共享列只拆出请求组，源列宽度二分给源/目标，其他串口列及 `__shell__` 比例保持；显式列按根 order 插入 Shell 列，保持原相对位置。
- 源列 ID 随被移动组改名时迁移局部选择，普通 row Shell 留在源列，独立 Shell 不改位置锚点。激活按列的全部组成员定位，维护独立 Shell 列选择；codec 仅恢复合法 `ownColumn` Shell 的局部 active。中间回归曾漏掉共享列后台组，已修正查找并保留既有关闭 Shell 回退断言。
- 新增 `test/group-split-shell-preservation.test.js` 7 项，覆盖隐式列保留、共享源宽度二分、Shell 中间位置、源列改名与 row Shell、完整快照往返、两个 Shell 的局部选择、前置拆组及其他组内格不变。
- 最终验证：`node --test test/group-split-shell-preservation.test.js test/tab-model.test.js test/workspace-layout-state.test.js test/multi-serial-model-fixes.test.js test/workspace-renderer-integration.test.js` **103/103**；`node scripts/run-tests.js` **740/740**。两份产品模块 `node --check`、renderer module-load、`git diff --check` 全部退出 0；环境 Node **20.16.0**，未运行 telemetry-server 测试，Node >=22.12.0 仍待验证。配置保持 v16/v1，不新增依赖、线程，不改变终端实例或发布流程。
- 范围边界：本轮不改变外层共用 `split.orientation` 的结构，不支持独立嵌套分屏方向；新增串口组时单→多的 `promoteShellsToRoots` 路径未改，不将根 Shell 列修复扩大为全部转换场景完成。
- 人工待验（本轮未截图、未启动/操作用户应用）：已有 Shell 列并调整宽度后，对串口组执行同方向分屏，检查 Shell 不合并、不移位、不重置比例；Shell 列选中第二个 Shell，再切串口组并分屏，原 Shell 内容保持；Shell 位于两串口列中间及其他组已有上下格时，位置和其他组内布局保持；正常关闭重启后位置、比例和局部选择保持。原菜单、排序/控制组定向复测及真实双端口/长时异常验收仍待反馈，R5 不标整体完成。

### 后续缺陷：终端内容区分屏菜单

- 内容区曾只检查 `tabId` 存在就启用新建分屏，标签栏却检查源格成员数；执行时模型拒绝唯一叶，renderer 又无失败提示。“移到另一分屏”还错误发出 `split-tab`。
- `src/workspace/tab-model.js` 提供 `canSplitTab`，菜单和 `split-tab` 事务共用；源格须至少两个标签，多组串口叶保持 owner、Shell 不能进入组内格，单组根 Shell 的既有合法路径保留。不可拆时两类菜单一致置灰。
- `getOtherPaneTarget` 按布局顺序选择下一合法已有格、末格回首格，并使用 `move` 交易副本检验候选，不复制移动准入、不修改输入模型。renderer 执行真正的 `move`，无目标置灰；唯一叶可移入已有格，模型删除空源格，不会凭空新建格。
- 菜单打开后状态变化仍按最新模型执行；标签已关闭、源格变唯一或目标消失时，状态栏提示无法分屏/移动。布局动作不再被缺少 term/chart 业务实例的早退吞掉。
- 新增 `test/workspace-context-menu.test.js` 8 项，覆盖源格计数、根 Shell、已有格移动/空格收敛、多组 owner、原生菜单模板、两类请求、实际 handler 成败反馈及三格不新增；真实菜单模板使用 VM 执行，不代表已做 OS 原生菜单交互。
- 首批 4 项因缺共享 API 全部失败后实现通过；补三格用例及清理注释后，复验暴露旧测试以注释截取函数和新夹具把额外标签放错活动格，已分别改用函数边界并激活正确源格，未放宽模型或产品断言。
- 最终验证：`node scripts/run-tests.js` **733/733**、相邻模型/renderer/组上下文 **90/90**；三份产品 JS 语法、renderer module-load、`git diff --check` 全部退出 0。环境 Node **20.16.0**，未运行 telemetry-server 测试，Node >=22.12.0 门槛仍待完成。配置保持 v16/v1，无新增依赖、线程或发布变更。
- 人工待验（本轮未截图、未启动/操作用户应用）：仅 main 时内容区/标签栏新建分屏都置灰；main+filter 同格可拆左右/上下，拆后两个唯一叶不可继续拆；filter/Shell/chart 移到已有格不新增格，源格搬空会收敛；另一格或另一组有标签不能让当前唯一叶可拆；单组根 Shell 仍可拆，多组 Shell 维持根级。原有排序/控制组定向复测、真实双端口、长时及异常断开仍未关闭。

### 后续缺陷：关闭根 Shell 的控制组回退

用户复现：三组串口、两个 Shell，选中组 3 → Shell 2 → 关闭 Shell 2，内容回首组但组 3 仍高亮。根因是根叶关闭缺少控制组回退上下文，默认选首容器。修复要求：生产关闭入口将当前控制组活动叶传入统一关闭事务，当前根 Shell 关闭后回组 3；后台 Shell 关闭不抢焦点，格内 Shell 保留局部回退；无效回退安全降级。代码修复完成：关闭动作显式传入控制组活动叶，模型在单次事务内完成回退，兼容路径之外不再二次激活。新增 `test/shell-close-fallback.test.js` 15 项回归通过，主流程根全量 681/681 通过，模块加载/差异检查通过，独立审查无阻断。真实隔离桌面已验证共享列与分屏两种布局：组3活动叶选择、Shell2 关闭后焦点、可见面板、侧栏、组按钮 active/aria-selected 均回到组3，后台关闭保持焦点及其他格 active；对照诊断确认：退出时存活 1 个 PTY（A）或 3 个中先关闭 2 个（C）均退出 0；仅退出时同时存活 3 个 PTY（B，不执行任何 Shell 关闭）复现 Windows 0xE06D7363。故该异常与本次 Shell 关闭/回退链无关，指向 node-pty/ConPTY 多实例 native 退出路径，作为独立既有风险保留；未修改生产退出策略、未放宽断言。


- 修复前基线：`node scripts/run-tests.js`，Node v20.16.0，642/642 通过。该结果用于比较既有失败，不替代 Node >=22.12.0 门槛。
- 本轮保持配置 schema v16、布局快照 v1；未提交、打 tag 或发布。
- 稳定实现的主流程验证：`node scripts/run-tests.js` 为 666/666、0 失败；模型相邻 105/105；生命周期/终端目标专属 14/14。`node --check main.js`、`node --check renderer.js`、`node scripts/check-renderer-module-load.js`、`git diff --check` 通过。所有命令使用现有 Node v20.16.0，尚未满足 Node >=22.12.0 验证门槛。
- 新增 24 项行为回归经历先红后绿，包含配置回声替换业务对象、关闭后同 ID 重建、断开先于连接返回、失败日志原路径保留及隐藏焦点边界。最终独立源码审查未发现新阻断。
- 可复用的隔离桌面验证入口：`node scripts/verify-multi-serial-tab-fixes.js --run`，临时 userData/documents/logs，禁用遥测/日志，不读取真实配置；实际运行退出 0（Node 20.16.0 / Electron 28.3.3）：关闭组后侧栏/registry/别名/连接参数一致；过滤终端、parser、stream、view 各销毁一次；Shell 焦点与搜索/选区/导出/清空一致；分屏实例复用，正常关闭重启后顺序、逐格 active、焦点及 37%/63% 比例等价。两次 Electron 正常退出 0，所属进程与临时目录已清理。首轮包装器资源路径夹具问题已修正，未降低断言。

| 阶段 | 代码/测试范围 | 自动化结果 | UI/硬件结果 | 剩余问题 |
| --- | --- | --- | --- | --- |
| P1 | F1/F2：关闭组控制同步、共用销毁、连接请求/会话身份及失败日志保留 | 生命周期与终端目标专属 14/14，根全量 666/666；语法/加载/差异检查通过（Node 20.16） | 隔离桌面通过（生产函数及真实 DOM） | 实际双端口、长时和 Node >=22.12 待验 |
| P2 | F4/M2 激活统一、activate:false 焦点移动、M1 owner 规范化；新增 10 项模型回归 | 相邻模型测试 105/105、根全量 666/666，主流程均已独立运行通过（Node 20.16） | 分屏活动格、实例复用及重启布局等价通过 | Node >=22.12、原生交互待验 |
| P3 | F3/F5：共用焦点目标、后台关闭保留焦点、统一焦点事件及取消延迟布局写入 | 专属行为回归及根全量通过；主流程独立核对搜索/导出/清空与控制组发送路径 | 隔离桌面通过（生产函数及真实 DOM） | 原生菜单/真实拖拽人工回归待验 |
| P4 | M1 准入及异常 owner 恢复、单多组转换/快照幂等；配置继续 v16/v1 | 根全量 666/666、最终只读差异审查无新阻断；模型 105/105 | 隔离 profile 正常关闭/重启精确等价通过 | Node >=22.12、原生交互、双端口和长时验收待完成 |
