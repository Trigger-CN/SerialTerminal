'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash, timingSafeEqual } = require('node:crypto');
const yaml = require('js-yaml');

function getArtifactName(value) {
  try {
    return path.posix.basename(new URL(String(value)).pathname);
  } catch {
    return path.basename(String(value || ''));
  }
}

async function sha512File(filePath) {
  const hash = createHash('sha512');
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk);
  return hash.digest();
}

async function verifyUpdateArtifacts({ metadataPath, installerPath, expectedVersion }) {
  const metadata = yaml.load(await fs.promises.readFile(metadataPath, 'utf8'));
  if (!metadata || typeof metadata !== 'object' || metadata.version !== expectedVersion) {
    throw new Error(`Update metadata version must be ${expectedVersion}`);
  }
  const installerName = path.basename(installerPath);
  const file = Array.isArray(metadata.files)
    ? metadata.files.find(item => getArtifactName(item?.url || item?.name) === installerName)
    : null;
  const legacyMatches = getArtifactName(metadata.path) === installerName;
  const checksum = file?.sha512 || (legacyMatches ? metadata.sha512 : '');
  if (typeof checksum !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(checksum)) {
    throw new Error(`Update metadata has no valid SHA-512 for ${installerName}`);
  }
  const expected = Buffer.from(checksum, 'base64');
  const actual = await sha512File(installerPath);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new Error(`SHA-512 mismatch for ${installerName}`);
  }
  const expectedSize = file?.size;
  if (Number.isSafeInteger(expectedSize)) {
    const { size } = await fs.promises.stat(installerPath);
    if (size !== expectedSize) throw new Error(`Size mismatch for ${installerName}: expected ${expectedSize}, received ${size}`);
  }
  return metadata;
}

function parseArguments(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!name?.startsWith('--') || !value) throw new Error(`Invalid argument: ${name || ''}`);
    options[name.slice(2)] = value;
  }
  for (const name of ['metadata', 'installer', 'version']) {
    if (!options[name]) throw new Error(`Missing --${name}`);
  }
  return options;
}

if (require.main === module) {
  (async () => {
    const options = parseArguments(process.argv.slice(2));
    await verifyUpdateArtifacts({
      metadataPath: options.metadata,
      installerPath: options.installer,
      expectedVersion: options.version
    });
  })().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { getArtifactName, parseArguments, sha512File, verifyUpdateArtifacts };
