'use strict';
// HTTP-level tests: start the real Express app on a random port and call it with fetch.
// Skipped automatically if Express is not installed (run `npm install` first).
const test = require('node:test');
const assert = require('node:assert/strict');

let hasExpress = true;
try {
  require.resolve('express');
} catch {
  hasExpress = false;
}

test('HTTP API end-to-end', { skip: !hasExpress && 'express is not installed (run npm install)' }, async (t) => {
  const { openDb } = require('../src/db');
  const { createApp } = require('../src/app');
  const { createUser } = require('../src/services');

  const db = openDb(':memory:');
  createUser(db, { name: 'Org', email: 'org@example.com', password: 'password123', role: 'organizer' });
  const app = createApp({ db, secret: 'test-secret' });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  const call = async (method, path, { token, body, raw } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: {
        ...(body !== undefined || raw !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, json: await res.json() };
  };

  assert.equal((await call('GET', '/health')).status, 200);
  assert.equal((await call('GET', '/nope')).status, 404);
  assert.equal((await call('POST', '/api/auth/login', { raw: '{bad json' })).status, 400);

  const reg = await call('POST', '/api/auth/register', {
    body: { name: 'Alice', email: 'alice@example.com', password: 'password123' },
  });
  assert.equal(reg.status, 201);
  const alice = reg.json.token;

  const org = (await call('POST', '/api/auth/login', { body: { email: 'org@example.com', password: 'password123' } })).json.token;
  assert.ok(org);

  assert.equal((await call('GET', '/api/auth/me')).status, 401);
  assert.equal((await call('GET', '/api/auth/me', { token: 'bad' })).status, 401);
  assert.equal((await call('GET', '/api/auth/me', { token: alice })).json.user.email, 'alice@example.com');

  const eventBody = {
    title: 'Workshop',
    location: 'Lucknow',
    event_date: new Date(Date.now() + 5 * 86400000).toISOString(),
    capacity: 1,
  };
  assert.equal((await call('POST', '/api/events', { token: alice, body: eventBody })).status, 403);
  const created = await call('POST', '/api/events', { token: org, body: eventBody });
  assert.equal(created.status, 201);
  const id = created.json.event.id;

  assert.equal((await call('GET', '/api/events')).json.events.length, 1);
  assert.equal((await call('GET', `/api/events/${id}`)).json.event.spots_left, 1);

  const joined = await call('POST', `/api/events/${id}/register`, { token: alice });
  assert.equal(joined.status, 201);
  assert.equal((await call('POST', `/api/events/${id}/register`, { token: alice })).status, 409);

  const mine = await call('GET', '/api/registrations', { token: alice });
  assert.equal(mine.json.registrations.length, 1);

  const regId = joined.json.registration.id;
  assert.equal((await call('GET', `/api/events/${id}/registrations`, { token: alice })).status, 403);
  assert.equal((await call('GET', `/api/events/${id}/registrations`, { token: org })).json.registrations.length, 1);

  assert.equal((await call('DELETE', `/api/registrations/${regId}`, { token: alice })).status, 200);
  assert.equal((await call('GET', '/api/registrations', { token: alice })).json.registrations.length, 0);

  assert.equal((await call('PUT', `/api/events/${id}`, { token: org, body: { title: 'Renamed' } })).json.event.title, 'Renamed');
  assert.equal((await call('DELETE', `/api/events/${id}`, { token: org })).status, 200);
  assert.equal((await call('GET', `/api/events/${id}`)).status, 404);
});
