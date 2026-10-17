'use strict';
// Business logic. Every function takes one `ctx` object:
//   { db, secret, user, params, query, body }
// and returns { status, body } or throws HttpError. Express is only a thin adapter
// around these functions (see app.js), which keeps the logic easy to test.
const { HttpError } = require('./errors');
const { hashPassword, verifyPassword, signToken } = require('./auth');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_CAPACITY = 100000;
const DEFAULT_CAPACITY = 100;

const ok = (body, status = 200) => ({ status, body });
const nowIso = () => new Date().toISOString();
const text = (v) => (typeof v === 'string' ? v.trim() : '');

// ---------- helpers ----------
function requireUser(user) {
  if (!user) throw new HttpError(401, 'Authentication required. Send "Authorization: Bearer <token>".');
  return user;
}

function requireOrganizer(user) {
  requireUser(user);
  if (user.role !== 'organizer') throw new HttpError(403, 'Only event organizers can do this.');
  return user;
}

function parseId(value, label = 'id') {
  if (!/^\d+$/.test(String(value)) || Number(value) < 1) {
    throw new HttpError(400, `Invalid ${label}.`);
  }
  return Number(value);
}

function publicUser(u) {
  return { id: u.id, name: u.name, email: u.email, role: u.role };
}

const EVENT_SELECT = `
  SELECT e.*,
    (SELECT COUNT(*) FROM registrations r
       WHERE r.event_id = e.id AND r.status = 'registered') AS registered_count
  FROM events e`;

function shapeEvent(row) {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    location: row.location,
    event_date: row.event_date,
    capacity: row.capacity,
    registered_count: row.registered_count,
    spots_left: Math.max(row.capacity - row.registered_count, 0),
    created_by: row.created_by,
    created_at: row.created_at,
  };
}

function findEvent(db, id) {
  const row = db.prepare(`${EVENT_SELECT} WHERE e.id = ?`).get(id);
  if (!row) throw new HttpError(404, 'Event not found.');
  return row;
}

function shapeRegistration(row) {
  return {
    id: row.id,
    event_id: row.event_id,
    user_id: row.user_id,
    status: row.status,
    registered_at: row.registered_at,
    cancelled_at: row.cancelled_at,
  };
}

// ---------- users / auth ----------
function createUser(db, { name, email, password, role = 'user' }) {
  const result = db
    .prepare('INSERT INTO users (name, email, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(name, email, hashPassword(password), role, nowIso());
  return db.prepare('SELECT * FROM users WHERE id = ?').get(result.lastInsertRowid);
}

function register({ db, secret, body }) {
  const input = body || {};
  const name = text(input.name);
  const email = text(input.email).toLowerCase();
  const password = typeof input.password === 'string' ? input.password : '';

  const errors = [];
  if (name.length < 2 || name.length > 100) errors.push('name must be 2-100 characters.');
  if (!EMAIL_RE.test(email) || email.length > 254) errors.push('email must be a valid email address.');
  if (password.length < 8 || password.length > 128) errors.push('password must be 8-128 characters.');
  if (errors.length) throw new HttpError(400, 'Validation failed.', errors);

  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) {
    throw new HttpError(409, 'An account with this email already exists.');
  }
  // Public sign-up always creates a normal user; organizers are created by the seed script.
  const user = createUser(db, { name, email, password, role: 'user' });
  const token = signToken({ sub: user.id, role: user.role }, secret);
  return ok({ user: publicUser(user), token }, 201);
}

function login({ db, secret, body }) {
  const input = body || {};
  const email = text(input.email).toLowerCase();
  const password = typeof input.password === 'string' ? input.password : '';
  if (!email || !password) throw new HttpError(400, 'email and password are required.');

  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user || !verifyPassword(password, user.password_hash)) {
    throw new HttpError(401, 'Invalid email or password.');
  }
  const token = signToken({ sub: user.id, role: user.role }, secret);
  return ok({ user: publicUser(user), token });
}

function me({ user }) {
  requireUser(user);
  return ok({ user: publicUser(user) });
}

// ---------- events ----------
function validateEventFields(input, { partial }) {
  const errors = [];
  const values = {};

  if (!partial || input.title !== undefined) {
    const title = text(input.title);
    if (!title || title.length > 200) errors.push('title is required (max 200 characters).');
    values.title = title;
  }
  if (!partial || input.description !== undefined) {
    const description = input.description === undefined || input.description === null ? '' : text(input.description);
    if (description.length > 5000) errors.push('description must be at most 5000 characters.');
    values.description = description;
  }
  if (!partial || input.location !== undefined) {
    const location = text(input.location);
    if (!location || location.length > 200) errors.push('location is required (max 200 characters).');
    values.location = location;
  }
  if (!partial || input.event_date !== undefined) {
    const parsed = new Date(input.event_date);
    if (typeof input.event_date !== 'string' || Number.isNaN(parsed.getTime())) {
      errors.push('event_date must be a valid date-time, e.g. 2026-12-01T10:00:00Z.');
    } else {
      values.event_date = parsed.toISOString();
    }
  }
  if (!partial || input.capacity !== undefined) {
    const capacity = input.capacity === undefined ? DEFAULT_CAPACITY : input.capacity;
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > MAX_CAPACITY) {
      errors.push(`capacity must be a whole number between 1 and ${MAX_CAPACITY}.`);
    }
    values.capacity = capacity;
  }
  return { values, errors };
}

function listEvents({ db, query }) {
  const q = query || {};
  const where = [];
  const params = [];

  const search = text(q.search);
  if (search) {
    const term = `%${search.replace(/[\\%_]/g, '\\$&')}%`;
    where.push("(e.title LIKE ? ESCAPE '\\' OR e.description LIKE ? ESCAPE '\\' OR e.location LIKE ? ESCAPE '\\')");
    params.push(term, term, term);
  }
  if (q.upcoming === 'true') {
    where.push('e.event_date >= ?');
    params.push(nowIso());
  }

  const limit = Math.min(Math.max(parseInt(q.limit, 10) || 50, 1), 100);
  const offset = Math.max(parseInt(q.offset, 10) || 0, 0);

  const sql = `${EVENT_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY e.event_date ASC, e.id ASC LIMIT ? OFFSET ?`;
  const rows = db.prepare(sql).all(...params, limit, offset);
  return ok({ events: rows.map(shapeEvent), limit, offset });
}

function getEvent({ db, params }) {
  return ok({ event: shapeEvent(findEvent(db, parseId(params.id, 'event id'))) });
}

function createEvent({ db, user, body }) {
  requireOrganizer(user);
  const { values, errors } = validateEventFields(body || {}, { partial: false });
  if (!errors.length && new Date(values.event_date) <= new Date()) {
    errors.push('event_date must be in the future.');
  }
  if (errors.length) throw new HttpError(400, 'Validation failed.', errors);

  const result = db
    .prepare(
      `INSERT INTO events (title, description, location, event_date, capacity, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(values.title, values.description, values.location, values.event_date, values.capacity, user.id, nowIso());
  return ok({ event: shapeEvent(findEvent(db, result.lastInsertRowid)) }, 201);
}

function updateEvent({ db, user, params, body }) {
  requireOrganizer(user);
  const id = parseId(params.id, 'event id');
  const current = findEvent(db, id);

  const { values, errors } = validateEventFields(body || {}, { partial: true });
  if (!errors.length && Object.keys(values).length === 0) {
    errors.push('Provide at least one field to update.');
  }
  if (values.capacity !== undefined && !errors.length && values.capacity < current.registered_count) {
    errors.push(`capacity cannot be lower than the ${current.registered_count} current registrations.`);
  }
  if (errors.length) throw new HttpError(400, 'Validation failed.', errors);

  const columns = Object.keys(values);
  db.prepare(`UPDATE events SET ${columns.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(
    ...columns.map((c) => values[c]),
    id
  );
  return ok({ event: shapeEvent(findEvent(db, id)) });
}

function deleteEvent({ db, user, params }) {
  requireOrganizer(user);
  const id = parseId(params.id, 'event id');
  findEvent(db, id);
  db.prepare('DELETE FROM events WHERE id = ?').run(id); // registrations are removed by ON DELETE CASCADE
  return ok({ message: 'Event deleted.' });
}

// ---------- registrations ----------
function registerForEvent({ db, user, params }) {
  requireUser(user);
  const eventId = parseId(params.id, 'event id');
  const event = findEvent(db, eventId);

  if (new Date(event.event_date) <= new Date()) {
    throw new HttpError(400, 'This event has already taken place.');
  }

  const existing = db
    .prepare('SELECT * FROM registrations WHERE user_id = ? AND event_id = ?')
    .get(user.id, eventId);
  if (existing && existing.status === 'registered') {
    throw new HttpError(409, 'You are already registered for this event.');
  }
  if (event.registered_count >= event.capacity) {
    throw new HttpError(409, 'This event is full.');
  }

  let id;
  if (existing) {
    // Re-registering after a cancellation re-activates the old row.
    db.prepare("UPDATE registrations SET status = 'registered', registered_at = ?, cancelled_at = NULL WHERE id = ?").run(
      nowIso(),
      existing.id
    );
    id = existing.id;
  } else {
    id = db
      .prepare('INSERT INTO registrations (user_id, event_id, status, registered_at) VALUES (?, ?, ?, ?)')
      .run(user.id, eventId, 'registered', nowIso()).lastInsertRowid;
  }
  const row = db.prepare('SELECT * FROM registrations WHERE id = ?').get(id);
  return ok({ registration: shapeRegistration(row) }, 201);
}

function myRegistrations({ db, user, query }) {
  requireUser(user);
  const status = (query && query.status) || 'registered';
  if (!['registered', 'cancelled', 'all'].includes(status)) {
    throw new HttpError(400, 'status must be registered, cancelled or all.');
  }
  const rows = db
    .prepare(
      `SELECT r.*, e.title AS event_title, e.location AS event_location, e.event_date AS event_date
       FROM registrations r JOIN events e ON e.id = r.event_id
       WHERE r.user_id = ? ${status === 'all' ? '' : 'AND r.status = ?'}
       ORDER BY e.event_date ASC, r.id ASC`
    )
    .all(...(status === 'all' ? [user.id] : [user.id, status]));
  return ok({
    registrations: rows.map((r) => ({
      ...shapeRegistration(r),
      event: { id: r.event_id, title: r.event_title, location: r.event_location, event_date: r.event_date },
    })),
  });
}

function cancelRegistration({ db, user, params }) {
  requireUser(user);
  const id = parseId(params.id, 'registration id');
  const row = db.prepare('SELECT * FROM registrations WHERE id = ?').get(id);
  if (!row) throw new HttpError(404, 'Registration not found.');
  if (row.user_id !== user.id && user.role !== 'organizer') {
    throw new HttpError(403, 'You can only cancel your own registrations.');
  }
  if (row.status === 'cancelled') throw new HttpError(409, 'This registration is already cancelled.');

  db.prepare("UPDATE registrations SET status = 'cancelled', cancelled_at = ? WHERE id = ?").run(nowIso(), id);
  const updated = db.prepare('SELECT * FROM registrations WHERE id = ?').get(id);
  return ok({ message: 'Registration cancelled.', registration: shapeRegistration(updated) });
}

function eventRegistrations({ db, user, params, query }) {
  requireOrganizer(user);
  const eventId = parseId(params.id, 'event id');
  findEvent(db, eventId);
  const status = (query && query.status) || 'registered';
  if (!['registered', 'cancelled', 'all'].includes(status)) {
    throw new HttpError(400, 'status must be registered, cancelled or all.');
  }
  const rows = db
    .prepare(
      `SELECT r.*, u.name AS user_name, u.email AS user_email
       FROM registrations r JOIN users u ON u.id = r.user_id
       WHERE r.event_id = ? ${status === 'all' ? '' : 'AND r.status = ?'}
       ORDER BY r.registered_at ASC, r.id ASC`
    )
    .all(...(status === 'all' ? [eventId] : [eventId, status]));
  return ok({
    registrations: rows.map((r) => ({
      ...shapeRegistration(r),
      user: { id: r.user_id, name: r.user_name, email: r.user_email },
    })),
  });
}

module.exports = {
  createUser,
  register,
  login,
  me,
  listEvents,
  getEvent,
  createEvent,
  updateEvent,
  deleteEvent,
  registerForEvent,
  myRegistrations,
  cancelRegistration,
  eventRegistrations,
};
