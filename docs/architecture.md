# 🏛️ KPNHCIS Backend Architecture Ledger

Dokumen ini mencatat keputusan arsitektur, justifikasi teknologi, dan status keamanan pada pengerjaan dari Tahap 1 hingga Tahap 5 pada repositori `kpnhcis-backend`.

## 📊 Matriks Status Arsitektur & Performa

| Tahap | Komponen Inti | Status Keamanan & Performa | Justifikasi Arsitektur |
| :--- | :--- | :--- | :--- |
| **Tahap 1** | Fondasi & Prisma Postgres | **LOCKED** (Hybrid JSONB + Pipe Validasi Global) | Mengunci standarisasi data masukan via `ValidationPipe` (DTO Whitelisting) untuk mitigasi celah keamanan *Mass Assignment*. Penyembunyian data sensitif (seperti hash kata sandi) dikunci otomatis pada level interceptor. |
| **Tahap 2** | Dynamic CASL RBAC | **LOCKED** (Interpolasi JSONB Conditions + Redis Cache) | Otorisasi granular dinamis yang membaca aturan dari pangkalan data. Dilengkapi pelindung sentinel `__CASL_UNRESOLVED__` untuk mencegah eskalasi hak akses ilegal. Beban kueri PostgreSQL ditekan hingga mendekati 0% berkat cache permissions di Redis (~300s TTL). |
| **Tahap 3** | Org Hierarchy & XState | **LOCKED** (O(N) Map Tree Builder + Stateless Rehydration) | Struktur pohon organisasi diproses menggunakan algoritma Hash Map berkecepatan O(N) guna menghindari kendala kueri *N+1*. Siklus hidup dokumen HRIS dikawal secara matematis oleh XState via skema *Stateless Rehydration* di dalam kueri transaksi interaktif Prisma (`$transaction`). |
| **Tahap 4** | Optimasi Database | **LOCKED** (PostgreSQL `jsonb_path_ops` GIN Index) | Mengatasi keterbatasan *native* Prisma dengan melakukan intervensi manual pada DDL migrasi. Penggunaan opsi `jsonb_path_ops` memangkas footprint indeks fisik di disk hingga 3-4 kali lebih kecil dan mempercepat kueri pencarian containment (`@>`) di bawah 5 milidetik. |
| **Tahap 5** | Integrasi Qwen AI BI | **LOCKED** (Anonymized Corpus + Pre-wired Async API Pipeline) | Sistem kecerdasan buatan terisolasi secara aman. Teks kualitatif diekstrak dan disanitasi dari data pribadi (PII Stripping via Regex) sebelum dikirim keluar sistem. Lapisan asinkron dikawal oleh RxJS `timeout()` untuk penanganan *error taxonomy* yang presisi (503 vs 504). |

## 🧠 Rekayasa Inti Proyek (Core Engineering Decisions)

### 1. Desain Pangkalan Data Hibrida (Hybrid JSONB Layout)
Aplikasi ini tidak murni menggunakan pendekatan Relasional (RDBMS) kaku, tidak juga murni NoSQL. Kita menggabungkan kolom relasional statis untuk kebutuhan kueri cepat (seperti ID, Email, Status) dengan kolom `JSONB` bernama `payload` untuk menyimpan data dinamis yang kerap berubah (seperti struktur kustom form, transisi riwayat XState, dan atribut profil tambahan).

### 2. Eliminasi Heavy Workflow Engine via XState
Untuk menjaga efisiensi pengeluaran biaya infrastruktur (*Cost Efficiency*) dan performa kecepatan tinggi, tim memilih untuk tidak menggunakan *engine* besar luar seperti Camunda. Seluruh logika alur persetujuan (*approval workflow*) HCIS dienkapsulasi ke dalam berkas mesin status XState ringan yang berjalan secara *stateless* di dalam daur hidup aplikasi NestJS.