'use strict';

const { validateUpdateMetadataUrl } = require('../src/server');

const allowedHosts = process.env.UPDATE_METADATA_HOSTS || undefined;
const entryUrl = 'https://trigger-cn.top/serialterminal/latest.yml';
const invalid = process.argv.slice(2).filter(value => {
  if (!validateUpdateMetadataUrl(value, allowedHosts)) return true;
  try {
    const candidate = new URL(value);
    const entry = new URL(entryUrl);
    return candidate.origin === entry.origin && candidate.pathname === entry.pathname;
  } catch {
    return true;
  }
});

if (invalid.length) {
  console.error(`Enabled update policies use disallowed metadata URLs: ${invalid.join(', ')}`);
  console.error('Add the required origins to UPDATE_METADATA_HOSTS before deploying.');
  process.exitCode = 1;
}
