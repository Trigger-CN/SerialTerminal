'use strict';

// Reconcile the real nested geometry while retaining terminal panels and existing leaf buttons.
function createLayoutRenderer({ document, host, createPane, getButton, getGroupButton, onActivate, onMenu, onResize, onDragState, onCollapse, fit,
    requestFrame = callback => callback(), cancelFrame = () => {} }) {
    const nodes = new Map();
    const gutters = new Map();
    function attach(parent, ordered) {
        let cursor = parent.firstChild;
        ordered.forEach(child => {
            if (child !== cursor) parent.insertBefore(child, cursor);
            cursor = child.nextSibling;
        });
    }
    function ensure(node) {
        if (nodes.has(node.id)) return nodes.get(node.id);
        let entry;
        if (node.type === 'stack') {
            const element = createPane(node.groupId, node.id);
            element.dataset.layoutNodeId = node.id;
            element.classList.add('layout-stack');
            const header = element.querySelector('.pane-tabs-header');
            const list = element.querySelector('.pane-tabs-list');
            const content = element.querySelector('.pane-tabs-content');
            list.dataset.layoutNodeId = node.id;
            list.addEventListener('click', event => {
                if (event.target.closest('.main-tab-close')) return;
                const button = event.target.closest('[data-layout-item-id]');
                if (!button) return;
                event.preventDefault(); event.stopImmediatePropagation();
                onActivate(button.dataset.target || button.dataset.groupId, button.dataset.layoutItemId);
            }, true);
            list.addEventListener('contextmenu', event => {
                const button = event.target.closest('[data-layout-item-id]');
                if (!button) return;
                event.preventDefault(); event.stopImmediatePropagation();
                onMenu(button.dataset.target || button.dataset.groupId, button.dataset.layoutItemId, node.id);
            }, true);
            entry = { element, header, list, content };
        } else {
            const element = document.createElement('div');
            element.className = 'layout-split';
            element.id = node.id;
            element.dataset.layoutNodeId = node.id;
            entry = { element };
        }
        nodes.set(node.id, entry);
        return entry;
    }
    function gutter(node, index, parent) {
        const beforeId = node.children[index - 1].id;
        const afterId = node.children[index].id;
        const key = `${node.id}:${beforeId}:${afterId}`;
        let element = gutters.get(key);
        if (!element) {
            element = document.createElement('div');
            element.className = 'layout-gutter';
            element.dataset.splitNodeId = node.id;
            element.dataset.beforeId = beforeId;
            element.dataset.afterId = afterId;
            element.addEventListener('pointerdown', event => {
                if (event.button !== 0) return;
                event.preventDefault(); event.stopPropagation();
                const vertical = element.dataset.orientation === 'vertical';
                const before = nodes.get(beforeId).element;
                const after = nodes.get(afterId).element;
                const a = before.getBoundingClientRect(); const b = after.getBoundingClientRect();
                const start = vertical ? event.clientY : event.clientX;
                const size = vertical ? a.height : a.width;
                const pair = size + (vertical ? b.height : b.width);
                if (pair <= 0) return;
                let pending = null; let frame = null;
                const flush = () => {
                    frame = null;
                    if (pending === null) return;
                    const ratio = pending; pending = null;
                    onResize({ type: 'resize', splitNodeId: node.id, beforeId, afterId, ratio });
                };
                const move = next => {
                    const delta = (vertical ? next.clientY : next.clientX) - start;
                    pending = Math.max(0.08, Math.min(0.92, (size + delta) / pair));
                    if (frame === null) frame = requestFrame(flush);
                };
                const up = () => {
                    if (frame !== null) cancelFrame(frame);
                    flush();
                    document.removeEventListener('pointermove', move);
                    document.removeEventListener('pointerup', up);
                    document.removeEventListener('pointercancel', up);
                    host.classList.remove('resizing'); onDragState?.(false);
                    fit?.();
                };
                host.classList.add('resizing'); onDragState?.(true);
                document.addEventListener('pointermove', move);
                document.addEventListener('pointerup', up);
                document.addEventListener('pointercancel', up);
            });
            gutters.set(key, element);
        }
        element.dataset.orientation = node.orientation;
        return element;
    }
    function render(plan) {
        const wanted = new Set(); const wantedGutters = new Set(); const active = new Set(plan.panelIds);
        const buttons = new Set(); const lists = [];
        function visit(node, parent, weight = null, orientation = null, childCount = 0) {
            wanted.add(node.id);
            const entry = ensure(node); const element = entry.element;
            element.hidden = node.visible === false;
            element.style.minWidth = '0'; element.style.minHeight = '0';
            element.style.flex = weight === null ? '1 1 0' : `0 0 calc(${weight * 100}% - ${weight * (childCount - 1) * 6}px)`;
            if (element.parentElement !== parent) parent.appendChild(element);
            if (node.type === 'split') {
                element.dataset.orientation = node.orientation;
                const ordered = [];
                node.children.forEach((child, index) => {
                    if (index) {
                        const bar = gutter(node, index, element);
                        wantedGutters.add(`${node.id}:${node.children[index - 1].id}:${child.id}`);
                        ordered.push(bar);
                    }
                    ordered.push(visit(child, element, node.weights[index], node.orientation, node.children.length));
                });
                attach(element, ordered);
                return element;
            }
            element.dataset.groupId = node.groupId || '';
            entry.header.hidden = node.headerHidden === true;
            if (node.canCollapse && !entry.collapseButton) {
                const button = document.createElement('button');
                button.className = 'pane-action-btn layout-collapse';
                button.addEventListener('click', event => {
                    event.preventDefault(); event.stopPropagation();
                    onCollapse?.(button.dataset.groupId, button.dataset.collapsed !== 'true');
                });
                entry.header.appendChild(button); entry.collapseButton = button;
            }
            if (entry.collapseButton) {
                const button = entry.collapseButton;
                button.hidden = node.canCollapse !== true;
                button.dataset.groupId = node.collapseGroupId;
                button.dataset.collapsed = String(node.collapsed === true);
                button.textContent = node.collapsed ? '▾' : '▴';
                button.setAttribute('title', node.collapsed ? '展开其他标签栏' : '收起其他标签栏');
                button.setAttribute('aria-expanded', String(!node.collapsed));
            }
            entry.header.classList.toggle('group-tab-row', node.rootLevel && plan.containerCount > 1);
            entry.list.classList.toggle('serial-group-tab-list', node.rootLevel && plan.containerCount > 1);
            const orderedButtons = [];
            const contentNodes = [];
            node.members.forEach(member => {
                const button = member.content ? getGroupButton(member, node) : getButton(member.tabId);
                if (button) {
                    buttons.add(button);
                    button.dataset.layoutItemId = member.id;
                    button.dataset.paneId = node.id;
                    button.classList.toggle('active', member.active);
                    button.setAttribute('aria-selected', String(member.active));
                    if (button.parentElement !== entry.list) entry.list.appendChild(button);
                    orderedButtons.push(button);
                }
                if (member.content) {
                    const child = visit(member.content, entry.content);
                    child.hidden = !member.active;
                    contentNodes.push(child);
                } else {
                    const panel = document.getElementById(member.tabId);
                    if (panel && panel.parentElement !== entry.content) entry.content.appendChild(panel);
                    if (panel) contentNodes.push(panel);
                }
            });
            attach(entry.list, orderedButtons);
            attach(entry.content, contentNodes);
            lists.push(entry.list);
            return element;
        }
        const root = visit(plan.root, host);
        // Legacy shells remain parked until their panels/buttons have safely moved.
        Array.from(host.children).forEach(child => { child.hidden = child !== root; });
        document.querySelectorAll('.main-tab-pane').forEach(panel => { panel.classList.toggle('active', active.has(panel.id)); });
        document.querySelectorAll('.main-tab').forEach(button => {
            if (!buttons.has(button)) button.classList.remove('active');
        });
        for (const list of lists) Array.from(list.children).forEach(button => {
            if (button.dataset.layoutItemId && !buttons.has(button)) button.remove();
        });
        for (const [key, entry] of nodes) if (!wanted.has(key)) { entry.element.remove(); nodes.delete(key); }
        for (const [key, element] of gutters) if (!wantedGutters.has(key)) { element.remove(); gutters.delete(key); }
    }
    return { render };
}
module.exports = { createLayoutRenderer };
