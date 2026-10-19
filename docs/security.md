# Keamanan

> Pemeriksaan ini dilakukan oleh pembangun dan penilai otomatis. Ia **bukan** tinjauan keamanan oleh manusia
> dan bukan uji penetrasi. Untuk data keuangan yang sebenarnya sensitif, minta tinjau oleh orang yang kompeten.

## Model ancaman

| Aset | Ancaman | Pelaku |
|---|---|---|
| Data keuangan pribadi (PostgreSQL, cadangan) | dibaca/diubah pihak lain | proses lain di mesin, jaringan yang sama, pengguna Telegram tak berwenang |
| Integritas saldo | duplikasi/kehilangan transaksi, nominal salah | retry, race condition, input jahat, model AI keliru |
| Identitas pengguna | pemalsuan pengirim pesan | pihak yang mengetahui URL webhook |
| Kredensial | bocor lewat log, repo, laporan | kelalaian, dependensi |
| Ketersediaan | banjir pesan/foto, gambar raksasa, model menggantung | pengguna berwenang yang ceroboh, penyerang |

Di luar cakupan: keamanan Telegram sebagai platform, keamanan fisik/OS mesin, malware di mesin pengguna.

## Kontrol yang diterapkan dan bukti

| Kontrol | Implementasi | Bukti (uji) |
|---|---|---|
| Secret webhook **selalu** diverifikasi (timing-safe); tanpa secret server menolak semua | `telegram-webhook.controller.ts`, validasi env | unit + e2e + mutasi M01/M02 |
| Allowlist eksplisit; allowlist kosong = **tidak ada** yang boleh; publik harus `TELEGRAM_ALLOW_PUBLIC=true` | `telegram.gateway.ts`, `env.validation.ts` | unit + e2e + mutasi M03/M04 |
| API hanya di loopback; bind lain butuh `ALLOW_REMOTE_BIND=true` | `env.validation.ts`, `main.ts` | unit + mutasi M05 |
| Kepemilikan: setiap query baris memfilter `userId` | repository Prisma | integrasi + mutasi M06–M08, M12 |
| Idempotensi di DB | `UNIQUE(user_id, idempotency_key)` | integrasi (termasuk konkurensi) + mutasi M09/M10 |
| Konfirmasi struk atomik, terikat pemilik, tidak ganda | `FOR UPDATE` + transaksi DB | integrasi (8 paralel → 1) + mutasi M11–M17 |
| Batas nominal (kode + `CHECK`) | `Money.isWithinLimit`, migrasi SQL | unit + integrasi + e2e + mutasi M31/M32 |
| Rate limit per pengguna (jendela geser), batas struk/jam | `rate-limiter.ts`, `ReceiptService` | unit + e2e + mutasi M28/M33 |
| Gambar tak tepercaya: magic bytes, batas ukuran & piksel, buang EXIF | `image-processor.ts` | unit (termasuk *bomb*) + mutasi M25–M27 |
| Teks struk = data, bukan instruksi: dibungkus, tanpa *tools*, keluaran divalidasi, `wallet` model dibuang | `receipt-extractor.ts`, `receipt-extraction.ts` | unit + e2e + mutasi M18–M24, M30 |
| Konfirmasi manusia sebelum uang dicatat | `ReceiptDraft` PENDING → `ya` | e2e + mutasi M30 |
| Timeout & batas ukuran respons untuk semua panggilan keluar | `http.ts`, `OllamaClient` | unit |
| Log/audit privasi: tanpa isi pesan, nominal, atau teks struk; pesan error tanpa URL/token/body; jaring pengaman redaksi pino untuk header secret webhook, token, secret, apiKey, passphrase, URL database/Redis | `incoming-message.handler.ts`, `http.ts`, `LOG_REDACT_PATHS` | e2e (privasi log), `logger.module.spec.ts` (13), mutan M96 |
| Header respons tidak menyebut framework (`x-powered-by` dimatikan) | `app.setup.ts` | e2e, mutan M97 |
| Update dari chat yang sama diproses berurutan (webhook bisa serentak) | `update-processor.ts` | `update-processor.spec.ts` (5 tes urutan), mutan M90 |
| Struk yang sama dari berkas berbeda diberi peringatan `POSSIBLE_DUPLICATE` (tidak diblokir) | `receipt.service.ts`, `prisma-receipt.repository.ts` | integrasi (8), e2e, mutan M91–M95 |
| Rahasia tidak masuk repo: `.env*`, `backups/`, `data/` di-ignore | `.gitignore` | pemeriksaan manual `git check-ignore` |
| Database hanya di `127.0.0.1`; kata sandi acak | `docker-compose.yml` | konfigurasi |
| Pelingkupan pemilik **ditegakkan statis**: panggilan Prisma pada model milik pengguna harus menyebut pemilik; pencarian kategori terikat pemilik/sistem | `src/user-scoping.spec.ts` (4), `category` repo | statis + `isolation-probes.spec.ts` (16) + mutan M54–M56 |
| Lapisan arsitektur ditegakkan (application tak boleh mengimpor Prisma/sharp/tesseract/infrastructure; tanpa siklus) | `src/architecture.spec.ts` | 7 tes + mutan M57 |
| Teks struk: tag palsu (`</receipt>`) dinetralkan sebelum masuk prompt; dua total tercetak berbeda ditandai `TOTAL_AMBIGUOUS` | `wrapUntrusted`, `heuristic-extractor.ts` | `receipt-ai-safety.spec.ts` (124) + mutan M49/M50 |
| Ollama: circuit breaker (probe tunggal) + antrean OCR terbatas (gagal cepat `busy`) | `circuit-breaker.ts`, `ocr.ts` | unit + mutan M44–M48 |
| Batas panjang pesan (`MAX_INPUT_CHARS`, 2000) | `incoming-message.handler.ts` | unit + mutan M51 |
| `/metrics` hanya loopback + cek Host (anti DNS rebinding); label metrik dibatasi himpunan tetap | `metrics.controller.ts`, `metrics.service.ts` | e2e (7) + unit (23) + mutan M52/M53 |
| Jejak audit di database (id dan jenis saja; 10 aksi) dan retensi data non-keuangan | `audit_events`, `RetentionService` | integrasi (16) + mutan M58–M60 |
| Batas sumber daya Docker dideklarasikan dan diverifikasi terhadap kontainer yang berjalan | `docker-compose.yml`, `scripts/verify-docker-limits.js` | `src/ops/docker-limits.spec.ts` (9); `npm run docker:verify` |
| Database menolak baris yang menunjuk data pengguna lain (kategori / transaksi) | trigger tenant (`finance_bot_assert_*`, migrasi `init`) | `tenant-guards.spec.ts` (13, termasuk SQL mentah) + `db:verify` mendeteksi pelanggaran yang lolos dari cadangan/impor |
| Antrean Redis opsional: payload divalidasi konsumen, chat harus milik user, tanpa foto/teks di Redis, fallback dalam proses, shutdown terbatas | `receipt-job.payload.ts`, `receipt-job.handler.ts`, `bull-job-queue.ts` | `test/queue` (24), `receipt-job*.spec` (37), mutan M72–M78 |
| Uji destruktif hanya ke `finance_bot_test` | `db-guard.ts` | unit |
| Cadangan terverifikasi checksum; restore tidak pernah menimpa DB kerja | `scripts/*.sh` | latihan restore |

## Kebijakan rahasia

- Nilai di `.env` tidak pernah dicetak, disalin ke laporan, atau di-commit.
- Skrip cadangan/restore hanya membaca `POSTGRES_USER`/`POSTGRES_DB` dari `.env`.
- Token bot yang pernah ditempel di kanal lain (percakapan, tangkapan layar) harus dianggap terekspos;
  **putar (rotate) lewat @BotFather** bila ragu ([prosedur](security/dependency-and-secret-review.md)).

## Dependensi

`npm audit --omit=dev`: 0 kerentanan. Temuan transitif (`js-yaml` di `@nestjs/swagger`, `uuid` di `exceljs`, `deepmerge-ts` di rantai CLI Prisma)
ditangani dengan `overrides` terlingkup; perbaikan yang menuntut perubahan mayor/downgrade tidak dipaksakan ([rincian](security/dependency-and-secret-review.md)). `sharp` dinaikkan ke 0.35.5 untuk menutup
kerentanan libvips; hanya JPEG/PNG/WebP yang pernah didekode (setelah cek magic bytes).

## Batasan yang jujur

- Telegram nyata diuji terbatas : transaksi teks, dua konfirmasi struk, dan satu `batal`. `ya` kedua dan pemutaran ulang update belum terbukti nyata (terbukti di e2e/soak, yang memakai transport palsu lewat HTTP webhook asli); tidak ada uji panjang.
- Hasil model AI tidak deterministik; keamanan bergantung pada validasi kode dan konfirmasi pengguna, bukan pada
  "kepatuhan" model. Prompt-injection pada teks struk tidak bisa menulis ke database karena model tidak punya
  *tools* dan setiap pencatatan butuh balasan `ya` dari pengguna.
- Satu pengguna berwenang tetap bisa mengonfirmasi nominal yang salah jika tidak membaca pratinjau.
- Tidak ada enkripsi *at rest* untuk volume Docker atau disk dari aplikasi. Cadangan database **terenkripsi** (GnuPG AES-256, lihat
  [perlindungan data](security/data-protection.md)); kehilangan passphrase berarti cadangan tidak bisa dipulihkan.
- Tidak ada autentikasi pada API HTTP (hanya loopback). Jangan membukanya ke jaringan tanpa lapisan sendiri.
- Uji mutasi adalah sampel guard (97 mutan), bukan mutasi penuh.
- Jejak audit di database best-effort, bukan anti-ubah, dan tidak atomik dengan perubahan yang dicatat.
- Pemeriksaan dilakukan oleh pembangun dan penilai otomatis; belum ada tinjauan manusia. Rencana menambahnya ada di [laporan proyek](project-report.md#5-keamanan).

## Lihat juga

- [Laporan proyek](project-report.md): ringkasan keseluruhan dan tinjauan keamanan
- [Perlindungan data](security/data-protection.md): inventaris data, cadangan terenkripsi, akses database, permukaan API
- [Dependensi dan rahasia](security/dependency-and-secret-review.md): audit dependensi, prosedur rotasi token
- [Model ancaman](security/threat-model.md)
