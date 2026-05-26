# KPNHCIS Backend

Standardized, Enterprise-Grade Headless API for Human Capital Information System (HCIS). Engineered for high concurrency, dynamic workflow flexibility, and strict authorization compliance.

---

## Tech Stack & Architecture

- **Core Framework:** [NestJS](https://nestjs.com/) (TypeScript) - Strict modular architecture.
- **Database & ORM:** PostgreSQL with [Prisma ORM](https://www.prisma.io/) (Hybrid JSONB + GIN Index design).
- **Caching & Queue:** Redis via `ioredis` & [BullMQ](https://github.com/taskforcesh/bullmq) (Background Jobs & Heavy Calculations).
- **State Mechanics:** [XState](https://xstate.js.org/) (Decoupled Process Control Layer for Approvals, replacing Camunda).
- **Real-time Engine:** Socket.io with Redis Adapter (State scaling friendly).
- **Authentication:** Stateless JWT via `@nestjs/jwt` + Redis Token Blacklisting.

---

## Security & Compliance Standards

> **Security First:** Kebijakan proteksi data sensitif dan mitigasi celah keamanan diimplementasikan secara ketat pada level arsitektur.

* **OWASP Top 10 Mitigation:** Proteksi *Mass Assignment* wajib menggunakan `ValidationPipe` (DTO Data Whitelisting) dan pencegahan *SQL Injection* secara menyeluruh melalui parameterisasi bawaan Prisma Client.
* **Envelope Encryption:** Mengamankan data bernilai sensitif tinggi (seperti NIK dan Gaji Pokok) menggunakan algoritma enkripsi biner sebelum persisten ke dalam database PostgreSQL.
* **Stateless Lifecycle Control:** Token JWT yang telah di-*revoke* oleh pengguna saat *logout* otomatis masuk ke dalam daftar hitam (*Blacklist*) di memori Redis menggunakan mekanisme TTL (Time-to-Live) untuk mencegah *replay attacks*.


---

## Getting Started

> **Estimated setup time:** ~10 minutes on a machine with Node.js and PostgreSQL already installed.

---

### Prerequisites

Ensure the following are installed and running before proceeding:

| Tool | Minimum Version | Notes |
|---|---|---|
| **Node.js** | v20 LTS | v22 LTS recommended. Use [nvm](https://github.com/nvm-sh/nvm) to manage versions. |
| **npm** | v10+ | Bundled with Node.js v20+. |
| **PostgreSQL** | v14+ | Must be running locally or accessible via network. |
| **Redis** | v6+ | Required for caching, BullMQ job queues, and Socket.IO adapter. |

> **PostgreSQL extensions required:** `pg_trgm` (trigram full-text search) and `pgcrypto` (UUID generation). These are declared in `prisma/schema.prisma` and enabled automatically during the first `migrate dev` run — no manual `CREATE EXTENSION` needed.

---

### Step 1 — Clone & Install Dependencies

```bash
# Clone the repository
git clone https://github.com/arywbsna/kpnhcis-backend.git
cd kpnhcis-backend

# Install all Node.js dependencies
npm install
```

---

### Step 2 — Environment Configuration

Copy the provided template and fill in your local credentials:

```bash
cp .env.example .env
```

> **Security note:** Never commit a `.env` file containing real credentials. The `.gitignore` already excludes it. Always use environment injection or a secrets manager (Vault, AWS SSM) in staging and production environments.

---

### Step 3 — Database Setup

#### 3a. Run Migrations

Apply the full migration history to your PostgreSQL instance. This creates all tables, indexes (including hand-authored GIN indexes for full-text search), foreign keys, and enum types:

```bash
npx prisma migrate deploy
```

> Use `migrate deploy` (not `migrate dev`) for **all non-development environments** (CI, staging, production). It applies pending migrations without generating new ones or touching the shadow database.
>
> For local development where you intend to iterate on the schema:
> ```bash
> npx prisma migrate dev
> ```

#### 3b. Generate the Prisma Client

The client is generated automatically by `migrate deploy`. If you need to regenerate it manually (e.g., after a schema pull or a `node_modules` wipe):

```bash
npx prisma generate
```

#### 3c. Seed Master Data

The seeder is **fully idempotent** — safe to run multiple times. It uses `upsert` throughout, so re-running it will never create duplicates or overwrite manually updated data.

```bash
npx prisma db seed
```

**What the seeder hydrates:**

| Phase | Target Table | Records |
|---|---|---|
| 1 | `subsidiaries` | 4 KPN legal entities (`KPN_HO`, `KPN_PLNT`, `KPN_LOG`, `KPN_AGRI`) |
| 2 | `units` *(migration)* | Pattern-based re-assignment of pre-existing units to their correct subsidiary |
| 3 | `units` | 9 org units — 1 holding root, 3 HQ departments, 5 branch offices |
| 4 | `permissions` | 16 CASL action:subject rules (`manage:all`, `read:User`, `create:LeaveRequest`, …) |
| 5 | `roles` + `role_permissions` | 4 system roles: `superadmin`, `hr_manager`, `line_manager`, `employee` |
| 6 | `users` | 3 seed users (admin, IT manager, staff engineer) |
| 7 | `user_roles` | Role assignments for the 3 seed users |

**Default seed credentials** (development only — change before any staging deployment):

| Email | Role | Password |
|---|---|---|
| `admin@kpncorp.com` | `superadmin` | `password` |
| `manager.it@kpncorp.com` | `line_manager` | `password` |
| `staff.it@kpncorp.com` | `employee` | `password` |

#### 3d. (Optional) Inspect the Database

Prisma Studio provides a visual browser for all tables without writing any SQL:

```bash
npx prisma studio
# Opens at http://localhost:5555
```

---

### Step 4 — Run the Application

#### Development (hot-reload enabled)

```bash
npm run start:dev
# API available at http://localhost:3000/api/v1
```

The NestJS file watcher recompiles and restarts the server on every `.ts` save. No manual restart needed during development.

#### Debug Mode

```bash
npm run start:debug
# Attach a Node.js inspector on the default port (9229)
```

---

### Step 5 — Build & Production Deployment

#### Build

Compile TypeScript to optimised JavaScript in `./dist`:

```bash
npm run build
```

#### Run (standalone Node)

```bash
NODE_ENV=production npm run start:prod
```

#### Run with PM2 (recommended for production servers)

PM2 provides process supervision, automatic restarts on crash, log management, and cluster mode for multi-core utilisation:

```bash
# Install PM2 globally (one-time)
npm install -g pm2

# Start the application
pm2 start dist/main.js --name "kpnhcis-backend"

# Save process list so it survives server reboots
pm2 save
pm2 startup   # Follow the printed command to enable auto-start on boot

# Useful PM2 commands
pm2 status                    # Show process health
pm2 logs kpnhcis-backend      # Tail live logs
pm2 reload kpnhcis-backend    # Zero-downtime reload (cluster mode)
pm2 stop kpnhcis-backend      # Graceful stop
```

> For zero-downtime deployments on Alibaba Cloud ECS or similar, use `pm2 reload` instead of `pm2 restart` — it cycles workers one by one, keeping the API available throughout the deployment.

---

## Architecture Overview

The system adapts a Domain-Driven Design (DDD) approach, completely decoupled from the Frontend UI (Vue 3 + Quasar):

```text
src/
├── app.module.ts
├── common/                # Shared Guards, Interceptors, Decorators
│   ├── decorators/
│   └── guards/            # Custom RBAC/CASL Permissions Guard
├── config/                # Environment configurations (Redis, Postgres, JWT)
├── database/              # Prisma Service & Client Lifecycle
└── modules/               # Domain Isolation
    ├── auth/              # JWT Issuance & Blacklisting
    ├── attendance/        # High-concurrency Clock-In/Out & Geofencing
    ├── leave/             # Managed by XState workflow engines
    ├── organization/      # Unit & Department hierarchy tree (Adjacency List)
    └── payroll/           # Heavy arithmetic processing via BullMQ workers
```
