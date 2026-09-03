# Smart Hospital Management, Patient Care & Forecasting Platform

A multi-role hospital platform: patient care, clinical records, hospital operations, billing,
analytics, and a demand-forecasting engine that predicts OPD, IPD, bed, ICU, OT, oxygen and
blood requirements 7, 14 and 30 days ahead.

```
web/     React 18 + Vite + Recharts   — three apps: patient, doctor, reception
server/  Node + Express + Prisma      — REST API, RBAC, audit logging, forecasting engine
```

Three roles, no more. **Patients** book and read their own records, **doctors** run clinics and
write the clinical record, and **reception** is the hospital desk — scheduling, wards, laboratory,
pharmacy, billing, analytics and the forecasting dashboard all sit with them.

## Quick start

```bash
npm install          # installs both workspaces
npm run setup        # creates the SQLite database and seeds two years of demo data
npm run dev          # API on :4000, web on :5173
```

Then open <http://localhost:5173>.

Every seeded account uses the password `Password123`:

| Role | Sign in with | Lands on |
| --- | --- | --- |
| Patient | `patient1@example.com` | `/app` |
| Doctor | `doctor1@sunrisehospital.dev` | `/doctor` |
| Reception | `reception@sunrisehospital.dev` | `/reception` |
| Reception (second desk) | `reception2@sunrisehospital.dev` | `/reception` |

There are two reception accounts on purpose: releasing a lab report requires someone other than
whoever entered the results, and that rule is worth keeping.

Useful commands:

```bash
npm test                              # forecasting model, data-quality and alert unit tests
npm run seed     --workspace=server   # re-seed without dropping the database
npm run db:reset --workspace=server   # drop, recreate and re-seed

# These two need the API running (npm run dev):
npm run test:smoke --workspace=server # every read endpoint, as all three roles
npm run test:e2e   --workspace=server # book → consult → prescribe → lab → verify → bill → pay
```

## Documentation

Two PDFs in [`docs/`](docs/), both generated from HTML in the same folder.

| Document | Pages | Contents |
| --- | --- | --- |
| [Technical Report](docs/Smart-Hospital-Technical-Report.pdf) | 36 | Architecture, every technology choice with its reasoning and rejected alternatives, the data model, all 14 workflow families, concurrency patterns, security model, testing, deployment, and the deliberate simplifications |
| [Role Workflows](docs/Smart-Hospital-Role-Workflows.pdf) | 15 | The same workflows told from each role's point of view — what patient, doctor and reception each do step by step, and what the system refuses them |

Regenerate either after editing its HTML source:

```bash
cd docs
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
"$CHROME" --headless --disable-gpu --no-pdf-header-footer \
  --print-to-pdf="Smart-Hospital-Technical-Report.pdf" "file://$PWD/technical-report.html"
"$CHROME" --headless --disable-gpu --no-pdf-header-footer \
  --print-to-pdf="Smart-Hospital-Role-Workflows.pdf" "file://$PWD/workflows.html"
```

## What is built

**Patient** — registration with OTP verification, profile, hospital search (city, specialty,
department, rating, emergency, availability), doctor search, doctor profiles, slot-based
appointment booking, reschedule and cancel, live OPD queue with token and estimated wait,
medical records, prescriptions, lab reports, bills and payments, insurance, notifications.

**Doctor** — dashboard, appointment lifecycle, consultation workspace (symptoms, vitals,
clinical notes, ICD-coded diagnosis, prescription, lab orders), patient history, lab results,
inpatients, admission requests and discharge summaries, clinic schedule and profile.

**Reception** — operational dashboard, appointment booking and check-in with token queue, bed and
ICU ward map with live status, admissions with atomic bed allocation and transfer, discharge with
automatic final billing, emergency triage queue, operation theatres with overlap-checked
scheduling, laboratory workflow (order → sample → processing → results → independent
verification), pharmacy inventory with expiry and reorder tracking and dispensing, billing with
line items, payments and insurance claims, doctor verification, reception and department
management, analytics, a searchable audit log, seven CSV/JSON reports, and the forecasting
dashboard.

**Forecasting** — see below.

## Forecasting engine

`server/src/forecast/` is self-contained JavaScript — there is no second Python service to
deploy. The full run for one hospital (7 metrics × 3 horizons + 8 blood groups = 45 forecasts)
takes about 160 ms over two years of daily data.

```
HospitalResourceDaily ─→ validate ─→ backtest 4 models ─→ pick lowest MAPE
                                                              │
                                            refit on full series, forecast h days
                                                              │
                                       Forecast + ForecastPoint + ForecastAlert ─→ dashboard
```

- **Models** (`models.js`) — moving average, seasonal naive, linear trend, and Holt-Winters
  with additive trend and a 7-day season whose smoothing constants are grid-searched.
  All four compete on a held-out window; the lowest MAPE wins and is refit on the full series.
- **Metrics** (`metrics.js`) — MAE, RMSE and MAPE, with zero actuals skipped rather than
  counted as infinite error.
- **Data quality** (`quality.js`) — missing values, negative quantities, duplicate dates,
  future dates, occupancy above capacity, and 4σ outliers. Rows failing a hard rule are
  excluded from training; outliers are flagged but kept, because a genuine surge is exactly
  what the model needs to learn.
- **Alerts** (`engine.js`) — ICU forecast peak ≥ 90%, bed occupancy ≥ 85%, oxygen demand
  growth ≥ 15%, blood demand growth ≥ 20%. Alerts notify every reception account.
- **Confidence bands** — ±1.96 × the residual spread of the winning model, clamped to the
  metric's valid range.

Typical accuracy on the seeded data:

| Metric | Winning model | MAPE |
| --- | --- | --- |
| ICU occupancy | linear trend | 2.5% |
| Oxygen | Holt-Winters | 3.2% |
| OPD visits | Holt-Winters | 4.5% |
| Bed occupancy | Holt-Winters | 8.5% |
| IPD admissions | Holt-Winters | 9.4% |

Training data comes from `HospitalResourceDaily`, one row per hospital per day. In production
`POST /api/forecast/data/snapshot` rolls up the day's live activity into that row; the seed
generates two years of synthetic history with a weekly cycle, a winter respiratory season, a
slow growth trend and correlated resource use, so the models have something real to learn from
on day one. Historical data can also be bulk-loaded through `POST /api/forecast/data/ingest`.

## Security and privacy

- Passwords hashed with bcrypt; short-lived JWT access tokens with rotating refresh tokens
  stored as revocable sessions.
- OTP verification for signup and optional two-factor at sign-in. In development the OTP is
  logged and returned by the API so the flow works without an SMS provider.
- Role-based access control on every route, plus record-level checks: a doctor reaches a
  patient's record only through an actual appointment, admission, lab order or prescription
  (`server/src/lib/access.js`), and reception is scoped to its own hospital. No role can read
  across hospitals — there is no platform-wide account.
- Lab results are released only after a reception account other than the one that entered them
  verifies them.
- Audit log for sign-ins, record access and modification, prescriptions, reports, billing,
  admissions, discharges, verification and forecast runs.
- Rate limiting globally and tighter limits on credential endpoints; uploads restricted to
  PDF/JPEG/PNG/WebP with random stored filenames.
- Changing a password revokes every live session.

## Configuration

`server/.env`:

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | `file:./dev.db` for SQLite; a `postgresql://` URL in production |
| `JWT_SECRET` | Signing key — must be replaced outside development |
| `JWT_EXPIRES_IN` | Access-token lifetime, default `30m` |
| `REFRESH_EXPIRES_DAYS` | Refresh-token lifetime, default `30` |
| `OTP_DEV_MODE` | `true` returns OTPs in API responses; set `false` in production |
| `UPLOAD_DIR` | Where uploaded documents are stored |
| `CORS_ORIGIN` | Allowed origin; defaults to reflecting the request origin |

### Moving to PostgreSQL

Change the provider in `server/prisma/schema.prisma` to `postgresql`, point `DATABASE_URL` at
the server, and run `npx prisma db push`. The schema deliberately avoids SQLite-only
constructs — enum-like columns are strings validated in `server/src/constants.js`, and JSON is
stored as text — so nothing else changes.

## API

All routes are under `/api`. The main groups:

```
/auth          register, login, verify-otp, refresh-token, logout, me, sessions, mfa
/hospitals     search, profile, registration, departments, staff
/doctors       search, profile, slots, availability, registration, me/dashboard
/patients      profile, clinical flags, records, history, prescriptions, reports, bills, dashboard
/appointments  book, reschedule, cancel, status transitions, queue/status
/consultations start, notes, vitals, diagnoses, complete
/prescriptions create, read, cancel
/lab           tests, orders, collect, process, results, verify, reports
/pharmacy      inventory, alerts, prescriptions, dispense
/beds          list, summary, create, bulk create, status
/admissions    request, approve, admit, transfer, discharge, discharge-summary
/ot            rooms, surgeries, status
/emergency     register, triage, allocate-bed, admit
/billing       bills, items, payments, insurance, claims
/notifications list, read, read-all
/files         upload, download, delete
/analytics     dashboard, patients, doctors, financial, operations, audit-logs, reports/*
/forecast      dashboard, per-metric, run, alerts, data ingest/snapshot/quality
```

## Deliberate simplifications

Small, reversible choices made to keep the system understandable:

- Beds, ICU beds and isolation beds share one table with a `type` column rather than separate
  tables that would duplicate every query.
- Notifications are database rows the UI polls once a minute. A websocket transport can
  subscribe to the same `notify()` call without touching any caller.
- Payments are recorded directly rather than through a gateway callback; swapping in a real
  gateway changes only the payment route.
- Distance sorting in hospital search is computed after the page is fetched (Haversine),
  which is accurate enough for city-level search without adding PostGIS.
- "Download as PDF" for prescriptions and reports uses the browser's print dialog.
- The daily forecast snapshot is exposed as an endpoint rather than an in-process scheduler,
  so it can be driven by whatever cron the deployment already has.
- There is no platform-administrator role: a hospital goes live as soon as it registers, and
  reception verifies its own doctors. Multi-tenant approval would need that role back.
