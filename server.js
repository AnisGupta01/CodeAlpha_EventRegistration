'use strict';
const crypto = require('node:crypto');
const path = require('node:path');
const { openDb } = require('./src/db');
const { createApp } = require('./src/app');

let secret = process.env.JWT_SECRET;
if (!secret) {
  secret = crypto.randomBytes(32).toString('hex');
  console.warn('JWT_SECRET is not set: using a random secret. Logins will be invalidated on every restart.');
}

const dbFile = process.env.DATABASE_PATH || path.join(__dirname, 'events.db');
const db = openDb(dbFile);
const port = Number(process.env.PORT) || 3000;

createApp({ db, secret }).listen(port, () => {
  console.log(`Event Registration API running on http://localhost:${port}`);
});
