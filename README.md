# Finance bot — bot keuangan Telegram

Catat keuangan lewat chat Telegram (`beli kopi 25rb`, `gaji 8 juta`, kirim foto struk). Data tersimpan di
PostgreSQL; foto struk dibaca dengan OCR (Tesseract) dan, bila ada, model Ollama.

> Status dan batasan ada di [laporan proyek](docs/project-report.md). Pemeriksaan keamanannya dilakukan secara
> otomatis dan oleh pembangun, **bukan** pengganti tinjauan keamanan oleh manusia.

## Fitur

- Catat pengeluaran/pemasukan dari kalimat biasa; beberapa transaksi dalam satu pesan.
- Dua dompet (cash / digital), saldo awal, transfer antar dompet, saldo per dompet.
- Ringkasan per periode, budget per kategori dengan peringatan, ekspor Excel.
- **Foto struk**: dibaca OCR + model, ditampilkan sebagai *draf*, baru dicatat setelah kamu balas `ya`
  (bisa dikoreksi: `total 45rb`, `tanggal kemarin`, `dompet digital`, `toko …`, `kategori …`).
- Keamanan fail-closed: secret webhook wajib, allowlist eksplisit, bind loopback, rate limit, batas nominal.

## Prasyarat

| Kebutuhan | Keterangan |
|---|---|
| Node.js ≥ 20 dan npm | paket manajer proyek ini adalah **npm** (`package-lock.json`) |
| Docker | untuk PostgreSQL 16 (`docker compose`) |
| Bot Telegram | token dari [@BotFather](https://t.me/BotFather); user id-mu dari [@userinfobot](https://t.me/userinfobot) |
| Ollama (opsional) | untuk membaca struk dengan model. Tanpa Ollama, bot tetap jalan dan pembaca deterministik dipakai |

## Menjalankan

```bash
npm install
cp .env.example .env          # isi POSTGRES_PASSWORD, DATABASE_URL, TELEGRAM_BOT_TOKEN, TELEGRAM_ALLOWED_USER_IDS
npm run db:up                 # PostgreSQL 127.0.0.1:15432 (hanya loopback)
npm run prisma:deploy         # terapkan skema
npm run start:dev             # long polling: tanpa URL publik
```

Cek kesehatan: `http://127.0.0.1:3100/health/live` (proses hidup) dan `/health/ready` (database + migrasi
siap; OCR/AI hanya dilaporkan sebagai `degraded` bila lemah). `http://127.0.0.1:3100/metrics` memberi penghitung
Prometheus (hanya loopback, tanpa data pengguna).

### Menyalakan dan menghentikan (manual)

```bash
npm run db:up        # PostgreSQL di Docker (data tetap di volume)
npm run start:dev    # bot (Telegram polling); Ctrl+C menghentikannya dengan rapi
curl http://127.0.0.1:3100/health/ready     # {"status":"ok",...} bila siap
```

Perintah `db:backup`, `db:restore-rehearsal`, `db:restore`, `db:verify`, dan `acceptance:check`
menjalankan skrip dengan `sh`; di Windows jalankan dari **terminal Git Bash**.

Setelah komputer dimatikan, kontainer dan bot tidak menyala sendiri; jalankan dua perintah di atas lagi. Tidak ada skrip
auto-start (sengaja, agar sederhana). Catatan Windows dan pemecahan masalah:
[docs/operations/windows-operation.md](docs/operations/windows-operation.md).

### Foto struk: sekali saja siapkan data bahasa OCR

OCR memakai Tesseract (Indonesia + Inggris) dan **tidak mengunduh apa pun secara diam-diam**. Jalankan sekali:

```bash
npm run receipt:fetch-langdata   # mengunduh ind.traineddata + eng.traineddata ke data/tessdata
npm run receipt:live-check       # uji nyata OCR + Ollama pada struk sintetis
```

Tanpa file itu bot membalas bahwa struk tidak terbaca dan menyarankan pencatatan manual.

### Model AI

Biarkan `OLLAMA_MODEL` kosong untuk memakai model pertama yang terpasang dan mendukung *completion*, atau isi
dengan nama dari `ollama list`. Tidak ada model yang diunduh otomatis. Kemampuan *vision* dibaca dari Ollama
(`/api/show`), bukan ditebak dari nama. Model teks saja tetap dipakai: OCR membaca gambar, model menyusun JSON,
kode memvalidasi angka.

## Perintah

| Perintah | Fungsi |
|---|---|
| `npm run start:dev` / `npm run build && npm run start:prod` | jalankan server |
| `npm run db:up` / `db:down` / `prisma:deploy` / `prisma:status` | PostgreSQL & migrasi |
| `npm run db:backup` (label opsional: `-- pre-migrasi`) | cadangan `pg_dump` **terenkripsi** (GnuPG AES-256) ke `backups/db/` + checksum; butuh passphrase (lihat [perlindungan data](docs/security/data-protection.md)) |
| `npm run db:verify` | audit integritas data (yatim, duplikat, tautan struk) + total uang |
| `npm run db:restore-rehearsal` | latihan pemulihan di kontainer sekali pakai (tidak menyentuh DB asli) |
| `npm test` | unit test |
| `npm run test:integration` | PostgreSQL asli (database `finance_bot_test` saja) |
| `npm run test:e2e` | aplikasi utuh lewat HTTP webhook, Telegram diganti penangkap |
| `npm run test:soak` | soak terkendali (transport simulasi, kegagalan disuntik, restart berkala); `SOAK_SECONDS=600` untuk lebih lama |
| `npm run test:mutation` | uji mutasi pada guard kritis (lambat, memakai salinan kerja; melaporkan jenis deteksi) |
| `npm run receipt:eval` | evaluasi OCR + parser pada struk sintetis (`-- --with-model`, `-- --dir <folder gambar milikmu>`) |
| `npm run acceptance:check -- <penanda>` | memeriksa uji penerimaan Telegram nyata di database |
| `npm run lint` (`lint:fix` memperbaiki otomatis) · `npm run typecheck` · `npm run format:check` | kualitas kode |
| `npm run verify` | gerbang lengkap satu perintah: typecheck, lint, format, unit, integrasi, e2e, antrean, build, `npm audit` produksi (jalankan sebelum commit) |
| `npm run test:queue` | antrean Redis/BullMQ nyata (menyalakan kontainer Redis profil `queue`; database Redis 15) |
| `npm run test:failure` | injeksi kegagalan: PostgreSQL dan Redis dimatikan/di-kill di bawah bot yang berjalan, cadangan terputus, disk penuh, restore (butuh Docker dan Git Bash) |
| `npm run queue:status` | jumlah job antrean dan alasan gagal, tanpa payload (hanya membaca) |
| `npm run db:migrate-rehearsal` | gladi migrasi tertunda pada **salinan** database nyata (tanpa berkas dump); harus lulus sebelum `prisma:deploy` ([prosedur](docs/operations/migration-procedure.md)) |
| `npm run disk:check` | ruang kosong volume PostgreSQL dan folder cadangan (hanya membaca); PostgreSQL tidak gagal dengan manis saat disk penuh |
| `npm run docker:verify` | membandingkan batas di `docker-compose.yml` dengan kontainer yang **berjalan** (memori, CPU, restart, port hanya loopback); hanya membaca |

## Struktur

```
prisma/                 skema + migrasi SQL (termasuk CHECK constraint dan trigger)
src/modules/<modul>/    domain (port, entitas) · application (service) · infrastructure (Prisma, Telegram, Ollama)
src/modules/bot/        orchestrator percakapan, adapter Telegram (polling & webhook), update processor
src/modules/receipt/    foto struk: validasi gambar, OCR, Ollama, draf, konfirmasi atomik
test/integration|e2e    uji dengan PostgreSQL asli
scripts/                backup, latihan restore, uji mutasi, unduh data bahasa OCR
docs/                   dokumentasi (lihat di bawah)
```

## Dokumentasi

- **[Laporan proyek](docs/project-report.md)** — ringkasan keseluruhan, keamanan, risiko, dan batasan
- [Arsitektur](docs/architecture.md) · [Invarian keuangan](docs/engineering/financial-integrity-invariants.md) · [Performa](docs/engineering/performance-and-resource-review.md) · [Peningkatan keandalan dan keamanan](docs/engineering/hardening-and-improvements.md)
- [Runbook operasional](docs/runbook.md) — start/stop, backup, restore, insiden
- [Operasi di Windows](docs/operations/windows-operation.md) · [Deploy ke VPS](docs/operations/vps-deploy.md) · [Cadangan terjadwal di VPS](docs/operations/vps-backup-cron.md)
- [Observabilitas](docs/operations/observability-and-diagnostics.md) · [Antrean Redis (opsional)](docs/operations/queues.md) · [Prosedur migrasi database](docs/operations/migration-procedure.md) · [Peran DB terbatas](docs/operations/db-least-privilege.md)
- [Keamanan](docs/security.md) · [Model ancaman](docs/security/threat-model.md) · [Perlindungan data](docs/security/data-protection.md) · [Dependensi dan rahasia](docs/security/dependency-and-secret-review.md)
- [Strategi tes](docs/testing/test-strategy-and-coverage.md) · [Kualitas tes](docs/engineering/test-quality-review.md) · [Uji Telegram nyata](docs/testing/telegram-real-integration-checklist.md) · [Uji Telegram manual](docs/testing/telegram-acceptance-manual.md) · [Evaluasi OCR struk](docs/testing/receipt-ocr-evaluation.md)

## Catatan privasi

Database, cadangan (`backups/`), dan data OCR (`data/`) berisi data keuangan pribadi dan
**git-ignored**. Log aplikasi dan audit tidak memuat isi pesan, nominal, atau teks struk.
