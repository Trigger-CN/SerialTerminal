'use strict';

// 波特率列表与自定义波特率删除的回归测试。
//
// 背景：
//   1. 9600 以下的速率（110/300/600/1200/2400/4800）在现代串口设备上已无用武之地，
//      从标准列表与下拉框中移除，避免把常用值挤到列表下半部分。
//   2. 自定义波特率此前只能加不能删，选错了只能改配置文件。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'renderer.js'), 'utf8');
const i18n = fs.readFileSync(path.join(root, 'src', 'common', 'i18n.js'), 'utf8');
const {
  STANDARD_BAUD_RATES,
  MIN_BAUD_RATE,
  isSupportedBaudRate,
  normalizeCustomBaudRates
} = require('../src/serial/baud-rates');

test('下拉框中不再出现 9600 以下的速率', () => {
  const selectStart = html.indexOf('<select id="baud-select"');
  const selectEnd = html.indexOf('</select>', selectStart);
  assert.ok(selectStart !== -1 && selectEnd > selectStart, '应能定位波特率下拉框');
  const block = html.slice(selectStart, selectEnd);

  for (const removed of ['110', '300', '600', '1200', '2400', '4800']) {
    assert.ok(
      !new RegExp(`<option value="${removed}">`).test(block),
      `${removed} 不应出现在下拉框中`
    );
  }
  // 9600 必须保留：它现在是最低速档，也是默认值。
  assert.match(block, /<option value="9600">9600<\/option>/);
});

test('标准速率列表与下拉框选项一一对应', () => {
  const selectStart = html.indexOf('<select id="baud-select"');
  const selectEnd = html.indexOf('</select>', selectStart);
  const block = html.slice(selectStart, selectEnd);
  const optionValues = [...block.matchAll(/<option value="(\d+)"/g)].map(m => m[1]);

  // 下拉框 = 标准速率 + custom 入口，顺序一致。
  assert.deepEqual(optionValues, [...STANDARD_BAUD_RATES]);
  assert.ok(MIN_BAUD_RATE === 9600);
});

test('最低速率以下的值不会被当作自定义波特率保留', () => {
  // 老配置里残留的 4800 之类不应转成自定义项混进下拉框。
  assert.deepEqual(normalizeCustomBaudRates(['4800', '1200', '250000']), ['250000']);
  assert.equal(isSupportedBaudRate('9600'), true);
  assert.equal(isSupportedBaudRate('9599'), false);
});

test('自定义波特率提供删除入口', () => {
  // 删除按钮存在于侧栏波特率控件旁。
  assert.match(html, /id="baud-custom-delete"/);

  // 渲染层绑定删除动作。
  assert.match(renderer, /baudCustomDelete\?\.addEventListener\('click', deleteSelectedCustomBaudRate\)/);

  // 实现存在，且拒绝删除标准速率。
  assert.match(renderer, /function deleteSelectedCustomBaudRate\(\)/);
  const impl = renderer.slice(
    renderer.indexOf('function deleteSelectedCustomBaudRate()'),
    renderer.indexOf('function deleteSelectedCustomBaudRate()') + 800
  );
  assert.match(impl, /isStandardBaudRate\(selected\)\) return/, '标准速率必须不可删');
  assert.match(impl, /customBaudRates/) ;
  // 删掉当前生效值时必须回落，不能留下一个不存在的选项。
  assert.match(impl, /previousBaudRate === selected/);
});

test('删除按钮只在选中自定义速率时显示', () => {
  assert.match(renderer, /function syncBaudDeleteButton\(\)/);
  const impl = renderer.slice(
    renderer.indexOf('function syncBaudDeleteButton()'),
    renderer.indexOf('function syncBaudDeleteButton()') + 400
  );
  // 标准速率 / custom 入口都不显示按钮。
  assert.match(impl, /!isStandardBaudRate\(selected\)/);
});

test('删除相关文案覆盖六种语言', () => {
  const languages = ['en', "'zh-CN'", "'zh-TW'", 'fr', 'ru', 'de'];
  for (const lang of languages) {
    const re = new RegExp(`\\n  ${lang}: \\{[^\\n]*deleteCustomBaudRate`);
    assert.match(i18n, re, `${lang} 缺少 deleteCustomBaudRate 文案`);
  }
  assert.match(i18n, /customBaudRateDeleted/);
});
