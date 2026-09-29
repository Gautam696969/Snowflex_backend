# Snowflex People Operations API

A role-based employee management backend. All application data is stored in Snowflake; this project does not use another database or an ORM.

## Features

- JWT authentication with bcryptjs password hashing
- Snowflake-backed employees, departments, attendance, leave, tasks, and dashboard statistics
- Roles: `ADMIN`, `HR`, `MANAGER`, `EMPLOYEE`
- Legacy `USER` roles are treated as `EMPLOYEE` at API/token boundaries; no mass role migration is run automatically
- Helmet, CORS allowlist, Morgan request logging, authentication rate limiting, and Zod validation
- Parameterized Snowflake queries and safe user serializers
- AI features are intentionally not implemented

## Stack

Node.js 20+, Express, TypeScript, official `snowflake-sdk`, `jsonwebtoken`, `bcryptjs`, `dotenv`, `cors`, `helmet`, `morgan`, `express-rate-limit`, and `zod`.

## Structure

```text
src/config       environment and Snowflake access
src/controllers  thin HTTP controllers
src/middleware   auth, role, validation, and error handling
src/routes       auth and domain routes
src/services     Snowflake-backed business logic
src/utils        JWT, passwords, response and row helpers
src/types        Express and application role types
sql              schema migration and leave-type seed script
```

## Install and Configure

```bash
cd /home/woyce/Snowflex/Back
npm install
cp .env.example .env
```

Fill the ignored `.env` file with Snowflake credentials and a random `JWT_SECRET` of at least 32 characters. Never commit or paste `.env` contents. `CORS_ORIGIN` accepts comma-separated exact frontend origins.

```dotenv
PORT=5000
SNOWFLAKE_ACCOUNT=
SNOWFLAKE_USERNAME=
SNOWFLAKE_PASSWORD=
SNOWFLAKE_WAREHOUSE=
SNOWFLAKE_DATABASE=AUTH_PROJECT
SNOWFLAKE_SCHEMA=AUTH
SNOWFLAKE_ROLE=
JWT_SECRET=
JWT_EXPIRES_IN=1d
CORS_ORIGIN=http://localhost:5173
ATTENDANCE_START_TIME=09:00
```

Startup validates the configuration, prints `Connecting to Snowflake...`, waits for a successful connection, prints `Snowflake connected successfully`, then listens and prints `Server running on port ...`. It exits instead of serving requests when the database connection fails.

## Snowflake Setup

`AUTH_PROJECT.AUTH.USERS` is an existing table. Do not recreate or drop it. Run `sql/001_create_tables.sql` with a role that can create tables in `AUTH_PROJECT.AUTH`; it creates only `EMPLOYEES`, `DEPARTMENTS`, `ATTENDANCE`, `LEAVE_TYPES`, `LEAVE_REQUESTS`, and `TASKS`. Then run `sql/002_seed_data.sql` for `CASUAL`, `SICK`, and `ANNUAL` leave types.

Grant the service role warehouse/database/schema/table permissions for `USERS` and the new tables. Snowflake standard-table `UNIQUE` constraints are informational, so the service checks for duplicate users, departments, and employee identifiers; concurrent writers should be serialized or protected with a supported enforced-key table strategy.

Legacy accounts with `ROLE = 'USER'` authenticate as `EMPLOYEE` without a table rewrite. To migrate stored values after reviewing the impact, run:

```sql
UPDATE AUTH_PROJECT.AUTH.USERS
SET ROLE = 'EMPLOYEE', UPDATED_AT = CURRENT_TIMESTAMP()
WHERE ROLE = 'USER';
```

To assign an operator role, update a known account explicitly:

```sql
UPDATE AUTH_PROJECT.AUTH.USERS
SET ROLE = 'ADMIN', UPDATED_AT = CURRENT_TIMESTAMP()
WHERE EMAIL = 'admin@example.com';
```

A newly registered user gets role `EMPLOYEE` and an active linked employee profile. Employee onboarding by HR should create an employee record for an existing user instead of registering that user again.

## Run and Verify

```bash
npm run dev
```

```bash
npm run build
npm test
npm start
```

Frontend login redirects to `/dashboard`, which loads the current profile and role dashboard from the API. Frontend API URL defaults to `http://localhost:5000/api`; override with `VITE_API_URL` when needed.

## Roles

- `ADMIN`: organization access and all dashboard/admin functions
- `HR`: employees, departments, attendance, leave administration, and reports
- `MANAGER`: direct-report directory, attendance and leave review, task assignment/management
- `EMPLOYEE`: own profile, attendance check-in/out, leave requests, own tasks and task status

The API derives user identity from a verified JWT. Client-supplied actor IDs are not trusted. `EMPLOYEE` can only read their own records; `MANAGER` reads team records; `HR`/`ADMIN` can read organization records. Creating/updating/deleting employee or department records is limited to `ADMIN`/`HR`.

## API Endpoints

All successful responses use `{ "success": true, "message": "...", "data": ... }`; errors use `{ "success": false, "message": "...", "error": null }`.

### Authentication

- `POST /api/auth/register` — `{ fullName, email, password }`; creates a `EMPLOYEE` user and employee profile
- `POST /api/auth/login` — returns `{ data: { token, user } }`
- `GET /api/auth/me` — authenticated safe profile
- `POST /api/auth/logout` — stateless response; client removes its token

Send protected requests with `Authorization: Bearer <token>`. JWT includes `{ id, email, role }` and uses `JWT_EXPIRES_IN`.

### Employees

- `GET /api/employees` — ADMIN/HR all, MANAGER team, EMPLOYEE self
- `GET /api/employees/:id`
- `GET /api/employees/:id/profile`
- `POST /api/employees` — ADMIN/HR
- `PUT /api/employees/:id` — ADMIN/HR
- `DELETE /api/employees/:id` — ADMIN/HR

### Departments

- `GET /api/departments`, `GET /api/departments/:id`
- `POST /api/departments`, `PUT /api/departments/:id`, `DELETE /api/departments/:id` — ADMIN/HR

### Attendance

- `POST /api/attendance/check-in`, `POST /api/attendance/check-out` — own current-day attendance
- `GET /api/attendance/me` — own records
- `GET /api/attendance/:employeeId` — self, team, HR, or ADMIN
- `GET /api/attendance` — ADMIN/HR organization-wide; MANAGER team-only

Check-in uses Snowflake current date/time and `ATTENDANCE_START_TIME`. Duplicate check-ins are rejected. Checkout calculates hours and marks attendance `HALF_DAY` under four hours. Historical attendance cannot be edited through the API.

### Leaves

- `POST /api/leaves`, `GET /api/leaves/me`
- `GET /api/leaves`, `GET /api/leaves/:id`
- `PATCH /api/leaves/:id/approve`, `PATCH /api/leaves/:id/reject`
- `PATCH /api/leaves/:id/cancel`

Employees can create/cancel their pending requests. HR/ADMIN and the employee's manager can approve/reject; self-approval is rejected. Date range and day count are server-validated/calculated.

### Tasks

- `POST /api/tasks` — ADMIN/HR/MANAGER
- `GET /api/tasks`, `GET /api/tasks/:id`
- `PUT /api/tasks/:id`, `DELETE /api/tasks/:id` — ADMIN/HR/MANAGER with ownership/team checks
- `PATCH /api/tasks/:id/status` — assigned employee or authorized manager/HR/ADMIN

### Dashboards

- `GET /api/dashboard/admin` — ADMIN
- `GET /api/dashboard/hr` — HR/ADMIN
- `GET /api/dashboard/manager` — MANAGER/ADMIN team stats
- `GET /api/dashboard/employee` — EMPLOYEE own stats

Dashboard values are computed from Snowflake records. Leave balance uses the sum of seeded leave-type defaults minus approved leave; organizations with per-type policies should replace this basic calculation with their policy model.

## curl Examples

Register and login:

```bash
curl -X POST http://localhost:5000/api/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"fullName":"John Doe","email":"john@example.com","password":"Password@123"}'

TOKEN=$(curl -sS -X POST http://localhost:5000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"john@example.com","password":"Password@123"}' \
  | node -p "JSON.parse(require('fs').readFileSync(0, 'utf8')).data.token")
```

Current profile, dashboard, and check-in:

```bash
curl http://localhost:5000/api/auth/me -H "Authorization: Bearer $TOKEN"
curl http://localhost:5000/api/dashboard/employee -H "Authorization: Bearer $TOKEN"
curl -X POST http://localhost:5000/api/attendance/check-in -H "Authorization: Bearer $TOKEN"
```

In Postman, use raw JSON for register/login, then set Authorization type to Bearer Token for protected endpoints. For admin/HR/manager actions, first assign the corresponding role to an existing user in Snowflake.

## Logging and Errors

Morgan logs method, URL, and status only. It does not log request bodies, passwords, tokens, or Snowflake credentials. Unexpected database errors are sanitized. Validation failures return 422, authentication 401, role failures 403, missing records 404, duplicate/business conflicts 409, and unexpected errors 500.
