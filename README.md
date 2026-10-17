# CodeAlpha_EventRegistration

**CodeAlpha Backend Development Internship, Task 2: Event Registration System**

REST API built with **Node.js + Express.js** and **SQLite**. Users can sign up, browse events, register for them, view and cancel their registrations. Organizers (admin role) can create, edit and delete events and see the attendee list.

## Features

- JWT authentication (HS256), passwords hashed with scrypt
- Roles: `user` (default for sign-up) and `organizer` (created via the seed script)
- Events: list (search, upcoming filter, pagination), details, create / update / delete (organizer)
- Registrations linked to both a user and an event, with:
  - duplicate registration blocked, capacity limit enforced, past events blocked
  - view my registrations, cancel (soft cancel, status = `cancelled`), re-register after cancelling
  - organizer can view attendees of an event
- Input validation and consistent JSON errors (400 / 401 / 403 / 404 / 409)
- Foreign keys with cascade delete (deleting an event removes its registrations)

## Setup

Requires **Node.js 22.13 or newer** (uses the built-in `node:sqlite`, so there is no native build step).

```bash
npm install
JWT_SECRET="change-me-to-a-long-random-string" npm run seed   # creates organizer + 3 sample events
JWT_SECRET="change-me-to-a-long-random-string" npm start
```

Windows PowerShell:

```powershell
$env:JWT_SECRET="change-me-to-a-long-random-string"; npm run seed; npm start
```

Server runs on http://localhost:3000.

Default organizer from the seed script: `organizer@example.com` / `Organizer@123`. Set your own with
`ADMIN_EMAIL` and `ADMIN_PASSWORD` before running `npm run seed`.

Other environment variables: `PORT` (default 3000), `DATABASE_PATH` (default `events.db`).
If `JWT_SECRET` is not set, a random one is generated on each start (logins reset on restart).

## API

Send the token as `Authorization: Bearer <token>`.

| Method | Endpoint | Access | Description |
|--------|----------|--------|-------------|
| POST | `/api/auth/register` | public | Sign up: `{name, email, password}` |
| POST | `/api/auth/login` | public | Log in: `{email, password}` returns token |
| GET | `/api/auth/me` | user | Current user |
| GET | `/api/events` | public | List events. Query: `search`, `upcoming=true`, `limit`, `offset` |
| GET | `/api/events/:id` | public | Event details (with `registered_count`, `spots_left`) |
| POST | `/api/events` | organizer | Create: `{title, description?, location, event_date, capacity?}` |
| PUT | `/api/events/:id` | organizer | Update any of those fields |
| DELETE | `/api/events/:id` | organizer | Delete event and its registrations |
| GET | `/api/events/:id/registrations` | organizer | Attendee list. Query: `status=registered\|cancelled\|all` |
| POST | `/api/events/:id/register` | user | Register for an event |
| GET | `/api/registrations` | user | My registrations. Query: `status=registered\|cancelled\|all` |
| DELETE | `/api/registrations/:id` | owner / organizer | Cancel a registration |

### One-command demo

```bash
npm run demo
```

Starts the app on a temporary in-memory database and walks through the whole flow (login, create event, sign up, register, duplicate and full-event errors, view, cancel, attendee list) with real HTTP calls. Useful for screen recordings. Set `DEMO_PAUSE_MS` to change the pause between steps (default 2500).

### Quick demo with curl

```bash
# sign up and save the token
curl -s -X POST localhost:3000/api/auth/register -H "Content-Type: application/json" \
  -d '{"name":"Anish","email":"anish@example.com","password":"password123"}'

TOKEN=<paste token here>

curl -s localhost:3000/api/events
curl -s -X POST localhost:3000/api/events/1/register -H "Authorization: Bearer $TOKEN"
curl -s localhost:3000/api/registrations -H "Authorization: Bearer $TOKEN"
curl -s -X DELETE localhost:3000/api/registrations/1 -H "Authorization: Bearer $TOKEN"
```

## Database

```
users          id, name, email (unique), password_hash, role, created_at
events         id, title, description, location, event_date, capacity, created_by -> users, created_at
registrations  id, user_id -> users, event_id -> events, status, registered_at, cancelled_at
               UNIQUE (user_id, event_id)
```

## Tests

```bash
npm test
```

- `tests/services.test.js`: 17 tests for auth, validation, roles, capacity, cancel / re-register, cascade delete
- `tests/api.test.js`: end-to-end HTTP test against the real Express app

## Project structure

```
server.js           Entry point
src/app.js          Express routes + error handling
src/services.js     Business logic (framework independent)
src/auth.js         scrypt password hashing, JWT sign/verify, auth lookup
src/db.js           SQLite schema
scripts/seed.js     Creates organizer + sample events
tests/              Automated tests
```

## Author

Anish Gupta, CodeAlpha Backend Development Intern (October-November 2026)
