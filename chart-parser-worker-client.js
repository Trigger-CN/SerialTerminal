'use strict';

const path = require('node:path');
const { Worker: NodeWorker } = require('node:worker_threads');

const DEFAULT_WORKER_PATH = path.join(__dirname, 'chart-parser-worker.js');

class ChartParserWorkerClient {
  constructor({
    config,
    onSamples,
    onError,
    onStats,
    WorkerConstructor = NodeWorker,
    workerPath = DEFAULT_WORKER_PATH,
    timeoutMs = 500,
    batchSize = 500,
    maxQueue = 5000
  }) {
    this.config = config;
    this.onSamples = typeof onSamples === 'function' ? onSamples : null;
    this.onError = typeof onError === 'function' ? onError : null;
    this.onStats = typeof onStats === 'function' ? onStats : null;
    this.WorkerConstructor = WorkerConstructor;
    this.workerPath = workerPath;
    this.timeoutMs = Math.max(10, Number(timeoutMs) || 500);
    this.batchSize = Math.max(1, Number(batchSize) || 500);
    this.maxQueue = Math.max(this.batchSize, Number(maxQueue) || 5000);
    this.queue = [];
    this.inFlight = null;
    this.nextId = 1;
    this.dropped = 0;
    this.closed = false;
    this.restartTimer = null;
    this.restartAttempts = 0;
    this._startWorker();
  }

  push(record) {
    if (this.closed || !record) return;
    this.queue.push({
      text: String(record.text || ''),
      receivedAt: record.receivedAt,
      sequence: record.sequence
    });
    if (this.queue.length > this.maxQueue) {
      const removeCount = this.queue.length - this.maxQueue;
      this.queue.splice(0, removeCount);
      this.dropped += removeCount;
      this._reportStats();
    }
    this._pump();
  }

  _startWorker() {
    if (this.closed) return;
    const worker = new this.WorkerConstructor(this.workerPath, { workerData: { config: this.config } });
    this.worker = worker;
    worker.on('message', message => this._handleMessage(message));
    worker.on('error', error => this._recover(error));
    worker.on('exit', code => {
      if (!this.closed && worker === this.worker && code !== 0) this._recover(new Error(`Chart parser worker exited with code ${code}`));
    });
  }

  _pump() {
    if (this.closed || this.inFlight || !this.queue.length || !this.worker) return;
    const records = this.queue.splice(0, this.batchSize);
    const id = this.nextId++;
    const timer = setTimeout(() => this._handleTimeout(id), this.timeoutMs);
    this.inFlight = { id, records, timer };
    this.worker.postMessage({ type: 'parse', id, records });
  }

  _handleMessage(message) {
    if (!this.inFlight || message?.id !== this.inFlight.id) return;
    clearTimeout(this.inFlight.timer);
    this.inFlight = null;
    this.restartAttempts = 0;
    if (message.type === 'error') this.onError?.(new Error(message.message || 'Chart parser failed'));
    else if (message.type === 'parse-result') this.onSamples?.(message.samples || []);
    this._pump();
  }

  _handleTimeout(id) {
    if (!this.inFlight || this.inFlight.id !== id) return;
    const count = this.inFlight.records.length;
    clearTimeout(this.inFlight.timer);
    this.inFlight = null;
    this.dropped += count;
    this._reportStats();
    this._recover(new Error('Chart parser timed out'));
  }

  _recover(error) {
    if (this.closed) return;
    const worker = this.worker;
    this.worker = null;
    if (this.inFlight) {
      clearTimeout(this.inFlight.timer);
      this.dropped += this.inFlight.records.length;
      this.inFlight = null;
      this._reportStats();
    }
    worker?.removeAllListeners?.();
    Promise.resolve(worker?.terminate?.()).catch(() => {});
    this.onError?.(error);
    if (this.restartTimer) return;
    const delay = Math.min(5000, 100 * (2 ** this.restartAttempts++));
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.closed) return;
      try {
        this._startWorker();
        this._pump();
      } catch (startError) {
        this._recover(startError);
      }
    }, delay);
  }

  _reportStats() {
    this.onStats?.({ queued: this.queue.length, dropped: this.dropped });
  }

  reset() {
    if (this.closed) return;
    clearTimeout(this.restartTimer);
    this.restartTimer = null;
    this.restartAttempts = 0;
    const worker = this.worker;
    this.worker = null;
    if (this.inFlight) clearTimeout(this.inFlight.timer);
    this.inFlight = null;
    this.queue = [];
    this.dropped = 0;
    worker?.removeAllListeners?.();
    Promise.resolve(worker?.terminate?.()).catch(() => {});
    this._reportStats();
    this._startWorker();
  }

  close() {
    this.closed = true;
    clearTimeout(this.restartTimer);
    this.restartTimer = null;
    if (this.inFlight) clearTimeout(this.inFlight.timer);
    this.inFlight = null;
    this.queue = [];
    const worker = this.worker;
    this.worker = null;
    worker?.removeAllListeners?.();
    return worker?.terminate?.();
  }
}

function discoverChartFieldsInWorker(sampleLine, config, {
  WorkerConstructor = NodeWorker,
  workerPath = DEFAULT_WORKER_PATH,
  timeoutMs = 500
} = {}) {
  return new Promise((resolve, reject) => {
    const worker = new WorkerConstructor(workerPath);
    const id = 1;
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.removeAllListeners?.();
      Promise.resolve(worker.terminate?.()).catch(() => {});
      callback(value);
    };
    const timer = setTimeout(() => finish(reject, new Error('Chart sample parsing timed out')), Math.max(10, Number(timeoutMs) || 500));
    worker.on('message', message => {
      if (message?.id !== id) return;
      if (message.type === 'error') finish(reject, new Error(message.message || 'Chart sample parsing failed'));
      else if (message.type === 'discover-result') finish(resolve, message.fields || []);
    });
    worker.on('error', error => finish(reject, error));
    worker.postMessage({ type: 'discover', id, sampleLine: String(sampleLine || ''), config });
  });
}

module.exports = { ChartParserWorkerClient, discoverChartFieldsInWorker, DEFAULT_WORKER_PATH };
