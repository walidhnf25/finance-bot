# Deploy finance bot ke VPS (Docker)

Satu server Linux dengan Docker menjalankan dua layanan dari `docker-compose.yml`: PostgreSQL dan bot. Telegram memakai long
polling, jadi **tidak ada port yang dibuka ke luar** dan tidak butuh domain atau sertifikat.

> **Status pengujian (jujur):** image dan layanan diuji di Docker Desktop (Windows), pada tumpukan terpisah
> dengan **token Telegram palsu**. Terbukti: image terbangun, migrasi berjalan dari database kosong, bot sehat, OCR
> membaca struk di dalam kontainer read-only non-root, crash dipulihkan otomatis, penghentian rapi, data bertahan setelah
> `down`/`up`, bot tetap hidup tanpa Ollama. **Belum terbukti:** polling dengan token asli di dalam kontainer, jalur Ollama
> di host Linux (bagian 6), dan semuanya pada VPS sungguhan.

## 1. Penyiapan server (sekali)

Debian atau Ubuntu, pengguna biasa (bukan root) dengan `sudo`:

```bash
sudo apt update && sudo apt install -y git gnupg ca-certificates curl
# Docker Engine + Compose plugin: ikuti petunjuk resmi untuk distro-mu (docs.docker.com/engine/install)
sudo usermod -aG docker "$USER"        # keluar-masuk SSH agar berlaku
sudo ufw allow OpenSSH && sudo ufw enable
```

Port bot dan database **tidak dipublikasikan ke host** (database hanya di `127.0.0.1`), jadi firewall cukup membuka SSH.
Jangan menambahkan `ports:` ke layanan `app`.

## 2. Ambil kode dan isi `.env`

```bash
git clone <url-repo> ~/finance-bot && cd ~/finance-bot
cp .env.example .env && chmod 600 .env
nano .env
```

Yang wajib diisi (compose menolak start bila kosong):

| Variabel | Catatan |
|---|---|
| `POSTGRES_PASSWORD` | kata sandi kuat, **huruf dan angka saja** (dipakai di URL), diisi **sebelum start pertama**: database mengingat kata sandi pertamanya |
| `TELEGRAM_BOT_TOKEN` | disarankan token baru dari @BotFather untuk server, bukan token yang dipakai di mesin lain (satu token hanya boleh dipolling satu proses, kalau tidak Telegram membalas 409) |
| `TELEGRAM_ALLOWED_USER_IDS` | id Telegram yang boleh memakai bot, dipisah koma |

Opsional: `TZ` (bawaan `Asia/Jakarta`), `OLLAMA_MODEL`, `RECEIPT_AI_MODE`, `AI_PROVIDER` (`none` bila tanpa Ollama), dan
`APP_OLLAMA_BASE_URL` (alamat Ollama **dari dalam kontainer**; bukan `OLLAMA_BASE_URL`, yang di `.env.example` berisi
`127.0.0.1` untuk host dan akan salah di dalam kontainer). Variabel lain di `.env.example` (mis. `DATABASE_URL`, `HOST`, `PORT`, `OLLAMA_BASE_URL`) dipakai untuk menjalankan langsung di host dan
**diabaikan** oleh layanan `app`: compose menyetelnya sendiri (`HOST=127.0.0.1`, `PORT=3000`, `NODE_ENV=production`, alamat database di jaringan Docker).

## 3. Nyalakan

```bash
docker compose --profile app up -d --build
docker compose --profile app ps            # postgres: healthy, migrate: exited (0), app: healthy
docker compose logs -f app                 # Ctrl+C untuk berhenti melihat log
```

Urutannya otomatis: database sehat, lalu `migrate` (`prisma migrate deploy`), lalu bot. Profil `app` membuat `npm run db:up`
di mesin pengembangan **tidak** ikut menyalakan bot kedua. `restart: unless-stopped` menyalakan kembali bot dan database setelah reboot
server atau crash (Docker harus aktif saat boot: `sudo systemctl enable docker`).

Cek kesiapan dari dalam kontainer:

```bash
docker compose exec app node -e "fetch('http://127.0.0.1:3000/health/ready').then(async r=>console.log(r.status, await r.text()))"
```

`200` dengan `"status":"ok"` berarti siap; `"degraded"` berarti jalan tapi Ollama tidak terjangkau.

## 4. Data bahasa OCR (sekali)

Foto struk dibaca dengan Tesseract; data bahasanya tidak diunduh diam-diam. Unduh sekali ke volume `appdata`:

```bash
docker compose --profile app run --rm --no-deps app node scripts/fetch-tessdata.mjs
```

Bila gagal di tengah jalan (jaringan), jalankan lagi: berkas yang sudah ada dilewati. Tanpa data ini bot membalas bahwa struk
tidak terbaca dan menyarankan pencatatan manual.

## 5. Cadangan terjadwal

Sama seperti pada pemakaian langsung di host, dari folder proyek (skrip memanggil `docker exec finance-bot-postgres`): ikuti
[cadangan terjadwal di VPS](vps-backup-cron.md). Buat cadangan pertama dan latihan restore sebelum mengandalkan server ini.

## 6. Ollama (opsional)

Layanan `app` mencari Ollama di `http://host.docker.internal:11434` (alamat host, lewat `extra_hosts: host-gateway`; ubah dengan `APP_OLLAMA_BASE_URL`).
Tanpa Ollama bot tetap bekerja (pembaca struk deterministik), dan `/health/ready` melaporkan `degraded`.

Catatan penting, **belum diuji di Linux**: di Linux, Ollama yang hanya mendengarkan `127.0.0.1` tidak terjangkau dari kontainer.
Agar terjangkau, Ollama harus mendengarkan di alamat jembatan Docker (mis. `OLLAMA_HOST=172.17.0.1`), dan port 11434 **tidak
boleh** terbuka ke internet (cek `ufw`). Model besar butuh RAM yang tidak ada di VPS kecil; pertimbangkan `AI_PROVIDER=none`.

## 6b. Antrean Redis (opsional)

Tanpa ini struk dibaca di dalam proses bot, dan itu sudah memadai untuk satu pengguna. Untuk membacanya di latar belakang (dengan retry dan tahan restart) lihat [queues.md](queues.md):
isi `REDIS_PASSWORD=<acak panjang>` dan `APP_REDIS_URL=redis://:<sandi yang sama>@redis:6379` di `.env`, lalu `docker compose --profile app --profile queue up -d --build`.
`redis://redis:6379` bukan loopback sehingga aplikasi **menolak** URL tanpa sandi (`REDIS_ALLOW_UNAUTHENTICATED=true` hanya bila kamu sengaja menerima Redis terbuka di jaringan compose).
Image produksi dengan antrean aktif diuji (Postgres + Redis berkata sandi sekali-pakai, root read-only, tanpa capability): `/health/ready` = `queue: up`; Redis dimatikan → `degraded`, aplikasi tetap hidup;
`docker stop` selesai dalam 8 detik dengan kode keluar 0; sandi Redis tidak muncul di log. Belum diuji di server nyata.

## 7. Pembaruan

```bash
cd ~/finance-bot
bash scripts/backup-db.sh pre-update            # cadangan dulu (minta passphrase)
git pull
docker compose --profile app up -d --build      # migrasi baru dijalankan otomatis sebelum bot
docker compose logs --tail 50 app
```

Kembali ke versi sebelumnya: `git checkout <commit-lama>` lalu perintah `up -d --build` yang sama. Migrasi tidak ikut dibatalkan;
untuk itu pulihkan cadangan (`docs/runbook.md`).

## 8. Operasi sehari-hari

| Tujuan | Perintah |
|---|---|
| Status | `docker compose --profile app ps` |
| Log | `docker compose logs -f app` (dirotasi otomatis: 5 berkas × 10 MB) |
| Mulai ulang bot | `docker compose restart app` |
| Hentikan bot saja | `docker compose stop app` (data aman) |
| Hentikan semuanya | `docker compose --profile app down` (volume **tetap**; jangan pakai `down -v`, itu menghapus database) |

## 9. Apa yang dikeraskan di kontainer

Pengguna non-root (`node`), sistem berkas root read-only (hanya `/tmp` dan volume data yang bisa ditulis), semua capability
dibuang, `no-new-privileges`, batas memori 1 GB, tidak ada port terbuka, tidak ada rahasia di dalam image (`.dockerignore`
mengeluarkan `.env*`), dan `init: true` agar proses ditangani dengan benar. Penghentian rapi berakhir dengan kode keluar 143
(SIGTERM), itu normal.

## 10. Batasan

- Satu instans bot per token. Jangan jalankan bot yang sama di dua mesin sekaligus.
- Image ±0,9 GB (Prisma CLI dan mesin Tesseract ikut di dalamnya).
- Database terkelola belum didukung oleh skrip cadangan (memakai `docker exec`).
- Belum ada pemantauan aktif atau peringatan; lihat `docker compose ps` dan log.
