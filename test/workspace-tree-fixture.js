'use strict';
const assert = require('node:assert/strict');
const model = require('../src/workspace/tab-model');
const codec = require('../src/workspace/workspace-layout-state');
const { importWorkspace } = require('../src/workspace/tabs-workspace-projection');
function fixture(multiple = false) {
    return importWorkspace({ groups: [{ id: 'default' }, ...(multiple ? [{ id: 'b' }, { id: 'c' }] : [])],
        filterTabs: { default: [{ id: 'f1' }, { id: 'f2' }], c: [{ id: 'fc' }] },
        shellTabs: [{ id: 'tab-shell-1' }, { id: 'tab-shell-2' }], focusedTabId: 'tab-main' });
}
function act(ws, action) {
    const result = model.applyWorkspaceAction(ws, action);
    assert.equal(result.ok, true, result.reason);
    assert.deepEqual(model.validateLayout(result.workspace), []);
    return result.workspace;
}
function regions(ws) {
    const result = {};
    function visit(node, rect) {
        if (node.type === 'split') {
            let offset = 0;
            node.children.forEach((child, i) => {
                const [x, y, width, height] = rect, weight = node.weights[i];
                visit(child, node.orientation === 'vertical' ? [x, y + height * offset, width, height * weight]
                    : [x + width * offset, y, width * weight, height]);
                offset += weight;
            });
        } else for (const item of node.items) {
            if (item.content) visit(item.content, rect); else result[item.tabId] = rect;
        }
    }
    visit(ws.layout.root, [0, 0, 1, 1]);
    return result;
}
function resize(ws, split = ws.layout.root, ratio = 0.6) {
    return act(ws, { type: 'resize', splitNodeId: split.id, beforeId: split.children[0].id, afterId: split.children[1].id, ratio });
}
function roundtrip(ws) {
    const saved = codec.serializeWorkspaceLayout(ws), restored = codec.restoreWorkspaceLayout(ws, saved);
    assert.deepEqual(codec.serializeWorkspaceLayout(restored), saved);
    assert.deepEqual(regions(restored), regions(ws));
    return restored;
}
module.exports = { model, codec, fixture, act, regions, resize, roundtrip };
