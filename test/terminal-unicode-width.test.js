const test = require('node:test');
const assert = require('node:assert/strict');
const { Terminal } = require('@xterm/xterm');
const { TerminalUnicodeWidthAddon, usesEmojiCellWidth } = require('../terminal-unicode-width');

function getRenderedCells(text) {
    return new Promise(resolve => {
        const terminal = new Terminal({ allowProposedApi: true, cols: 40 });
        terminal.loadAddon(new TerminalUnicodeWidthAddon());
        terminal.write(text, () => {
            const line = terminal.buffer.active.getLine(0);
            const cells = [];
            for (let column = 0; column < terminal.cols; column++) {
                const cell = line.getCell(column);
                if (cell?.getChars()) cells.push({ chars: cell.getChars(), width: cell.getWidth() });
            }
            terminal.dispose();
            resolve(cells);
        });
    });
}

test('emoji-like symbols use two terminal cells', async () => {
    for (const symbol of ['⊕', '⊖', '⊗', '⊘', '⊙', '⊚', '⊛', '⊜', '⊝', '⊞', '⊟', '⊠', '⊡', '🌧', '☀️', '⛈', '🌪', '😀', '⚡', '❤️']) {
        const cells = await getRenderedCells(symbol);
        assert.equal(cells[0].width, 2, `${symbol} should use two cells`);
    }
});

test('standard text, combining characters, and CJK retain Unicode 11 widths', async () => {
    assert.equal(usesEmojiCellWidth('🌧'.codePointAt(0)), true);
    assert.deepEqual(await getRenderedCells('A'), [{ chars: 'A', width: 1 }]);
    assert.deepEqual(await getRenderedCells('中'), [{ chars: '中', width: 2 }]);
    assert.deepEqual(await getRenderedCells('e\u0301'), [{ chars: 'é', width: 1 }]);
});
