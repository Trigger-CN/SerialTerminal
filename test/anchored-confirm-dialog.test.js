'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createAnchoredConfirmDialog } = require('../src/common/anchored-confirm-dialog');

function fixture(rect = { left: 700, right: 820, top: 50, bottom: 86, width: 120, height: 36 }) {
    let document;
    class Element {
        constructor() {
            this.events = new Map(); this.style = {}; this.textContent = ''; this.isConnected = true;
            this.classes = new Set(['hidden']);
            this.classList = { add: name => this.classes.add(name), remove: name => this.classes.delete(name), contains: name => this.classes.has(name) };
        }
        addEventListener(name, callback) { if (!this.events.has(name)) this.events.set(name, new Set()); this.events.get(name).add(callback); }
        removeEventListener(name, callback) { this.events.get(name)?.delete(callback); }
        fire(name, props = {}) {
            const event = { target: this, preventDefault() { this.prevented = true; }, stopImmediatePropagation() { this.stopped = true; }, ...props };
            for (const callback of [...(this.events.get(name) || [])]) callback(event);
            return event;
        }
        focus() { document.activeElement = this; document.fire('focusin', { target: this }); }
        getBoundingClientRect() { return this.rect; }
    }
    document = new Element();
    const window = new Element(); window.innerWidth = 1280; window.innerHeight = 720;
    const overlay = new Element(), dialog = new Element(), title = new Element(), message = new Element(), detail = new Element();
    const cancel = new Element(), confirm = new Element(), dismiss = new Element(), previous = new Element(), anchor = new Element();
    anchor.rect = rect; dialog.offsetWidth = 380; dialog.offsetHeight = 230;
    dialog.contains = element => [dialog, title, message, detail, cancel, confirm, dismiss].includes(element);
    const nodes = { '.app-dialog': dialog, h2: title, '#tab-close-dialog-message': message, '#tab-close-dialog-detail': detail,
        '#tab-close-dialog-cancel': cancel, '#tab-close-dialog-confirm': confirm, '.app-dialog-close': dismiss };
    overlay.querySelector = selector => nodes[selector];
    document.activeElement = previous;
    const controller = createAnchoredConfirmDialog({ document, window, overlay });
    const show = (options = {}) => controller.show({ anchor, title: 'Close Tab', message: 'Close <Shell>?', detail: 'Session ends', cancelLabel: 'Cancel', confirmLabel: 'Close', ...options });
    return { document, window, overlay, dialog, title, message, detail, cancel, confirm, dismiss, previous, anchor, show };
}

function assertClean(f) {
    assert.equal(f.overlay.classList.contains('hidden'), true);
    for (const name of ['keydown', 'focusin', 'scroll']) assert.equal(f.document.events.get(name).size, 0, name);
    for (const name of ['resize', 'beforeunload']) assert.equal(f.window.events.get(name).size, 0, name);
}

test('application confirmation is anchored below its target and starts on Cancel', async () => {
    const f = fixture(), pending = f.show();
    assert.equal(f.overlay.classList.contains('hidden'), false);
    assert.equal(f.dialog.style.left, '440px'); assert.equal(f.dialog.style.top, '94px');
    assert.equal(f.document.activeElement, f.cancel);
    assert.equal(f.message.textContent, 'Close <Shell>?'); assert.equal(f.detail.textContent, 'Session ends');
    f.cancel.fire('click'); assert.equal(await pending, false); assertClean(f);
});

for (const method of ['cancel', 'dismiss', 'escape', 'backdrop', 'unload']) test(`${method} cancels and restores focus without approval`, async () => {
    const f = fixture(), pending = f.show();
    if (method === 'escape') {
        const event = f.document.fire('keydown', { key: 'Escape' });
        assert.equal(event.prevented, true); assert.equal(event.stopped, true);
    } else if (method === 'backdrop') f.overlay.fire('click');
    else if (method === 'unload') f.window.fire('beforeunload');
    else f[method].fire('click');
    assert.equal(await pending, false); assert.equal(f.document.activeElement, f.previous); assertClean(f);
});

test('only explicit confirmation approves, once, and releases all temporary listeners', async () => {
    const f = fixture(), pending = f.show();
    f.overlay.fire('click', { target: f.message });
    assert.equal(f.overlay.classList.contains('hidden'), false);
    f.confirm.fire('click'); f.confirm.fire('click');
    assert.equal(await pending, true); assertClean(f);
});

test('Escape is isolated from underlying app shortcuts; Tab stays in the dialog', async () => {
    const f = fixture(), pending = f.show();
    const forward = f.document.fire('keydown', { key: 'Tab' });
    assert.equal(forward.prevented, true); assert.equal(f.document.activeElement, f.confirm);
    f.document.fire('keydown', { key: 'Tab' }); assert.equal(f.document.activeElement, f.dismiss);
    f.document.fire('keydown', { key: 'Tab', shiftKey: true }); assert.equal(f.document.activeElement, f.confirm);
    f.previous.focus(); assert.equal(f.document.activeElement, f.cancel);
    const shortcut = f.document.fire('keydown', { key: 'Delete' }); assert.equal(shortcut.stopped, true);
    f.document.activeElement = f.dialog;
    assert.equal(f.document.fire('keydown', { key: 'Enter' }).prevented, true);
    f.document.fire('keydown', { key: 'Escape' }); assert.equal(await pending, false);
});

test('another close request cannot replace the pending target or approve it', async () => {
    const f = fixture(), pending = f.show();
    assert.equal(await f.show({ message: 'Different target' }), false);
    assert.equal(f.message.textContent, 'Close <Shell>?');
    f.cancel.fire('click'); assert.equal(await pending, false);
    const next = f.show({ message: 'Next target' });
    assert.equal(f.message.textContent, 'Next target');
    f.confirm.fire('click'); assert.equal(await next, true); assertClean(f);
});

test('a bottom-row target flips the dialog above without overflowing', async () => {
    const f = fixture({ left: 950, right: 1070, top: 650, bottom: 686, width: 120, height: 36 }), pending = f.show();
    assert.equal(f.dialog.style.left, '690px'); assert.equal(f.dialog.style.top, '412px');
    f.cancel.fire('click'); await pending;
});

for (const [label, rect, expected] of [
    ['left', { left: 5, right: 125, top: 40, bottom: 76, width: 120, height: 36 }, '8px'],
    ['right', { left: 1200, right: 1320, top: 40, bottom: 76, width: 120, height: 36 }, '892px']
]) test(`${label}-edge target is clamped inside viewport`, async () => {
    const f = fixture(rect), pending = f.show(); assert.equal(f.dialog.style.left, expected);
    f.cancel.fire('click'); await pending;
});

test('scroll and window resize follow the same target rather than global focus', async () => {
    const f = fixture(), pending = f.show();
    f.anchor.rect = { left: 350, right: 470, top: 80, bottom: 116, width: 120, height: 36 };
    f.document.fire('scroll'); assert.equal(f.dialog.style.left, '90px'); assert.equal(f.dialog.style.top, '124px');
    f.window.innerWidth = 400; f.window.innerHeight = 240;
    f.dialog.offsetWidth = 384; f.dialog.offsetHeight = 224;
    f.window.fire('resize'); assert.equal(f.dialog.style.left, '8px'); assert.equal(f.dialog.style.top, '8px');
    f.cancel.fire('click'); await pending;
});

test('missing or invisible tab anchor safely centers within the viewport', async () => {
    for (const missing of [true, false]) {
        const f = fixture({ left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 });
        const pending = f.show(missing ? { anchor: null } : {});
        assert.equal(f.dialog.style.left, '450px'); assert.equal(f.dialog.style.top, '245px');
        f.cancel.fire('click'); assert.equal(await pending, false);
    }
});

test('detaching a pending target cancels rather than confirming another tab', async () => {
    const f = fixture(), pending = f.show();
    f.anchor.isConnected = false; f.document.fire('scroll');
    assert.equal(await pending, false); assertClean(f);
});
