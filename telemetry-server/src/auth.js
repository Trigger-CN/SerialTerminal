'use strict';

const { randomBytes, scrypt: scryptCallback, timingSafeEqual, createHash } = require('crypto');
const { promisify } = require('util');

const scrypt = promisify(scryptCallback);

function hashToken(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function hashPassword(password) {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${derived.toString('hex')}`;
}

async function verifyPassword(password, encoded) {
  const [algorithm, saltHex, hashHex] = String(encoded || '').split('$');
  if (algorithm !== 'scrypt' || !/^[0-9a-f]{32}$/i.test(saltHex || '') || !/^[0-9a-f]{128}$/i.test(hashHex || '')) {
    return false;
  }
  const expected = Buffer.from(hashHex, 'hex');
  const actual = await scrypt(password, Buffer.from(saltHex, 'hex'), expected.length);
  return timingSafeEqual(actual, expected);
}

function createSessionCredentials() {
  const token = randomBytes(32).toString('base64url');
  const csrf = randomBytes(32).toString('base64url');
  return { token, csrf, tokenHash: hashToken(token), csrfHash: hashToken(csrf) };
}

module.exports = { hashPassword, verifyPassword, hashToken, createSessionCredentials };
