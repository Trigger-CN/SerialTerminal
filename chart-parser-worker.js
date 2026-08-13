'use strict';

const { parentPort, workerData } = require('node:worker_threads');
const { createChartParser, discoverChartFields } = require('./chart-parser');

let parser = null;

function getParser() {
  if (!parser) parser = createChartParser(workerData?.config || {});
  return parser;
}

parentPort.on('message', message => {
  try {
    if (message.type === 'discover') {
      const fields = discoverChartFields(message.sampleLine, message.config);
      parentPort.postMessage({ type: 'discover-result', id: message.id, fields });
      return;
    }
    if (message.type !== 'parse') return;
    const activeParser = getParser();
    const samples = [];
    for (const record of message.records || []) {
      const sample = activeParser.parse(record.text, record);
      if (sample) samples.push(sample);
    }
    parentPort.postMessage({ type: 'parse-result', id: message.id, samples });
  } catch (error) {
    parentPort.postMessage({
      type: 'error',
      id: message.id,
      message: error?.message || String(error)
    });
  }
});
