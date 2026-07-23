# Hex 显示与发送功能待办事项

## 1. 文档目标

本文档用于规划 `SerialTerminal` 的 Hex 接收显示、Hex 发送及相关配套能力。

核心原则：

- 串口层始终收发原始字节，Text / Hex 只是显示和输入解释方式。
- Hex 不再作为字符编码，不与 UTF-8、ASCII、GBK 放在同一个编码概念中。
- 接收显示模式与发送模式相互独立，允许 Text/Text、Hex/Hex、Hex/Text、Text/Hex 四种组合。
- Text 模式应保持现有串口显示、过滤、输入和日志行为不退化。
- Shell tab 不参与串口 Text / Hex 模式，不能受到本功能影响。
- 所有发送入口使用同一套校验、编码和串口写入逻辑。

---

## 2. 第一版范围

### 2.1 必须实现

- [x] RX 接收显示支持 `Text` / `Hex` 独立切换。
- [x] TX 发送支持 `Text` / `Hex` 独立切换。
- [x] Text 模式继续支持 UTF-8、ASCII、GBK。
- [x] 接收链路以原始 `Buffer` / `Uint8Array` 为数据源。
- [x] Text 接收使用流式 decoder，正确处理跨数据块的多字节字符。
- [x] Hex 接收以每行 16 字节的 Hex dump 显示。
- [x] Hex dump 支持偏移地址和 ASCII 预览。
- [x] 不足一行的数据支持空闲超时刷新，默认 50ms。
- [x] 底部主输入框支持 Text / Hex 输入模式。
- [x] Hex 输入提供实时校验、标准化和字节数预览。
- [x] Hex 模式支持追加 `0D 0A`。
- [x] 快捷发送项独立记录 Text / Hex 模式。
- [x] 自动发送独立记录 Text / Hex 模式。
- [x] 发送历史记录输入模式、编码和追加 CRLF 状态。
- [x] Hex 显示内容支持现有搜索能力。
- [x] 过滤 tab 支持过滤格式化后的 Hex 行。
- [x] 支持保存 RX 原始二进制日志 `.bin`。
- [x] 旧 `encoding` 配置自动迁移到新数据模型。
- [x] 六种语言补齐相关 UI 和错误文案。
- [x] 完成后同步更新 `agent_notes.md`。

### 2.2 第一版不实现

- [ ] 不实现 Modbus CRC 或其他协议校验自动计算。
- [ ] 不实现协议帧自动识别。
- [ ] 不实现带通配符的字节掩码过滤。
- [ ] 不实现跨 Hex dump 行的字节序列过滤。
- [ ] 不实现同一串口流同时显示 Text 和 Hex 两个主视图。
- [ ] 不实现 RX / TX 混合的自定义二进制容器日志。
- [ ] 不实现文件发送和大文件分块发送。
- [ ] 不实现主终端逐字符拼接 Hex 字节。

---

## 3. 关键产品决策

- [x] 确认 Hex dump 默认每行字节数为 16。
- [x] 确认 Hex dump 默认显示 8 位十六进制偏移。
- [x] 确认 Hex dump 默认显示 ASCII 预览。
- [x] 确认不可打印 ASCII 字节显示为 `.`。
- [x] 确认 Hex 字母默认使用大写。
- [x] 确认残余字节默认在 50ms 无新数据后输出。
- [x] 确认重新连接时 Hex 偏移重置为 0。
- [x] 确认普通清屏不重置 Hex 偏移。
- [x] 确认增加“清空并重置 Hex 偏移”菜单动作。
- [x] 确认显示模式切换只影响切换后收到的数据，不重新解释终端历史。
- [x] 确认 TX Hex 模式下主终端普通键盘输入不直接发送。
- [x] 确认 TX Hex 模式下 Ctrl+V 默认填入底部输入框，不直接发送。
- [x] 确认旧快捷发送项统一迁移为 Text，不根据内容猜测 Hex。
- [x] 确认 Raw `.bin` 第一版只保存 RX 数据。

---

## 4. 配置与数据模型

### 4.1 配置版本和迁移

- [x] 在配置中新增 `configVersion`。
- [x] 定义本次配置版本号，例如 `2`。
- [x] 在 `main.js -> loadConfig()` 中集中执行配置迁移。
- [x] 避免在 `renderer.js` 多处散落旧配置兼容判断。
- [x] 迁移完成后保存新结构，避免每次启动重复迁移。
- [x] 对损坏或字段类型错误的配置提供安全默认值。

旧 `lastSerialOptions.encoding` 迁移规则：

| 旧值 | RX 模式 | RX 编码 | TX 模式 | TX 编码 |
|---|---|---|---|---|
| `utf8` | `text` | `utf8` | `text` | `utf8` |
| `ascii` | `text` | `ascii` | `text` | `ascii` |
| `gbk` | `text` | `gbk` | `text` | `gbk` |
| `hex` | `hex` | `utf8` | `hex` | `utf8` |

### 4.2 串口模式配置

- [x] 将 `lastSerialOptions.encoding` 拆分为以下字段：

```json
{
  "lastSerialOptions": {
    "path": "",
    "baudRate": "9600",
    "dataBits": "8",
    "stopBits": "1",
    "parity": "none",
    "receiveDisplayMode": "text",
    "receiveEncoding": "utf8",
    "sendMode": "text",
    "sendEncoding": "utf8",
    "appendCrLf": false,
    "newlineMode": "crlf"
  }
}
```

- [x] 校验 `receiveDisplayMode` 只允许 `text` / `hex`。
- [x] 校验 `sendMode` 只允许 `text` / `hex`。
- [x] 校验 Text 编码只允许项目支持的编码。
- [x] 保留最近一次 Text 编码，切换 Hex 时不丢失。

### 4.3 Hex 显示配置

- [x] 新增 `hexDisplaySettings` 默认配置：

```json
{
  "hexDisplaySettings": {
    "bytesPerLine": 16,
    "showOffset": true,
    "showAscii": true,
    "uppercase": true,
    "idleFlushMs": 50
  }
}
```

- [x] 限制 `bytesPerLine` 为 8、16、24、32 中的一个值。
- [x] 限制 `idleFlushMs` 在合理范围内，例如 0 到 1000ms。
- [x] 对异常值回退到默认值。

### 4.4 主输入框配置

- [x] `mainInputSettings` 最终只保留可见状态和按回车发送；发送模式由统一 TX profile 管理。
- [x] 决定 Text / Hex 双草稿是否只保存在内存中。
- [ ] 若持久化草稿，增加关闭保存敏感输入的设置选项。
- [x] 发送历史条目改为结构化对象：

```js
{
    mode: 'hex',
    content: 'AA 55 01 FF'
}
```

### 4.5 自动发送配置

- [x] 将自动发送配置扩展为：

```json
{
  "autoSendSettings": {
    "enabled": false,
    "interval": 1000,
    "content": ""
  }
}
```

- [x] 自动发送始终使用统一 TX profile，配置只保存 enabled、interval、content。
- [x] 旧自动发送模式/编码/追加字段在规范化时移除，内容保持不变。

### 4.6 快捷发送配置

- [x] 快捷发送项扩展为：

```json
{
  "id": "quick-1",
  "label": "读取寄存器",
  "content": "01 03 00 00 00 02 C4 0B"
}
```

- [x] 为新快捷发送项生成稳定 ID。
- [x] 快捷发送项只持久化稳定 id、label、content，旧 profile 字段在规范化时移除。
- [x] 旧快捷发送项保留原始 `content`，不重复追加换行。
- [x] 拖动排序后保存简化数据模型。

### 4.7 Raw 日志配置

- [x] 新增 `saveRawSerialToFile`。
- [x] 新增 `rawLogFileNameFormat`，默认 `raw_%Y-%m-%d_%H-%M-%S.bin`。
- [x] 明确 Raw 日志仅记录 RX 原始字节。
- [x] 校验最终 Raw 日志文件扩展名和非法文件名字符。

---

## 5. UI 布局待办

### 5.1 左侧串口设置区

- [x] 从现有 Encoding 下拉框中移除 `Hex` 选项。
- [x] 新增 RX 显示模式下拉框：Text / Hex。
- [x] 新增 RX 文本编码下拉框：UTF-8 / ASCII / GBK。
- [x] TX 发送模式和文本编码移至左侧发送页顶部的统一 profile。
- [x] 统一 profile 增加追加 CRLF / 0D 0A 开关。
- [x] 保留现有换行模式下拉框。
- [x] 串口设置区只保留紧凑 RX 行，统一 TX profile 位于发送页顶部。
- [x] RX 为 Hex 时禁用 RX 编码控件。
- [x] TX 为 Hex 时禁用 TX 编码控件。
- [x] 模式控件在连接期间保持可切换。
- [x] 串口物理参数在连接期间维持现有行为。
- [x] 模式变化立即保存配置，但避免配置保存/回推形成 UI 回环。

当前布局：

```text
RX  [ Text ▼ ] [ UTF-8 ▼ ]
NL  [ CRLF / CRLF       ▼ ]

发送页：
TX  [ Text ▼ ] [ UTF-8 ▼ ]
    [x] Append CRLF / 0D 0A
```

### 5.2 Hex 显示选项

- [x] 决定 Hex 显示选项放在左侧设置区还是设置窗口。
- [x] 增加每行字节数选择。
- [x] 增加显示偏移开关。
- [x] 增加显示 ASCII 开关。
- [x] 增加大写 Hex 开关。
- [x] 增加空闲断行时间设置。
- [x] 修改设置后只影响后续输出，不重排历史终端内容。

### 5.3 底部主输入框

- [x] 移除底部 Text / Hex 控件，模式由统一 TX profile 控制。
- [x] Text / Hex 分别保留输入草稿。
- [x] Text 模式显示字符数和预计编码字节数。
- [x] Hex 模式显示格式有效性和字节数。
- [x] Hex 输入无效时禁用发送按钮。
- [x] Hex 输入无效时显示具体错误位置或 token。
- [x] Text 模式 placeholder 保持现有语义。
- [x] Hex 模式 placeholder 改为 `AA 55 01 FF` 一类示例。
- [x] 移除底部追加控件，追加语义由统一 TX profile 控制。
- [x] 发送成功状态显示实际写入字节数。
- [x] 发送失败状态显示结构化错误信息。
- [x] 保持发送后不清空输入框。
- [x] 保持过滤输入框焦点不被主输入框抢占。

当前布局：

```text
AA 55 01 00 FF                            [发送] [+快捷] [回车发送]
5 字节，HEX 格式有效
```

### 5.4 自动发送区

- [x] 移除自动发送独立模式/编码/追加控件，统一使用全局 TX profile。
- [x] 增加实时输入校验状态。
- [x] Hex 无效时禁止启用自动发送。
- [x] 自动发送启用期间修改内容后重新校验。
- [x] 设置合理的最小发送间隔，例如 10ms 或 20ms。
- [x] 串口断开时显示“等待连接”，不执行写入。
- [x] 串口重连后按既定产品决策恢复。
- [x] 串口实际写入失败时停止自动发送并提示。

### 5.5 快捷发送区

- [x] 移除快捷编辑区独立模式/编码/追加控件，统一使用全局 TX profile。
- [x] Hex 内容无效时禁止添加或保存。
- [x] 快捷列表不显示 `TXT` / `HEX` 徽标，因为模式来自当前全局 profile。
- [x] 列表项 tooltip 显示标准化后的发送内容和字节数。
- [x] 编辑已有项只恢复标签和内容。
- [x] 主输入框“加入快捷发送”只保存稳定 id、标签和内容。
- [x] 保持现有快捷发送拖动排序。

### 5.6 窄窗口和跨平台布局

- [ ] Windows 下检查下拉框宽度和文本截断。
- [ ] Linux 下检查字体、下拉框和 checkbox 对齐。
- [ ] 窄窗口下主输入操作区允许合理换行。
- [ ] 输入 textarea 保持 `flex: 1`，不能被模式控件挤没。
- [ ] 校验状态在窄窗口中独占 meta 行。
- [ ] 分屏状态下底部输入区仍可正常使用。

---

## 6. Hex 输入解析器

### 6.1 支持语法

- [x] 支持空格分隔：`AA 55 01 FF`。
- [x] 支持连续字符：`AA5501FF`。
- [x] 支持 `0x` 前缀：`0xAA 0x55`。
- [x] 支持逗号分隔：`AA,55,01,FF`。
- [x] 支持冒号分隔：`AA:55:01:FF`。
- [x] 支持连字符分隔：`AA-55-01-FF`。
- [x] 支持空格、Tab 和换行混合。
- [x] 支持小写 Hex 字符。

第一版明确不支持：

- [ ] 不支持 `\xAA`。
- [ ] 不支持 `AAh`。
- [ ] 不支持十进制字节输入。
- [ ] 不支持二进制字节输入。

### 6.2 严格校验

- [x] 禁止直接依赖 `Buffer.from(input, 'hex')` 的宽松解析行为。
- [x] 空内容返回 `EMPTY_INPUT`。
- [x] 非 Hex 字符返回 `INVALID_HEX_CHAR`。
- [x] 奇数个 Hex 数字返回 `ODD_HEX_DIGITS`。
- [x] 无效 `0x` token 返回 `INVALID_HEX_TOKEN`。
- [x] 超过单次发送上限返回 `PAYLOAD_TOO_LARGE`。
- [x] 错误结果包含用户可定位的位置或 token。
- [x] 成功结果返回 Buffer、标准化文本和字节数。

建议结果结构：

```js
{
    ok: true,
    bytes: Buffer.from([0xAA, 0x55]),
    normalized: 'AA 55',
    byteCount: 2
}
```

### 6.3 单元测试数据

- [ ] `AA 55` 解析为两个字节。
- [ ] `AA55` 解析为两个字节。
- [ ] `0xAA,0x55` 解析为两个字节。
- [ ] `aa:55-01` 正常解析。
- [ ] `00 FF` 保留 `00`。
- [ ] `AA 5` 返回不完整字节错误。
- [ ] `AA GG` 返回非法字符错误。
- [ ] `0xA 0x55` 返回无效 token。
- [ ] 纯分隔符返回空内容错误。
- [ ] 超过限制的数据被拒绝。

---

## 7. 统一发送业务逻辑

### 7.1 发送 IPC

- [x] 新增统一的 `ipcMain.handle('serial-write')`。
- [x] 使用 `ipcRenderer.invoke()` 获取发送成功或失败结果。
- [ ] 定义统一请求结构：

```js
{
    mode: 'hex',
    content: 'AA 55 01 FF',
    encoding: 'utf8',
    appendCrLf: false,
    source: 'main-input'
}
```

- [ ] 定义成功返回值：

```js
{
    ok: true,
    bytesWritten: 4
}
```

- [ ] 定义失败返回值，包含 `code`、`message` 和可选位置。
- [x] 在主进程进行最终校验，不能只信任渲染层校验。
- [x] 等待 `SerialPort.write()` 回调后再报告成功。
- [ ] 需要时调用 `drain()`，明确成功语义是进入系统缓冲还是实际排空。

### 7.2 Text 发送

- [x] 使用指定 Text 编码生成 Buffer。
- [x] 主终端按 Enter 时根据 `newlineMode` 发送 CR、LF 或 CRLF。
- [x] 主输入框“追加 CRLF”始终追加 `0D 0A`。
- [x] 主输入、快捷发送和自动发送统一使用全局追加选项。
- [x] 发送结果按 Buffer 长度统计吞吐量。

### 7.3 Hex 发送

- [x] 使用统一 Hex 解析器生成 Buffer。
- [x] Hex 模式不执行文本换行替换。
- [x] 勾选追加时追加字节 `0D 0A`。
- [x] 内容已含 `0D 0A` 时仍按选项再次追加。
- [x] TX 吞吐量按最终写入 Buffer 长度统计。
- [x] 日志不得把 Hex 输入字符串误当成实际发送字节。

### 7.4 所有发送入口接入统一服务

- [x] 底部主输入框。
- [x] 主终端逐键 Text 输入。
- [x] 主终端 Enter。
- [x] 快捷发送。
- [x] 自动发送。
- [x] 右键“粘贴并发送”。
- [x] 右键“发送选中内容”。
- [ ] 其他现有直接发送 `serial-input` 的入口。
- [ ] 清理或废弃旧 `serial-input` IPC，避免两套逻辑长期并存。

### 7.5 主终端键盘策略

- [ ] TX Text 模式保持逐键发送和本地回显。
- [ ] TX Hex 模式拦截普通键盘输入，不直接发送。
- [ ] TX Hex 模式给出使用底部输入框的提示。
- [ ] TX Hex 模式粘贴时将内容放入底部输入框并校验。
- [ ] 右键发送选中内容时根据当前 TX 模式解释选区。
- [ ] Shell tab 键盘和粘贴逻辑保持不变。

### 7.6 发送限制

- [x] 主输入框单次发送限制默认 1MB。
- [x] 快捷发送单次发送限制默认 1MB。
- [x] 自动发送单次发送限制默认 64KB。
- [x] 粘贴发送单次限制默认 1MB。
- [x] 限制值集中定义，避免散落魔法数字。

---

## 8. 原始字节接收链路

### 8.1 主进程

- [x] 移除主进程把 Hex 当 `serialEncoding` 的逻辑。
- [x] `currentSerialPort.on('data')` 保留原始 Buffer。
- [x] RX 吞吐量继续使用 `data.length`。
- [x] 将原始字节发送给渲染进程。
- [x] 优先使用 `Uint8Array` 或已验证可结构化克隆的 Buffer。
- [x] 避免使用参数展开或整块 `Array.from(data)` 追加 RX 数据；Hex formatter 使用 `Uint8Array.subarray()` 分行处理。
- [x] 对主窗口销毁状态进行保护。

建议 IPC：

```js
mainWindow.webContents.send('serial-output-bytes', {
    bytes: new Uint8Array(data),
    receivedAt: Date.now()
});
```

### 8.2 Text 流式解码

- [x] 渲染层为当前接收编码创建流式 decoder。
- [x] UTF-8 多字节字符跨 Buffer 时不乱码。
- [x] GBK 双字节字符跨 Buffer 时不乱码。
- [x] 解码后的文本继续进入现有 `SerialDataParser`。
- [x] 保持时间戳、行号和高亮逻辑。
- [x] 编码切换前 flush 旧 decoder。
- [x] 断开连接时调用 decoder `end()`。
- [ ] 明确非法编码序列的替换行为。

### 8.3 HexStreamFormatter

- [x] 新增 `HexStreamFormatter` 类。
- [x] 维护累计字节偏移。
- [x] 维护未满一行的 `pendingBytes`。
- [x] 收到足够字节时输出完整行。
- [x] 空闲超时后输出残余行。
- [x] 新数据到达时重置空闲 timer。
- [x] 断开和模式切换时 flush 残余行。
- [x] 重连时重置偏移。
- [x] 提供普通 reset 和 flush/reset 两种明确操作。
- [x] 使用结构化 Hex 行对象，避免过早只保留最终字符串。

建议行对象：

```js
{
    offset: 16,
    bytes: new Uint8Array([1, 2, 3, 4]),
    hexText: '01 02 03 04',
    asciiText: '....',
    output: '00000010  01 02 03 04 ... |....|\r\n'
}
```

### 8.4 Hex dump 格式

- [x] 偏移固定宽度并使用十六进制。
- [x] Hex 列按 `bytesPerLine` 补齐，保持 ASCII 列对齐。
- [x] 可打印 ASCII 范围使用 `0x20` 到 `0x7E`。
- [x] 其他字节显示为 `.`。
- [x] 输出使用 `\r\n` 适配 xterm。
- [x] 大小写受配置控制。
- [x] `showOffset` 和 `showAscii` 开关正确影响输出。
- [ ] 终端宽度不足时允许横向视觉处理，但不改变数据行边界。

示例：

```text
00000000  48 65 6C 6C 6F 0D 0A 00  FF 10 20 30 40 50 60 70  |Hello..... 0@P`p|
00000010  01 02 03 04                                       |....|
```

### 8.5 显示模式切换

- [x] Text 切 Hex 前 flush Text decoder 和 parser 残余内容。
- [x] Text 切 Hex后重置 Hex pending 状态。
- [x] Hex 切 Text前 flush Hex 残余行。
- [x] Hex 切 Text后创建新 decoder。
- [x] 模式切换不重放历史数据。
- [x] 模式切换提示只写显示终端，不写 Raw 二进制日志。
- [ ] 过滤 tab 根据其数据模式决定暂停或继续接收。
- [x] 切换过程不得触发主输入框抢焦点。

---

## 9. 搜索和过滤

### 9.1 搜索

- [x] Text 模式保持现有 xterm 搜索行为。
- [x] Hex 模式可搜索偏移、Hex 字节文本和 ASCII 预览。
- [ ] Hex 普通搜索默认忽略 A-F 大小写，或明确沿用大小写开关。
- [x] 搜索计数继续跟随当前 active pane 的 active tab。
- [x] 分屏切换后搜索目标正确。

### 9.2 过滤 tab 数据模型

- [x] 为过滤 tab 增加 `dataMode: "text" | "hex"`。
- [x] 新建过滤 tab 时默认使用当前 RX 显示模式。
- [x] 恢复过滤 tab 时恢复其数据模式。
- [x] tab UI 显示 `TXT` / `HEX` 标识。
- [x] Text 过滤 tab 只处理 Text 行。
- [x] Hex 过滤 tab 只处理 Hex 行。
- [x] 主 RX 模式与 tab 模式不一致时暂停更新并给出轻量状态提示。

### 9.3 Hex 过滤

- [x] 普通过滤支持 `AA 55` 一类字节文本。
- [ ] 普通过滤在 Hex 模式下默认不区分 A-F 大小写。
- [x] 正则过滤作用于格式化后的完整 Hex 行。
- [x] 明确第一版不支持跨行序列匹配。
- [x] 明确第一版不支持 `??` 通配符。
- [x] Hex 过滤日志保存实际命中的格式化行。

### 9.4 右键菜单

- [x] Hex 主终端复制保持复制显示文本。
- [ ] 增加“复制所选 Hex 字节”时去除偏移和 ASCII 的能力，若首版需要。
- [x] “发送选中内容”根据 TX 模式解释。
- [x] “用选中文本创建过滤标签页”记录当前数据模式。
- [x] 增加“清空并重置 Hex 偏移”。
- [x] 保持现有右键菜单焦点抑制逻辑。

---

## 10. 日志

### 10.1 日志类型

- [x] 明确 Text 显示日志保存解码后的文本。
- [x] 明确 Hex 显示日志保存格式化 Hex dump。
- [x] 明确 Raw 日志直接保存 RX 原始字节。
- [x] Raw 日志使用 `.bin`。
- [x] Raw 日志不混入连接、断开和错误提示文本。
- [x] Raw 日志不混入 TX 数据，避免丢失方向语义。

### 10.2 Raw 二进制缓冲

- [x] 将真正的 Raw Buffer 与当前字符串 `rawSerialBuffer` 区分命名。
- [x] 使用 Buffer 数组保存待刷盘数据。
- [x] `rawBinaryByteCount` 使用 `data.length` 精确计数。
- [x] 达到阈值时批量 `Buffer.concat()` 并追加写入。
- [x] 首次写入生成并缓存本次连接的 Raw 日志路径。
- [x] 后续 auto-flush 追加到同一文件。
- [x] 断开、退出和异常关闭时 flush。
- [x] 写入失败时保留错误信息并避免静默丢失。

### 10.3 显示日志

- [x] Text 主终端日志行为保持现有约定。
- [x] Hex 主终端日志保存当前格式化输出。
- [x] 过滤 tab 日志根据其 Text / Hex 模式保存。
- [x] Hex 日志不执行 ANSI SGR 剥离之外的内容变换。
- [ ] 检查显示模式切换提示是否应进入显示日志，并固定行为。
- [x] 确保多 tab 日志文件名不冲突。

### 10.4 日志设置 UI

- [x] 设置窗口增加“保存原始串口数据”开关。
- [x] 增加 Raw 文件名格式输入。
- [x] 增加 `.bin` 文件类型说明。
- [x] 明确 Raw 文件只包含 RX 字节。
- [x] 恢复默认设置时恢复 Raw 日志默认值。
- [x] 六种语言补齐设置说明。

---

## 11. 生命周期和异常处理

### 11.1 连接

- [x] 连接成功时重置 Hex offset。
- [x] 连接成功时清空 Hex pending bytes。
- [x] 创建或重置 Text decoder。
- [x] 初始化 Raw 日志状态。
- [x] 初始化 RX/TX 吞吐量。
- [x] 恢复当前 RX/TX UI 模式。

### 11.2 断开

- [x] 停止或暂停自动发送 timer。
- [x] flush Hex 残余行。
- [x] 调用 Text decoder `end()`。
- [x] 处理 `SerialDataParser` 未完成内容。
- [ ] flush 显示日志。
- [x] flush Raw 二进制日志。
- [x] 清理 idle timer。
- [x] 清理串口对象和发送中状态。
- [x] 避免 `close` 事件和手动断开重复执行清理。

### 11.3 清空终端

- [x] 普通清空前处理 Hex pending bytes，避免清屏后残余旧数据突然出现。
- [x] 普通清空不重置 offset。
- [x] “清空并重置 Hex 偏移”同时清空 pending 和 offset。
- [x] 清空操作不删除已落盘日志。
- [x] 清空操作不影响串口连接。

### 11.4 自动发送异常

- [x] 串口未连接时进入等待状态，不持续产生失败日志。
- [x] Hex 内容变为无效时暂停发送。
- [x] 上一次写入未完成时不启动下一次写入。
- [x] 写入失败时停止 timer 并显示原因。
- [ ] 应用退出时清理 timer。

---

## 12. 性能与稳定性

- [ ] 验证串口 `data` 事件直接传 `Uint8Array` 的性能和兼容性。
- [ ] 避免数字普通数组造成大量对象分配。
- [x] Hex formatter 避免逐字节反复字符串拼接。
- [x] 合并多行后批量调用 `term.write()`。
- [ ] 高吞吐时评估每 8ms 或 16ms 合并一次 IPC 数据。
- [x] 不在渲染层长期保留完整原始字节历史。
- [ ] Hex 模式评估合理的 xterm scrollback 上限。
- [x] Raw 日志 auto-flush 不生成碎片文件。
- [x] Raw 日志缓冲达到阈值后能及时释放内存。
- [ ] splitter 拖动期间不得引入额外串口或日志高频操作。
- [x] 配置保存不得形成 `save-config -> config-updated -> applyConfig` 高频回环。

---

## 13. 多语言

- [x] 英文 `en`。
- [x] 简体中文 `zh-CN`。
- [x] 繁体中文 `zh-TW`。
- [x] 法语 `fr`。
- [x] 俄语 `ru`。
- [x] 德语 `de`。

至少新增以下语义：

- [x] 接收显示模式。
- [x] Text 接收。
- [x] Hex 接收。
- [x] 接收编码。
- [x] 发送模式。
- [x] Text 发送。
- [x] Hex 发送。
- [x] Hex 显示设置。
- [x] 每行字节数。
- [x] 显示偏移。
- [x] 显示 ASCII。
- [x] 大写 Hex。
- [x] 追加 `0D 0A`。
- [x] Hex 输入有效。
- [x] Hex 输入无效。
- [x] 字节数。
- [x] 非法 Hex 字符。
- [x] 不完整 Hex 字节。
- [x] 单次发送过大。
- [x] 串口写入失败。
- [x] 清空并重置 Hex 偏移。
- [x] 保存原始串口数据。
- [x] Raw 日志只包含 RX 数据。

---

## 14. 建议代码组织

### 14.1 可新增文件

- [x] 评估新增 `serial-codec.js`。
- [x] 评估新增 `hex-formatter.js`。
- [x] 若新增文件，同步更新 `agent_notes.md` 目录结构。

建议职责：

```text
serial-codec.js
- parseHexInput()
- normalizeHexInput()
- validateSerialWriteRequest()
- formatByteCount()

hex-formatter.js
- HexStreamFormatter
- formatHexLine()
- byteToPrintableAscii()
```

### 14.2 `main.js`

- [ ] 增加配置迁移函数。
- [ ] 增加 `parseHexInput()` 或复用共享模块。
- [ ] 增加 `buildSerialWriteBuffer()`。
- [ ] 增加统一 `writeSerialPayload()`。
- [x] 增加 Raw 日志缓冲和刷盘函数。
- [ ] 将串口接收改为原始字节 IPC。
- [ ] 删除旧 Hex 编码分支。

### 14.3 `renderer.js`

- [ ] 增加模式 UI 状态管理。
- [ ] 增加 Text 流式 decoder 管理。
- [ ] 增加 Hex formatter 生命周期管理。
- [ ] 增加主输入实时校验。
- [ ] 增加统一发送调用封装。
- [ ] 改造自动发送和快捷发送。
- [ ] 改造过滤 tab 数据模式。
- [ ] 保持 workspace、搜索、焦点和 Shell 行为稳定。

### 14.4 `index.html` / `style.css`

- [ ] 新增 RX/TX 模式控件。
- [ ] 改造主输入布局。
- [ ] 改造自动发送和快捷发送编辑区。
- [ ] 增加模式徽标和校验状态样式。
- [ ] 清理本次涉及区域的内联样式，优先复用 CSS class。

### 14.5 `preferences.html` / `preferences.js`

- [ ] 增加 Hex 显示高级设置。
- [x] 增加 Raw 二进制日志设置。
- [ ] 回填、保存和恢复默认值。
- [ ] 增加输入范围校验。

---

## 15. 分阶段实施计划

### 阶段 A：底层模型与解析器（已实现，待硬件回归）

- [x] 增加配置版本和迁移。
- [x] 完成严格 Hex 解析器。
- [x] 完成统一发送请求/响应模型。
- [x] 完成解析器单元测试或最小 Node 测试脚本。
- [ ] 验证旧配置可以正常启动。

完成条件：

- Text 和 Hex 请求都能生成准确 Buffer。
- 非法 Hex 不会被静默截断或部分发送。
- 旧配置迁移结果可预测。

### 阶段 B：原始字节接收和 Text 回归（代码完成，待串口实测）

- [x] 主进程发送原始字节 IPC。
- [x] 渲染层使用流式 Text decoder。
- [x] 保持 `SerialDataParser` 后续链路不变。
- [ ] 回归 UTF-8、GBK、ASCII、CR/LF/CRLF。
- [ ] 回归主终端、过滤 tab 和 Text 日志。

完成条件：

- Text 模式行为不退化。
- 跨串口数据块的 UTF-8 和 GBK 字符不乱码。

### 阶段 C：Hex 接收显示（代码完成，待高吞吐实测）

- [x] 实现 `HexStreamFormatter`。
- [x] 实现完整行和空闲残余行输出。
- [x] 实现偏移和 ASCII 预览。
- [x] 实现 RX 模式切换。
- [x] 实现清空与偏移重置动作。
- [ ] 验证高吞吐和长时间接收。

完成条件：

- 串口数据块边界不影响最终 Hex dump。
- `00`、高位字节和残余字节均不丢失。

### 阶段 D：主输入和统一发送（已实现）

- [x] 改造底部主输入 UI。
- [x] 实现 Text / Hex 双草稿。
- [x] 实现实时 Hex 校验。
- [x] 所有发送入口接入统一 IPC。
- [x] 实现 TX Hex 模式下主终端键盘策略。
- [x] 发送历史保存模式。

完成条件：

- 所有入口对相同输入发送完全相同的字节。
- 主输入发送后不清空。
- 过滤输入焦点无回归。

### 阶段 E：快捷发送和自动发送（已实现）

- [x] 迁移快捷发送数据结构。
- [x] 改造快捷发送编辑与列表 UI。
- [x] 保持拖动排序。
- [x] 改造自动发送数据结构和 UI。
- [x] 防止自动发送重入。
- [x] 完成断线、重连和错误状态处理。

完成条件：

- Text 和 Hex 快捷项均可稳定保存、恢复和发送。
- 无效 Hex 不会进入自动发送循环。

### 阶段 F：过滤、搜索和日志（代码完成，待文件与串口实测）

- [x] 过滤 tab 增加数据模式。
- [x] Hex 格式化行接入过滤。
- [x] Hex 内容接入搜索。
- [x] 实现 Hex 显示日志。
- [x] 实现 RX Raw `.bin` 日志。
- [ ] 验证 auto-flush、断开和退出落盘（需串口与文件实测）。

完成条件：

- Hex 搜索和过滤在定义范围内正确。
- Raw 文件与实际 RX 字节逐字节一致。
- 日志不覆盖、不重复、不碎片化。

### 阶段 G：国际化、文档和发布验证（文档完成，待平台验证）

- [x] 补齐六种语言。
- [x] 更新 `README.md` 的功能和使用说明。
- [x] 更新 `agent_notes.md` 的配置、架构、关键函数和经验。
- [ ] 完成 Windows 实机验证。
- [ ] 完成 Linux 基础验证。
- [ ] 完成打包验证。

完成条件：

- 无缺失翻译 key。
- 文档与最终代码行为一致。
- 打包应用可正常连接、收发 Text 和 Hex。

---

## 16. 测试矩阵

### 16.1 Hex 接收

- [ ] 接收 `00 FF 01`，正确显示且不丢 `00`。
- [ ] 一次接收 32 字节，正确显示两行。
- [ ] 同一 32 字节拆成多个串口 `data` 事件，显示结果一致。
- [ ] 只接收 3 字节，空闲超时后显示残余行。
- [ ] 接收 `0D 0A` 时作为普通字节显示，不触发 Text 换行。
- [ ] 不可打印字节在 ASCII 区显示 `.`。
- [ ] 清屏后继续接收，偏移行为符合定义。
- [ ] 重连后偏移归零。
- [ ] 修改每行字节数后只影响后续输出。

### 16.2 Text 接收

- [ ] UTF-8 中文字符跨 Buffer 不乱码。
- [ ] GBK 中文字符跨 Buffer 不乱码。
- [ ] ASCII 显示正常。
- [ ] CR、LF、CRLF 行处理保持现有行为。
- [ ] Text -> Hex -> Text 切换不崩溃、不重复数据。
- [ ] 编码切换后新数据按新编码显示。

### 16.3 Hex 发送

- [ ] `AA 55` 发送 `0xAA 0x55`。
- [ ] `AA55` 发送两个字节。
- [ ] `0xAA,0x55` 发送两个字节。
- [ ] 小写 Hex 正常发送。
- [ ] `AA 5` 被拒绝。
- [ ] `AA GG` 被拒绝。
- [ ] 空白内容不发送。
- [ ] 追加选项正确增加 `0D 0A`。
- [ ] 已有 `0D 0A` 时仍按选项再次追加。
- [ ] TX 吞吐量按真实字节数增长。

### 16.4 发送入口一致性

- [ ] 主输入框发送结果正确。
- [ ] 快捷发送结果正确。
- [ ] 自动发送结果正确。
- [ ] 右键粘贴并发送结果正确。
- [ ] 右键发送选中内容结果正确。
- [ ] 相同 request 从不同入口发送的 Buffer 完全一致。

### 16.5 日志

- [ ] Raw `.bin` 与测试设备发送字节完全一致。
- [ ] Raw 文件不包含 UI 提示文本。
- [ ] Raw 文件不包含 TX 数据。
- [ ] Hex 显示日志格式可读。
- [ ] Text 日志行为无回归。
- [ ] 多 tab 日志文件名不冲突。
- [ ] 超过 auto-flush 阈值后继续写入同一文件。
- [ ] 断开和退出时残余缓冲完整落盘。

### 16.6 UI 和回归

- [ ] 主终端 Text 模式逐键发送正常。
- [ ] 主输入框发送后不清空。
- [ ] 上下键发送历史正常并恢复模式。
- [ ] 过滤输入框不被抢焦点。
- [ ] 分屏创建、移动、关闭和恢复正常。
- [ ] Shell tab 输入、输出和粘贴不受影响。
- [ ] 搜索目标跟随 active pane / tab。
- [ ] 快捷发送拖动排序正常。
- [ ] 窗口重启后 RX/TX 模式恢复。
- [ ] 六种语言切换无布局严重溢出。
- [ ] Windows / Linux 基础行为一致。

---

## 17. 建议测试工具

- [ ] 使用虚拟串口对进行端到端测试。
- [ ] 扩展 `test/serial_tester.py`，支持发送任意原始字节。
- [ ] 增加分块发送选项，模拟随机串口数据块边界。
- [ ] 增加 UTF-8 / GBK 跨块字符测试。
- [ ] 增加连续高吞吐二进制数据测试。
- [ ] 增加固定 payload 回显，用于验证 TX 字节。
- [ ] 增加 Raw `.bin` 文件逐字节对比脚本。

---

## 18. 风险清单

- [ ] 风险：把串口 `data` 事件边界误当协议帧边界。
  - 规避：Hex formatter 按连续字节流处理，协议帧识别不在第一版范围内。
- [ ] 风险：UTF-8 / GBK 字符跨 Buffer 后乱码。
  - 规避：使用流式 decoder，不对每个 Buffer 独立 `toString()`。
- [ ] 风险：`Buffer.from(text, 'hex')` 静默截断非法输入。
  - 规避：发送前使用严格 parser，并在主进程再次校验。
- [ ] 风险：多个发送入口产生不同转换结果。
  - 规避：统一请求模型和 `serial-write` IPC。
- [ ] 风险：Hex 字符串显示进入现有换行 parser 后长期不显示。
  - 规避：Hex 模式完全绕过 `SerialDataParser`。
- [ ] 风险：Raw 日志实际保存为 Hex 文本。
  - 规避：Raw 日志直接 append Buffer。
- [ ] 风险：Hex dump 放大显示内容并增加内存。
  - 规避：批量写 xterm、控制 scrollback、不保存渲染层原始历史。
- [ ] 风险：模式切换触发配置回推和 UI 状态回环。
  - 规避：区分用户操作保存与配置应用阶段，避免重复 save。
- [ ] 风险：改造发送逻辑影响 Shell tab。
  - 规避：Shell IPC 保持独立，不复用串口 TX 模式。
- [ ] 风险：主输入框再次抢占过滤输入焦点。
  - 规避：遵守现有 `suppressMainInputFocus` 和显式聚焦原则。

---

## 19. 完成定义

只有满足以下条件，Hex 功能才能标记为完成：

- [ ] 第一版“必须实现”列表全部完成。
- [ ] Text / Hex 接收和发送四种组合均通过验证。
- [ ] 所有发送入口使用统一业务逻辑。
- [ ] 非法 Hex 输入不会发送任何部分数据。
- [ ] Raw `.bin` 与实际 RX 字节完全一致。
- [ ] UTF-8 和 GBK 跨 Buffer 解码测试通过。
- [ ] 主终端、过滤 tab、分屏、Shell、搜索和焦点无关键回归。
- [ ] 配置迁移和启动恢复通过验证。
- [ ] 六种语言完成并检查布局。
- [ ] Windows 实机测试通过。
- [ ] Linux 基础测试通过或明确记录未验证项。
- [ ] `README.md` 和 `agent_notes.md` 已同步更新。
- [ ] 代码语法检查、现有测试和新增测试通过。
