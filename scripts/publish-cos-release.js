'use strict';

const fs = require('node:fs');
const path = require('node:path');
const COS = require('cos-nodejs-sdk-v5');
const yaml = require('js-yaml');

const SLICE_SIZE = 8 * 1024 * 1024;
const ASYNC_LIMIT = 4;

function parseArguments(args) {
  const options = { files: [] };
  for (let index = 0; index < args.length; index++) {
    const name = args[index];
    if (name === '--files') {
      options.files = args.slice(index + 1);
      break;
    }
    if (!name.startsWith('--') || !args[index + 1]) throw new Error(`Invalid argument: ${name}`);
    options[name.slice(2)] = args[++index];
  }
  if (!options.tag) throw new Error('Missing --tag');
  if (options.files.length === 0) throw new Error('Missing --files');
  return options;
}

function createCosPublisher({ secretId, secretKey, bucket, region, cos, logger = console }) {
  for (const [name, value] of Object.entries({ secretId, secretKey, bucket, region })) {
    if (!value) throw new Error(`Missing COS ${name}`);
  }
  const client = cos || new COS({ SecretId: secretId, SecretKey: secretKey, FileParallelLimit: ASYNC_LIMIT });
  const publicRoot = `https://${bucket}.cos.${region}.myqcloud.com`;

  async function uploadFile(filePath, key, cacheControl) {
    const size = (await fs.promises.stat(filePath)).size;
    let lastPercent = -1;
    logger.log(`[cos] upload start: ${filePath} -> ${key} (${formatBytes(size)})`);
    const result = await callCos(client, 'uploadFile', {
      Bucket: bucket,
      Region: region,
      Key: key,
      FilePath: filePath,
      SliceSize: SLICE_SIZE,
      AsyncLimit: ASYNC_LIMIT,
      CacheControl: cacheControl,
      onProgress(progress) {
        const percent = Math.floor((progress.percent || 0) * 100);
        if (percent === lastPercent && percent !== 100) return;
        lastPercent = percent;
        logger.log(`[cos] upload progress: ${path.basename(filePath)} ${percent}% ` +
          `${formatBytes(progress.loaded || 0)}/${formatBytes(progress.total || size)} ${formatBytes(progress.speed || 0)}/s`);
      }
    });
    logger.log(`[cos] upload complete: ${key}, HTTP ${result.statusCode || 200}, request ${result.RequestId || 'unknown'}`);
  }

  async function uploadBuffer(buffer, key, cacheControl) {
    logger.log(`[cos] publish metadata: ${key} (${formatBytes(buffer.length)})`);
    const result = await callCos(client, 'putObject', {
      Bucket: bucket,
      Region: region,
      Key: key,
      Body: buffer,
      ContentLength: buffer.length,
      ContentType: 'text/yaml; charset=utf-8',
      CacheControl: cacheControl
    });
    logger.log(`[cos] metadata complete: ${key}, HTTP ${result.statusCode || 200}, request ${result.RequestId || 'unknown'}`);
  }

  async function publish({ tag, files }) {
    const versionPrefix = `releases/${tag}`;
    const metadataFiles = files.filter(file => /^latest(?:-linux)?\.yml$/i.test(path.basename(file)));
    const artifactFiles = files.filter(file => !metadataFiles.includes(file));
    if (metadataFiles.length === 0) throw new Error('No update metadata file was provided');

    for (const filePath of artifactFiles) {
      await uploadFile(filePath, `${versionPrefix}/${path.basename(filePath)}`, 'public, max-age=31536000, immutable');
    }
    for (const filePath of metadataFiles) {
      const metadata = yaml.load(await fs.promises.readFile(filePath, 'utf8'));
      for (const file of metadata.files || []) {
        file.url = `${publicRoot}/${versionPrefix}/${path.basename(file.url)}`;
      }
      if (metadata.path) metadata.path = `${publicRoot}/${versionPrefix}/${path.basename(metadata.path)}`;
      const content = Buffer.from(yaml.dump(metadata), 'utf8');
      await fs.promises.writeFile(filePath, content);
      await uploadBuffer(content, `${versionPrefix}/${path.basename(filePath)}`, 'public, max-age=31536000, immutable');
      await uploadBuffer(content, `releases/latest/${path.basename(filePath)}`, 'no-cache, no-store, must-revalidate');
    }
    return { publicRoot, versionPrefix };
  }

  return { publish };
}

function callCos(client, method, options) {
  return new Promise((resolve, reject) => {
    client[method](options, (error, data) => {
      if (!error) return resolve(data || {});
      const details = [error.code, error.statusCode && `HTTP ${error.statusCode}`, error.error, error.message]
        .filter(Boolean).join(', ');
      reject(new Error(`COS ${method} ${options.Key} failed: ${details || String(error)}`, { cause: error }));
    });
  });
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KiB', 'MiB', 'GiB'];
  let value = bytes;
  let unit = -1;
  do {
    value /= 1024;
    unit++;
  } while (value >= 1024 && unit < units.length - 1);
  return `${value.toFixed(2)} ${units[unit]}`;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const publisher = createCosPublisher({
    secretId: process.env.COS_SECRET_ID,
    secretKey: process.env.COS_SECRET_KEY,
    bucket: process.env.COS_BUCKET,
    region: process.env.COS_REGION
  });
  const result = await publisher.publish(options);
  console.log(`Published ${options.files.length} artifact(s) to ${result.publicRoot}/${result.versionPrefix}/`);
}

if (require.main === module) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { createCosPublisher, parseArguments };
