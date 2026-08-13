'use strict';

function escapeCsv(value) {
  return `"${String(value ?? '').replace(/"/g, '""')}"`;
}

function buildChartCsv(samples, fields) {
  const rows = [
    ['timestamp', 'sequence', ...fields.map(field => field.label || field.key)],
    ...samples.map(sample => [
      new Date(sample.originalTimestamp ?? sample.timestamp).toISOString(),
      sample.sequence ?? '',
      ...fields.map(field => sample.values[field.key] ?? '')
    ])
  ];
  return `\uFEFF${rows.map(row => row.map(escapeCsv).join(',')).join('\r\n')}`;
}

module.exports = { buildChartCsv };
