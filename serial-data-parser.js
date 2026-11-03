'use strict';

// 串口接收数据行解析器（P2）。
//
// 负责把任意切分的字节块切成「行」，并为每一行的起始位置附上前缀（时间戳 / 行号）。
// 这里刻意不在内部调用全局的 getPrefix()：早先那样写，一旦将来出现多个分组各自的
// parser 实例，所有实例都会把行号记到同一个分组上，表现为两个端口的行号互相跳号。
// 改为构造时注入 prefixProvider，每个实例绑定自己的分组。
//
// 本模块不依赖 DOM、xterm 或 Electron，可直接在 Node 里断言。

const DEFAULT_GROUP_ID = 'default';

// 行分隔符正则复用同一实例；parse 会按上次扫描位置设置 lastIndex。
const LINE_DELIMITER_RE = /(\r\n|\r|\n)/g;

// 单行超过该阈值时不再等待分隔符，直接作为一行吐出，避免无限增长的缓冲。
const MAX_UNTERMINATED_LINE = 10000;

class SerialDataParser {
  constructor({ prefixProvider = null, groupId = DEFAULT_GROUP_ID } = {}) {
    // 未注入时退化为「空前缀」：拿到的是显式行为而不是隐式的全局状态。
    this.prefixProvider = typeof prefixProvider === 'function' ? prefixProvider : () => '';
    this.groupId = groupId;
    this.incomingBuffer = '';
    this.isNewLine = true;
  }

  parse(data) {
    if (!data) return [];

    // incomingBuffer 中已保留的尾部不含任何分隔符，因此只需从新增数据的起点继续扫描，
    // 避免每次 flush 都重新 split 整个增长中的缓冲。
    const scanFrom = this.incomingBuffer.length;
    this.incomingBuffer += data;
    const buffer = this.incomingBuffer;

    const lines = [];
    let cursor = 0;
    LINE_DELIMITER_RE.lastIndex = scanFrom;
    let match;
    while ((match = LINE_DELIMITER_RE.exec(buffer)) !== null) {
      lines.push({
        text: buffer.slice(cursor, match.index),
        delimiter: match[0],
        prefix: this.isNewLine ? this.prefixProvider() : ''
      });
      this.isNewLine = true; // After delimiter, next line is new
      cursor = match.index + match[0].length;
    }

    if (!lines.length) {
      if (buffer.length > MAX_UNTERMINATED_LINE) {
        const lineContent = buffer;
        this.incomingBuffer = '';

        const prefix = this.isNewLine ? this.prefixProvider() : '';
        this.isNewLine = false; // Next chunk is continuation
        return [{ text: lineContent, delimiter: '', prefix }];
      }
      return [];
    }

    this.incomingBuffer = buffer.slice(cursor);
    return lines;
  }

  flush() {
    if (!this.incomingBuffer) return [];
    const line = {
      text: this.incomingBuffer,
      delimiter: '',
      prefix: this.isNewLine ? this.prefixProvider() : ''
    };
    this.incomingBuffer = '';
    this.isNewLine = false;
    return [line];
  }

  reset() {
    this.incomingBuffer = '';
    this.isNewLine = true;
  }
}

module.exports = { SerialDataParser, MAX_UNTERMINATED_LINE };
