# Snowflex Authentication API

Express and TypeScript REST API for the React frontend. Authentication data is stored only in Snowflake.

```text
React + TypeScript -> Express REST API -> Snowflake
```

Passwords are hashed with `bcryptjs` before insertion. Login returns a one-day JWT containing only `{ id, email, role }`; authenticated routes require `Authorization: Bearer <token>`. `/api/auth/me` reads the current safe profile from Snowflake. Logout is stateless and the frontend removes the token from browser storage.

## Requirements

- Node.js 20 or newer
- npm
- Snowflake account credentials with access to the configured warehouse, database, schema, and `USERS` table

## Snowflake Setup

The API uses the existing `AUTH_PROJECT.AUTH.USERS` table. If the table has not been created, run the following as an administrator:

```sql
CREATE ROLE IF NOT EXISTS SNOWFLEX_AUTH_ROLE;
CREATE WAREHOUSE IF NOT EXISTS SNOWFLEX_AUTH_WH
  WAREHOUSE_SIZE = XSMALL
  AUTO_SUSPEND = 60
  AUTO_RESUME = TRUE;
CREATE DATABASE IF NOT EXISTS AUTH_PROJECT;
CREATE SCHEMA IF NOT EXISTS AUTH_PROJECT.AUTH;

USE DATABASE AUTH_PROJECT;
USE SCHEMA AUTH;

CREATE TABLE IF NOT EXISTS USERS (
  ID INTEGER AUTOINCREMENT START 1 INCREMENT 1,
  FULL_NAME VARCHAR(150) NOT NULL,
  EMAIL VARCHAR(255) NOT NULL UNIQUE,
  PASSWORD_HASH VARCHAR(255) NOT NULL,
  ROLE VARCHAR(50) DEFAULT 'USER',
  CREATED_AT TIMESTAMP DEFAULT CURRENT_TIMESTAMP(),
  UPDATED_AT TIMESTAMP DEFAULT CURRENT_TIMESTAMP(),
  LAST_LOGIN TIMESTAMP
);

GRANT USAGE ON WAREHOUSE SNOWFLEX_AUTH_WH TO ROLE SNOWFLEX_AUTH_ROLE;
GRANT USAGE ON DATABASE AUTH_PROJECT TO ROLE SNOWFLEX_AUTH_ROLE;
GRANT USAGE ON SCHEMA AUTH_PROJECT.AUTH TO ROLE SNOWFLEX_AUTH_ROLE;
GRANT SELECT, INSERT, UPDATE ON TABLE AUTH_PROJECT.AUTH.USERS TO ROLE SNOWFLEX_AUTH_ROLE;
GRANT ROLE SNOWFLEX_AUTH_ROLE TO USER API_SERVICE_USER;
```

Grant the role used by the API access to the warehouse, database, schema, and table. For example, assign admin access only to the intended operator account:

```sql
UPDATE AUTH_PROJECT.AUTH.USERS
SET ROLE = 'ADMIN', UPDATED_AT = CURRENT_TIMESTAMP()
WHERE EMAIL = 'admin@example.com';
```

`GET /api/admin/users` requires this database role. `EMAIL` is checked before insertion by the service. Snowflake standard-table `UNIQUE` constraints are informational rather than enforced; if duplicate prevention must remain absolute under concurrent registration traffic, use an enforced-key Snowflake table type supported by your account or serialize registration writes.

## Configuration

Copy `.env.example` to `.env` and fill in account-specific values; `.env` is ignored by Git and must never be committed. `.env.example` contains only variable names and safe local defaults.

```dotenv
SNOWFLAKE_ACCOUNT=
SNOWFLAKE_USERNAME=
SNOWFLAKE_PASSWORD=
SNOWFLAKE_WAREHOUSE=SNOWFLEX_AUTH_WH
SNOWFLAKE_DATABASE=AUTH_PROJECT
SNOWFLAKE_SCHEMA=AUTH
SNOWFLAKE_ROLE=SNOWFLEX_AUTH_ROLE
JWT_SECRET=
PORT=5000
FRONTEND_URL=http://localhost:5173
```

Set `JWT_SECRET` to a high-entropy secret, for example by running `openssl rand -base64 32` in a trusted local terminal. `FRONTEND_URL` may contain a comma-separated allowlist for multiple deployed frontends. In production, an unset `FRONTEND_URL` permits no browser origins.

The frontend optionally accepts `VITE_API_URL`; it defaults to `http://localhost:5000/api`.

## Run Locally

In one terminal:

```bash
cd /home/woyce/Snowflex/Back
npm install
npm run dev
```

Startup requires `JWT_SECRET`, tests Snowflake connectivity before listening, and prints `Snowflake connected` only when the connection check passes. On failure, the process exits without starting the API.

In a second terminal:

```bash
cd /home/woyce/Snowflex/Front
npm install
npm run dev
```

Open `http://localhost:5173`. Set `VITE_API_URL` in the frontend environment only when the API is not at the default URL.

## Build and Tests

Backend:

```bash
cd /home/woyce/Snowflex/Back
npm run build
npm test
npm start
```

Frontend:

```bash
cd /home/woyce/Snowflex/Front
npm run build
```

The backend tests exercise registration success and duplicate handling, invalid email and short password rejection, successful and failed login, safe response fields, protected routes with missing/invalid/valid JWTs, the admin role gate, generic storage errors, the Snowflake configuration failure path, and the health endpoint.

## API Examples

Register:

```bash
curl -X POST http://localhost:5000/api/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"fullName":"John Doe","email":"john@example.com","password":"Password123"}'
```

Login and save its token in a shell variable:

```bash
TOKEN=$(curl -sS -X POST http://localhost:5000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"john@example.com","password":"Password123"}' | node -p "JSON.parse(require('fs').readFileSync(0, 'utf8')).token")
```

Get the current profile:

```bash
curl http://localhost:5000/api/auth/me -H "Authorization: Bearer $TOKEN"
```

List users as an ADMIN:

```bash
curl http://localhost:5000/api/admin/users -H "Authorization: Bearer $TOKEN"
```

In Postman, use `POST` with raw JSON for registration/login, then add a Bearer Token authorization value for `/me` and `/api/admin/users`.

## API

- `GET /api/health` returns the backend health response.
- `POST /api/auth/register` accepts `{ "fullName", "email", "password" }` and returns `201` on success or `409` for an existing email.
- `POST /api/auth/login` accepts `{ "email", "password" }` and returns a JWT plus safe user fields.
- `GET /api/auth/me` requires a bearer token and returns the authenticated safe user.
- `POST /api/auth/logout` requires a bearer token and returns a stateless logout response. The frontend clears the token.
- `GET /api/admin/users` requires a bearer token with `role: "ADMIN"` and returns safe user fields only.

Validation and authentication failures use `{ "success": false, "message": "..." }`. Unexpected server and database errors are sanitized and never include provider details.