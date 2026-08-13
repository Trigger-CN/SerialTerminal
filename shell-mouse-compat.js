const CONPTY_MOUSE_MODE_PATTERN = /\x1b\[\?1015([hl])/g;
const CONPTY_MOUSE_MODE_PREFIX = '\x1b[?1015';

function translateConptyMouseMode(state, data) {
    const input = `${state.mouseModeSequenceCarry || ''}${data}`;
    let carryLength = 0;

    for (let length = 1; length < CONPTY_MOUSE_MODE_PREFIX.length; length++) {
        if (input.endsWith(CONPTY_MOUSE_MODE_PREFIX.slice(0, length))) carryLength = length;
    }

    const complete = carryLength ? input.slice(0, -carryLength) : input;
    state.mouseModeSequenceCarry = carryLength ? input.slice(-carryLength) : '';
    return complete.replace(CONPTY_MOUSE_MODE_PATTERN, (_sequence, action) => `\x1b[?1002;1006${action}`);
}

module.exports = { translateConptyMouseMode };
