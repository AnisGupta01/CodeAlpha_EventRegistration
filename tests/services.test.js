'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../src/db');
const { HttpError } = require('../src/errors');
const auth = require('../src/auth');
const s = require('../src/services');

const SECRET = 'test-secret';
const future = (days = 10) => new Date(Date.now() + days * 86400000).toISOString();
const past = (days = 10) => new Date(Date.now() - days * 86400000).toISOString();

function setup() {
  const db = openDb(':memory:');
  const ctx = (extra = {}) => ({ db, secret: SECRET, user: null, params: {}, query: {}, body: {}, ...extra });
  const signup = (name, email) =>
    s.register(ctx({ body: { name, email, password: 'password123' } })).body;
  const alice = signup('Alice', 'alice@example.com');
  const bob = signup('Bob', 'bob@example.com');
  const organizer = s.createUser(db, {
    name: 'Org',
    email: 'org@example.com',
    password: 'password123',
    role: 'organizer',
  });
  const orgUser = { id: organizer.id, name: organizer.name, email: organizer.email, role: 'organizer' };
  return { db, ctx, alice: alice.user, bob: bob.user, organizer: orgUser, aliceToken: alice.token };
}

function status(fn) {
  try {
    fn();
    return null;
  } catch (e) {
    assert.ok(e instanceof HttpError, `expected HttpError, got ${e && e.stack}`);
    return e.status;
  }
}

function makeEvent(t, extra = {}) {
  return s.createEvent(
    t.ctx({
      user: t.organizer,
      body: { title: 'Workshop', description: 'desc', location: 'Lucknow', event_date: future(), capacity: 2, ...extra },
    })
  ).body.event;
}

// ---------- auth ----------
test('password hashing verifies correct and rejects wrong passwords', () => {
  const stored = auth.hashPassword('s3cret-pass');
  assert.ok(stored.startsWith('scrypt$'));
  assert.ok(auth.verifyPassword('s3cret-pass', stored));
  assert.ok(!auth.verifyPassword('wrong', stored));
  assert.notEqual(auth.hashPassword('s3cret-pass'), stored); // unique salt
});

test('JWT: valid token round-trips, tampering/expiry/wrong secret are rejected', () => {
  const token = auth.signToken({ sub: 7 }, SECRET);
  assert.equal(auth.verifyToken(token, SECRET).sub, 7);
  assert.equal(auth.verifyToken(token, 'other-secret'), null);
  assert.equal(auth.verifyToken(token + 'x', SECRET), null);
  const [h, , sig] = token.split('.');
  const forged = Buffer.from(JSON.stringify({ sub: 1, exp: 9999999999 })).toString('base64url');
  assert.equal(auth.verifyToken(`${h}.${forged}.${sig}`, SECRET), null);
  assert.equal(auth.verifyToken(auth.signToken({ sub: 7 }, SECRET, -10), SECRET), null);
  assert.equal(auth.verifyToken('garbage', SECRET), null);
  assert.equal(auth.verifyToken(undefined, SECRET), null);
});

test('authenticate: anonymous, bad header, bad token, valid token', () => {
  const t = setup();
  assert.equal(auth.authenticate(t.db, SECRET, undefined), null);
  assert.equal(status(() => auth.authenticate(t.db, SECRET, 'Token abc')), 401);
  assert.equal(status(() => auth.authenticate(t.db, SECRET, 'Bearer nope')), 401);
  const user = auth.authenticate(t.db, SECRET, `Bearer ${t.aliceToken}`);
  assert.equal(user.email, 'alice@example.com');
  assert.equal(user.password_hash, undefined);
});

test('register: validation, duplicate email, never grants organizer role', () => {
  const t = setup();
  assert.equal(status(() => s.register(t.ctx({ body: { name: 'A', email: 'bad', password: 'short' } }))), 400);
  assert.equal(status(() => s.register(t.ctx({ body: undefined }))), 400);
  assert.equal(
    status(() => s.register(t.ctx({ body: { name: 'Alice 2', email: 'ALICE@example.com', password: 'password123' } }))),
    409
  );
  const res = s.register(
    t.ctx({ body: { name: 'Eve', email: 'eve@example.com', password: 'password123', role: 'organizer' } })
  );
  assert.equal(res.status, 201);
  assert.equal(res.body.user.role, 'user');
  assert.ok(res.body.token);
  assert.equal(res.body.user.password_hash, undefined);
});

test('login: success (case-insensitive email) and failures', () => {
  const t = setup();
  const ok = s.login(t.ctx({ body: { email: 'Alice@Example.com', password: 'password123' } }));
  assert.equal(ok.status, 200);
  assert.ok(auth.verifyToken(ok.body.token, SECRET));
  assert.equal(status(() => s.login(t.ctx({ body: { email: 'alice@example.com', password: 'wrongpass1' } }))), 401);
  assert.equal(status(() => s.login(t.ctx({ body: { email: 'nobody@example.com', password: 'password123' } }))), 401);
  assert.equal(status(() => s.login(t.ctx({ body: {} }))), 400);
});

test('me requires login', () => {
  const t = setup();
  assert.equal(status(() => s.me(t.ctx())), 401);
  assert.equal(s.me(t.ctx({ user: t.alice })).body.user.email, 'alice@example.com');
});

// ---------- events ----------
test('only organizers can create/update/delete events', () => {
  const t = setup();
  const body = { title: 'X', location: 'Y', event_date: future(), capacity: 5 };
  assert.equal(status(() => s.createEvent(t.ctx({ body }))), 401);
  assert.equal(status(() => s.createEvent(t.ctx({ user: t.alice, body }))), 403);
  const ev = makeEvent(t);
  assert.equal(status(() => s.updateEvent(t.ctx({ user: t.alice, params: { id: ev.id }, body: { title: 'Z' } }))), 403);
  assert.equal(status(() => s.deleteEvent(t.ctx({ user: t.alice, params: { id: ev.id } }))), 403);
});

test('createEvent validates input', () => {
  const t = setup();
  const create = (body) => s.createEvent(t.ctx({ user: t.organizer, body }));
  const good = { title: 'T', location: 'L', event_date: future(), capacity: 10 };
  assert.equal(create(good).status, 201);
  assert.equal(status(() => create({ ...good, title: '' })), 400);
  assert.equal(status(() => create({ ...good, location: '' })), 400);
  assert.equal(status(() => create({ ...good, event_date: 'not-a-date' })), 400);
  assert.equal(status(() => create({ ...good, event_date: past() })), 400);
  assert.equal(status(() => create({ ...good, capacity: 0 })), 400);
  assert.equal(status(() => create({ ...good, capacity: 1.5 })), 400);
  assert.equal(status(() => create({ ...good, capacity: '10' })), 400);
  const { capacity, ...noCap } = good;
  assert.equal(create(noCap).body.event.capacity, 100); // default
});

test('list/get events with search, upcoming filter, counts', () => {
  const t = setup();
  const a = makeEvent(t, { title: 'Node workshop', location: 'Delhi' });
  makeEvent(t, { title: 'Python meetup', location: 'Lucknow' });
  // an event in the past, inserted directly
  t.db
    .prepare('INSERT INTO events (title, description, location, event_date, capacity, created_by, created_at) VALUES (?,?,?,?,?,?,?)')
    .run('Old talk', '', 'Mumbai', past(), 10, t.organizer.id, new Date().toISOString());

  assert.equal(s.listEvents(t.ctx()).body.events.length, 3);
  assert.equal(s.listEvents(t.ctx({ query: { upcoming: 'true' } })).body.events.length, 2);
  assert.deepEqual(s.listEvents(t.ctx({ query: { search: 'python' } })).body.events.map((e) => e.title), ['Python meetup']);
  assert.deepEqual(s.listEvents(t.ctx({ query: { search: 'delhi' } })).body.events.map((e) => e.id), [a.id]);
  assert.equal(s.listEvents(t.ctx({ query: { search: '%' } })).body.events.length, 0); // wildcard is escaped
  assert.equal(s.listEvents(t.ctx({ query: { limit: '1' } })).body.events.length, 1);

  const one = s.getEvent(t.ctx({ params: { id: String(a.id) } })).body.event;
  assert.equal(one.registered_count, 0);
  assert.equal(one.spots_left, 2);
  assert.equal(status(() => s.getEvent(t.ctx({ params: { id: '9999' } }))), 404);
  assert.equal(status(() => s.getEvent(t.ctx({ params: { id: 'abc' } }))), 400);
});

test('updateEvent: partial update, validation, capacity cannot drop below registrations', () => {
  const t = setup();
  const ev = makeEvent(t, { capacity: 3 });
  s.registerForEvent(t.ctx({ user: t.alice, params: { id: ev.id } }));
  s.registerForEvent(t.ctx({ user: t.bob, params: { id: ev.id } }));

  const upd = (body) => s.updateEvent(t.ctx({ user: t.organizer, params: { id: ev.id }, body }));
  const res = upd({ title: 'Renamed' });
  assert.equal(res.body.event.title, 'Renamed');
  assert.equal(res.body.event.location, 'Lucknow'); // untouched
  assert.equal(upd({ capacity: 10 }).body.event.spots_left, 8);
  assert.equal(status(() => upd({ capacity: 1 })), 400);
  assert.equal(status(() => upd({})), 400);
  assert.equal(status(() => upd({ event_date: 'nope' })), 400);
  assert.equal(
    status(() => s.updateEvent(t.ctx({ user: t.organizer, params: { id: '999' }, body: { title: 'x' } }))),
    404
  );
});

// ---------- registrations ----------
test('register for event, duplicate blocked, counts update', () => {
  const t = setup();
  const ev = makeEvent(t);
  assert.equal(status(() => s.registerForEvent(t.ctx({ params: { id: ev.id } }))), 401);

  const res = s.registerForEvent(t.ctx({ user: t.alice, params: { id: String(ev.id) } }));
  assert.equal(res.status, 201);
  assert.equal(res.body.registration.status, 'registered');
  assert.equal(res.body.registration.user_id, t.alice.id);
  assert.equal(status(() => s.registerForEvent(t.ctx({ user: t.alice, params: { id: ev.id } }))), 409);

  const after = s.getEvent(t.ctx({ params: { id: ev.id } })).body.event;
  assert.equal(after.registered_count, 1);
  assert.equal(after.spots_left, 1);
  assert.equal(status(() => s.registerForEvent(t.ctx({ user: t.alice, params: { id: 999 } }))), 404);
});

test('full event rejects new registrations; cancelling frees a spot', () => {
  const t = setup();
  const ev = makeEvent(t, { capacity: 1 });
  const first = s.registerForEvent(t.ctx({ user: t.alice, params: { id: ev.id } })).body.registration;
  assert.equal(status(() => s.registerForEvent(t.ctx({ user: t.bob, params: { id: ev.id } }))), 409);

  s.cancelRegistration(t.ctx({ user: t.alice, params: { id: first.id } }));
  assert.equal(s.registerForEvent(t.ctx({ user: t.bob, params: { id: ev.id } })).status, 201);
  // Alice cannot get back in now that Bob took the spot
  assert.equal(status(() => s.registerForEvent(t.ctx({ user: t.alice, params: { id: ev.id } }))), 409);
});

test('cannot register for an event that already happened', () => {
  const t = setup();
  const id = t.db
    .prepare('INSERT INTO events (title, description, location, event_date, capacity, created_by, created_at) VALUES (?,?,?,?,?,?,?)')
    .run('Old', '', 'X', past(), 5, t.organizer.id, new Date().toISOString()).lastInsertRowid;
  assert.equal(status(() => s.registerForEvent(t.ctx({ user: t.alice, params: { id } }))), 400);
});

test('my registrations: view, filter, cancel, re-register reuses the row', () => {
  const t = setup();
  const e1 = makeEvent(t, { title: 'E1' });
  const e2 = makeEvent(t, { title: 'E2' });
  const r1 = s.registerForEvent(t.ctx({ user: t.alice, params: { id: e1.id } })).body.registration;
  s.registerForEvent(t.ctx({ user: t.alice, params: { id: e2.id } }));
  s.registerForEvent(t.ctx({ user: t.bob, params: { id: e1.id } }));

  assert.equal(status(() => s.myRegistrations(t.ctx())), 401);
  const mine = s.myRegistrations(t.ctx({ user: t.alice })).body.registrations;
  assert.equal(mine.length, 2);
  assert.equal(mine[0].event.title.startsWith('E'), true);

  const cancelled = s.cancelRegistration(t.ctx({ user: t.alice, params: { id: r1.id } }));
  assert.equal(cancelled.body.registration.status, 'cancelled');
  assert.ok(cancelled.body.registration.cancelled_at);
  assert.equal(status(() => s.cancelRegistration(t.ctx({ user: t.alice, params: { id: r1.id } }))), 409);

  assert.equal(s.myRegistrations(t.ctx({ user: t.alice })).body.registrations.length, 1);
  assert.equal(s.myRegistrations(t.ctx({ user: t.alice, query: { status: 'cancelled' } })).body.registrations.length, 1);
  assert.equal(s.myRegistrations(t.ctx({ user: t.alice, query: { status: 'all' } })).body.registrations.length, 2);
  assert.equal(status(() => s.myRegistrations(t.ctx({ user: t.alice, query: { status: 'bogus' } }))), 400);

  const again = s.registerForEvent(t.ctx({ user: t.alice, params: { id: e1.id } })).body.registration;
  assert.equal(again.id, r1.id);
  assert.equal(again.status, 'registered');
  assert.equal(again.cancelled_at, null);
});

test('users cannot cancel other users registrations; organizers can', () => {
  const t = setup();
  const ev = makeEvent(t);
  const reg = s.registerForEvent(t.ctx({ user: t.alice, params: { id: ev.id } })).body.registration;
  assert.equal(status(() => s.cancelRegistration(t.ctx({ user: t.bob, params: { id: reg.id } }))), 403);
  assert.equal(status(() => s.cancelRegistration(t.ctx({ params: { id: reg.id } }))), 401);
  assert.equal(status(() => s.cancelRegistration(t.ctx({ user: t.alice, params: { id: 9999 } }))), 404);
  assert.equal(s.cancelRegistration(t.ctx({ user: t.organizer, params: { id: reg.id } })).status, 200);
});

test('organizer sees attendee list; normal users do not', () => {
  const t = setup();
  const ev = makeEvent(t);
  s.registerForEvent(t.ctx({ user: t.alice, params: { id: ev.id } }));
  const bobReg = s.registerForEvent(t.ctx({ user: t.bob, params: { id: ev.id } })).body.registration;
  s.cancelRegistration(t.ctx({ user: t.bob, params: { id: bobReg.id } }));

  assert.equal(status(() => s.eventRegistrations(t.ctx({ user: t.alice, params: { id: ev.id } }))), 403);
  const list = s.eventRegistrations(t.ctx({ user: t.organizer, params: { id: ev.id } })).body.registrations;
  assert.deepEqual(list.map((r) => r.user.email), ['alice@example.com']);
  assert.equal(
    s.eventRegistrations(t.ctx({ user: t.organizer, params: { id: ev.id }, query: { status: 'all' } })).body.registrations.length,
    2
  );
});

test('deleting an event removes its registrations', () => {
  const t = setup();
  const ev = makeEvent(t);
  s.registerForEvent(t.ctx({ user: t.alice, params: { id: ev.id } }));
  assert.equal(s.deleteEvent(t.ctx({ user: t.organizer, params: { id: ev.id } })).status, 200);
  assert.equal(t.db.prepare('SELECT COUNT(*) AS c FROM registrations').get().c, 0);
  assert.equal(status(() => s.getEvent(t.ctx({ params: { id: ev.id } }))), 404);
  assert.equal(status(() => s.deleteEvent(t.ctx({ user: t.organizer, params: { id: ev.id } }))), 404);
});
