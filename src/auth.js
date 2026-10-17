'use strict';
// Password hashing (scrypt) and JWT (HS256) using only Node's built-in crypto module.
const crypto = require('node:crypto');
const { HttpError } = require('./errors');

const TOKEN_TTL_SECONDS = 8 * 60 * 60; // 8 hours

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  const [scheme, saltHex, hashHex] = String(stored).split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

const b64url = (value) => Buffer.from(value).toString('base64url');

function sign(data, secret) {
  return crypto.createHmac('sha256', secret).update(data).digest('base64url');
}

function signToken(payload, secret, ttlSeconds = TOKEN_TTL_SECONDS) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify({ ...payload, iat: now, exp: now + ttlSeconds }));
  const data = `${header}.${body}`;
  return `${data}.${sign(data, secret)}`;
}

// Returns the payload, or null if the token is malformed, tampered with, or expired.
function verifyToken(token, secret) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, body, signature] = parts;

  const expected = Buffer.from(sign(`${header}.${body}`, secret));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;

  try {
    const head = JSON.parse(Buffer.from(header, 'base64url').toString());
    if (head.alg !== 'HS256') return null;
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (typeof payload.exp !== 'number' || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

// Reads "Authorization: Bearer <token>". No header -> null (anonymous).
// A header that is present but invalid -> 401.
function authenticate(db, secret, authorizationHeader) {
  if (!authorizationHeader) return null;
  const match = /^Bearer\s+(.+)$/i.exec(authorizationHeader);
  if (!match) throw new HttpError(401, 'Authorization header must be: Bearer <token>.');
  const payload = verifyToken(match[1].trim(), secret);
  if (!payload) throw new HttpError(401, 'Invalid or expired token.');
  const user = db.prepare('SELECT id, name, email, role FROM users WHERE id = ?').get(payload.sub);
  if (!user) throw new HttpError(401, 'User no longer exists.');
  return { ...user };
}

module.exports = { hashPassword, verifyPassword, signToken, verifyToken, authenticate, TOKEN_TTL_SECONDS };
