'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');

test('main terminal tab uses only the renderer click binding', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const renderer = fs.readFileSync(path.join(root, 'renderer.js'), 'utf8');
  const mainTab = html.match(/<div class="main-tab active"[^>]*data-target="tab-main"[^>]*>/)?.[0] || '';

  assert.ok(mainTab, 'main terminal tab markup was not found');
  assert.doesNotMatch(mainTab, /\sonclick=/);
  assert.doesNotMatch(html, /function\s+switchMainTab\s*\(/);
  assert.equal((renderer.match(/mainTabButton\.addEventListener\('click'/g) || []).length, 1);
});

test('collapsed sidebar keeps tools scrollable and expand control outside the scroll area', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const styles = fs.readFileSync(path.join(root, 'style.css'), 'utf8');
  const toolbar = html.match(/<div class="sidebar-collapsed-toolbar"[\s\S]*?<\/div>\s*<!-- Persistent Header -->/)?.[0] || '';
  const scrollStart = toolbar.indexOf('class="sidebar-tool-scroll"');
  const scrollEnd = toolbar.lastIndexOf('</div>');
  const expandIndex = toolbar.indexOf('id="sidebar-expand-btn"');

  assert.ok(scrollStart >= 0, 'scrollable sidebar tool group was not found');
  assert.ok(expandIndex >= 0 && expandIndex < scrollStart, 'expand button must remain outside the scrollable tool group');
  assert.ok(scrollEnd > scrollStart);
  assert.match(styles, /\.sidebar-tool-scroll\s*\{[^}]*overflow-y:\s*auto;/s);
  assert.match(styles, /#sidebar-expand-btn\s*\{[^}]*flex-shrink:\s*0;/s);
});
