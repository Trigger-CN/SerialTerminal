'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ChartView } = require('../chart-view');

class FakeResizeObserver {
  observe() {}
  disconnect() { this.disconnected = true; }
}

function installFakeDocument() {
  const previousDocument = global.document;
  global.document = element();
  return () => { global.document = previousDocument; };
}

class FakePlot {
  constructor(options, data) {
    this.options = options;
    this.data = data;
    this.scales = { x: { min: null, max: null } };
    FakePlot.instances.push(this);
  }
  setData(data) {
    this.data = data;
    const timestamps = data[0] || [];
    if (timestamps.length) {
      this.scales.x = { min: timestamps[0], max: timestamps[timestamps.length - 1] };
      this.options.hooks?.setScale?.forEach(hook => hook(this, 'x'));
    }
  }
  setScale(key, range) { this.scales[key] = { ...range }; }
  setSize(size) { this.size = size; }
  destroy() { this.destroyed = true; }
}
FakePlot.instances = [];

function element(width = 400, height = 200) {
  return {
    listeners: {},
    getBoundingClientRect: () => ({ width, height, left: 0 }),
    addEventListener(type, handler) { this.listeners[type] = handler; },
    removeEventListener(type) { delete this.listeners[type]; }
  };
}

function navigatorElement() {
  const windowElement = {
    hidden: true, style: {}, listeners: {}, attributes: {},
    addEventListener(type, handler) { this.listeners[type] = handler; },
    removeEventListener(type) { delete this.listeners[type]; },
    setAttribute(name, value) { this.attributes[name] = value; },
    querySelector(selector) { return this.children[selector]; }
  };
  windowElement.children = {
    '.chart-navigator-handle.start': element(),
    '.chart-navigator-handle.end': element()
  };
  return { querySelector: () => windowElement };
}

test('creates two plots, follows live data, and releases resources', () => {
  const previousObserver = global.ResizeObserver;
  const restoreDocument = installFakeDocument();
  global.ResizeObserver = FakeResizeObserver;
  FakePlot.instances = [];
  try {
    const view = new ChartView({
      uPlot: FakePlot,
      mainHost: element(600, 300),
      timelineHost: element(600, 82),
      navigator: navigatorElement(),
      fields: [{ key: 'a', label: 'A', color: '#4fc3f7' }],
      windowDurationMs: 1000
    });
    assert.equal(FakePlot.instances.length, 2);
    assert.equal(view.timelinePlot.options.axes[0].size, 28);
    assert.equal(view.timelinePlot.options.cursor.show, false);
    view.setData([[1, 2, 3], [10, 20, 30]]);
    assert.deepEqual(view.fullRange, [1000, 3000]);
    assert.deepEqual(view.viewRange, [2000, 3000]);
    view.setViewRange(1000, 2000, { following: false });
    view.setData([[1, 2, 3, 4], [10, 20, 30, 40]]);
    assert.deepEqual(view.viewRange, [1000, 2000]);
    view.returnToLive();
    assert.deepEqual(view.viewRange, [3000, 4000]);
    assert.equal(view.following, true);
    view.setData([[1, 2, 3, 4, 5], [10, 20, 30, 40, 50]]);
    assert.deepEqual(view.viewRange, [4000, 5000]);
    assert.equal(view.following, true);
    view.destroy();
    assert.ok(FakePlot.instances.every(plot => plot.destroyed));
    assert.equal(view.resizeObserver.disconnected, true);
  } finally {
    global.ResizeObserver = previousObserver;
    restoreDocument();
  }
});

test('applies automatic and fixed Y-axis ranges', () => {
  const previousObserver = global.ResizeObserver;
  const restoreDocument = installFakeDocument();
  global.ResizeObserver = FakeResizeObserver;
  try {
    const auto = new ChartView({ uPlot: FakePlot, mainHost: element(), timelineHost: element(), navigator: navigatorElement(), fields: [{ key: 'a' }], yAxis: { includeZero: true, margin: 0.1 } });
    assert.deepEqual(auto._yRange(10, 20), [-2, 22]);
    auto.destroy();
    const fixed = new ChartView({ uPlot: FakePlot, mainHost: element(), timelineHost: element(), navigator: navigatorElement(), fields: [{ key: 'a' }], yAxis: { mode: 'fixed', min: -5, max: 50 } });
    assert.deepEqual(fixed._yRange(10, 20), [-5, 50]);
    fixed.destroy();
  } finally {
    global.ResizeObserver = previousObserver;
    restoreDocument();
  }
});

test('pans, zooms, and returns to live through public viewport controls', () => {
  const previousObserver = global.ResizeObserver;
  const restoreDocument = installFakeDocument();
  global.ResizeObserver = FakeResizeObserver;
  try {
    const mainHost = element();
    const timelineHost = element();
    const navigator = navigatorElement();
    const view = new ChartView({ uPlot: FakePlot, mainHost, timelineHost, navigator, fields: [{ key: 'a' }], windowDurationMs: 2000 });
    view.setData([[1, 2, 3, 4, 5], [1, 2, 3, 4, 5]]);
    view.panView(-1000);
    assert.deepEqual(view.viewRange, [2000, 4000]);
    view.zoomView(3000, 0.5);
    assert.deepEqual(view.viewRange, [2500, 3500]);
    timelineHost.listeners.dblclick();
    assert.deepEqual(view.viewRange, [4000, 5000]);
    assert.equal(navigator.querySelector().attributes['aria-valuemax'], '5000');
    view.destroy();
    assert.equal(mainHost.listeners.wheel, undefined);
  } finally {
    global.ResizeObserver = previousObserver;
    restoreDocument();
  }
});

test('uses overview data when the viewport extends beyond retained raw samples', () => {
  const previousObserver = global.ResizeObserver;
  const restoreDocument = installFakeDocument();
  global.ResizeObserver = FakeResizeObserver;
  FakePlot.instances = [];
  const modes = [];
  try {
    const view = new ChartView({
      uPlot: FakePlot,
      mainHost: element(), timelineHost: element(), navigator: navigatorElement(),
      fields: [{ key: 'a' }], windowDurationMs: 1000,
      onDataModeChange: summary => modes.push(summary)
    });
    const raw = [[3, 4], [30, 40]];
    const overview = [[1, 2, 3, 4], [10, 20, 30, 40]];
    view.setData(raw, overview);
    assert.equal(view.mainPlot.data, raw);
    view.setViewRange(1000, 2000, { following: false });
    assert.equal(view.mainPlot.data, overview);
    assert.equal(modes.at(-1), true);
    view.setViewRange(3000, 4000, { following: false });
    assert.equal(view.mainPlot.data, raw);
    assert.equal(modes.at(-1), false);
    view.destroy();
  } finally {
    global.ResizeObserver = previousObserver;
    restoreDocument();
  }
});

test('ignores delayed internal scale hooks after returning to live', () => {
  const previousObserver = global.ResizeObserver;
  const restoreDocument = installFakeDocument();
  global.ResizeObserver = FakeResizeObserver;
  try {
    const view = new ChartView({ uPlot: FakePlot, mainHost: element(), timelineHost: element(), navigator: navigatorElement(), fields: [{ key: 'a' }], windowDurationMs: 1000 });
    view.setData([[1, 2, 3], [10, 20, 30]]);
    view.setViewRange(1000, 2000, { following: false });
    view.returnToLive();
    view.mainPlot.scales.x = { min: 1, max: 2 };
    view._handleMainScale('x');
    assert.equal(view.following, true);
    assert.deepEqual(view.viewRange, [2000, 3000]);
    view.destroy();
  } finally {
    global.ResizeObserver = previousObserver;
    restoreDocument();
  }
});

test('leaves live mode only for an explicit main plot drag', () => {
  const previousObserver = global.ResizeObserver;
  const restoreDocument = installFakeDocument();
  global.ResizeObserver = FakeResizeObserver;
  try {
    const mainHost = element();
    const view = new ChartView({ uPlot: FakePlot, mainHost, timelineHost: element(), navigator: navigatorElement(), fields: [{ key: 'a' }], windowDurationMs: 1000 });
    view.setData([[1, 2, 3], [10, 20, 30]]);
    mainHost.listeners.pointerdown();
    global.document.listeners.pointermove();
    view.mainPlot.scales.x = { min: 1, max: 2 };
    view._handleMainScale('x');
    assert.equal(view.following, false);
    assert.deepEqual(view.viewRange, [1000, 2000]);
    view.destroy();
  } finally {
    global.ResizeObserver = previousObserver;
    restoreDocument();
  }
});

test('return to live enables following for a single-point range', () => {
  const previousObserver = global.ResizeObserver;
  const restoreDocument = installFakeDocument();
  global.ResizeObserver = FakeResizeObserver;
  try {
    const view = new ChartView({ uPlot: FakePlot, mainHost: element(), timelineHost: element(), navigator: navigatorElement(), fields: [{ key: 'a' }] });
    view.setData([[1], [10]]);
    view.setFollowing(false);
    view.returnToLive();
    assert.equal(view.following, true);
    view.setData([[1, 2], [10, 20]]);
    assert.equal(view.following, true);
    assert.deepEqual(view.viewRange, [1000, 2000]);
    view.destroy();
  } finally {
    global.ResizeObserver = previousObserver;
    restoreDocument();
  }
});
