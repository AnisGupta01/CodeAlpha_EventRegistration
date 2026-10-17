'use strict';
// Creates an organizer account and a few sample events.
// Usage: ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='StrongPass123' npm run seed
const path = require('node:path');
const { openDb } = require('../src/db');
const { createUser } = require('../src/services');

const email = (process.env.ADMIN_EMAIL || 'organizer@example.com').toLowerCase();
const password = process.env.ADMIN_PASSWORD || 'Organizer@123';
if (!process.env.ADMIN_PASSWORD) {
  console.warn('ADMIN_PASSWORD not set: using the default demo password. Change it for anything real.');
}

const db = openDb(process.env.DATABASE_PATH || path.join(__dirname, '..', 'events.db'));

let organizer = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
if (organizer) {
  db.prepare("UPDATE users SET role = 'organizer' WHERE id = ?").run(organizer.id);
  console.log(`Existing user ${email} is now an organizer.`);
} else {
  organizer = createUser(db, { name: 'Event Organizer', email, password, role: 'organizer' });
  console.log(`Created organizer ${email}`);
}

if (db.prepare('SELECT COUNT(*) AS c FROM events').get().c === 0) {
  const inDays = (d) => new Date(Date.now() + d * 24 * 60 * 60 * 1000).toISOString();
  const insert = db.prepare(
    `INSERT INTO events (title, description, location, event_date, capacity, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  const now = new Date().toISOString();
  insert.run('Intro to Backend Development', 'Hands-on workshop on REST APIs and databases.', 'Lucknow', inDays(7), 50, organizer.id, now);
  insert.run('Hackathon 2026', '24-hour build-a-thon for students.', 'Online', inDays(21), 200, organizer.id, now);
  insert.run('Resume & LinkedIn Clinic', 'Get feedback on your resume and profile.', 'Online', inDays(14), 30, organizer.id, now);
  console.log('Added 3 sample events.');
}
