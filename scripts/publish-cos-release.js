'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const COS = require('cos-nodejs-sdk-v5');
const yaml = require('js-yaml');
const { parseReleaseTag } = require('./validate-release-tag');

const SLICE_SIZE = 8 * 1024 * 1024;
const ASYNC_LIMIT = 4;
const RETAINED_VERSION_COUNT = 3;
const MAX_DELETE_OBJECTS = 1000;
const SHA512_METADATA_HEADER = 'x-cos-meta-serialterminal-sha512';
const COS_IDENTIFIER = '(?:0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)';
const COS_VERSION_PATTERN = new RegExp(`^v?(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)(?:-(${COS_IDENTIFIER}(?:\\.${COS_IDENTIFIER})*))?$`);

function parseArguments(args) {
  const options = { files: [], pruneOnly: false };
  for (let index = 0; index < args.length; index++) {
    const name = args[index];
    if (name === '--prune-only') {
      options.pruneOnly = true;
      continue;
    }
    if (name === '--files') {
      options.files = args.slice(index + 1);
      break;
    }
    if (!name.startsWith('--') || !args[index + 1]) throw new Error(`Invalid argument: ${name}`);
    options[name.slice(2)] = args[++index];
  }
  if (!options.pruneOnly && !options.tag) throw new Error('Missing --tag');
  if (!options.pruneOnly) parseReleaseTag(options.tag);
  if (!options.pruneOnly && options.files.length === 0) throw new Error('Missing --files');
  return options;
}

function createCosPublisher({ secretId, secretKey, bucket, region, cos, logger = console }) {
  for (const [name, value] of Object.entries({ secretId, secretKey, bucket, region })) {
    if (!value) throw new Error(`Missing COS ${name}`);
  }
  const client = cos || new COS({ SecretId: secretId, SecretKey: secretKey, FileParallelLimit: ASYNC_LIMIT });
  const publicRoot = `https://${bucket}.cos.${region}.myqcloud.com`;

  async function uploadFile(filePath, key, cacheControl, size, sha512) {
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
      [SHA512_METADATA_HEADER]: sha512,
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

  async function uploadBuffer(buffer, key, cacheControl, sha512 = hashBuffer(buffer)) {
    logger.log(`[cos] publish metadata: ${key} (${formatBytes(buffer.length)})`);
    const result = await callCos(client, 'putObject', {
      Bucket: bucket,
      Region: region,
      Key: key,
      Body: buffer,
      ContentLength: buffer.length,
      ContentType: 'text/yaml; charset=utf-8',
      CacheControl: cacheControl,
      [SHA512_METADATA_HEADER]: sha512
    });
    logger.log(`[cos] metadata complete: ${key}, HTTP ${result.statusCode || 200}, request ${result.RequestId || 'unknown'}`);
  }

  async function listReleaseObjects() {
    const objects = [];
    let marker = '';
    do {
      const result = await callCos(client, 'getBucket', {
        Bucket: bucket,
        Region: region,
        Prefix: 'releases/',
        Marker: marker,
        MaxKeys: 1000
      });
      objects.push(...(result.Contents || []).map(item => item.Key).filter(Boolean));
      const isTruncated = result.IsTruncated === true || result.IsTruncated === 'true';
      if (isTruncated && !result.NextMarker) throw new Error('COS getBucket response is truncated without NextMarker');
      marker = isTruncated ? result.NextMarker : '';
    } while (marker);
    return objects;
  }

  async function getObjectIfExists(key) {
    try {
      return await callCos(client, 'getObject', { Bucket: bucket, Region: region, Key: key });
    } catch (error) {
      if (error.cause?.statusCode === 404) return null;
      throw error;
    }
  }

  async function headObjectIfExists(key) {
    try {
      return await callCos(client, 'headObject', { Bucket: bucket, Region: region, Key: key });
    } catch (error) {
      if (error.cause?.statusCode === 404) return null;
      throw error;
    }
  }

  async function prepareImmutableObject(key, source) {
    const size = source.buffer ? source.buffer.length : (await fs.promises.stat(source.filePath)).size;
    const sha512 = source.buffer ? hashBuffer(source.buffer) : await hashFile(source.filePath);
    const existing = await headObjectIfExists(key);
    if (!existing) return { ...source, key, size, sha512, exists: false };
    const existingHash = getHeader(existing, SHA512_METADATA_HEADER);
    const existingSize = Number(getHeader(existing, 'content-length'));
    if (existingHash !== sha512 || existingSize !== size) {
      throw new Error(`COS immutable object differs from local release: ${key}`);
    }
    logger.log(`[cos] immutable object already matches: ${key}`);
    return { ...source, key, size, sha512, exists: true };
  }

  async function getStableLatestMetadata(fileName = 'latest.yml') {
    const object = await getObjectIfExists(`releases/latest/${fileName}`);
    if (!object) return null;
    const metadata = yaml.load(Buffer.from(object.Body || '').toString('utf8'));
    if (!metadata || typeof metadata.version !== 'string') {
      throw new Error(`COS stable latest metadata is invalid: releases/latest/${fileName}`);
    }
    return { metadata, content: Buffer.from(object.Body || '') };
  }

  async function pruneOldVersions() {
    const objectKeys = await listReleaseObjects();
    const versions = [...new Set(objectKeys.map(getVersionFromKey).filter(Boolean))].sort(compareVersions).reverse();
    const stableVersions = versions.filter(version => !parseVersion(version).prerelease.length);
    const prereleaseVersions = versions.filter(version => parseVersion(version).prerelease.length);
    const stableLatest = await getStableLatestMetadata();
    const protectedStableVersion = stableLatest
      ? stableVersions.find(version => version.replace(/^v/, '') === stableLatest.metadata.version)
      : null;
    if (stableLatest && !protectedStableVersion) {
      throw new Error(`COS stable latest references a missing release: ${stableLatest.metadata.version}`);
    }
    const keptVersions = [
      ...stableVersions.slice(0, RETAINED_VERSION_COUNT),
      ...prereleaseVersions.slice(0, RETAINED_VERSION_COUNT),
      ...(protectedStableVersion ? [protectedStableVersion] : [])
    ];
    const keptVersionSet = new Set(keptVersions);
    const removedVersions = versions.filter(version => !keptVersionSet.has(version));
    const removedVersionSet = new Set(removedVersions);
    const deleteKeys = objectKeys.filter(key => removedVersionSet.has(getVersionFromKey(key)));
    if (deleteKeys.length === 0) {
      logger.log(`[cos] retention complete: keeping ${keptVersions.length} version(s), nothing to delete`);
      return;
    }

    logger.log(`[cos] retention cleanup: keeping ${keptVersions.join(', ')}; deleting ${removedVersions.join(', ')}`);
    for (let index = 0; index < deleteKeys.length; index += MAX_DELETE_OBJECTS) {
      const keys = deleteKeys.slice(index, index + MAX_DELETE_OBJECTS);
      const result = await callCos(client, 'deleteMultipleObject', {
        Bucket: bucket,
        Region: region,
        Objects: keys.map(Key => ({ Key })),
        Quiet: true
      });
      const errors = result.Error || result.Errors || [];
      if (errors.length > 0) {
        throw new Error(`COS retention cleanup failed for ${errors.length} object(s): ${errors.map(item => `${item.Key} (${item.Code})`).join(', ')}`);
      }
      logger.log(`[cos] retention cleanup: deleted ${keys.length} object(s)`);
    }
  }

  async function publish({ tag, files }) {
    const releaseTag = parseReleaseTag(tag);
    const versionPrefix = `releases/${tag}`;
    const metadataFiles = files.filter(file => /^latest(?:-linux)?\.yml$/i.test(path.basename(file)));
    const artifactFiles = files.filter(file => !metadataFiles.includes(file));
    if (metadataFiles.length === 0) throw new Error('No update metadata file was provided');

    const preparedArtifacts = await Promise.all(artifactFiles.map(filePath => prepareImmutableObject(
      `${versionPrefix}/${path.basename(filePath)}`,
      { filePath }
    )));
    const preparedMetadata = [];
    for (const filePath of metadataFiles) {
      const metadata = yaml.load(await fs.promises.readFile(filePath, 'utf8'));
      if (!metadata || metadata.version !== releaseTag.version) {
        throw new Error(`Update metadata version must be ${releaseTag.version}`);
      }
      for (const file of metadata.files || []) {
        file.url = `${publicRoot}/${versionPrefix}/${path.basename(file.url)}`;
      }
      if (metadata.path) metadata.path = `${publicRoot}/${versionPrefix}/${path.basename(metadata.path)}`;
      const content = Buffer.from(yaml.dump(metadata), 'utf8');
      const fileName = path.basename(filePath);
      const versioned = await prepareImmutableObject(`${versionPrefix}/${fileName}`, { buffer: content, filePath });
      let latestExists = false;
      if (!releaseTag.prerelease) {
        const current = await getStableLatestMetadata(fileName);
        if (current) {
          const comparison = compareVersions(releaseTag.version, current.metadata.version);
          if (comparison < 0) throw new Error(`Stable latest cannot move backward from ${current.metadata.version} to ${releaseTag.version}`);
          if (comparison === 0) {
            if (!current.content.equals(content)) {
              throw new Error(`Stable latest ${releaseTag.version} differs from the existing release`);
            }
            latestExists = true;
          }
        }
      }
      preparedMetadata.push({ filePath, fileName, content, versioned, latestExists });
    }

    for (const artifact of preparedArtifacts) {
      if (!artifact.exists) {
        await uploadFile(artifact.filePath, artifact.key, 'public, max-age=31536000, immutable', artifact.size, artifact.sha512);
      }
    }
    for (const item of preparedMetadata) {
      await fs.promises.writeFile(item.filePath, item.content);
      if (!item.versioned.exists) {
        await uploadBuffer(item.content, item.versioned.key, 'public, max-age=31536000, immutable', item.versioned.sha512);
      }
      if (!releaseTag.prerelease && !item.latestExists) {
        await uploadBuffer(item.content, `releases/latest/${item.fileName}`, 'no-cache, no-store, must-revalidate');
      }
    }
    return { publicRoot, versionPrefix };
  }

  return { pruneOldVersions, publish };
}

function callCos(client, method, options) {
  return new Promise((resolve, reject) => {
    client[method](options, (error, data) => {
      if (!error) return resolve(data || {});
      const details = [error.code, error.statusCode && `HTTP ${error.statusCode}`, error.error, error.message]
        .filter(Boolean).join(', ');
      const target = options.Key || options.Prefix || options.Objects?.[0]?.Key || '';
      reject(new Error(`COS ${method}${target ? ` ${target}` : ''} failed: ${details || String(error)}`, { cause: error }));
    });
  });
}

function getVersionFromKey(key) {
  const match = /^releases\/(v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\//.exec(key);
  return match?.[1] || '';
}

function compareVersions(left, right) {
  const leftVersion = parseVersion(left);
  const rightVersion = parseVersion(right);
  for (let index = 0; index < 3; index++) {
    const comparison = compareNumericStrings(leftVersion.numbers[index], rightVersion.numbers[index]);
    if (comparison) return comparison;
  }
  if (leftVersion.prerelease.length === 0 && rightVersion.prerelease.length > 0) return 1;
  if (leftVersion.prerelease.length > 0 && rightVersion.prerelease.length === 0) return -1;
  return comparePrerelease(leftVersion.prerelease, rightVersion.prerelease);
}

function parseVersion(version) {
  const match = COS_VERSION_PATTERN.exec(String(version || ''));
  if (!match) throw new Error(`Invalid COS release version: ${version}`);
  return {
    numbers: match.slice(1, 4),
    prerelease: match[4] ? match[4].split('.') : []
  };
}

function getHeader(result, name) {
  const headers = result?.headers || result?.Headers || {};
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return entry ? String(entry[1]) : '';
}

function hashBuffer(buffer) {
  return createHash('sha512').update(buffer).digest('hex');
}

async function hashFile(filePath) {
  const hash = createHash('sha512');
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

function compareNumericStrings(left, right) {
  if (left.length !== right.length) return left.length - right.length;
  return left < right ? -1 : left > right ? 1 : 0;
}

function comparePrerelease(left, right) {
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    if (left[index] === undefined) return -1;
    if (right[index] === undefined) return 1;
    if (left[index] === right[index]) continue;
    const leftNumber = /^\d+$/.test(left[index]);
    const rightNumber = /^\d+$/.test(right[index]);
    if (leftNumber && rightNumber) return compareNumericStrings(left[index], right[index]);
    if (leftNumber !== rightNumber) return leftNumber ? -1 : 1;
    return left[index] < right[index] ? -1 : 1;
  }
  return 0;
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
  if (options.pruneOnly) {
    await publisher.pruneOldVersions();
    return;
  }
  const result = await publisher.publish(options);
  console.log(`Published ${options.files.length} artifact(s) to ${result.publicRoot}/${result.versionPrefix}/`);
}

if (require.main === module) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { compareVersions, createCosPublisher, getVersionFromKey, parseArguments };
