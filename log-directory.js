'use strict';

const path = require('node:path');

function formatLocalDate(date = new Date()) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0')
  ].join('-');
}

function getLogDirectory(basePath, createDateFolder, date = new Date()) {
  return createDateFolder ? path.join(basePath, formatLocalDate(date)) : basePath;
}

module.exports = { formatLocalDate, getLogDirectory };
