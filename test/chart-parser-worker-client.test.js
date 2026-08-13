'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { ChartParserWorkerClient, discoverChartFieldsInWorker } = require('../chart-parser-worker-client');

class FakeWorker extends EventEmitter {
  static instances = [];
  constructor(_path, options) {
    super();
    this.options = options;
    FakeWorker.instances.push(this);
  }
  postMessage(message) { this.lastMessage = message; }
  terminate() { this.terminated = true; return Promise.resolve(); }
}

test('batches records and forwards parsed samples', async () => {
  FakeWorker.instances = [];
  const received = [];
  const client = new ChartParserWorkerClient({ config: {}, WorkerConstructor: FakeWorker, batchSize: 2, onSamples: samples => received.push(...samples) });
  client.push({ text: 'a=1', receivedAt: 1 });
  client.push({ text: 'a=2', receivedAt: 2 });
  const worker = FakeWorker.instances[0];
  assert.equal(worker.lastMessage.records.length, 1);
  worker.emit('message', { type: 'parse-result', id: worker.lastMessage.id, samples: [{ timestamp: 1, values: { a: 1 } }] });
  assert.equal(worker.lastMessage.records[0].text, 'a=2');
  worker.emit('message', { type: 'parse-result', id: worker.lastMessage.id, samples: [{ timestamp: 2, values: { a: 2 } }] });
  assert.equal(received.length, 2);
  await client.close();
});

test('drops excess queued records and recovers after a timeout', async () => {
  FakeWorker.instances = [];
  const stats = [];
  const errors = [];
  const client = new ChartParserWorkerClient({
    config: {}, WorkerConstructor: FakeWorker, timeoutMs: 10, batchSize: 1, maxQueue: 2,
    onStats: value => stats.push(value), onError: error => errors.push(error.message)
  });
  client.push({ text: 'a=1' });
  client.push({ text: 'a=2' });
  client.push({ text: 'a=3' });
  client.push({ text: 'a=4' });
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.ok(stats.some(item => item.dropped >= 2));
  assert.ok(errors.includes('Chart parser timed out'));
  assert.equal(FakeWorker.instances.length, 1);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(FakeWorker.instances.length, 2);
  await client.close();
});

test('discovers fields in a disposable worker', async () => {
  FakeWorker.instances = [];
  const promise = discoverChartFieldsInWorker('a=1', {}, { WorkerConstructor: FakeWorker });
  const worker = FakeWorker.instances[0];
  worker.emit('message', { type: 'discover-result', id: 1, fields: [{ key: 'a' }] });
  assert.deepEqual(await promise, [{ key: 'a' }]);
  assert.equal(worker.terminated, true);
});

test('reset discards in-flight and queued records before starting a fresh worker', async () => {
  FakeWorker.instances = [];
  const stats = [];
  const samples = [];
  const client = new ChartParserWorkerClient({
    config: {}, WorkerConstructor: FakeWorker, batchSize: 1,
    onStats: value => stats.push(value), onSamples: value => samples.push(...value)
  });
  client.push({ text: 'old=1' });
  client.push({ text: 'old=2' });
  const oldWorker = FakeWorker.instances[0];
  const oldId = oldWorker.lastMessage.id;
  client.reset();
  assert.equal(oldWorker.terminated, true);
  assert.equal(FakeWorker.instances.length, 2);
  assert.deepEqual(stats.at(-1), { queued: 0, dropped: 0 });
  oldWorker.emit('message', { type: 'parse-result', id: oldId, samples: [{ values: { old: 1 } }] });
  assert.equal(samples.length, 0);
  client.push({ text: 'new=1' });
  const newWorker = FakeWorker.instances[1];
  newWorker.emit('message', { type: 'parse-result', id: newWorker.lastMessage.id, samples: [{ values: { new: 1 } }] });
  assert.deepEqual(samples, [{ values: { new: 1 } }]);
  await client.close();
});

test('parses and converts values in a real worker thread', async () => {
  const fields = await discoverChartFieldsInWorker(
    '[FRAME_PERF] count=1 draw=11000us',
    { mode: 'key-value', marker: '[FRAME_PERF]', keyValueSeparator: '=' }
  );
  assert.deepEqual(fields.map(field => field.key), ['count', 'draw']);
  await new Promise((resolve, reject) => {
    const client = new ChartParserWorkerClient({
      config: { mode: 'key-value', marker: '[FRAME_PERF]', keyValueSeparator: '=', fields },
      onSamples: samples => {
        try {
          assert.equal(samples[0].values.draw, 11);
          assert.equal(samples[0].sourceSequence, 2);
          client.close();
          resolve();
        } catch (error) {
          client.close();
          reject(error);
        }
      },
      onError: reject
    });
    client.push({ text: '[FRAME_PERF] count=2 draw=11000us', receivedAt: 1000, sequence: 1 });
  });
});
