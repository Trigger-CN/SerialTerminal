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
