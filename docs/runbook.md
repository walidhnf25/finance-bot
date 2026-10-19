# Runbook operasional

Untuk mesin yang menjalankan bot (Windows/macOS/Linux dengan Docker). Perintah memakai npm dan Git Bash/sh untuk skrip `.sh`.

## Menyalakan

```bash
npm run db:up        # PostgreSQL (menunggu sampai sehat)
npm run prisma:deploy   # idempoten; aman dijalankan ulang
npm run start:dev    # atau: npm run build && npm run start:prod
```

Setelah komputer dimatikan, ulangi dua perintah di atas (kontainer dan bot tidak menyala sendiri). Catatan Windows dan pemecahan masalah:
[operasi di Windows](operations/windows-operation.md).

Mode polling (`TELEGRAM_POLLING=true`) tidak butuh URL publik. Jika bot punya webhook terpasang,
hapus dulu agar `getUpdates` tidak mendapat konflik 409:

```bash
curl "https://api.telegram.org/bot<TOKEN>/deleteWebhook"
```

## Mematikan

`Ctrl+C` pada server (shutdown hook menutup koneksi dan worker OCR). Database: `npm run db:down` menghentikan
kontainer **tanpa** menghapus data (volume `pgdata` tetap). Jangan pakai `docker compose down -v` kecuali
memang ingin menghapus seluruh data.

## Kesehatan

| Endpoint | Arti |
|---|---|
| `GET /health/live` | proses hidup (tidak menyentuh dependensi) |
| `GET /health/ready` | 200 bila PostgreSQL menjawab **dan** semua migrasi terapan; 503 bila tidak. `ai: degraded` = Ollama mati/tanpa model; `ocr: degraded` = data bahasa belum diunduh; `queue: degraded` = Redis tak terjangkau (bot tetap jalan); 503 membawa laporan lengkap |

## Cadangan

```bash
npm run db:backup             # backups/db/finance-bot-<UTC>.dump.gpg + .sha256, TERENKRIPSI (butuh passphrase)
npm run db:verify             # audit integritas (18 pemeriksaan) + total uang
npm run db:restore-rehearsal  # restore ke kontainer sekali pakai, bandingkan dengan DB hidup
```

- Di server Linux, jadwalkan lewat cron dengan rotasi: lihat [cadangan terjadwal di VPS](operations/vps-backup-cron.md) (`scripts/cron-job.sh`). Di Windows jadwalkan `db:backup` sendiri (Task Scheduler). Salin file `.dump.gpg` ke media lain; cadangan di folder yang
  sama dengan database bukan cadangan sungguhan.
- Latihan restore memverifikasi checksum, memulihkan ke Postgres sementara (tanpa port terbuka), membandingkan
  jumlah baris & total uang dengan DB hidup, lalu **selalu** menghapus kontainer. Tidak menyentuh `finance-bot-postgres`
  selain membaca, dan tidak menyentuh kontainer proyek lain.
- Checksum menangkap kerusakan berkas; `pg_restore --exit-on-error` menangkap dump yang tak dapat dipulihkan.

## Memulihkan data

1. Hentikan bot (`Ctrl+C`).
2. Pulihkan ke database **baru** (skrip menolak menimpa DB kerja):
   ```bash
   npm run db:restore -- backups/db/finance-bot-XXXX.dump.gpg finance_bot_restored
   ```
3. Periksa isinya (`npm run prisma:studio` dengan `DATABASE_URL` diarahkan ke `finance_bot_restored`).
4. Beralih: ubah `DATABASE_URL` di `.env` ke `finance_bot_restored` (atau ganti nama database di dalam psql setelah
   menyimpan yang lama), jalankan `npm run prisma:status`, lalu start bot.

## Foto struk

| Gejala | Penyebab & tindakan |
|---|---|
| "Saya belum bisa membaca total…" untuk semua foto | data bahasa OCR belum ada → `npm run receipt:fetch-langdata`; log menyebut `OCR language data is missing` |
| Struk terbaca tapi tanpa bantuan model | Ollama mati atau tak ada model → `ollama serve`, `ollama list`; `/health/ready` menunjukkan `ai: degraded` |
| Model lambat | naikkan `OLLAMA_TIMEOUT_MS` atau pakai model lebih kecil; bot jatuh ke pembaca deterministik saat timeout |
| Draf kedaluwarsa | kirim ulang fotonya (TTL `RECEIPT_PENDING_TTL_MINUTES`) |
| "Struk ini sudah tercatat" | foto yang sama (hash identik) sudah dikonfirmasi; hapus transaksinya (`hapus`) bila ingin mencatat ulang |
| Pratinjau berisi "Sudah ada pengeluaran dengan nominal dan tanggal yang sama" | struk yang sama mungkin difoto ulang (berkas berbeda). Bila itu struk yang sama, balas `batal`; bila memang pembelian lain dengan nominal sama, balas `ya`. Koreksi `total …` atau `tanggal …` memeriksa ulang peringatan ini |

Uji nyata tanpa Telegram: `npm run receipt:live-check` (struk sintetis) atau `-- foto.jpg` untuk fotomu.

## Insiden umum

| Situasi | Tindakan |
|---|---|
| Bot tidak membalas | cek log server; `/health/ready`; apakah `TELEGRAM_ALLOWED_USER_IDS` memuat id-mu; apakah webhook lama masih terpasang (409) |
| Pesan dibalas "gagal diproses" | update beracun sudah dicoba berulang lalu dilepas; lihat log (hanya nama error, tanpa isi pesan) |
| Database tidak naik | `docker ps`, `docker logs finance-bot-postgres`; port 15432 bentrok → ubah `POSTGRES_PORT` dan `DATABASE_URL` |
| Migrasi tertinggal | `npm run prisma:status` lalu `npm run prisma:deploy`; `/health/ready` 503 sampai selesai |
| Dugaan kebocoran token | putar token di @BotFather, perbarui `.env`, restart |
| Disk penuh | **Jangan menunggu PostgreSQL menolak tulis.** Pada simulasi terisolasi (tmpfs 96 MB) PostgreSQL tidak memberi galat biasa: ia **PANIC** saat menulis WAL ("No space left on device") lalu menolak menyala sampai ada ruang. Pantau ruang kosong dengan `npm run disk:check` (volume PostgreSQL dan folder cadangan; peringatan di bawah 2 GB, atau di bawah 15 % bila ruang kosongnya kurang dari 20 GB; gagal di bawah 512 MB, atau di bawah 5 % bila kurang dari 20 GB); `npm run db:backup` menolak berjalan bila ruang kosong < 100 MB (`FINANCE_BOT_BACKUP_MIN_FREE_MB`). Bila sudah terjadi: kosongkan ruang (hapus cadangan lama/log/gambar Docker tak terpakai), lalu `docker start finance-bot-postgres`; jangan hapus volume |
| Redis (antrean) mati | bot tetap membaca struk dalam proses; `/health/ready` = `degraded`; nyalakan lagi `docker compose --profile queue up -d redis`. Lihat [queues.md](operations/queues.md); `npm run queue:status` |
| Data pengguna harus dihapus | perintah `reset` di chat (dengan konfirmasi) menghapus data pengguna itu secara atomik |

## Pembersihan

`backups/` dan `data/` berisi data pribadi dan di-ignore git. Hapus cadangan lama sesuai
kebijakanmu; jangan commit.
