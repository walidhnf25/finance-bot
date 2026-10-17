# Menjalankan finance bot di Windows

Lingkungan yang dituju: Windows, Docker Desktop (PostgreSQL 16 dengan volume permanen), aplikasi NestJS,
Telegram **long polling** (tanpa URL publik), OCR (Tesseract), Ollama untuk AI.
Telegram tetap butuh internet dan token bot yang valid.

## Menyalakan dan menghentikan (manual)

Tidak ada skrip start/stop dan tidak ada auto-start: bot dijalankan manual.

```bash
npm run db:up        # PostgreSQL di Docker (data tetap di volume)
npm run start:dev    # bot (polling), mode watch; Ctrl+C menghentikannya dengan rapi
```

Cek kesiapan dari terminal lain:

```bash
curl http://127.0.0.1:3100/health/ready      # database + migrasi; "degraded" = OCR/AI lemah, bot tetap jalan
curl http://127.0.0.1:3100/metrics           # penghitung dan pengukur (lihat observability-and-diagnostics.md)
npm run docker:verify                        # batas memori/CPU/port PostgreSQL yang BERJALAN sesuai docker-compose.yml
```

Gerbang kualitas satu perintah sebelum meng-commit (tanpa CI):
`npm run verify` (typecheck, lint, format, unit, integrasi, e2e, build, audit produksi). Integrasi dan e2e memakai database `finance_bot_test` saja.

### Auto-start: hanya dokumentasi, bukan fitur

Tidak ada skrip auto-start. Bila kelak ingin bot menyala sendiri setelah login, jangan ubah repo: buat
tugas **Task Scheduler** sendiri (pemicu "At log on", aksi `cmd /c "cd /d C:\Users\user\proyek\finance-bot && npm run db:up && npm run start:dev"`)
dan ingat bahwa hanya satu proses boleh polling per token. Untuk server, pakai `restart: unless-stopped` pada profil `app`
([vps-deploy.md](vps-deploy.md)), yang sudah teruji di Docker Desktop.

Hal yang perlu diingat:
- Setelah komputer dimatikan atau di-restart, bot **tidak menyala sendiri**: jalankan dua perintah di atas lagi
  (jalankan `db:up` bila Docker Desktop baru saja menyala).
- Hanya **satu** proses boleh polling per token. Dua terminal yang menjalankan bot bersamaan akan bertabrakan (Telegram 409);
  data tidak ganda karena penulisan idempoten.
- Saat bot mati, pesan Telegram **tidak hilang**: Telegram menyimpannya sampai bot polling lagi.
- Log tampil di terminal tempat bot berjalan (JSON; memuat panjang pesan dan jenis kejadian, bukan isi pesan, nominal, atau
  teks struk).
- Port aplikasi (3100) diatur oleh `PORT` di `.env`; database ada di `127.0.0.1:15432`.

## Pemecahan masalah

| Gejala | Tindakan |
|---|---|
| `'sh' is not recognized` atau `execvpe(/bin/bash) failed` / `WSL ... ERROR` saat menjalankan `npm run db:backup`, `db:restore-rehearsal`, `db:restore`, `db:verify`, `db:encrypt-existing`, `acceptance:check` | Skrip `.sh` dijalankan dengan `sh scripts/...`. Di PowerShell/cmd `sh` tidak ada di PATH, dan `bash` biasa menunjuk ke peluncur **WSL** yang tidak berfungsi tanpa distribusi Linux. **Jalankan perintah itu dari terminal Git Bash** (atau tambahkan `C:\Program Files\Git\usr\bin` ke PATH Windows). `npm run db:up` dan `start:dev` jalan di terminal mana pun |
| "Docker is not running" / `db:up` gagal | Buka Docker Desktop, tunggu ikon stabil, ulangi `npm run db:up` |
| `docker compose` gagal: "ports are not available ... forbidden by its access permissions" | Windows mencadangkan rentang port acak setelah reboot (lihat `netsh interface ipv4 show excludedportrange protocol=tcp`). Port bawaan sudah **15432** (di bawah rentang dinamis 49152+). Bila port yang kamu pilih masuk rentang itu, ubah `POSTGRES_PORT` **dan** port di `DATABASE_URL` di `.env` |
| PostgreSQL tidak menjawab | `docker logs finance-bot-postgres`; `docker ps -a`; bila port 15432 dipakai aplikasi lain ubah `POSTGRES_PORT` dan `DATABASE_URL` |
| Volume database hilang / data kosong | Jangan jalankan migrasi dulu. Pulihkan dari cadangan: `npm run db:restore -- backups/db/<file> finance_bot_restored`, periksa, lalu arahkan `DATABASE_URL` (lihat `docs/runbook.md`) |
| Migrasi tertunda | Baca `npx prisma migrate status`; bila aman: `npx prisma migrate deploy` (jangan `migrate dev`/`reset`). Selalu ambil cadangan dulu |
| Token Telegram tidak valid | Log menyebut 401/`Unauthorized` dari Telegram. Perbarui `TELEGRAM_BOT_TOKEN` di `.env` (jangan tempel token di chat/terminal), restart. Lihat prosedur rotasi di `docs/security/dependency-and-secret-review.md` |
| Bot lain sedang polling (409 Conflict) | Hanya satu proses boleh `getUpdates` per token. Tutup terminal/proses bot lain , `deleteWebhook` bila ada webhook |
| Telegram membatasi (429) | Bot menunggu `retry_after` dan mencoba lagi sendiri; kurangi volume pesan |
| Ollama tidak jalan | Jalankan `ollama serve`; bot tetap berfungsi (pembaca deterministik). Model yang dikonfigurasi hilang: `ollama list`, atau kosongkan `OLLAMA_MODEL` |
| Data bahasa OCR hilang | `npm run receipt:fetch-langdata` (mengunduh dua berkas bahasa dari repositori Tesseract resmi) |
| Ekstraksi struk gagal / "belum bisa membaca" | `npm run receipt:live-check -- foto.jpg --ocr` untuk melihat teks yang dibaca; koreksi lewat chat: `total 45rb`, `tanggal 12/10/2026`, `toko …` |
| Konfirmasi tampak ganda | Tidak bisa membuat transaksi ganda: konfirmasi terkunci dan idempoten. Periksa `npm run acceptance:check -- <penanda>` |
| Cadangan tidak bisa dipulihkan | Jalankan `npm run db:restore-rehearsal <berkas>`; "Bad session key" = passphrase salah; "manipulated" = berkas rusak; pakai cadangan sebelumnya |
