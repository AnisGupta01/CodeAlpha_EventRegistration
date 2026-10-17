'use strict';
// Express layer: routing + JSON/error handling. All business logic lives in services.js.
const express = require('express');
const { authenticate } = require('./auth');
const { HttpError } = require('./errors');
const services = require('./services');

function createApp({ db, secret }) {
  if (!secret) throw new Error('A JWT secret is required.');
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '100kb' }));

  // Wraps a service function: authenticates the caller, runs the service, sends the JSON result.
  const route = (serviceFn) => (req, res, next) => {
    try {
      const user = authenticate(db, secret, req.headers.authorization);
      const result = serviceFn({
        db,
        secret,
        user,
        params: req.params,
        query: req.query,
        body: req.body,
      });
      res.status(result.status).json(result.body);
    } catch (err) {
      next(err);
    }
  };

  app.get('/', (_req, res) => {
    res.json({
      name: 'CodeAlpha Event Registration API',
      docs: 'See README.md for the full list of endpoints.',
      endpoints: [
        'POST /api/auth/register',
        'POST /api/auth/login',
        'GET  /api/auth/me',
        'GET  /api/events',
        'GET  /api/events/:id',
        'POST /api/events            (organizer)',
        'PUT  /api/events/:id        (organizer)',
        'DELETE /api/events/:id      (organizer)',
        'GET  /api/events/:id/registrations (organizer)',
        'POST /api/events/:id/register',
        'GET  /api/registrations',
        'DELETE /api/registrations/:id',
      ],
    });
  });
  app.get('/health', (_req, res) => res.json({ status: 'ok' }));

  // auth
  app.post('/api/auth/register', route(services.register));
  app.post('/api/auth/login', route(services.login));
  app.get('/api/auth/me', route(services.me));

  // events
  app.get('/api/events', route(services.listEvents));
  app.get('/api/events/:id', route(services.getEvent));
  app.post('/api/events', route(services.createEvent));
  app.put('/api/events/:id', route(services.updateEvent));
  app.delete('/api/events/:id', route(services.deleteEvent));
  app.get('/api/events/:id/registrations', route(services.eventRegistrations));

  // registrations
  app.post('/api/events/:id/register', route(services.registerForEvent));
  app.get('/api/registrations', route(services.myRegistrations));
  app.delete('/api/registrations/:id', route(services.cancelRegistration));

  // 404 for anything else
  app.use((_req, res) => res.status(404).json({ error: 'Route not found.' }));

  // central error handler
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err instanceof HttpError) {
      const body = { error: err.message };
      if (err.details) body.details = err.details;
      return res.status(err.status).json(body);
    }
    if (err && err.type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'Request body must be valid JSON.' });
    }
    if (err && err.type === 'entity.too.large') {
      return res.status(413).json({ error: 'Request body is too large.' });
    }
    console.error(err);
    return res.status(500).json({ error: 'Internal server error.' });
  });

  return app;
}

module.exports = { createApp };
