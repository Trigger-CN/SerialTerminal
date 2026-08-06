'use strict';

const { randomUUID } = require('crypto');

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEFAULT_ENDPOINT = 'https://trigger-cn.top/serialterminal/api/v1/activity';
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const RETRY_DELAYS_MS = [5 * 60 * 1000, 30 * 60 * 1000, 2 * 60 * 60 * 1000, 6 * 60 * 60 * 1000];

function createTelemetryReporter({
  getAppVersion,
  isReleaseBuild = () => false,
  onStateChange,
  logger,
  fetchImpl = global.fetch,
  endpoint = DEFAULT_ENDPOINT,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  random = Math.random,
  now = () => new Date()
}) {
  let config = { enabled: false, installationId: '', lastReportedDate: '' };
  let timer = null;
  let controller = null;
  let retryIndex = 0;
  let stopped = false;
  let configurationKey = '';

  function schedule(delay) {
    if (timer) clearTimer(timer);
    if (stopped || !config.enabled) return;
    timer = setTimer(run, delay);
    timer?.unref?.();
  }

  async function run() {
    timer = null;
    if (stopped || !config.enabled || controller) return;
    const today = now().toISOString().slice(0, 10);
    if (config.lastReportedDate === today) {
      schedule(CHECK_INTERVAL_MS);
      return;
    }

    controller = new AbortController();
    const timeout = setTimer(() => controller?.abort(), 3000);
    timeout?.unref?.();
    try {
      const response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': `SerialTerminal/${getAppVersion()}`
        },
        body: JSON.stringify({
          installationId: config.installationId,
          appVersion: getAppVersion(),
          platform: process.platform,
          arch: process.arch,
          schemaVersion: 1
        }),
        signal: controller.signal
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const result = await response.json();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(result.activityDate || '')) {
        throw new Error('Invalid activity date');
      }
      config.lastReportedDate = result.activityDate;
      configurationKey = JSON.stringify(config);
      retryIndex = 0;
      onStateChange({
        telemetryInstallationId: config.installationId,
        telemetryLastReportedDate: config.lastReportedDate
      });
      schedule(CHECK_INTERVAL_MS);
    } catch (error) {
      if (config.enabled && !stopped) {
        logger?.warn?.('Anonymous activity report failed:', error?.message || String(error));
        schedule(RETRY_DELAYS_MS[Math.min(retryIndex++, RETRY_DELAYS_MS.length - 1)]);
      }
    } finally {
      clearTimer(timeout);
      controller = null;
    }
  }

  function configure(next = {}) {
    const nextConfig = {
      enabled: next.telemetryEnabled === true && isReleaseBuild(),
      installationId: UUID_PATTERN.test(next.telemetryInstallationId || '')
        ? next.telemetryInstallationId
        : '',
      lastReportedDate: /^\d{4}-\d{2}-\d{2}$/.test(next.telemetryLastReportedDate || '')
        ? next.telemetryLastReportedDate
        : ''
    };
    const nextKey = JSON.stringify(nextConfig);
    if (!stopped && nextKey === configurationKey) return;
    config = nextConfig;
    configurationKey = nextKey;
    stopped = false;
    retryIndex = 0;
    if (timer) clearTimer(timer);
    timer = null;
    if (!config.enabled) {
      controller?.abort();
      return;
    }
    if (!config.installationId) {
      config.installationId = randomUUID();
      configurationKey = JSON.stringify(config);
      onStateChange({ telemetryInstallationId: config.installationId });
    }
    schedule(30000 + Math.floor(random() * 90001));
  }

  function stop() {
    stopped = true;
    if (timer) clearTimer(timer);
    timer = null;
    controller?.abort();
  }

  return { configure, stop, runNow: run };
}

module.exports = { createTelemetryReporter, UUID_PATTERN };
