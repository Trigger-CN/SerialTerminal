'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const model = require('../src/workspace/tab-model');
const { importWorkspace } = require('../src/workspace/tabs-workspace-projection');
const { createLayoutRenderer } = require('../src/workspace/layout-renderer');
function fixture(multiple = false) {
    const nodes = [], events = new Map(), frames = new Map(), calls = [], buttons = new Map();
    let nextFrame = 0, ws = importWorkspace({ groups: [{ id: 'default' }, ...(multiple ? [{ id: 'b' }] : [])],
        filterTabs: { default: [{ id: 'f1' }] }, shellTabs: [{ id: 'tab-shell-1' }, { id: 'tab-shell-2' }], focusedTabId: 'tab-main' });
    class Element {
        constructor(className = '', id = '') {
            this.className = className; this.id = id; this.children = []; this.dataset = {}; this.style = {}; this.listeners = new Map(); this.hidden = false;
            this.classList = { contains: name => this.className.split(' ').includes(name),
                toggle: (name, on) => { const list = this.className.split(' ').filter(x => x && x !== name); if (on) list.push(name); this.className = list.join(' '); },
                add: name => this.classList.toggle(name, true), remove: name => this.classList.toggle(name, false) };
            nodes.push(this);
        }
        appendChild(child) { return this.insertBefore(child, null); }
        insertBefore(child, before) {
            if (child === before) return child;
            child.remove(); const index = before ? this.children.indexOf(before) : this.children.length;
            assert.ok(index >= 0); this.children.splice(index, 0, child); child.parentElement = this; return child;
        }
        remove() { if (this.parentElement) { const p = this.parentElement; p.children.splice(p.children.indexOf(this), 1); this.parentElement = null; } }
        get firstChild() { return this.children[0] || null; }
        get nextSibling() { const p = this.parentElement; return p?.children[p.children.indexOf(this) + 1] || null; }
        setAttribute(key, value) { this[key] = value; }
        querySelectorAll(selector) { return this.children.flatMap(child => [child, ...child.querySelectorAll('*')]).filter(child => selector === '*' || child.matches(selector)); }
        querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
        matches(selector) { return selector[0] === '.' ? this.classList.contains(selector.slice(1)) : selector === '[data-layout-item-id]' && !!this.dataset.layoutItemId; }
        closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector) || null; }
        addEventListener(name, fn) { this.listeners.set(name, [...this.listeners.get(name) || [], fn]); }
        emit(name, event) { for (const fn of this.listeners.get(name) || []) fn({ preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {}, ...event }); }
        getBoundingClientRect() { return { left: 0, top: 0, width: 300, height: 200 }; }
    }
    const host = new Element('host');
    const document = { createElement: () => new Element(), getElementById: id => nodes.find(node => node.id === id),
        querySelectorAll: selector => host.querySelectorAll(selector),
        addEventListener: (name, fn) => events.set(name, [...events.get(name) || [], fn]),
        removeEventListener: (name, fn) => events.set(name, (events.get(name) || []).filter(item => item !== fn)) };
    const act = action => { const r = model.applyWorkspaceAction(ws, action); assert.equal(r.ok, true, r.reason); ws = r.workspace; return r; };
    for (const tab of Object.values(ws.tabs).filter(tab => !model.isContainer(tab))) {
        buttons.set(tab.id, new Element('main-tab')); buttons.get(tab.id).dataset.target = tab.id;
        host.appendChild(new Element('main-tab-pane', tab.id));
    }
    const renderer = createLayoutRenderer({ document, host,
        createPane: (_, id) => { const el = new Element('workspace-pane', id), header = new Element('pane-tabs-header'), list = new Element('pane-tabs-list');
            header.appendChild(list); header.appendChild(new Element('pane-tab-actions')); el.appendChild(header); el.appendChild(new Element('pane-tabs-content')); return el; },
        getButton: id => buttons.get(id), getGroupButton: member => {
            if (!buttons.has(member.id)) { const el = new Element('main-tab serial-group-tab'); el.dataset.groupId = member.tabId; buttons.set(member.id, el); }
            return buttons.get(member.id);
        },
        onActivate: (tabId, itemId) => { calls.push(['activate', tabId, itemId]); act({ type: 'activate', tabId, itemId }); },
        onMenu: (...args) => calls.push(['menu', ...args]),
        onResize: action => { calls.push(['resize', action]); act(action); renderer.render(model.buildRenderPlan(ws)); },
        onCollapse: (groupId, collapsed) => { act({ type: 'collapse-group', groupId, collapsed }); renderer.render(model.buildRenderPlan(ws)); },
        onDragState: state => calls.push(['drag', state]), fit: () => calls.push(['fit']),
        requestFrame: fn => { frames.set(++nextFrame, fn); return nextFrame; }, cancelFrame: id => frames.delete(id)
    });
    return { act, host, nodes, buttons, document, calls, read: () => ws, render: () => renderer.render(model.buildRenderPlan(ws)),
        emit: (name, event) => [...events.get(name) || []].forEach(fn => fn(event)),
        flush: () => { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(fn => fn()); } };
}
test('nested renderer preserves panel/button references, independent selections and one gutter per adjacent pair', () => {
    const f = fixture(); f.render();
    const panels = Object.values(f.read().tabs).filter(tab => !model.isContainer(tab)).map(tab => f.document.getElementById(tab.id));
    const buttons = [...f.buttons.values()];
    f.act({ type: 'split-tab', tabId: 'tab-shell-1' });
    f.act({ type: 'split-tab', tabId: 'f1', direction: 'bottom' }); f.render();
    assert.equal(f.host.querySelectorAll('.layout-gutter').length, 2);
    assert.deepEqual(new Set(f.host.querySelectorAll('.layout-split').map(node => node.dataset.orientation)), new Set(['horizontal', 'vertical']));
    assert.deepEqual(f.host.querySelectorAll('.main-tab-pane').filter(panel => panel.classList.contains('active')).map(panel => panel.id).sort(), ['f1', 'tab-main', 'tab-shell-1']);
    f.render();
    assert.ok(panels.every(panel => f.document.getElementById(panel.id) === panel));
    assert.ok(buttons.every(button => f.host.querySelectorAll('.main-tab').includes(button)));
    f.act({ type: 'collapse-all' }); f.render();
    assert.equal(f.host.querySelectorAll('.layout-gutter').length, 0);
    assert.equal(f.host.querySelectorAll('.layout-stack').length, 1);
    assert.equal(f.host.querySelectorAll('.main-tab-pane').length, panels.length);
});
test('group anchor merge removes stale button but retains panels and hidden content local choice', () => {
    const f = fixture(true); f.render();
    const panel = f.document.getElementById('tab-main-b');
    f.act({ type: 'split-group', groupId: 'b' }); f.render();
    assert.equal(f.host.querySelectorAll('.serial-group-tab').length, 2);
    f.act({ type: 'merge', source: { tabId: 'b' } }); f.render();
    assert.equal(f.host.querySelectorAll('.serial-group-tab').length, 2);
    const sourceStack = model.locateTab(f.read(), 'b').stack;
    assert.equal(f.document.getElementById(sourceStack.id).querySelector('.pane-tabs-list').children.length, 4);
    assert.equal(f.document.getElementById('tab-main-b'), panel);
    const anchor = model.locateTab(f.read(), 'default').item;
    assert.equal(model.tree.stacks(anchor.content)[0].activeItemId, 'tab-main');
    const button = f.buttons.get(anchor.id), list = button.parentElement;
    list.emit('click', { target: button }); list.emit('contextmenu', { target: button });
    assert.deepEqual(f.calls.slice(-2).map(call => call[0]), ['activate', 'menu']);
    assert.equal(f.calls.at(-1)[2], anchor.id);
});
test('gutter coalesces moves, resizes only its pair, flushes on release and fits after drag state resets', () => {
    const f = fixture();
    f.act({ type: 'split-tab', tabId: 'tab-shell-1' }); f.act({ type: 'split-tab', tabId: 'f1' }); f.render();
    const root = f.read().layout.root, bar = f.host.querySelectorAll('.layout-gutter')[0];
    const unchanged = root.weights[2];
    bar.emit('pointerdown', { button: 0, clientX: 300, clientY: 0 });
    f.emit('pointermove', { clientX: 360 }); f.emit('pointermove', { clientX: 420 });
    assert.equal(f.calls.filter(call => call[0] === 'resize').length, 0);
    f.flush();
    assert.equal(f.calls.filter(call => call[0] === 'resize').length, 1);
    assert.equal(f.read().layout.root.weights[2], unchanged);
    f.emit('pointermove', { clientX: 390 }); f.emit('pointerup', {});
    assert.equal(f.calls.filter(call => call[0] === 'resize').length, 2);
    assert.deepEqual(f.calls.slice(-2), [['drag', false], ['fit']]);
    f.emit('pointermove', { clientX: 450 }); f.flush();
    assert.equal(f.calls.filter(call => call[0] === 'resize').length, 2);
});
test('destination-before-source moves retain the same mounted button and panel', () => {
    const f = fixture(); f.act({ type: 'split-tab', tabId: 'tab-shell-1', direction: 'right' }); f.render();
    const button = f.buttons.get('tab-shell-1'), panel = f.document.getElementById('tab-shell-1');
    f.act({ type: 'move', tabId: 'tab-shell-1', target: { nodeId: model.locateTab(f.read(), 'tab-main').stack.id } }); f.render();
    assert.ok(f.host.querySelectorAll('.main-tab').includes(button));
    assert.equal(f.host.querySelectorAll('.main-tab-pane').filter(item => item === panel).length, 1);
    assert.equal(f.host.querySelectorAll('.layout-stack').length, 1);
});
test('collapsed subRows keep the first restore button and all selected terminal panels', () => {
    const f = fixture(); f.act({ type: 'split-tab', tabId: 'f1' }); f.render();
    const button = f.host.querySelector('.layout-collapse');
    assert.ok(button); button.emit('click', {});
    assert.equal(f.host.querySelectorAll('.pane-tabs-header').filter(header => !header.hidden).length, 1);
    assert.equal(f.host.querySelectorAll('.main-tab-pane').filter(panel => panel.classList.contains('active')).length, 2);
    button.emit('click', {});
    assert.equal(f.host.querySelectorAll('.pane-tabs-header').filter(header => !header.hidden).length, 2);
});
