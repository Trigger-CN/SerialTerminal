'use strict';

class ChartDataModel {
  constructor({ fields = [], maxPoints = 200000, maxDurationMs = 30 * 60 * 1000, maxOverviewBuckets = 2000 } = {}) {
    this.fields = fields.filter(field => field?.key && field.role !== 'sequence').map(field => ({ ...field }));
    this.maxPoints = Math.max(100, Number(maxPoints) || 200000);
    this.maxDurationMs = Math.max(1000, Number(maxDurationMs) || 30 * 60 * 1000);
    this.maxOverviewBuckets = Math.max(100, Number(maxOverviewBuckets) || 2000);
    this.clear();
  }

  append(sample) {
    if (!sample || !Number.isFinite(sample.timestamp)) return false;
    const previous = this.samples[this.samples.length - 1];
    const originalTimestamp = sample.timestamp;
    const timestamp = previous && originalTimestamp <= previous.timestamp ? previous.timestamp + 0.001 : originalTimestamp;
    const values = {};
    this.fields.forEach(field => {
      const value = sample.values?.[field.key];
      values[field.key] = Number.isFinite(value) ? value : null;
    });
    this.samples.push({ timestamp, originalTimestamp, sequence: sample.sequence ?? null, values });
    this._appendOverview(timestamp, values);
    this._trim(timestamp);
    return true;
  }

  _appendOverview(timestamp, values) {
    const series = {};
    this.fields.forEach(field => {
      const value = values[field.key];
      series[field.key] = Number.isFinite(value)
        ? { first: value, last: value, min: value, max: value, sum: value, count: 1, minTime: timestamp, maxTime: timestamp }
        : { first: null, last: null, min: null, max: null, sum: 0, count: 0, minTime: timestamp, maxTime: timestamp };
    });
    this.overviewBuckets.push({ startTime: timestamp, endTime: timestamp, series });
    if (this.overviewBuckets.length > this.maxOverviewBuckets) this._compactOverview();
  }

  _compactOverview() {
    const compacted = [];
    for (let index = 0; index < this.overviewBuckets.length; index += 2) {
      const first = this.overviewBuckets[index];
      const second = this.overviewBuckets[index + 1];
      if (!second) {
        compacted.push(first);
        continue;
      }
      const series = {};
      this.fields.forEach(field => {
        const a = first.series[field.key];
        const b = second.series[field.key];
        const finite = [a, b].filter(item => Number.isFinite(item.min));
        if (!finite.length) {
          series[field.key] = { first: null, last: null, min: null, max: null, sum: 0, count: 0, minTime: first.startTime, maxTime: second.endTime };
          return;
        }
        const minSource = finite.reduce((lowest, item) => item.min < lowest.min ? item : lowest);
        const maxSource = finite.reduce((highest, item) => item.max > highest.max ? item : highest);
        series[field.key] = {
          first: Number.isFinite(a.first) ? a.first : b.first,
          last: Number.isFinite(b.last) ? b.last : a.last,
          min: minSource.min,
          max: maxSource.max,
          sum: (a.sum || 0) + (b.sum || 0),
          count: (a.count || 0) + (b.count || 0),
          minTime: minSource.minTime,
          maxTime: maxSource.maxTime
        };
      });
      compacted.push({ startTime: first.startTime, endTime: second.endTime, series });
    }
    this.overviewBuckets = compacted;
  }

  _trim(latestTimestamp) {
    const minimumTimestamp = latestTimestamp - this.maxDurationMs;
    let removeCount = Math.max(0, this.samples.length - this.maxPoints);
    while (removeCount < this.samples.length && this.samples[removeCount].timestamp < minimumTimestamp) removeCount++;
    if (removeCount) this.samples.splice(0, removeCount);
  }

  query(start = -Infinity, end = Infinity) {
    return this.samples.filter(sample => sample.timestamp >= start && sample.timestamp <= end);
  }

  toAlignedData(start = -Infinity, end = Infinity) {
    const samples = this.query(start, end);
    return [
      samples.map(sample => sample.timestamp / 1000),
      ...this.fields.map(field => samples.map(sample => sample.values[field.key]))
    ];
  }

  toOverviewAlignedData(start = -Infinity, end = Infinity) {
    const points = [];
    this.overviewBuckets.forEach(bucket => {
      const times = new Set([bucket.startTime, bucket.endTime]);
      this.fields.forEach(field => {
        const summary = bucket.series[field.key];
        if (Number.isFinite(summary.min)) {
          times.add(summary.minTime);
          times.add(summary.maxTime);
        }
      });
      [...times].sort((a, b) => a - b).forEach(timestamp => {
        const values = {};
        this.fields.forEach(field => {
          const summary = bucket.series[field.key];
          if (!Number.isFinite(summary.min)) values[field.key] = null;
          else if (timestamp === summary.minTime) values[field.key] = summary.min;
          else if (timestamp === summary.maxTime) values[field.key] = summary.max;
          else if (timestamp === bucket.startTime) values[field.key] = summary.first;
          else if (timestamp === bucket.endTime) values[field.key] = summary.last;
          else values[field.key] = null;
        });
        points.push({ timestamp, values });
      });
    });
    points.sort((a, b) => a.timestamp - b.timestamp);
    const unique = [];
    points.forEach(point => {
      const previous = unique[unique.length - 1];
      if (!previous || previous.timestamp !== point.timestamp) {
        unique.push(point);
        return;
      }
      this.fields.forEach(field => {
        if (Number.isFinite(point.values[field.key])) previous.values[field.key] = point.values[field.key];
      });
    });
    const selected = unique.filter(point => point.timestamp >= start && point.timestamp <= end);
    return [
      selected.map(point => point.timestamp / 1000),
      ...this.fields.map(field => selected.map(point => point.values[field.key]))
    ];
  }

  stats(key, start = -Infinity, end = Infinity) {
    const values = this.query(start, end).map(sample => sample.values[key]).filter(Number.isFinite);
    if (!values.length) return null;
    const sum = values.reduce((total, value) => total + value, 0);
    return { current: values[values.length - 1], min: Math.min(...values), max: Math.max(...values), average: sum / values.length, count: values.length };
  }

  overviewStats(key, start = -Infinity, end = Infinity) {
    const summaries = this.overviewBuckets
      .filter(bucket => bucket.endTime >= start && bucket.startTime <= end)
      .map(bucket => bucket.series[key])
      .filter(summary => summary?.count > 0);
    if (!summaries.length) return null;
    const count = summaries.reduce((total, summary) => total + summary.count, 0);
    const sum = summaries.reduce((total, summary) => total + summary.sum, 0);
    return {
      current: summaries[summaries.length - 1].last,
      min: Math.min(...summaries.map(summary => summary.min)),
      max: Math.max(...summaries.map(summary => summary.max)),
      average: sum / count,
      count,
      estimated: true
    };
  }

  getRange() {
    if (!this.overviewBuckets.length) return null;
    return [this.overviewBuckets[0].startTime, this.overviewBuckets[this.overviewBuckets.length - 1].endTime];
  }

  clear() {
    this.samples = [];
    this.overviewBuckets = [];
  }
}

module.exports = { ChartDataModel };
