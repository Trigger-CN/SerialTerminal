'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const renderer = fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf8');
const start = renderer.indexOf('function bindTerminalWheel(');
assert.ok(start >= 0);
const end = renderer.indexOf('\n}', start) + 2;
const fn = renderer.slice(start, end);

function fixture() {
    let listener;
    const moves = [], target = {
        addEventListener(name, callback, options) { assert.equal(name, 'wheel'); listener = { callback, options }; }
    };
    const term = { scrollLines: delta => moves.push(delta) };
    const context = vm.createContext({ mouseWheelScrollLines: 5, Number, Math });
    vm.runInContext(fn, context);
    context.bindTerminalWheel(term, target);
    return { context, listener, moves };
}

function wheel(deltaY) {
    return { deltaY, prevented: false, stopped: false,
        preventDefault() { this.prevented = true; },
        stopImmediatePropagation() { this.stopped = true; } };
}

test('serial wheel settings control exact scrolling direction and intercept xterm defaults', () => {
    const f = fixture();
    assert.equal(f.listener.options.capture, true); assert.equal(f.listener.options.passive, false);
    const down = wheel(120); f.listener.callback(down);
    assert.deepEqual(f.moves, [5]); assert.equal(down.prevented, true); assert.equal(down.stopped, true);
    f.context.mouseWheelScrollLines = 12;
    const up = wheel(-120); f.listener.callback(up);
    assert.deepEqual(f.moves, [5, -12]);
});

test('custom scrolling can be gated for tracked mouse reports and alternate buffers', () => {
    let tracked = true;
    const f = fixture();
    f.context.bindTerminalWheel({ scrollLines: delta => f.moves.push(delta) }, {
        addEventListener(_name, callback) { f.trackedListener = callback; }
    }, () => !tracked);
    const report = wheel(120); f.trackedListener(report);
    assert.deepEqual(f.moves, []); assert.equal(report.prevented, false);
    tracked = false;
    const normal = wheel(120); f.trackedListener(normal);
    assert.deepEqual(f.moves, [5]); assert.equal(normal.prevented, true);
});

test('zero/non-finite wheel deltas and absent terminal do not scroll', () => {
    const f = fixture();
    for (const delta of [0, NaN, Infinity, -Infinity]) f.listener.callback(wheel(delta));
    assert.deepEqual(f.moves, []);
    assert.doesNotThrow(() => f.context.bindTerminalWheel(null, {}));
    assert.doesNotThrow(() => f.context.bindTerminalWheel({}, null));
});

test('default and added serial runtimes bind their own terminal exactly once', () => {
    const bindings = [], containers = new Map(['default', 'g-1'].map(id => [id, {}]));
    class Terminal { loadAddon() {} open(container) { this.element = {}; this.container = container; } }
    const context = vm.createContext({ Terminal, FitAddon: class {}, SearchAddon: class {}, SerialDataParser: class {},
        buildSerialTerminalOptions: () => ({}), enableTerminalUnicode11() {}, serialContainerId: id => id,
        document: { getElementById: id => containers.get(id) },
        bindTerminalWheel: (term, container) => bindings.push({ term, container }) });
    const createStart = renderer.indexOf('function createSerialRuntime(');
    vm.runInContext(renderer.slice(createStart, renderer.indexOf('\n}', createStart) + 2), context);
    for (const id of containers.keys()) {
        const runtime = context.createSerialRuntime(id);
        assert.equal(bindings.at(-1).term, runtime.term);
        assert.equal(bindings.at(-1).container, containers.get(id));
        assert.notEqual(bindings.at(-1).container, runtime.term.element);
    }
    assert.equal(bindings.length, 2);
    assert.equal(context.createSerialRuntime('missing'), null); assert.equal(bindings.length, 2);
    assert.equal((renderer.match(/bindTerminalWheel\(serialTerm,/g) || []).length, 0);
});

test('Shell normal scrollback and text mode use configured lines, application mouse modes keep native handling', () => {
    const f = fixture(), moves = []; let listener;
    const shell = { textMode: false, term: { buffer: { active: { type: 'normal' } },
        modes: { mouseTrackingMode: 'none' }, scrollLines: delta => moves.push(delta), element: {} } };
    const wrapper = { addEventListener(_name, callback) { listener = callback; } };
    const shellStart = renderer.indexOf('function bindShellTextModeWheel(');
    vm.runInContext(renderer.slice(shellStart, renderer.indexOf('\n}', shellStart) + 2), f.context);
    f.context.bindShellTextModeWheel(shell, wrapper);
    listener(wheel(100)); assert.deepEqual(moves, [5]);
    shell.term.modes.mouseTrackingMode = 'vt200';
    const tracked = wheel(100); listener(tracked); assert.equal(tracked.prevented, false);
    shell.term.modes.mouseTrackingMode = 'none'; shell.term.buffer.active.type = 'alternate';
    const alternate = wheel(100); listener(alternate); assert.equal(alternate.prevented, false);
    shell.textMode = true; f.context.mouseWheelScrollLines = 20;
    listener(wheel(-100)); assert.deepEqual(moves, [5, -20]);
});

test('applying saved scroll settings updates existing wheel bindings without recreating terminals', () => {
    const { normalizeIntegerSetting } = require('../src/common/config-values');
    const f = fixture(); f.context.normalizeIntegerSetting = normalizeIntegerSetting;
    const assignment = renderer.match(/^    mouseWheelScrollLines = .+;$/m)?.[0];
    assert.ok(assignment);
    for (const [value, expected] of [[1, 1], [50, 50], [999, 50], [undefined, 3]]) {
        f.context.config = { mouseWheelScrollLines: value };
        vm.runInContext(assignment, f.context);
        f.listener.callback(wheel(100)); assert.equal(f.moves.at(-1), expected);
    }
});
