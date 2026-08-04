'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createTelemetryReporter } = require('../telemetry-reporter');

const installationId = '9284747a-85cc-4e0a-92b2-6d577442b27e';

function createHarness(fetchImpl) {
  const timers = new Set();
  const stateChanges = [];
  const reporter = createTelemetryReporter({
    getAppVersion: () => '0.3.6',
    onStateChange: state => stateChanges.push(state),
    logger: { warn() {} },
    fetchImpl,
    now: () => new Date('2026-08-04T12:00:00.000Z'),
    random: () => 0,
    setTimer(callback, delay) {
      const timer = { callback, delay, unref() {} };
      timers.add(timer);
      return timer;
    },
    clearTimer(timer) {
      timers.delete(timer);
    }
  });
  return { reporter, timers, stateChanges };
}

test('anonymous activity reporting stays disabled after explicit opt-out', async () => {
  let calls = 0;
  const { reporter, timers } = createHarness(async () => {
    calls++;
    return { ok: true, json: async () => ({ activityDate: '2026-08-04' }) };
  });

  reporter.configure({ telemetryEnabled: false });
  await reporter.runNow();

  assert.equal(calls, 0);
  assert.equal(timers.size, 0);
});

test('activity report sends only minimal installation metadata and persists server date', async () => {
  let request;
  const { reporter, stateChanges } = createHarness(async (_url, options) => {
    request = options;
    return { ok: true, json: async () => ({ accepted: true, activityDate: '2026-08-04' }) };
  });

  reporter.configure({ telemetryEnabled: true, telemetryInstallationId: installationId });
  await reporter.runNow();

  const payload = JSON.parse(request.body);
  assert.deepEqual(Object.keys(payload).sort(), ['appVersion', 'arch', 'installationId', 'platform', 'schemaVersion'].sort());
  assert.equal(payload.installationId, installationId);
  assert.equal(payload.appVersion, '0.3.6');
  assert.equal(payload.schemaVersion, 1);
  assert.deepEqual(stateChanges.at(-1), {
    telemetryInstallationId: installationId,
    telemetryLastReportedDate: '2026-08-04'
  });
});

test('activity report does not repeat after the server date is recorded', async () => {
  let calls = 0;
  const { reporter } = createHarness(async () => {
    calls++;
    return { ok: true, json: async () => ({ activityDate: '2026-08-04' }) };
  });

  reporter.configure({
    telemetryEnabled: true,
    telemetryInstallationId: installationId,
    telemetryLastReportedDate: '2026-08-04'
  });
  await reporter.runNow();

  assert.equal(calls, 0);
});

test('reapplying unchanged telemetry config preserves the scheduled report', () => {
  const { reporter, timers } = createHarness(async () => ({
    ok: true,
    json: async () => ({ activityDate: '2026-08-04' })
  }));
  const config = { telemetryEnabled: true, telemetryInstallationId: installationId };

  reporter.configure(config);
  const scheduled = [...timers][0];
  reporter.configure(config);

  assert.equal(timers.size, 1);
  assert.equal([...timers][0], scheduled);
});
