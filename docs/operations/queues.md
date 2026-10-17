# Antrean latar belakang (Redis + BullMQ) — opsional

Antrean opsional: **aktif hanya bila `REDIS_URL` diisi**. Tanpa itu (bawaan)
foto struk dibaca langsung di dalam penanganan chat. PostgreSQL tetap satu-satunya sumber kebenaran; Redis tidak pernah menyimpan foto, teks struk, atau nominal.

## 1. Mengapa ada, dan mengapa opsional

| Topik | Keputusan finance bot |
|---|---|
| Redis/BullMQ | **Opsional**: aktif bila `REDIS_URL` diisi, jalur dalam-proses tetap ada. Antrean `receipts` (membaca foto struk) dan `maintenance` (retensi), dengan pola: opsional, fallback dalam proses, payload divalidasi konsumen, batas retensi job, dead letter terbatas, shutdown rapi |
| Kuota penyedia bersama lewat Redis | **Tidak berlaku**: satu proses, satu allowlist; pembatas laju per pengguna sudah dalam proses |
| Peran proses `gateway`/`worker` | **Tidak diadopsi**: polling Telegram hanya boleh di satu proses dan bot ini satu pengguna; pekerja berjalan di proses yang sama |
| Antrean `alerts`/`notifications` | Tidak berlaku (tidak ada alert pasar; balasan dikirim dalam jalur update yang sudah di-retry) |

Manfaat nyata di finance bot, dan batasnya: pembacaan struk dapat memakan puluhan detik (OCR serial + model di CPU). Dengan antrean, chat langsung menjawab "Struk diterima", pembacaan di-retry dengan
backoff bila **unduhan Telegram, database, atau pengiriman balasan** gagal sementara, dan pekerjaan yang menunggu bertahan melewati restart aplikasi.
Kegagalan **OCR** tidak di-retry: pembaca struk mengubahnya menjadi balasan "belum bisa membaca" (sama seperti tanpa antrean); pengguna cukup memotret ulang. Tanpa antrean, update Telegram sudah di-retry oleh pemroses update dan foto yang gagal
dikirim ulang oleh Telegram, jadi **antrean bukan syarat keamanan data**, hanya keandalan dan kenyamanan.

## 2. Arsitektur

```
foto ─► IncomingMessageHandler ─► orchestrator.receiptPhoto
          ├─ terlalu besar? ─► balas "terlalu besar" (tidak memakai slot antrean)
          ├─ antrean aktif? ─► ReceiptJobProducer.tryEnqueue ─► Redis (referensi: userId, chatId, messageId, fileId, receivedAt)
          │                      └─ Redis tak terjangkau (3 d)  ─► QueueUnavailableError ─► baca di sini juga (fallback)
          └─ balas "Struk diterima, sedang dibaca"
Redis ─► BullJobQueue (satu worker per antrean) ─► ReceiptJobHandler.run
          validasi ulang payload ─► user ada? ─► chatId = chat milik user? ─► orchestrator.readReceipt (unduh, OCR, draf) ─► kirim pratinjau
          gagal sementara ─► retry (RECEIPT_JOB_ATTEMPTS, backoff eksponensial)   gagal terakhir ─► pesan "belum berhasil dibaca"
```

Kode: `src/modules/queue` (port `JobQueue` di domain, adaptor `BullJobQueue`), `src/modules/bot/application/receipt-job.{payload,producer,handler}.ts`,
`src/modules/retention/infrastructure/retention.service.ts` (job berulang `maintenance`).

## 3. Konfigurasi

| Variabel | Bawaan | Arti |
|---|---|---|
| `REDIS_URL` | kosong (**mati**) | `redis://127.0.0.1:16379` (compose). Non-loopback tanpa sandi ditolak saat start kecuali `REDIS_ALLOW_UNAUTHENTICATED=true` |
| `REDIS_PASSWORD` (compose) | kosong | bila diisi, `REDIS_URL` harus membawanya |
| `REDIS_KEY_PREFIX` | `finance-bot:` | awalan semua kunci |
| `REDIS_CONNECT_TIMEOUT_MS` | 2000 | |
| `RECEIPT_WORKER_CONCURRENCY` | 1 (maks 4) | foto yang dibaca bersamaan. OCR sendiri serial dan model dibatasi `Semaphore(1)`, jadi menaikkan angka ini **tidak otomatis menambah kecepatan**; belum diukur pada mesin ini |
| `RECEIPT_JOB_ATTEMPTS` | 3 | total percobaan (percobaan pertama dihitung) |
| `RECEIPT_JOB_BACKOFF_SECONDS` | 5 | jeda retry pertama; berlipat ganda |
| `RECEIPT_JOB_TIMEOUT_SECONDS` | 300 | job yang lebih lama dianggap gagal; kunci dilepas |

Redis di compose (profil `queue`): `maxmemory 256mb`, **`noeviction`** (BullMQ menyimpan keadaan antrean pada kunci tanpa TTL; kebijakan LRU bisa membuang job tanpa pemberitahuan),
**AOF `always` + volume** (job yang menunggu bertahan melewati restart dan `kill -9` Redis; enqueue baru dijawab setelah tertulis ke disk; beban finance bot beberapa job per jam jadi fsync per tulis tidak terasa; Redis tetap bukan penyimpanan tahan lama selamanya: disk Redis rusak/volume dihapus = job hilang, foto dikirim ulang),
`mem_limit 384m`, `cpus 0.5`, port hanya `127.0.0.1`.

## 4. Menjalankan

```bash
docker compose --profile queue up -d --wait redis        # Redis (kontainer finance-bot-redis)
# di .env:  REDIS_URL=redis://127.0.0.1:16379
npm run start:dev                                        # /health/ready menampilkan checks.queue
npm run queue:status                                     # jumlah job dan alasan gagal (tanpa payload); hanya membaca
docker compose --profile queue stop redis                # mematikan Redis; bot lanjut membaca struk di dalam proses
```

Kembali ke mode tanpa antrean: kosongkan `REDIS_URL` dan mulai ulang bot. Job yang masih menunggu di Redis tidak diproses lagi (foto bisa dikirim ulang oleh pengguna); data keuangan tidak terpengaruh.
Di server: `--profile app --profile queue`, `REDIS_PASSWORD` dan `APP_REDIS_URL=redis://:<sandi>@redis:6379` di `.env` ([vps-deploy.md](vps-deploy.md) §6b); tanpa sandi aplikasi menolak start kecuali `REDIS_ALLOW_UNAUTHENTICATED=true`.

## 5. Perilaku saat gagal (semua diuji dengan Redis dan PostgreSQL nyata)

| Kejadian | Perilaku | Bukti |
|---|---|---|
| Redis mati saat foto dikirim | tidak ada struk yang hilang: dibaca dalam proses, metrik `queue_jobs_total{outcome="fallback"}`, `/health/ready` = `degraded` (bukan `down`) | `test/failure/redis-outage`, `test/queue/receipt-queue` |
| Redis kembali | foto berikutnya masuk antrean lagi tanpa restart bot | `redis-outage` |
| `kill -9` Redis saat job menunggu | job tetap ada dan dikerjakan sesudah Redis hidup (AOF) | `redis-outage` (durabilitas) |
| Unduhan Telegram gagal sementara | retry dengan backoff, lalu draf terkirim | `receipt-queue` |
| Percobaan habis | pengguna diberi tahu; tidak ada draf, tidak ada transaksi | `receipt-queue` |
| Job yang sama dijalankan dua kali (pengiriman *at-least-once*) | satu draf; setelah `ya` satu transaksi | `receipt-queue`, `bull-job-queue` |
| Update Telegram yang sama dikirim ulang | satu job (`jobId` per pesan), satu pratinjau | `receipt-queue` |
| Payload dipalsukan di Redis (chat orang lain, pengguna tak dikenal, kolom tambahan, id jahat, waktu lama, grup) | ditolak sekali, tidak di-retry, payload diganti kode alasan, **tidak ada pesan ke siapa pun** | `receipt-queue`, `receipt-job.payload.spec` |
| Shutdown saat job berjalan | worker menyelesaikan job dalam genggaman (batas 20 d), lalu dipaksa; tidak menggantung bila Redis hilang | `bull-job-queue` |
| Foto terlalu besar | ditolak sebelum memakai slot antrean | `receipt-queue` |
| Job melewati batas waktu | gagal dan kunci dilepas | `bull-job-queue` |

Batas yang diketahui: job yang melewati timeout tidak bisa dibatalkan secara paksa di dalam proses (hanya ditandai gagal); pekerjaan OCR yang menggantung dibatasi oleh timeout OCR/AI-nya sendiri.
Redis down saat **worker** berjalan: worker mencoba tersambung kembali sendiri; job yang sedang berjalan saat Redis hilang dapat dijalankan ulang (aman karena idempoten).

## 5b. Batas yang diketahui (jujur)

| Batas | Penjelasan |
|---|---|
| "Struk diterima" diucapkan **sebelum** pekerjaan tahan lama | dengan AOF `always` job yang sudah dijawab "diterima" bertahan melewati `kill -9` Redis (diuji); yang tersisa: volume Redis hilang/rusak. Job yang hilang tidak memberi tahu siapa pun, foto dikirim ulang bila draf tidak muncul |
| Umur draf dihitung dari **waktu pemrosesan** | job yang dipulihkan setelah mati lama tidak lahir sudah kedaluwarsa (diuji). Tetapi job yang lebih tua dari 7 hari ditolak diam-diam |
| Pesan "gagal" tidak terkirim bila aplikasi sedang shutdown saat job gagal terakhir | job tetap tercatat di set `failed` (`npm run queue:status`) |
| Pekerja memakai draf PENDING **terbaru** saat `ya` | draf dibuat antara pratinjau 1 dan balasan `ya` dapat yang dikonfirmasi; efeknya terlihat dan dapat dibatalkan. Pekerja juga dapat menggantikan pertanyaan lain yang sedang terbuka dengan status konfirmasi struk |
| Kata sandi Redis | `expandVariables` pada konfigurasi dapat mengubah `$` di dalam URL; hindari `$` pada `REDIS_PASSWORD` |
| Redis di compose tanpa sandi secara bawaan | hanya `127.0.0.1` di host; untuk server isi `REDIS_PASSWORD` |

## 6. Keamanan

Redis di luar batas kepercayaan: konsumen memvalidasi ulang setiap job (hanya kolom yang dikenal, `userId` UUID, `chatId` harus **sama dengan chat milik user itu**, `fileId` pola terbatas, waktu ≤ 7 hari).
Isi job hanya referensi; foto tidak pernah masuk Redis. Redis hanya di `127.0.0.1` dan non-loopback tanpa sandi ditolak oleh validasi env. Metrik antrean memakai label tetap (`queue`, `outcome`) dan tidak memuat id.
Log antrean hanya memuat nama job, id korelasi, jumlah percobaan, dan kode alasan; tidak pernah payload.
