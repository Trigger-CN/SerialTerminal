'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createGiteePublisher, parseArguments } = require('../scripts/publish-gitee-release');

function response(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    async json() { return body; },
    async text() { return typeof body === 'string' ? body : JSON.stringify(body); }
  };
}

test('Gitee release arguments separate files from named options', () => {
  assert.deepEqual(parseArguments([
    '--owner', 'trigger-cn', '--repo', 'SerialTerminal', '--tag', 'v1.2.3',
    '--target', 'abc123', '--notes', 'notes.md', '--files', 'one.exe', 'two.deb'
  ]), {
    owner: 'trigger-cn', repo: 'SerialTerminal', tag: 'v1.2.3', target: 'abc123',
    notes: 'notes.md', files: ['one.exe', 'two.deb']
  });
});

test('Gitee publisher creates a missing release and uploads attachments', async () => {
  const requests = [];
  const publisher = createGiteePublisher({
    token: 'secret',
    async fetchImpl(url, options) {
      requests.push({ url, options });
      if (options.method === 'GET' && url.pathname.endsWith('/tags/v1.2.3')) return response(404, {});
      if (options.method === 'POST' && url.pathname.endsWith('/releases')) return response(201, { id: 7, tag_name: 'v1.2.3' });
      if (options.method === 'GET' && url.pathname.endsWith('/attach_files')) return response(200, []);
      return response(201, { id: 8 });
    }
  });

  await publisher.publish({
    owner: 'trigger-cn', repo: 'SerialTerminal', tag: 'v1.2.3', target: 'abc123',
    notes: 'Changes', files: [__filename]
  });

  assert.deepEqual(requests.map(item => item.options.method), ['GET', 'POST', 'GET', 'POST', 'GET']);
  assert.equal(JSON.parse(requests[1].options.body).target_commitish, 'abc123');
  requests.forEach(item => assert.equal(item.url.searchParams.get('access_token'), 'secret'));
  assert.doesNotMatch(requests.map(item => item.url.toString().replace('secret', '')).join('\n'), /undefined/);
});

test('Gitee publisher updates an existing release and replaces same-name attachments', async () => {
  const methods = [];
  const publisher = createGiteePublisher({
    token: 'secret',
    async fetchImpl(url, options) {
      methods.push(options.method);
      if (url.pathname.endsWith('/tags/v1.2.3')) return response(200, { id: 7 });
      if (options.method === 'PATCH') return response(200, { id: 7, tag_name: 'v1.2.3' });
      if (options.method === 'GET') return response(200, [{ id: 9, name: 'gitee-release.test.js' }]);
      if (options.method === 'DELETE') return response(204, null);
      return response(201, { id: 10 });
    }
  });

  await publisher.publish({
    owner: 'trigger-cn', repo: 'SerialTerminal', tag: 'v1.2.3', target: 'abc123',
    notes: 'Changes', files: [__filename]
  });

  assert.deepEqual(methods, ['GET', 'PATCH', 'GET', 'DELETE', 'POST', 'GET']);
});

test('Gitee publisher retries temporary network failures with request context', async () => {
  let attempts = 0;
  const waits = [];
  const publisher = createGiteePublisher({
    token: 'secret',
    wait: async milliseconds => waits.push(milliseconds),
    async fetchImpl(url, options) {
      if (url.pathname.endsWith('/tags/v1.2.3')) {
        attempts++;
        if (attempts < 3) throw new TypeError('fetch failed', { cause: new Error('connection reset') });
        return response(200, { id: 7 });
      }
      if (options.method === 'PATCH') return response(200, { id: 7, tag_name: 'v1.2.3' });
      if (options.method === 'GET') return response(200, []);
      return response(201, { id: 10 });
    }
  });

  await publisher.publish({
    owner: 'trigger-cn', repo: 'SerialTerminal', tag: 'v1.2.3', target: 'abc123',
    notes: 'Changes', files: [__filename]
  });

  assert.equal(attempts, 3);
  assert.deepEqual(waits, [2000, 5000]);
});

test('Gitee publisher reports the failed API and underlying network cause', async () => {
  const publisher = createGiteePublisher({
    token: 'secret',
    wait: async () => {},
    async fetchImpl() {
      throw new TypeError('fetch failed', { cause: new Error('headers timeout') });
    }
  });

  await assert.rejects(() => publisher.publish({
    owner: 'trigger-cn', repo: 'SerialTerminal', tag: 'v1.2.3', target: 'abc123',
    notes: 'Changes', files: [__filename]
  }), /Gitee API GET \/repos\/trigger-cn\/SerialTerminal\/releases\/tags\/v1\.2\.3 failed after 4 attempt\(s\): fetch failed \(headers timeout\)/);
});

test('Gitee publisher recovers when a timed-out attachment upload completed remotely', async () => {
  const methods = [];
  let attachmentChecks = 0;
  const waits = [];
  const publisher = createGiteePublisher({
    token: 'secret',
    wait: async milliseconds => waits.push(milliseconds),
    async fetchImpl(url, options) {
      methods.push(options.method);
      if (url.pathname.endsWith('/tags/v1.2.3')) return response(200, { id: 7 });
      if (options.method === 'PATCH') return response(200, { id: 7, tag_name: 'v1.2.3' });
      if (options.method === 'POST') {
        throw new TypeError('fetch failed', { cause: new Error('Headers Timeout Error') });
      }
      attachmentChecks++;
      return response(200, attachmentChecks >= 2
        ? [{ id: 10, name: 'gitee-release.test.js', browser_download_url: 'https://gitee.test/file' }]
        : []);
    }
  });

  await publisher.publish({
    owner: 'trigger-cn', repo: 'SerialTerminal', tag: 'v1.2.3', target: 'abc123',
    notes: 'Changes', files: [__filename]
  });

  assert.deepEqual(methods, ['GET', 'PATCH', 'GET', 'POST', 'GET', 'GET']);
  assert.deepEqual(waits, [2000]);
});
