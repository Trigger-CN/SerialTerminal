'use strict';

const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required');
  process.exitCode = 1;
} else {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  pool.query("DELETE FROM device_activity WHERE activity_date < CURRENT_DATE - 90")
    .then(result => console.log(`Deleted ${result.rowCount} expired activity rows`))
    .finally(() => pool.end());
}
