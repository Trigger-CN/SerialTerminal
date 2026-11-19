const { Unicode11Addon } = require('@xterm/addon-unicode11');

const DOUBLE_WIDTH_SYMBOL_RANGES = [
    [0x2295, 0x22a1]
];
const EXTENDED_PICTOGRAPHIC = /\p{Extended_Pictographic}/u;

function usesEmojiCellWidth(codepoint) {
    return DOUBLE_WIDTH_SYMBOL_RANGES.some(([start, end]) => codepoint >= start && codepoint <= end)
        || EXTENDED_PICTOGRAPHIC.test(String.fromCodePoint(codepoint));
}

class TerminalUnicodeWidthAddon {
    activate(terminal) {
        let unicode11Provider = null;
        new Unicode11Addon().activate({
            unicode: {
                register(provider) {
                    unicode11Provider = provider;
                }
            }
        });
        if (!unicode11Provider) throw new Error('Unicode 11 provider unavailable');

        terminal.unicode.register({
            version: '11-emoji',
            wcwidth(codepoint) {
                const width = unicode11Provider.wcwidth(codepoint);
                return width === 1 && usesEmojiCellWidth(codepoint) ? 2 : width;
            },
            charProperties(codepoint, preceding) {
                const properties = unicode11Provider.charProperties(codepoint, preceding);
                return unicode11Provider.wcwidth(codepoint) === 1 && usesEmojiCellWidth(codepoint)
                    ? (properties & ~6) | 4
                    : properties;
            }
        });
        terminal.unicode.activeVersion = '11-emoji';
    }

    dispose() {}
}

module.exports = { TerminalUnicodeWidthAddon, usesEmojiCellWidth };
