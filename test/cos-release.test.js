'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const yaml = require('js-yaml');
const { compareVersions, createCosPublisher, getVersionFromKey, parseArguments } = require('../scripts/publish-cos-release');

function missingObject(options, callback) {
  callback({ code: 'NoSuchKey', statusCode: 404, message: 'Not Found' });
}

test('COS release arguments separate files from named options', () => {
  assert.deepEqual(parseArguments([
    '--tag', 'v1.2.3', '--files', 'one.exe', 'latest.yml'
  ]), {
    tag: 'v1.2.3', files: ['one.exe', 'latest.yml'], pruneOnly: false
  });
  assert.deepEqual(parseArguments(['--prune-only']), { files: [], pruneOnly: true });
  assert.throws(() => parseArguments([
    '--tag', 'v9007199254740992.0.0', '--files', 'one.exe', 'latest.yml'
  ]), /Invalid release tag/);
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
    headObject: missingObject,
    getObject: missingObject,
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

test('COS prereleases do not replace stable latest metadata', async t => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'serialterminal-cos-prerelease-'));
  t.after(() => fs.promises.rm(directory, { recursive: true, force: true }));
  const metadataPath = path.join(directory, 'latest.yml');
  await fs.promises.writeFile(metadataPath, yaml.dump({ version: '1.2.3-preview.1', files: [] }));
  const keys = [];
  const cos = {
    headObject: missingObject,
    putObject(options, callback) {
      keys.push(options.Key);
      callback(null, { statusCode: 200 });
    }
  };
  const publisher = createCosPublisher({
    secretId: 'id', secretKey: 'key', bucket: 'bucket-123', region: 'ap-hongkong', cos,
    logger: { log() {} }
  });
  await publisher.publish({ tag: 'v1.2.3-preview.1', files: [metadataPath] });
  assert.deepEqual(keys, ['releases/v1.2.3-preview.1/latest.yml']);
});

test('COS release versions use semantic ordering and ignore stable metadata', () => {
  const versions = [
    'v0.9.0', 'v0.10.0-A', 'v0.10.0-a', 'v0.10.0-beta.2', 'v0.10.0-beta.10', 'v0.10.0',
    'v9007199254740993.0.0', 'v9007199254740992.0.0'
  ];
  assert.deepEqual(versions.sort(compareVersions), [
    'v0.9.0', 'v0.10.0-A', 'v0.10.0-a', 'v0.10.0-beta.2', 'v0.10.0-beta.10', 'v0.10.0',
    'v9007199254740992.0.0', 'v9007199254740993.0.0'
  ]);
  assert.equal(getVersionFromKey('releases/v1.2.3/app.exe'), 'v1.2.3');
  assert.equal(getVersionFromKey('releases/latest/latest.yml'), '');
});

test('COS publisher paginates releases and deletes all but the latest three versions in batches', async t => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'serialterminal-cos-retention-'));
  t.after(() => fs.promises.rm(directory, { recursive: true, force: true }));
  const metadataPath = path.join(directory, 'latest.yml');
  await fs.promises.writeFile(metadataPath, yaml.dump({ version: '0.10.0', files: [] }));

  const listCalls = [];
  const deleteCalls = [];
  const oldVersionKeys = Array.from({ length: 1001 }, (_, index) => `releases/v0.7.0/file-${index}.bin`);
  const cos = {
    headObject: missingObject,
    getObject: missingObject,
    putObject(options, callback) {
      callback(null, { statusCode: 200 });
    },
    getBucket(options, callback) {
      listCalls.push(options);
      if (!options.Marker) {
        callback(null, {
          IsTruncated: true,
          NextMarker: 'page-2',
          Contents: [
            { Key: 'releases/latest/latest.yml' },
            { Key: 'releases/v0.8.0/app.exe' },
            { Key: 'releases/v0.10.0/app.exe' }
          ]
        });
        return;
      }
      callback(null, {
        IsTruncated: false,
        Contents: [{ Key: 'releases/v0.9.0/app.exe' }, ...oldVersionKeys.map(Key => ({ Key }))]
      });
    },
    deleteMultipleObject(options, callback) {
      deleteCalls.push(options);
      callback(null, {});
    }
  };
  const publisher = createCosPublisher({
    secretId: 'id', secretKey: 'key', bucket: 'bucket-123', region: 'ap-hongkong', cos,
    logger: { log() {} }
  });

  await publisher.publish({ tag: 'v0.10.0', files: [metadataPath] });
  await publisher.pruneOldVersions();

  assert.deepEqual(listCalls.map(call => call.Marker), ['', 'page-2']);
  assert.deepEqual(deleteCalls.map(call => call.Objects.length), [1000, 1]);
  assert.ok(deleteCalls.flatMap(call => call.Objects).every(item => item.Key.startsWith('releases/v0.7.0/')));
});

test('COS retention keeps stable releases independently from prereleases', async () => {
  const deleted = [];
  const cos = {
    getObject: missingObject,
    getBucket(options, callback) {
      callback(null, {
        IsTruncated: false,
        Contents: [
          'releases/v1.2.3/app.exe',
          'releases/v1.3.0-preview.1/app.exe',
          'releases/v1.3.0-preview.2/app.exe',
          'releases/v1.3.0-preview.3/app.exe',
          'releases/v1.3.0-preview.4/app.exe'
        ].map(Key => ({ Key }))
      });
    },
    deleteMultipleObject(options, callback) {
      deleted.push(...options.Objects.map(item => item.Key));
      callback(null, {});
    }
  };
  const publisher = createCosPublisher({
    secretId: 'id', secretKey: 'key', bucket: 'bucket-123', region: 'ap-hongkong', cos,
    logger: { log() {} }
  });
  await publisher.pruneOldVersions();
  assert.deepEqual(deleted, ['releases/v1.3.0-preview.1/app.exe']);
});

test('COS publisher only cleans up versions when explicitly requested', async t => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'serialterminal-cos-failure-'));
  t.after(() => fs.promises.rm(directory, { recursive: true, force: true }));
  const metadataPath = path.join(directory, 'latest.yml');
  await fs.promises.writeFile(metadataPath, yaml.dump({ version: '1.2.3', files: [] }));
  let listed = 0;
  const cos = {
    headObject: missingObject,
    getObject: missingObject,
    putObject(options, callback) {
      callback(null, { statusCode: 200 });
    },
    getBucket(options, callback) {
      listed++;
      callback(null, { IsTruncated: false, Contents: [] });
    }
  };
  const publisher = createCosPublisher({
    secretId: 'id', secretKey: 'key', bucket: 'bucket-123', region: 'ap-hongkong', cos,
    logger: { log() {} }
  });

  await publisher.publish({ tag: 'v1.2.3', files: [metadataPath] });
  assert.equal(listed, 0);
  await publisher.pruneOldVersions();
  assert.equal(listed, 1);
});

test('COS publisher reports SDK status and request errors', async () => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'serialterminal-cos-error-'));
  const metadataPath = path.join(directory, 'latest.yml');
  await fs.promises.writeFile(metadataPath, yaml.dump({ version: '1.2.3', files: [] }));
  const cos = {
    headObject: missingObject,
    getObject: missingObject,
    uploadFile(options, callback) {
      callback({ code: 'AccessDenied', statusCode: 403, error: 'permission denied' });
    }
  };
  const publisher = createCosPublisher({
    secretId: 'id', secretKey: 'key', bucket: 'bucket-123', region: 'ap-hongkong', cos,
    logger: { log() {} }
  });

  await assert.rejects(
    () => publisher.publish({ tag: 'v1.2.3', files: [__filename, metadataPath] }),
    /COS uploadFile releases\/v1\.2\.3\/cos-release\.test\.js failed: AccessDenied, HTTP 403, permission denied/
  );
  await fs.promises.rm(directory, { recursive: true, force: true });
});

test('COS publisher rejects stable rollback before uploading release objects', async t => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'serialterminal-cos-rollback-'));
  t.after(() => fs.promises.rm(directory, { recursive: true, force: true }));
  const metadataPath = path.join(directory, 'latest.yml');
  await fs.promises.writeFile(metadataPath, yaml.dump({ version: '1.2.2', files: [] }));
  const calls = [];
  const cos = {
    headObject: missingObject,
    getObject(options, callback) {
      if (options.Key === 'releases/latest/latest.yml') {
        callback(null, { Body: Buffer.from(yaml.dump({ version: '1.2.3', files: [] })) });
        return;
      }
      missingObject(options, callback);
    },
    putObject(options, callback) {
      calls.push(options.Key);
      callback(null, {});
    }
  };
  const publisher = createCosPublisher({
    secretId: 'id', secretKey: 'key', bucket: 'bucket-123', region: 'ap-hongkong', cos,
    logger: { log() {} }
  });

  await assert.rejects(
    () => publisher.publish({ tag: 'v1.2.2', files: [metadataPath] }),
    /Stable latest cannot move backward from 1\.2\.3 to 1\.2\.2/
  );
  assert.deepEqual(calls, []);
});
