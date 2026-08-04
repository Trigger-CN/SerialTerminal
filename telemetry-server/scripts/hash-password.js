'use strict';

const { hashPassword } = require('../src/auth');

const password = process.argv[2];
if (!password || password.length < 12) {
  console.error('Usage: npm run password -- "a password with at least 12 characters"');
  process.exitCode = 1;
} else {
  hashPassword(password).then(console.log, error => {
    console.error(error);
    process.exitCode = 1;
  });
}
