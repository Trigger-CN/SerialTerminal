'use strict';

class ChartView {
  constructor({ uPlot, mainHost, timelineHost, navigator, fields, windowDurationMs = 60000, yAxis = {}, onFollowChange = null, onDataModeChange = null, onViewRangeChange = null }) {
    this.uPlot = uPlot;
    this.mainHost = mainHost;
    this.timelineHost = timelineHost;
    this.navigator = navigator;
    this.fields = fields.filter(field => field.role !== 'sequence');
    this.windowDurationMs = Math.max(1000, Number(windowDurationMs) || 60000);
    this.minWindowDurationMs = 1000;
    this.following = true;
    this.onFollowChange = onFollowChange;
    this.onDataModeChange = onDataModeChange;
    this.onViewRangeChange = onViewRangeChange;
    this.yAxis = {
      mode: yAxis.mode === 'fixed' ? 'fixed' : 'auto',
      min: Number(yAxis.min),
      max: Number(yAxis.max),
      includeZero: yAxis.includeZero === true,
      margin: Math.max(0, Math.min(1, Number.isFinite(Number(yAxis.margin)) ? Number(yAxis.margin) : 0.08))
    };
    this.summaryHistory = false;
    this.data = [[], ...this.fields.map(() => [])];
    this.overviewData = this.data;
    this.fullRange = null;
    this.viewRange = null;
    this.syncingScale = false;
    this.listeners = [];
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(mainHost);
    this.resizeObserver.observe(timelineHost);
    this._createPlots();
    this._bindNavigator();
  }

  _series() {
    return [{ label: 'Time' }, ...this.fields.map(field => ({
      label: field.label || field.key,
      stroke: field.color,
      width: 1.5,
      show: field.visible !== false,
      value: (_plot, value) => value == null ? '-' : `${Number(value).toFixed(field.precision ?? 2)}${field.displayUnit ? ` ${field.displayUnit}` : ''}`
    }))];
  }

  _createPlots() {
    const base = {
      width: 300,
      height: 200,
      tzDate: timestamp => new Date(timestamp * 1000),
      series: this._series(),
      scales: { x: { time: true }, y: { range: (_plot, min, max) => this._yRange(min, max) } },
      axes: [
        { stroke: '#8d99a8', grid: { stroke: '#26313d', width: 1 } },
        { stroke: '#8d99a8', grid: { stroke: '#26313d', width: 1 } }
      ]
    };
    this.mainPlot = new this.uPlot({
      ...base,
      cursor: { drag: { x: true, y: false, setScale: true } },
      hooks: { setScale: [(_plot, key) => this._handleMainScale(key)] }
    }, this.data, this.mainHost);
    this.timelinePlot = new this.uPlot({
      ...base,
      height: 82,
      cursor: { show: false },
      legend: { show: false },
      axes: [{ stroke: '#718093', grid: { show: false }, size: 28 }, { show: false }]
    }, this.data, this.timelineHost);
    this.resize();
  }

  _yRange(min, max) {
    if (this.yAxis.mode === 'fixed' && Number.isFinite(this.yAxis.min) && Number.isFinite(this.yAxis.max) && this.yAxis.min < this.yAxis.max) {
      return [this.yAxis.min, this.yAxis.max];
    }
    if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 1];
    if (this.yAxis.includeZero) {
      min = Math.min(0, min);
      max = Math.max(0, max);
    }
    const span = Math.max(Number.EPSILON, max - min || Math.abs(max) || 1);
    return [min - span * this.yAxis.margin, max + span * this.yAxis.margin];
  }

  _handleMainScale(key) {
    if (key !== 'x' || this.syncingScale || !this.fullRange) return;
    const { min, max } = this.mainPlot.scales.x;
    if (!Number.isFinite(min) || !Number.isFinite(max)) return;
    this.setViewRange(min * 1000, max * 1000, { following: false, updatePlot: false });
  }

  _bindNavigator() {
    const listen = (target, type, handler, options) => {
      target.addEventListener(type, handler, options);
      this.listeners.push(() => target.removeEventListener(type, handler, options));
    };
    const startDrag = (event, mode) => {
      if (!this.fullRange || !this.viewRange) return;
      event.preventDefault();
      const rect = this.timelineHost.getBoundingClientRect();
      const initialX = event.clientX;
      const initialRange = [...this.viewRange];
      const durationPerPixel = (this.fullRange[1] - this.fullRange[0]) / Math.max(1, rect.width);
      const move = moveEvent => {
        const delta = (moveEvent.clientX - initialX) * durationPerPixel;
        let [start, end] = initialRange;
        if (mode === 'move') {
          start += delta;
          end += delta;
          if (start < this.fullRange[0]) { end += this.fullRange[0] - start; start = this.fullRange[0]; }
          if (end > this.fullRange[1]) { start -= end - this.fullRange[1]; end = this.fullRange[1]; }
        } else if (mode === 'start') {
          start = Math.min(end - this.minWindowDurationMs, Math.max(this.fullRange[0], start + delta));
        } else {
          end = Math.max(start + this.minWindowDurationMs, Math.min(this.fullRange[1], end + delta));
        }
        this.setViewRange(start, end, { following: false });
      };
      const stop = () => {
        document.removeEventListener('pointermove', move);
        document.removeEventListener('pointerup', stop);
        document.removeEventListener('pointercancel', stop);
      };
      document.addEventListener('pointermove', move);
      document.addEventListener('pointerup', stop);
      document.addEventListener('pointercancel', stop);
    };
    const windowElement = this.navigator.querySelector('.chart-navigator-window');
    listen(windowElement, 'pointerdown', event => {
      if (event.target.closest('.chart-navigator-handle')) return;
      startDrag(event, 'move');
    });
    listen(this.navigator.querySelector('.chart-navigator-handle.start'), 'pointerdown', event => startDrag(event, 'start'));
    listen(this.navigator.querySelector('.chart-navigator-handle.end'), 'pointerdown', event => startDrag(event, 'end'));
    listen(this.timelineHost, 'click', event => {
      if (!this.fullRange || !this.viewRange || event.target.closest?.('.chart-navigator-window')) return;
      const rect = this.timelineHost.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / Math.max(1, rect.width)));
      const center = this.fullRange[0] + ratio * (this.fullRange[1] - this.fullRange[0]);
      const duration = this.viewRange[1] - this.viewRange[0];
      this.setViewRange(center - duration / 2, center + duration / 2, { following: false });
    });
    listen(this.timelineHost, 'dblclick', () => this.returnToLive());
    listen(this.timelineHost, 'wheel', event => {
      if (!event.shiftKey || !this.fullRange || !this.viewRange) return;
      event.preventDefault();
      const rect = this.timelineHost.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / Math.max(1, rect.width)));
      this.zoomView(this.fullRange[0] + ratio * (this.fullRange[1] - this.fullRange[0]), event.deltaY > 0 ? 1.2 : 0.8);
    }, { passive: false });
    listen(this.mainHost, 'wheel', event => {
      if (!this.viewRange) return;
      event.preventDefault();
      const rect = this.mainHost.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / Math.max(1, rect.width)));
      const anchor = this.viewRange[0] + ratio * (this.viewRange[1] - this.viewRange[0]);
      this.zoomView(anchor, event.deltaY > 0 ? 1.2 : 0.8);
    }, { passive: false });
    listen(windowElement, 'keydown', event => {
      const duration = this.viewRange ? this.viewRange[1] - this.viewRange[0] : 0;
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault();
        this.panView((event.key === 'ArrowLeft' ? -1 : 1) * duration * 0.1);
      } else if (event.key === '+' || event.key === '=') {
        event.preventDefault();
        this.zoomView((this.viewRange[0] + this.viewRange[1]) / 2, 0.8);
      } else if (event.key === '-') {
        event.preventDefault();
        this.zoomView((this.viewRange[0] + this.viewRange[1]) / 2, 1.2);
      } else if (event.key === 'End') {
        event.preventDefault();
        this.returnToLive();
      }
    });
  }

  panView(deltaMs) {
    if (!this.viewRange) return;
    this.setViewRange(this.viewRange[0] + deltaMs, this.viewRange[1] + deltaMs, { following: false });
  }

  zoomView(anchorTime, scale) {
    if (!this.fullRange || !this.viewRange) return;
    const fullDuration = this.fullRange[1] - this.fullRange[0];
    const duration = Math.max(this.minWindowDurationMs, Math.min(fullDuration, (this.viewRange[1] - this.viewRange[0]) * scale));
    const ratio = (anchorTime - this.viewRange[0]) / Math.max(1, this.viewRange[1] - this.viewRange[0]);
    let start = anchorTime - duration * ratio;
    let end = start + duration;
    if (start < this.fullRange[0]) { end += this.fullRange[0] - start; start = this.fullRange[0]; }
    if (end > this.fullRange[1]) { start -= end - this.fullRange[1]; end = this.fullRange[1]; }
    this.setViewRange(start, end, { following: false });
  }

  setData(data, overviewData = data) {
    this.data = data;
    this.overviewData = overviewData;
    const timestamps = overviewData[0] || [];
    if (!timestamps.length) {
      this.fullRange = null;
      this.viewRange = null;
      this._setMainData(false);
      this.timelinePlot.setData(overviewData);
      this._renderNavigator();
      return;
    }
    this.fullRange = [timestamps[0] * 1000, timestamps[timestamps.length - 1] * 1000];
    if (!this.viewRange) {
      const end = this.fullRange[1];
      this.viewRange = [Math.max(this.fullRange[0], end - this.windowDurationMs), end];
    } else if (this.following) {
      const duration = Math.max(this.minWindowDurationMs, this.viewRange[1] - this.viewRange[0]);
      this.viewRange = [Math.max(this.fullRange[0], this.fullRange[1] - duration), this.fullRange[1]];
    } else {
      this.viewRange[0] = Math.max(this.fullRange[0], this.viewRange[0]);
      this.viewRange[1] = Math.min(this.fullRange[1], this.viewRange[1]);
    }
    this._updateMainData();
    this.timelinePlot.setData(overviewData, false);
    this.syncingScale = true;
    this.timelinePlot.setScale('x', { min: this.fullRange[0] / 1000, max: this.fullRange[1] / 1000 });
    this.mainPlot.setScale('x', { min: this.viewRange[0] / 1000, max: this.viewRange[1] / 1000 });
    this.syncingScale = false;
    this._renderNavigator();
    this.onViewRangeChange?.(this.viewRange, this.summaryHistory);
  }

  setViewRange(start, end, { following = false, updatePlot = true } = {}) {
    if (!this.fullRange) return;
    const fullDuration = this.fullRange[1] - this.fullRange[0];
    if (fullDuration <= 0) {
      this.viewRange = [...this.fullRange];
      return;
    }
    start = Math.max(this.fullRange[0], Number(start));
    end = Math.min(this.fullRange[1], Number(end));
    if (end - start < Math.min(this.minWindowDurationMs, fullDuration)) return;
    this.viewRange = [start, end];
    this.setFollowing(following);
    this._updateMainData();
    if (updatePlot) {
      this.syncingScale = true;
      this.mainPlot.setScale('x', { min: start / 1000, max: end / 1000 });
      this.syncingScale = false;
    }
    this._renderNavigator();
    this.onViewRangeChange?.(this.viewRange, this.summaryHistory);
  }

  returnToLive() {
    if (!this.fullRange) return;
    const duration = this.viewRange ? this.viewRange[1] - this.viewRange[0] : this.windowDurationMs;
    this.setViewRange(Math.max(this.fullRange[0], this.fullRange[1] - duration), this.fullRange[1], { following: true });
  }

  setFollowing(following) {
    if (this.following === following) return;
    this.following = following;
    this.onFollowChange?.(following);
  }

  _updateMainData() {
    const rawTimestamps = this.data[0] || [];
    const useSummary = Boolean(this.viewRange && this.overviewData?.[0]?.length && (
      !rawTimestamps.length ||
      this.viewRange[0] < rawTimestamps[0] * 1000 ||
      this.viewRange[1] > rawTimestamps[rawTimestamps.length - 1] * 1000
    ));
    this._setMainData(useSummary);
  }

  _setMainData(useSummary) {
    this.mainPlot.setData(useSummary ? this.overviewData : this.data, false);
    if (this.summaryHistory === useSummary) return;
    this.summaryHistory = useSummary;
    this.onDataModeChange?.(useSummary);
    this.onViewRangeChange?.(this.viewRange, useSummary);
  }

  _renderNavigator() {
    const windowElement = this.navigator.querySelector('.chart-navigator-window');
    if (!this.fullRange || !this.viewRange || this.fullRange[1] <= this.fullRange[0]) {
      windowElement.hidden = true;
      return;
    }
    windowElement.hidden = false;
    const duration = this.fullRange[1] - this.fullRange[0];
    const left = (this.viewRange[0] - this.fullRange[0]) / duration * 100;
    const width = (this.viewRange[1] - this.viewRange[0]) / duration * 100;
    windowElement.style.left = `${left}%`;
    windowElement.style.width = `${Math.max(1, width)}%`;
    windowElement.setAttribute('aria-valuemin', String(Math.round(this.fullRange[0])));
    windowElement.setAttribute('aria-valuemax', String(Math.round(this.fullRange[1])));
    windowElement.setAttribute('aria-valuenow', String(Math.round((this.viewRange[0] + this.viewRange[1]) / 2)));
    windowElement.setAttribute('aria-valuetext', `${new Date(this.viewRange[0]).toLocaleTimeString()} - ${new Date(this.viewRange[1]).toLocaleTimeString()}`);
  }

  resize() {
    const mainRect = this.mainHost.getBoundingClientRect();
    const timelineRect = this.timelineHost.getBoundingClientRect();
    if (mainRect.width > 0 && mainRect.height > 0) this.mainPlot.setSize({ width: Math.floor(mainRect.width), height: Math.floor(mainRect.height) });
    if (timelineRect.width > 0 && timelineRect.height > 0) this.timelinePlot.setSize({ width: Math.floor(timelineRect.width), height: Math.floor(timelineRect.height) });
  }

  destroy() {
    this.listeners.splice(0).forEach(remove => remove());
    this.resizeObserver.disconnect();
    this.mainPlot.destroy();
    this.timelinePlot.destroy();
  }
}

module.exports = { ChartView };
