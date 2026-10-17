# Cadangan terjadwal di VPS (cron + rotasi)

Untuk server Linux dengan Docker (PostgreSQL di kontainer `finance-bot-postgres`; penyiapan server: [deploy ke VPS](vps-deploy.md)). Skrip-skripnya sama dengan yang dipakai saat bot dijalankan langsung di host;
yang ditambahkan hanya pembungkus untuk cron dan rotasi.

> **Status pengujian (jujur):** semua yang ada di sini diuji di **kontainer Linux** (bash 5.3, GnuPG 2.4, Docker socket,
> database nyata): cadangan terenkripsi, rotasi, kunci anti-tumpang-tindih, kegagalan tanpa passphrase,
> dan latihan restore. **Belum** diuji di VPS sungguhan dengan daemon cron-nya sendiri.

## 1. Prasyarat di server

- Linux, Docker, `bash`, dan GnuPG (`apt install gnupg`). Pengguna yang menjalankan cron harus bisa memakai Docker
  (anggota grup `docker`).
- Ambil kode dengan `git clone` (akhiran baris LF terjamin oleh `.gitattributes`). Menyalin folder dari Windows dengan
  zip/scp bisa membawa CRLF dan merusak skrip.
- Kontainer database berjalan: `npm run db:up`.

## 2. Passphrase untuk cron

Cron tidak punya terminal, jadi passphrase dibaca dari berkas **di luar repositori**, hanya bisa dibaca pemiliknya:

```bash
install -m 600 /dev/null ~/.finance-bot-backup-passphrase
nano ~/.finance-bot-backup-passphrase        # baris pertama = passphrase
```

Simpan passphrase yang sama di pengelola kata sandi, **terpisah dari server**. Kalau server hilang bersama berkas ini, dan
passphrase tidak tersimpan di tempat lain, semua cadangan tidak bisa dibuka siapa pun. Wrapper memberi peringatan di log
kalau berkas itu bisa dibaca pengguna lain.

## 3. Crontab

`crontab -e` (sebagai pengguna yang sama), ganti `/opt/finance-bot` dengan lokasi proyek:

```cron
FINANCE_BOT_BACKUP_PASSPHRASE_FILE=/home/deploy/.finance-bot-backup-passphrase
FINANCE_BOT_BACKUP_KEEP=30
MAILTO=kamu@contoh.com

# setiap hari 03:17 — cadangan terenkripsi (label "cron") + rotasi
17 3 * * * /opt/finance-bot/scripts/cron-job.sh backup
# setiap Minggu 04:43 — latihan restore: membuktikan cadangan terbaru benar-benar bisa dipulihkan
43 4 * * 0 /opt/finance-bot/scripts/cron-job.sh rehearsal
```

Catatan: baris `VAR=nilai` di crontab didukung cron biasa (Vixie/cronie). Pada `busybox crond` tidak didukung; di sana
awali perintahnya: `17 3 * * * env FINANCE_BOT_BACKUP_PASSPHRASE_FILE=... /opt/finance-bot/scripts/cron-job.sh backup`.

Uji sekali secara manual sebelum mengandalkannya:

```bash
FINANCE_BOT_BACKUP_PASSPHRASE_FILE=~/.finance-bot-backup-passphrase /opt/finance-bot/scripts/cron-job.sh backup
tail -n 20 /opt/finance-bot/logs/backup-cron.log
```

## 4. Yang dilakukan pembungkus

| Perilaku | Detail |
|---|---|
| Tanpa terminal | passphrase wajib dari `FINANCE_BOT_BACKUP_PASSPHRASE_FILE`; kalau tidak ada, gagal dengan kode keluar 1 dan tercatat di log |
| Satu proses per job | kunci `backups/.cron-<job>.lock`; kalau job sebelumnya masih jalan, dilewati (kode 0, tercatat `SKIPPED`); kunci yang lebih tua dari 6 jam dianggap sisa dan dihapus |
| Log | `logs/backup-cron.log` (UTC); di atas ±1 MB hanya 2000 baris terakhir yang disimpan; tanpa token, passphrase, atau isi data |
| Kode keluar | sama dengan kode keluar skrip yang dijalankan, jadi `MAILTO` atau pemantau bisa bereaksi |
| PATH | dibuat minimal dan eksplisit (`/usr/local/bin:/usr/bin:/bin`), karena cron tidak membawa PATH pengguna |

## 5. Rotasi

`scripts/backup-db.sh` memangkas **setelah** cadangan baru ditulis dan terverifikasi (dibaca balik). Aturannya:

- Menyimpan `FINANCE_BOT_BACKUP_KEEP` cadangan terbaru (bawaan **30**) **per label**. `0` mematikan rotasi.
- Label terpisah = kelompok terpisah: cadangan harian (`finance-bot-cron-…`) tidak pernah menghapus cadangan manual
  (`finance-bot-pre-migrasi-…`) atau yang tanpa label.
- Hanya berkas dengan pola nama yang tepat (label + cap waktu) yang disentuh, beserta `.sha256`-nya. Berkas lain di folder
  itu tidak tersentuh.
- Dengan 30 cadangan harian, riwayat ±30 hari. Ukuran saat ini ±26 KB per cadangan, jadi penyimpanan bukan masalah.

## 6. Yang belum disediakan: salinan keluar server

Cadangan yang hanya ada di VPS ikut hilang kalau VPS hilang atau disknya rusak. Skrip ini sengaja tidak mengunggah ke
mana pun. Contoh (belum diuji) memakai `rclone` setelah cron cadangan, ke penyimpanan yang kamu pilih; file sudah
terenkripsi sehingga aman disalin:

```cron
30 3 * * * rclone copy /opt/finance-bot/backups/db remote:finance-bot --include "finance-bot-cron-*.dump.gpg*" --max-age 2d
```

## 7. Pemulihan

Lihat `docs/runbook.md`. Singkatnya: `bash scripts/restore-db.sh backups/db/<berkas>.dump.gpg finance_bot_restored` memulihkan ke
database **baru** (tidak menimpa yang kerja), lalu periksa dan arahkan `DATABASE_URL` bila yakin.

## 8. Batasan

- Hanya untuk PostgreSQL di kontainer (`docker exec`). Untuk database terkelola, skrip perlu
  diganti dengan `pg_dump` lewat jaringan.
- Belum ada pemantauan aktif; kegagalan hanya terlihat di log, surel `MAILTO`, atau kode keluar.
- Zona waktu cron mengikuti server; log selalu UTC.
