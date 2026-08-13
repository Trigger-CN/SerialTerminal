const test = require('node:test');
const assert = require('node:assert/strict');
const { translateConptyMouseMode } = require('../shell-mouse-compat');

test('restores SGR drag mouse mode consumed by ConPTY', () => {
    const state = {};
    assert.equal(
        translateConptyMouseMode(state, '\x1b[?25l\x1b[?1015htext\x1b[?1015l'),
        '\x1b[?25l\x1b[?1002;1006htext\x1b[?1002;1006l'
    );
});

test('restores a ConPTY mouse mode split across output chunks', () => {
    const state = {};
    assert.equal(translateConptyMouseMode(state, 'before\x1b[?10'), 'before');
    assert.equal(translateConptyMouseMode(state, '15hafter'), '\x1b[?1002;1006hafter');
    assert.equal(state.mouseModeSequenceCarry, '');
});

test('does not alter SGR mouse reports', () => {
    const state = {};
    const report = '\x1b[<0;12;8M';
    assert.equal(translateConptyMouseMode(state, report), report);
});
