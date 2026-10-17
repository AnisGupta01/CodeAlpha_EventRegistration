'use strict';
// Self-running demo for screen recordings:  npm run demo
// Starts the real Express app on a temporary in-memory database, then walks through the
// whole flow with real HTTP calls, pausing between steps so the output is easy to follow.
const { openDb } = require('../src/db');
const { createApp } = require('../src/app');
const { createUser } = require('../src/services');

const PAUSE_MS = Number(process.env.DEMO_PAUSE_MS ?? 2500);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const C = { cyan: '\x1b[36m', green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', dim: '\x1b[2m', bold: '\x1b[1m', off: '\x1b[0m' };

async function main() {
  const db = openDb(':memory:');
  createUser(db, { name: 'Event Organizer', email: 'organizer@example.com', password: 'Organizer@123', role: 'organizer' });
  const app = createApp({ db, secret: 'demo-secret' });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  let step = 0;
  async function call(title, method, path, { token, body } = {}) {
    step += 1;
    console.log(`\n${C.bold}${C.cyan}Step ${step}: ${title}${C.off}`);
    console.log(`${C.yellow}${method} ${path}${C.off}${token ? C.dim + '   (Authorization: Bearer <token>)' + C.off : ''}`);
    if (body) console.log(C.dim + JSON.stringify(body) + C.off);
    await sleep(PAUSE_MS / 2);
    const res = await fetch(base + path, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json();
    const color = res.status < 400 ? C.green : C.red;
    console.log(`${color}-> ${res.status}${C.off}`);
    console.log(JSON.stringify(json, null, 2).split('\n').slice(0, 24).join('\n'));
    await sleep(PAUSE_MS);
    return json;
  }

  console.log(`${C.bold}CodeAlpha Backend Internship | Task 2: Event Registration System (Express + SQLite)${C.off}`);
  await sleep(PAUSE_MS);

  const org = await call('Organizer logs in', 'POST', '/api/auth/login', {
    body: { email: 'organizer@example.com', password: 'Organizer@123' },
  });

  const soon = new Date(Date.now() + 7 * 86400000).toISOString();
  const created = await call('Organizer creates an event (capacity 1)', 'POST', '/api/events', {
    token: org.token,
    body: { title: 'Intro to Backend Development', description: 'Hands-on REST API workshop', location: 'Lucknow', event_date: soon, capacity: 1 },
  });
  const eventId = created.event.id;

  const anish = await call('A new user signs up', 'POST', '/api/auth/register', {
    body: { name: 'Anish Gupta', email: 'anish@example.com', password: 'password123' },
  });
  const friend = await call('A second user signs up', 'POST', '/api/auth/register', {
    body: { name: 'Friend', email: 'friend@example.com', password: 'password123' },
  });

  await call('Anyone can browse events', 'GET', '/api/events');
  const reg = await call('User registers for the event', 'POST', `/api/events/${eventId}/register`, { token: anish.token });
  await call('Registering twice is blocked (409)', 'POST', `/api/events/${eventId}/register`, { token: anish.token });
  await call('Event is full for the second user (409)', 'POST', `/api/events/${eventId}/register`, { token: friend.token });
  await call('User views their registrations', 'GET', '/api/registrations', { token: anish.token });
  await call('Normal users cannot see attendees (403)', 'GET', `/api/events/${eventId}/registrations`, { token: anish.token });
  await call('Organizer views the attendee list', 'GET', `/api/events/${eventId}/registrations`, { token: org.token });
  await call('User cancels the registration', 'DELETE', `/api/registrations/${reg.registration.id}`, { token: anish.token });
  await call('The spot is free again: second user registers', 'POST', `/api/events/${eventId}/register`, { token: friend.token });

  console.log(`\n${C.bold}${C.green}Demo complete.${C.off}`);
  server.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
