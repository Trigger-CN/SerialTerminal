'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const yaml = require('js-yaml');
const { createCosPublisher, parseArguments } = require('../scripts/publish-cos-release');

test('COS release arguments separate files from named options', () => {
  assert.deepEqual(parseArguments([
    '--tag', 'v1.2.3', '--files', 'one.exe', 'latest.yml'
  ]), {
    tag: 'v1.2.3', files: ['one.exe', 'latest.yml']
  });
});

test('COS publisher uploads versioned artifacts before publishing latest metadata', async t => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'serialterminal-cos-'));
  t.after(() => fs.promises.rm(directory, { recursive: true, force: true }));
  const installer = path.join(directory, 'SerialTerminal-Setup-1.2.3.exe');
  const metadataPath = path.join(directory, 'latest.yml');
  await fs.promises.writeFile(installer, 'installer');
  await fs.promises.writeFile(metadataPath, yaml.dump({
    version: '1.2.3',
    files: [{ url: 'SerialTerminal-Setup-1.2.3.exe', sha512: 'hash', size: 9 }],
    path: 'SerialTerminal-Setup-1.2.3.exe',
    sha512: 'hash'
  }));

  const calls = [];
  const cos = {
    uploadFile(options, callback) {
      calls.push({ method: 'uploadFile', options });
      options.onProgress({ percent: 1, loaded: 9, total: 9, speed: 1024 });
      callback(null, { statusCode: 200, RequestId: 'artifact-request' });
    },
    putObject(options, callback) {
      calls.push({ method: 'putObject', options });
      callback(null, { statusCode: 200, RequestId: 'metadata-request' });
    }
  };
  const publisher = createCosPublisher({
    secretId: 'id', secretKey: 'key', bucket: 'bucket-123', region: 'ap-hongkong', cos,
    logger: { log() {} }
  });

  await publisher.publish({ tag: 'v1.2.3', files: [metadataPath, installer] });

  assert.deepEqual(calls.map(call => [call.method, call.options.Key]), [
    ['uploadFile', 'releases/v1.2.3/SerialTerminal-Setup-1.2.3.exe'],
    ['putObject', 'releases/v1.2.3/latest.yml'],
    ['putObject', 'releases/latest/latest.yml']
  ]);
  assert.equal(calls[0].options.AsyncLimit, 4);
  assert.equal(calls[0].options.CacheControl, 'public, max-age=31536000, immutable');
  assert.equal(calls[2].options.CacheControl, 'no-cache, no-store, must-revalidate');
  const metadata = yaml.load(calls[2].options.Body.toString());
  const installerUrl = 'https://bucket-123.cos.ap-hongkong.myqcloud.com/releases/v1.2.3/SerialTerminal-Setup-1.2.3.exe';
  assert.equal(metadata.files[0].url, installerUrl);
  assert.equal(metadata.path, installerUrl);
  assert.deepEqual(yaml.load(await fs.promises.readFile(metadataPath, 'utf8')), metadata);
});

test('COS publisher reports SDK status and request errors', async () => {
  const cos = {
    uploadFile(options, callback) {
      callback({ code: 'AccessDenied', statusCode: 403, error: 'permission denied' });
    }
  };
  const publisher = createCosPublisher({
    secretId: 'id', secretKey: 'key', bucket: 'bucket-123', region: 'ap-hongkong', cos,
    logger: { log() {} }
  });

  await assert.rejects(
    () => publisher.publish({ tag: 'v1.2.3', files: [__filename, 'latest.yml'] }),
    /COS uploadFile releases\/v1\.2\.3\/cos-release\.test\.js failed: AccessDenied, HTTP 403, permission denied/
  );
});
