'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const {
  createGiteePublisher,
  createMultipartUpload,
  downloadAndHashAttachment,
  formatError,
  parseArguments,
  validateAttachmentUrl
} = require('../scripts/publish-gitee-release');

function response(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    async json() { return body; },
    async text() { return typeof body === 'string' ? body : JSON.stringify(body); }
  };
}

function downloadResponse(body) {
  const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body);
  return {
    status: 200,
    ok: true,
    headers: { get(name) { return name.toLowerCase() === 'content-length' ? String(buffer.length) : null; } },
    body: Readable.from([buffer])
  };
}

function redirectResponse(location) {
  return {
    status: 302,
    ok: false,
    headers: { get(name) { return name.toLowerCase() === 'location' ? location : null; } },
    body: Readable.from([])
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

test('Gitee release arguments allow a notes-only release', () => {
  assert.deepEqual(parseArguments([
    '--owner', 'trigger-cn', '--repo', 'SerialTerminal', '--tag', 'v1.2.3',
    '--target', 'abc123', '--notes', 'notes.md'
  ]), {
    owner: 'trigger-cn', repo: 'SerialTerminal', tag: 'v1.2.3', target: 'abc123',
    notes: 'notes.md', files: []
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
      return response(201, { id: 8, browser_download_url: 'https://gitee.com/download/gitee-release.test.js' });
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

test('Gitee publisher reuses an identical existing attachment without deleting it', async () => {
  const methods = [];
  const publisher = createGiteePublisher({
    token: 'secret',
    downloadImpl: async () => downloadResponse(await fs.promises.readFile(__filename)),
    async fetchImpl(url, options) {
      methods.push(options.method);
      if (url.pathname.endsWith('/tags/v1.2.3')) return response(200, { id: 7 });
      if (options.method === 'PATCH') return response(200, { id: 7, tag_name: 'v1.2.3' });
      if (options.method === 'GET') return response(200, [{
        id: 9,
        name: 'gitee-release.test.js',
        browser_download_url: 'https://gitee.com/download/gitee-release.test.js'
      }]);
      return response(201, { id: 10 });
    }
  });

  await publisher.publish({
    owner: 'trigger-cn', repo: 'SerialTerminal', tag: 'v1.2.3', target: 'abc123',
    notes: 'Changes', files: [__filename]
  });

  assert.deepEqual(methods, ['GET', 'GET', 'PATCH']);
});

test('Gitee attachment verification bounds redirects to Gitee-controlled hosts', async () => {
  assert.equal(validateAttachmentUrl('https://gitee.com/trigger-cn/SerialTerminal/releases/download/v1.2.3/file.exe'), 'https://gitee.com/trigger-cn/SerialTerminal/releases/download/v1.2.3/file.exe');
  assert.equal(validateAttachmentUrl('https://foruda.gitee.com/attach_file/file.exe'), 'https://foruda.gitee.com/attach_file/file.exe');
  assert.throws(() => validateAttachmentUrl('https://example.com/file.exe'), /unexpected host/);

  const requests = [];
  const result = await downloadAndHashAttachment('https://gitee.com/download/file.exe', 4, {
    dispatcher: undefined,
    async downloadImpl(url) {
      requests.push(url);
      if (requests.length === 1) return redirectResponse('https://gitee.com/attach_files/1/download/file.exe');
      if (requests.length === 2) return redirectResponse('https://foruda.gitee.com/attach_file/file.exe');
      return downloadResponse('data');
    }
  });
  assert.equal(result.size, 4);
  assert.deepEqual(requests, [
    'https://gitee.com/download/file.exe',
    'https://gitee.com/attach_files/1/download/file.exe',
    'https://foruda.gitee.com/attach_file/file.exe'
  ]);
  await assert.rejects(() => downloadAndHashAttachment('https://gitee.com/download/file.exe', 4, {
    dispatcher: undefined,
    async downloadImpl() { return redirectResponse('https://evil.example/file.exe'); }
  }), /unexpected host/);
});

test('Gitee publisher rejects a changed same-tag attachment without mutating the release', async () => {
  const methods = [];
  const publisher = createGiteePublisher({
    token: 'secret',
    downloadImpl: async () => downloadResponse('different bytes'),
    async fetchImpl(url, options) {
      methods.push(options.method);
      if (url.pathname.endsWith('/tags/v1.2.3')) return response(200, { id: 7 });
      return response(200, [{
        id: 9,
        name: 'gitee-release.test.js',
        browser_download_url: 'https://gitee.com/download/gitee-release.test.js'
      }]);
    }
  });

  await assert.rejects(() => publisher.publish({
    owner: 'trigger-cn', repo: 'SerialTerminal', tag: 'v1.2.3', target: 'abc123',
    notes: 'Changes', files: [__filename]
  }), /immutable attachment differs/);
  assert.deepEqual(methods, ['GET', 'GET']);
});

test('Gitee marks every semantic prerelease identifier as prerelease', async () => {
  let releaseBody;
  const publisher = createGiteePublisher({
    token: 'secret',
    async fetchImpl(url, options) {
      if (options.method === 'GET') return response(404, {});
      releaseBody = JSON.parse(options.body);
      return response(201, { id: 7, tag_name: releaseBody.tag_name });
    }
  });
  await publisher.publish({
    owner: 'trigger-cn', repo: 'SerialTerminal', tag: 'v1.2.3-preview.1', target: 'abc123', notes: 'Changes'
  });
  assert.equal(releaseBody.prerelease, true);
});

test('Gitee publisher uploads updater assets before metadata and rewrites installer URLs', async () => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'serialterminal-gitee-'));
  const installerPath = path.join(directory, 'SerialTerminal-Setup-1.2.3.exe');
  const blockmapPath = `${installerPath}.blockmap`;
  const metadataPath = path.join(directory, 'latest.yml');
  const uploads = [];
  const attachments = [];
  try {
    await fs.promises.writeFile(installerPath, 'installer');
    await fs.promises.writeFile(blockmapPath, 'blockmap');
    await fs.promises.writeFile(metadataPath, [
      'version: 1.2.3',
      'files:',
      '  - url: https://cos.example/releases/v1.2.3/SerialTerminal-Setup-1.2.3.exe',
      '    sha512: checksum',
      'path: https://cos.example/releases/v1.2.3/SerialTerminal-Setup-1.2.3.exe',
      'sha512: checksum',
      ''
    ].join('\n'));

    const publisher = createGiteePublisher({
      token: 'secret',
      async fetchImpl(url, options) {
        if (url.pathname.endsWith('/tags/v1.2.3')) return response(200, { id: 7 });
        if (options.method === 'PATCH') return response(200, { id: 7, tag_name: 'v1.2.3' });
        if (options.method === 'GET') return response(200, [...attachments]);
        if (options.method === 'POST') {
          const chunks = [];
          for await (const chunk of options.body) chunks.push(Buffer.from(chunk));
          const body = Buffer.concat(chunks).toString('utf8');
          const name = /filename="([^"]+)"/.exec(body)?.[1];
          uploads.push({ name, body });
          const attachment = {
            id: uploads.length,
            name,
            browser_download_url: `https://gitee.com/trigger-cn/SerialTerminal/releases/download/v1.2.3/${name}`
          };
          attachments.push(attachment);
          return response(201, attachment);
        }
        return response(204, null);
      }
    });

    await publisher.publish({
      owner: 'trigger-cn', repo: 'SerialTerminal', tag: 'v1.2.3', target: 'abc123',
      notes: 'Changes', files: [metadataPath, blockmapPath, installerPath]
    });

    assert.deepEqual(uploads.map(upload => upload.name), [
      'SerialTerminal-Setup-1.2.3.exe.blockmap',
      'SerialTerminal-Setup-1.2.3.exe',
      'latest.yml'
    ]);
    const metadataUpload = uploads.at(-1).body;
    const installerUrl = 'https://gitee.com/trigger-cn/SerialTerminal/releases/download/v1.2.3/SerialTerminal-Setup-1.2.3.exe';
    assert.equal((metadataUpload.match(new RegExp(installerUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length, 2);
    assert.doesNotMatch(metadataUpload, /cos\.example/);
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
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
      return response(201, { id: 10, browser_download_url: 'https://gitee.com/download/gitee-release.test.js' });
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
  }), /Gitee API GET \/repos\/trigger-cn\/SerialTerminal\/releases\/tags\/v1\.2\.3 failed after 4 attempt\(s\): fetch failed/);
});

test('Gitee publisher recovers when a timed-out attachment upload completed remotely', async () => {
  const methods = [];
  let attachmentChecks = 0;
  const waits = [];
  const publisher = createGiteePublisher({
    token: 'secret',
    wait: async milliseconds => waits.push(milliseconds),
    downloadImpl: async () => downloadResponse(await fs.promises.readFile(__filename)),
    async fetchImpl(url, options) {
      methods.push(options.method);
      if (url.pathname.endsWith('/tags/v1.2.3')) return response(200, { id: 7 });
      if (options.method === 'PATCH') return response(200, { id: 7, tag_name: 'v1.2.3' });
      if (options.method === 'POST') {
        throw new TypeError('fetch failed', { cause: new Error('Headers Timeout Error') });
      }
      attachmentChecks++;
      return response(200, attachmentChecks >= 2
        ? [{ id: 10, name: 'gitee-release.test.js', browser_download_url: 'https://gitee.com/download/gitee-release.test.js' }]
        : []);
    }
  });

  await publisher.publish({
    owner: 'trigger-cn', repo: 'SerialTerminal', tag: 'v1.2.3', target: 'abc123',
    notes: 'Changes', files: [__filename]
  });

  assert.deepEqual(methods, ['GET', 'GET', 'POST', 'GET', 'GET', 'PATCH']);
  assert.deepEqual(waits, [2000]);
});

test('multipart attachment upload reports byte progress and an exact content length', async () => {
  const logs = [];
  let currentTime = 0;
  const upload = createMultipartUpload(
    { buffer: Buffer.from('artifact-data'), size: 13 },
    'artifact.exe',
    {
      logger: { log: message => logs.push(message) },
      now: () => currentTime += 5000,
      progressIntervalMs: 5000
    }
  );
  const chunks = [];
  for await (const chunk of upload.body) chunks.push(chunk);
  const body = Buffer.concat(chunks);

  assert.equal(body.length, upload.contentLength);
  assert.equal(upload.headers['Content-Length'], String(body.length));
  assert.match(body.toString(), /name="file"; filename="artifact\.exe"/);
  assert.match(body.toString(), /artifact-data/);
  assert.equal(upload.transferred(), 13);
  assert.match(logs.join('\n'), /upload progress: artifact\.exe, 13 B\/13 B \(100\.0%\),/);
  assert.match(logs.join('\n'), /upload body complete: artifact\.exe, 13 B read; waiting for Gitee response/);
});

test('Gitee error diagnostics include nested network error codes', () => {
  const networkError = new Error('Headers Timeout Error');
  networkError.code = 'UND_ERR_HEADERS_TIMEOUT';
  const error = new TypeError('fetch failed', { cause: networkError });

  assert.equal(
    formatError(error),
    'TypeError: fetch failed <- cause: Error/UND_ERR_HEADERS_TIMEOUT: Headers Timeout Error'
  );
});
