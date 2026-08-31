'use strict';

const IDENTIFIER = '(?:0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)';
const RELEASE_TAG_PATTERN = new RegExp(`^v(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)(?:-(${IDENTIFIER}(?:\\.${IDENTIFIER})*))?$`);
const MAX_SEMVER_LENGTH = 256;
const MAX_SAFE_VERSION_NUMBER = BigInt(Number.MAX_SAFE_INTEGER);

function parseReleaseTag(value) {
  const tag = String(value || '');
  const version = tag.slice(1);
  const match = version.length <= MAX_SEMVER_LENGTH ? RELEASE_TAG_PATTERN.exec(tag) : null;
  if (!match) throw new Error(`Invalid release tag: ${value}`);
  if (match.slice(1, 4).some(part => BigInt(part) > MAX_SAFE_VERSION_NUMBER)) {
    throw new Error(`Invalid release tag: ${value}`);
  }
  return {
    tag,
    version,
    prerelease: Boolean(match[4]),
    prereleaseIdentifiers: match[4] ? match[4].split('.') : []
  };
}

function compareReleaseTags(left, right) {
  const leftTag = parseReleaseTag(left);
  const rightTag = parseReleaseTag(right);
  const leftNumbers = leftTag.version.split('-')[0].split('.').map(Number);
  const rightNumbers = rightTag.version.split('-')[0].split('.').map(Number);
  for (let index = 0; index < 3; index++) {
    if (leftNumbers[index] !== rightNumbers[index]) return leftNumbers[index] - rightNumbers[index];
  }
  const leftPrerelease = leftTag.prereleaseIdentifiers;
  const rightPrerelease = rightTag.prereleaseIdentifiers;
  if (leftPrerelease.length === 0 && rightPrerelease.length > 0) return 1;
  if (leftPrerelease.length > 0 && rightPrerelease.length === 0) return -1;
  for (let index = 0; index < Math.max(leftPrerelease.length, rightPrerelease.length); index++) {
    const leftPart = leftPrerelease[index];
    const rightPart = rightPrerelease[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    if (leftPart === rightPart) continue;
    const leftNumeric = /^\d+$/.test(leftPart);
    const rightNumeric = /^\d+$/.test(rightPart);
    if (leftNumeric && rightNumeric) {
      if (leftPart.length !== rightPart.length) return leftPart.length - rightPart.length;
      return leftPart < rightPart ? -1 : 1;
    }
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}

if (require.main === module) {
  try {
    parseReleaseTag(process.argv[2]);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { compareReleaseTags, parseReleaseTag };
