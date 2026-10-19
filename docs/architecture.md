# Arsitektur finance bot

Dokumen ini menjelaskan arsitektur yang berlaku dan ditegakkan tes: prinsip, komponen, keputusan teknis, aliran foto struk, ketahanan, dan aturan lapisan. Ringkasan proyek ada di [laporan proyek](project-report.md).

## 1. Prinsip

1. **Data di PostgreSQL.** PostgreSQL adalah satu-satunya sumber kebenaran. AI (Ollama) dan OCR (Tesseract) hanya membantu membaca struk; keduanya opsional.
2. **Uang itu bilangan bulat.** Nominal disimpan sebagai `BIGINT` satuan minor (rupiah × 100) lewat kelas `Money`; tidak ada float. Batas maksimum `1e15` minor, dijaga kode **dan** `CHECK` di database.
3. **Saldo diturunkan, tidak disimpan.** `saldo = saldo awal + pemasukan − pengeluaran ± transfer` dihitung dari tabel transaksi dan transfer, jadi tidak bisa menyimpang dari buku besarnya.
4. **Database yang menegakkan aturan.** Idempotensi (`UNIQUE(user_id, idempotency_key)`), kepemilikan (filter `userId` di setiap query, ditambah trigger yang menolak baris yang menunjuk data pengguna lain), `CHECK`, `ON DELETE CASCADE/SET NULL`. Kode aplikasi bukan satu-satunya penjaga.
5. **Fail-closed.** Konfigurasi yang tidak aman membuat aplikasi menolak start (secret webhook, allowlist, bind).
6. **AI hanya mengusulkan.** Model tidak pernah menulis ke database dan tidak menghitung uang; hasilnya divalidasi kode dan harus dikonfirmasi pengguna.

## 2. Komponen

```
Telegram ──(long polling | webhook + secret)──► TelegramGateway
                                                    │ IncomingMessage
                                                    ▼
                  UpdateProcessor (retry, at-least-once)
                                                    ▼
        IncomingMessageHandler: dedupe → rate limit → user → audit
                                                    ▼
                       MessageOrchestrator (state percakapan)
        ┌────────────┬─────────────┬───────────────┬──────────────┐
   Transaction   Wallet/Transfer   Budget/Report   ReceiptService
        │            │                  │                │
        └────────────┴────────┬─────────┴────────────────┘
                              ▼
                  Repository (port) ──► Prisma ──► PostgreSQL 16 (Docker, 127.0.0.1:15432)

ReceiptService ─► image-processor (sharp) ─► OCR (tesseract.js) ─► OllamaClient (127.0.0.1:11434)
                       └─ validateExtraction (kode)  └─ ReceiptDraft PENDING ─ "ya" ─► Transaction (satu DB transaction)
```

Modul: `user`, `category`, `transaction`, `wallet`, `budget`, `conversation`, `audit`, `report`, `parser` (rule-based), `bot`, `receipt`, `health`, `queue`, `retention`. `MessagingGateway` adalah port: transport lain dapat menggantikan Telegram tanpa menyentuh handler.

### Model data (ringkas)

`users`, `categories` (sistem: `user_id NULL`, id deterministik `system-<type>-<slug>`), `transactions` (`amount_minor`, `idempotency_key`, `deleted_at`, `wallet`, `note`), `transfers`, `budgets`, `conversations` (1 baris/pengguna, state + payload JSON + `expires_at`), `receipt_drafts` (`image_sha256` unik per pengguna, `extraction` JSON tervalidasi, `transaction_id` unik), `audit_events`. Skema: `prisma/schema.prisma`; migrasi: `prisma/migrations/*/migration.sql` (termasuk `CHECK` dan trigger yang tidak bisa diungkapkan Prisma).

## 3. Lapisan dan arah dependensi

```
src/modules/<area>/
  domain/          murni: entitas, nilai, aturan, antarmuka (port). Tanpa I/O, tanpa NestJS, tanpa Prisma
  application/     kasus penggunaan; hanya bergantung pada domain dan port
  infrastructure/  adaptor: Prisma, sharp, tesseract.js, HTTP Ollama, Telegram
  <area>.module.ts satu-satunya tempat modul lain boleh menjangkau infrastructure
src/shared/        uang, tanggal: tidak tahu apa pun tentang modul
src/common/        logger, filter, utilitas umum (mis. CircuitBreaker)
```

Aturan-aturan ini bukan konvensi lisan; `src/architecture.spec.ts` gagal bila dilanggar:

| Aturan | Cara ditegakkan |
|---|---|
| `domain` tidak mengimpor `application`/`infrastructure`/Prisma/NestJS/modul I/O node | pemindaian impor |
| `application` tidak mengimpor Prisma, `sharp`, `tesseract.js`, I/O node, atau `infrastructure` | pemindaian impor |
| Modul lain hanya boleh menjangkau `infrastructure` lewat `*.module.ts` | pemindaian impor |
| `shared` tidak mengimpor modul | pemindaian impor |
| Tidak ada siklus impor | graf impor |
| Daftar pengecualian tidak boleh basi | tes gagal bila pengecualian sudah tidak dipakai |

### Port jalur struk

`src/modules/receipt/domain/receipt-ports.ts`:

| Port | Adaptor | Gunanya |
|---|---|---|
| `ReceiptOcr` (+ `OcrFailedError` dengan alasan `language_data_missing`/`engine_error`/`timeout`/`busy`) | `TesseractOcr` | OCR dapat diganti dan diuji tanpa tesseract |
| `ReceiptImageProcessor` (+ `InvalidImageError`, `PreparedImage`, `ImageLimits`) | `SharpImageProcessor` | pemrosesan gambar tidak masuk ke application |
| `ReceiptAiProvider` (+ `AiUnavailableError`) | `OllamaClient` | model dapat diganti; breaker ada di adaptor |
| `OcrHealthProbe` (`health/ocr-health.probe.ts`) | `TesseractOcrHealthProbe` | kapabilitas OCR di `/health/ready` tanpa health mengimpor tesseract |
| `UserDataResetRepository` (`user/domain`) | `PrismaUserDataResetRepository` | layanan reset tidak menyentuh Prisma |

## 4. Keputusan penting

| Keputusan | Alasan | Konsekuensi |
|---|---|---|
| PostgreSQL + Prisma | transaksi atomik, constraint, indeks | skema dan migrasi di `prisma/` |
| Prisma 6.19.3 (versi tepat) | stabil, klien terbit bersama CLI; hindari lompatan mayor tak sengaja | audit dev-chain `deepmerge-ts` ditangani dengan override |
| Satuan minor `BIGINT` | tidak ada galat pembulatan | `Money` menolak input tak valid; batas dijaga di DB |
| Idempotensi di DB | webhook/polling bersifat at-least-once; retry harus aman | kunci `<chatId>:<messageId>[#i]`, struk `receipt:<draftId>` |
| Konfirmasi struk dengan `SELECT … FOR UPDATE` | dua konfirmasi serentak tidak boleh menghasilkan dua transaksi | diuji 8 konfirmasi paralel → 1 transaksi |
| Redis/BullMQ opsional | membaca foto struk bisa makan puluhan detik | antrean `receipts` dan `maintenance`, mati secara bawaan, fallback dalam proses: [operations/queues.md](operations/queues.md). Kuota Redis bersama dan peran proses terpisah tidak dipakai |
| Ollama sebagai AI bawaan, opsional | gratis dan privat | tanpa Ollama bot tetap jalan (pembaca deterministik) |
| Nama model tidak di-hardcode | model berbeda di tiap mesin | `OLLAMA_MODEL` atau model pertama yang mendukung *completion* |
| Vision hanya bila dilaporkan Ollama | nama model menipu | model teks saja → jalur teks (OCR→model) |
| OCR: tesseract.js + data bahasa | tanpa API berbayar | data bahasa diunduh **eksplisit** sekali (`receipt:fetch-langdata`) |
| Bind loopback + tanpa login API | API tidak punya autentikasi | `HOST` non-loopback wajib `ALLOW_REMOTE_BIND=true` |

## 5. Aliran foto struk

1. Pesan berisi foto → ukuran yang diumumkan Telegram dicek sebelum unduh; unduhan dibatasi byte.
2. `prepareImage`: magic bytes (JPEG/PNG/WebP), batas piksel (anti *decompression bomb*), rotasi EXIF, buang metadata (GPS dll.), skala maks 2200 px, hash SHA-256 dari byte asli (kunci duplikat).
3. OCR → teks (dipotong 6000 karakter).
4. Ollama menyusun JSON sesuai skema; teks struk dibungkus `<receipt>` dan diberi label *untrusted data*; tidak ada *tools*. Bila model gagal/tidak ada → pembaca deterministik (hanya baris berlabel *total*).
5. `validateExtraction` (kode): total bulat positif ≤ batas, tanggal nyata (masa depan diganti hari ini; tanggal lama dipertahankan dengan peringatan), teks disanitasi, total harus tertelusur ke teks OCR (jika tidak → peringatan `TOTAL_NOT_IN_TEXT`), jumlah item vs total, properti tak dikenal dibuang, `wallet` dari model dibuang.
6. Disimpan sebagai `ReceiptDraft` PENDING (TTL 30 menit) dan pratinjau dikirim. **Belum ada transaksi.**
7. Balasan: `ya` → satu transaksi (transaksi DB terkunci, idempoten); `batal`; atau koreksi (`total 45rb`, `tanggal kemarin`, `dompet digital`, `toko …`, `kategori …`) yang memperbarui draf dan meminta konfirmasi lagi.

## 6. Ketahanan

- `fetchWithTimeout`, pembacaan body dibatasi, `withRetry` (backoff + jitter + `retry_after`).
- `UpdateProcessor`: gagal → coba ulang; habis jatah → pengguna diberi tahu, update beracun tidak memblokir selamanya. Update dari chat yang sama diproses satu per satu menurut urutan datang (penting pada mode webhook, yang bisa mengirim dua update serentak); chat berbeda tidak saling menunggu.
- Poller menaikkan offset hanya setelah sukses; dedupe menandai pesan hanya setelah sukses.
- `/health/live` tidak menyentuh dependensi; `/health/ready` memeriksa database + semua migrasi terapan; AI → `degraded`, tidak pernah `down` hanya karena OCR/AI.
- Shutdown: `enableShutdownHooks`; worker OCR dan antrean dihentikan dengan batas waktu.

| Mekanisme | Perilaku | Berkas |
|---|---|---|
| `CircuitBreaker` Ollama | CLOSED → OPEN setelah `OLLAMA_BREAKER_FAILURES` (3) kegagalan beruntun; OPEN selama `OLLAMA_BREAKER_COOLDOWN_SECONDS` (30); lalu HALF_OPEN dengan **satu** probe. Model tak terpasang / tak mendukung dihitung "hidup" | `common/utils/circuit-breaker.ts`, `ollama.client.ts` |
| Antrean OCR terbatas | maksimum 6 menunggu; yang ke-7 gagal cepat dengan `busy` dan pengguna menerima balasan "sedang sibuk" | `ocr.ts` |
| `Semaphore(1)` untuk Ollama | satu permintaan model pada satu waktu (CPU) | `ollama.client.ts` |
| Batas panjang pesan | `MAX_INPUT_CHARS` (2000, 100–4096); lebih panjang → balasan singkat, tidak diurai | `incoming-message.handler.ts` |
| AI opsional | mati/lambat/paused → pembaca deterministik tetap bekerja | `health.service.ts` |

## 7. Antrean latar belakang (opsional)

`JobQueue` (port, `src/modules/queue/domain`) dengan adaptor `BullJobQueue` (BullMQ). **Mati secara bawaan**; hidup bila `REDIS_URL` diisi. Dua antrean: `receipts` (membaca foto struk) dan `maintenance` (retensi berulang).
Pola: jalur dalam-proses tetap ada dan menjadi fallback, payload divalidasi oleh konsumen, riwayat job dibatasi, dead letter terbatas, shutdown rapi. Rincian, konfigurasi, dan perilaku saat gagal: [queues.md](operations/queues.md).
Lapisan application hanya melihat port `JobQueue` (domain), tidak pernah `bullmq` atau `ioredis` (dipaksa `architecture.spec.ts`).

## 8. Data yang bukan keuangan, dan perawatannya

`audit_events` (jejak, lihat [invarian](engineering/financial-integrity-invariants.md)), `receipt_drafts` (CANCELLED/EXPIRED), `conversations` (kedaluwarsa) dibersihkan oleh `RetentionService` (`RETENTION_INTERVAL_HOURS` 6; draf `RECEIPT_DRAFT_RETENTION_DAYS` 30; audit `AUDIT_RETENTION_DAYS` 365; 0 = simpan).
Retensi **tidak pernah** menyentuh `users`, `transactions`, `transfers`, `budgets`, `categories`, atau draf `CONFIRMED`. Pengecualian pelingkupan pemilik pada retensi (karena sapuan lintas-pengguna) didaftarkan eksplisit di `src/user-scoping.spec.ts`.

## 9. Yang sengaja tidak ada

Redis sebagai keharusan (hanya opsional), peran proses `gateway`/`worker` terpisah (polling hanya boleh di satu proses), kuota bersama lewat Redis (satu pengguna), event bus/outbox (tidak ada konsumen), multi-tenant publik, API HTTP berautentikasi (hanya loopback), fine-tuning model.
