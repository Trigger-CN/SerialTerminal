'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { hashPassword, verifyPassword, createSessionCredentials, hashToken } = require('../src/auth');

test('administrator passwords use salted scrypt hashes', async () => {
  const encoded = await hashPassword('correct horse battery staple');

  assert.match(encoded, /^scrypt\$[0-9a-f]{32}\$[0-9a-f]{128}$/);
  assert.equal(await verifyPassword('correct horse battery staple', encoded), true);
  assert.equal(await verifyPassword('wrong password', encoded), false);
});

test('session credentials expose random tokens but store only hashes', () => {
  const session = createSessionCredentials();

  assert.notEqual(session.token, session.tokenHash);
  assert.notEqual(session.csrf, session.csrfHash);
  assert.equal(hashToken(session.token), session.tokenHash);
  assert.equal(hashToken(session.csrf), session.csrfHash);
});
