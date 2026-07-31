'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const root = path.join(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const iconNames = [
  'filter_alt',
  'terminal',
  'vertical_split',
  'horizontal_split',
  'close_fullscreen',
  'content_paste_go',
  'send',
  'content_copy',
  'copy_all',
  'search',
  'delete_sweep',
  'restart_alt',
  'swap_horiz',
  'close',
  'playlist_add',
  'my_location',
  'match_case',
  'match_word',
  'regular_expression'
];

function alphaValues(png, size) {
  const chunks = [];
  let offset = 8;
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString('ascii', offset + 4, offset + 8);
    if (type === 'IDAT') chunks.push(png.subarray(offset + 8, offset + 8 + length));
    offset += length + 12;
  }

  const raw = zlib.inflateSync(Buffer.concat(chunks));
  const rows = [];
  const alphas = [];
  for (let row = 0; row < size; row += 1) {
    const rowOffset = row * (size * 4 + 1);
    const filter = raw[rowOffset];
    const decoded = Buffer.alloc(size * 4);
    const previous = rows[row - 1];
    for (let index = 0; index < decoded.length; index += 1) {
      const left = index >= 4 ? decoded[index - 4] : 0;
      const above = previous ? previous[index] : 0;
      const upperLeft = previous && index >= 4 ? previous[index - 4] : 0;
      const predictor = left + above - upperLeft;
      const paeth = [left, above, upperLeft].reduce((best, value) => (
        Math.abs(predictor - value) < Math.abs(predictor - best) ? value : best
      ), left);
      const filters = [0, left, above, Math.floor((left + above) / 2), paeth];
      assert.ok(filter >= 0 && filter < filters.length, `unsupported PNG filter ${filter}`);
      decoded[index] = (raw[rowOffset + 1 + index] + filters[filter]) & 0xff;
    }
    rows.push(decoded);
    for (let column = 0; column < size; column += 1) alphas.push(decoded[column * 4 + 3]);
  }
  return alphas;
}

test('terminal context menu uses plain labels and native icon properties', () => {
  const menuSource = main.slice(
    main.indexOf("ipcMain.on('show-terminal-context-menu'"),
    main.indexOf("ipcMain.handle('get-system-fonts'")
  );

  assert.ok(menuSource.length > 0);
  assert.doesNotMatch(menuSource, /withIcon|label:\s*['"`]\s*\[/);
  iconNames.forEach(name => assert.match(menuSource, new RegExp(`\\.\\.\\.menuIcon\\('${name}'\\)`)));
  assert.match(main, /path\.join\(__dirname, 'assets', 'menu-icons'\)/);
  assert.match(main, /fs\.existsSync\(icon\) \? \{ icon \} : \{\}/);
});

test('menu icon assets are transparent 16px and 32px PNGs', () => {
  iconNames.forEach(name => {
    for (const [suffix, expectedSize] of [['', 16], ['@2x', 32]]) {
      const png = fs.readFileSync(path.join(root, 'assets', 'menu-icons', `${name}${suffix}.png`));
      assert.deepEqual(png.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      assert.equal(png.readUInt32BE(16), expectedSize, `${name}${suffix} width`);
      assert.equal(png.readUInt32BE(20), expectedSize, `${name}${suffix} height`);
      assert.equal(png[25], 6, `${name}${suffix} must use RGBA color`);
      const alphas = alphaValues(png, expectedSize);
      assert.ok(alphas.includes(0), `${name}${suffix} must have transparent pixels`);
      assert.ok(alphas.some(alpha => alpha > 0), `${name}${suffix} must have visible pixels`);
    }
  });
});
