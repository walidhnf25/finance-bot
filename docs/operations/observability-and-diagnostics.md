# Observabilitas dan diagnosis

Semuanya dalam proses, tanpa layanan luar (tidak ada Prometheus/Grafana yang wajib). Tidak ada data pengguna di metrik maupun log: tanpa id
pengguna, nominal, isi pesan, atau teks struk.

## 1. Titik pemeriksaan

| Endpoint | Arti | Dipakai oleh |
|---|---|---|
| `GET /health/live` | proses hidup, event loop berputar; tidak menyentuh dependensi | pemeriksaan "apakah proses hidup?" |
| `GET /health/ready` | PostgreSQL menjawab **dan** semua migrasi di disk sudah diterapkan; menyertakan `checks.ocr` (`up`/`degraded`/`skipped`) dan AI | healthcheck Docker, pemeriksaan manual |
| `GET /health` | ringkasan | manual |
| `GET /metrics` | teks Prometheus; hanya loopback **dan** header `Host` harus loopback (cegah DNS rebinding) | pemantauan |

Saat `ready` gagal, respons **503 membawa laporan lengkapnya** (mis. `"migrations":{"status":"down","detail":"1 migration(s) not applied: run \"npm run prisma:deploy\""}`), jadi penyebab terlihat tanpa membuka log. Detail adalah kalimat tetap; galat mentah dari driver tidak pernah masuk ke badan respons.

`degraded` berarti "bot tetap berfungsi, tetapi satu kemampuan opsional lemah" (OCR belum punya data bahasa, Ollama mati/paused, Redis antrean tak terjangkau). OCR atau AI **tidak pernah**
membuat status `down`; hanya PostgreSQL atau migrasi tertunda yang membuat `ready` gagal.

```bash
curl -s http://127.0.0.1:3100/health/ready
curl -s http://127.0.0.1:3100/metrics
```

(Port sesuai `PORT` di `.env`; contoh ini memakai 3100.)

## 2. Katalog metrik

Katalog **tetap** (`src/modules/observability/metrics.service.ts`). Nilai label di luar himpunan yang dideklarasikan dicatat sebagai `other`, sehingga kardinalitas tidak bisa
meledak dan teks bebas tidak bisa masuk. `MetricsService` tidak pernah melempar galat ke jalur utama.

| Metrik | Jenis | Label | Cara membaca |
|---|---|---|---|
| `updates_total` | counter | `outcome`: processed, duplicate, rate_limited, too_long, failed | `failed` naik → lihat log; `too_long` → pesan di atas `MAX_INPUT_CHARS` |
| `updates_unauthorized_total` | counter | – | ada yang mencoba memakai bot tanpa izin (diabaikan) |
| `update_attempts_total` | counter | `result`: done, retry, given_up | `given_up` naik → pembaruan dibuang setelah percobaan ulang |
| `message_latency_ms` | histogram | – | latensi per pesan |
| `receipts_total` | counter | `outcome`: draft, pending_exists, already_confirmed, rate_limited, rejected_image, unreadable, busy, error | `busy` → antrean OCR penuh; `unreadable` → OCR tak menemukan teks |
| `receipt_duration_ms` | histogram | – | foto → draf (dominan OCR dan, bila dipakai, model) |
| `ocr_failures_total` | counter | `reason`: language_data_missing, engine_error, timeout, busy | `language_data_missing` → `npm run receipt:fetch-langdata` |
| `ai_requests_total` | counter | `outcome`: ok, unavailable | rasio `unavailable` tinggi → Ollama bermasalah |
| `ai_breaker_transitions_total` | counter | `to`: CLOSED, OPEN, HALF_OPEN | sering OPEN → Ollama tidak stabil |
| `retention_deleted_total` | counter | `kind`: receipt_drafts, conversations, audit_events | pembersihan terjadwal bekerja |
| `retention_expired_total` | counter | – | draf PENDING yang kedaluwarsa |
| `telegram_errors_total` | counter | `kind`: poll, send, download | masalah jaringan/token |
| `queue_jobs_total` | counter | `queue`: receipts, maintenance; `outcome`: enqueued, duplicate, completed, retried, failed, rejected, fallback | `fallback` naik → Redis tak terjangkau, struk dibaca dalam proses; `rejected` → payload palsu/cacat di Redis; `failed` → percobaan habis |
| `queue_job_ms` | histogram | `queue` | lama satu job |
| `queue_waiting`, `queue_active`, `queue_failed` | gauge | – | jumlah job (semua antrean), disegarkan tiap 15 d |
| `db_ping_ms` | histogram | – | dari pemeriksaan readiness |
| `uptime_seconds`, `process_resident_memory_bytes`, `event_loop_delay_p99_ms` | gauge | – | kesehatan proses |
| `ocr_queue_depth` | gauge | – | foto berjalan + menunggu OCR (maks 6 menunggu) |
| `ai_breaker_open` | gauge | – | `1` selama breaker tidak CLOSED |

Metrik hidup di memori; direset saat proses restart. Itu disengaja (tanpa penyimpanan, tanpa data pribadi).

## 3. Log

pino JSON (`LOG_PRETTY=false` di kontainer). Tidak memuat isi pesan. Pesan galat jaringan tidak memuat URL, token, atau badan respons. Di VPS, log kontainer dirotasi
oleh Docker (`10m × 5`); log cron dirotasi oleh skrip cadangan (lihat [vps-backup-cron.md](vps-backup-cron.md)).

## 4. Jejak audit (di database)

```sql
SELECT created_at, action, user_id FROM audit_events ORDER BY created_at DESC LIMIT 20;
```

Hanya id dan jenis aksi. Dibersihkan setelah `AUDIT_RETENTION_DAYS` (365). Bukan anti-ubah; lihat [invarian](../engineering/financial-integrity-invariants.md).

## 5. Diagnosis cepat

| Gejala | Periksa | Tindakan |
|---|---|---|
| Bot tidak menjawab | `/health/ready`; log; `telegram_errors_total{kind="poll"}` | PostgreSQL naik? token benar? hanya satu proses yang polling? |
| `ready` gagal, "migrasi tertunda" | `npm run prisma:status` | `npm run db:backup`, lalu `npm run prisma:deploy` |
| Balasan "sedang sibuk" pada foto | `ocr_queue_depth`, `receipts_total{outcome="busy"}` | tunggu; kirim foto satu per satu |
| Foto tidak terbaca | `ocr_failures_total`, `checks.ocr` | `npm run receipt:fetch-langdata` |
| Struk lambat | `ai_breaker_open`, `receipt_duration_ms` | Ollama mati? set `RECEIPT_AI_MODE=never` atau biarkan `auto` |
| Batas Docker | `npm run docker:verify` | `docker compose up -d postgres` bila kontainer lama (ambil cadangan dulu) |
