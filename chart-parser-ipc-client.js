'use strict';

const { ipcRenderer } = require('electron');

let nextClientId = 1;

class ChartParserIpcClient {
  constructor({ config, onSamples, onError, onStats }) {
    this.clientId = `chart-parser-${nextClientId++}`;
    this.onSamples = typeof onSamples === 'function' ? onSamples : null;
    this.onError = typeof onError === 'function' ? onError : null;
    this.onStats = typeof onStats === 'function' ? onStats : null;
    this.closed = false;
    this._handleResult = (_event, message) => {
      if (message?.clientId !== this.clientId || this.closed) return;
      if (message.type === 'samples') this.onSamples?.(message.samples || []);
      else if (message.type === 'stats') this.onStats?.(message.stats || { queued: 0, dropped: 0 });
      else if (message.type === 'error') this.onError?.(new Error(message.message || 'Chart parser failed'));
    };
    ipcRenderer.on('chart-parser-result', this._handleResult);
    ipcRenderer.send('chart-parser-start', { clientId: this.clientId, config });
  }

  push(record) {
    if (!this.closed) ipcRenderer.send('chart-parser-push', { clientId: this.clientId, record });
  }

  reset() {
    if (!this.closed) ipcRenderer.send('chart-parser-reset', { clientId: this.clientId });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    ipcRenderer.removeListener('chart-parser-result', this._handleResult);
    ipcRenderer.send('chart-parser-close', { clientId: this.clientId });
  }
}

function discoverChartFieldsInWorker(sampleLine, config) {
  return ipcRenderer.invoke('chart-parser-discover', { sampleLine, config });
}

module.exports = { ChartParserIpcClient, discoverChartFieldsInWorker };
