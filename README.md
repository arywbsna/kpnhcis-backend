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

---

## Getting Started
- **Clone the Repository**
Buka terminal atau command prompt Anda, lalu jalankan perintah berikut:
git clone [https://github.com/arywbsna/kpnhcis-backend.git](https://github.com/arywbsna/kpnhcis-backend.git)
cd kpnhcis-backend

- **Install Dependencies**
Pastikan Node.js (Minimal v20 LTS) sudah terinstal di sistem Anda. Jalankan perintah ini untuk mengunduh semua package:
npm install

- **Environment Configuration (.env)**
Buat berkas bernama .env di root folder proyek (bisa menyalin dari .env.example). Sesuaikan kredensialnya dengan PostgreSQL dan Redis lokal Anda:
DATABASE_URL="postgresql://username_postgres:password_postgres@localhost:5432/nama_database_hcis?schema=public"
REDIS_URL="redis://localhost:6379"
JWT_SECRET="buat_string_rahasia_super_panjang_di_sini"

- **Database Migration & Synchronization (Prisma)**
Perintah ini mirip dengan php artisan migrate di Laravel. Langkah ini akan membaca berkas schema.prisma, melakukan migrasi tabel ke PostgreSQL, dan men-generate TypeScript client.
npx prisma migrate dev --name init
(Opsional) Jika ingin menjalankan data master awal untuk tabel RBAC/User melalui seeder:
npx prisma db seed

- **Running the Application in Development Mode**
Dalam mode ini, server NestJS akan menggunakan fitur Hot Reload. Setiap kali Anda mengubah atau menyimpan kode (.ts), server akan otomatis me-restart sendiri.
npm run start:dev
Server secara default akan berjalan di http://localhost:3000

- **Compiling / Building the Project**
Karena Node.js tidak bisa mengeksekusi file TypeScript (.ts) secara langsung di production, Anda harus mengompilasi seluruh kode proyek menjadi JavaScript murni (.js). File hasil compile akan masuk ke dalam folder /dist.
npm run build

- **Running the Application in Production Mode**
Setelah proses npm run build selesai dijalankan dengan sukses, gunakan perintah ini di server produksi untuk menjalankan aplikasi JavaScript yang sudah dioptimasi:
npm run start:prod

- **Production Process Management (PM2)**
Pada server produksi asli (seperti Alibaba Cloud ECS), sangat disarankan mengawal proses aplikasi menggunakan Process Manager seperti PM2 agar sistem dapat melakukan auto-restart jika terjadi crash yang tidak terduga:
pm2 start dist/main.js --name "kpnhcis-backend"
