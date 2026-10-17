# Tinjauan dependensi dan rahasia

> Tinjauan ini dibuat oleh pembangun dan alat otomatis, **bukan** audit manusia. Angka diukur dengan `npm audit`.

## 1. Hasil audit dependensi

| Ukuran | Hasil |
|---|---|
| `npm audit --omit=dev` (produksi) | **0 kerentanan** |
| `npm audit` (semua termasuk dev) | 20 moderate, 0 high, 0 critical |

Gerbang `npm run verify` memakai `npm audit --omit=dev --audit-level=critical`.

Yang dilakukan:
- `@nestjs/swagger` → `js-yaml` dipaksa ke 5.4.2 lewat `overrides` (versi yang tidak terkena).
- `exceljs` → `uuid` dipaksa ke 11.1.1 lewat `overrides`.
- `prisma` → `@prisma/config` → `deepmerge-ts` dipaksa ke 8.0.2 lewat satu *override* sempit dan terkunci versinya: `"overrides": {"@prisma/config": {"deepmerge-ts": "8.0.2"}}` (v8 punya ekspor CJS/ESM dan API `deepmerge` yang sama). Perbaikan yang disarankan npm (`prisma@7.10.1`) adalah lompatan **mayor** (generator, `prisma.config.ts`, perubahan koneksi) dan tidak dipakai.
- Jest 30 dan `@types/jest` 30 menghilangkan rantai `braces`/`micromatch` yang menandai belasan paket sebagai high. ts-jest 29.4 mendukung Jest 30.
- Tidak ada downgrade mayor dan tidak ada `npm audit fix --force`.

Override `deepmerge-ts` diuji dengan `prisma validate`, `generate`, `migrate status`, `migrate diff`, `migrate deploy` pada salinan database nyata (`db:migrate-rehearsal`), build, dan seluruh gerbang `npm run verify`.
Hapus override ini saat Prisma merilis `@prisma/config` yang sendiri memakai `deepmerge-ts` ≥ 8 (mis. saat naik ke Prisma 7), dan jalankan lagi `db:migrate-rehearsal`. Bila suatu perintah CLI Prisma gagal dengan galat modul, lepas override.

## 2. Temuan yang dicek satu per satu

| Paket | Jalur | Tingkat | Advisory | Terjangkau saat runtime? | Keputusan |
|---|---|---|---|---|---|
| `js-yaml` 5.x | `@nestjs/swagger@11.4.7` | moderate | GHSA-r3ph-w7gj-g6xm (CPU pada merge key YAML) | Tidak untuk input luar: Swagger **mati secara default** dan hanya *menghasilkan* YAML dari kode sendiri | **Diperbaiki** (override ke 5.4.2). `@nestjs/swagger@12` butuh NestJS 12, tidak kompatibel; 11.4.7 adalah rilis 11.x terakhir |
| `uuid` 8.x | `exceljs@4.4.0` | moderate | GHSA-w5hq-g745-h8pq (batas buffer pada uuid v3/v5/v6 bila `buf` diberikan) | **Tidak.** `exceljs` hanya memanggil `v4()` tanpa buffer | **Diperbaiki** (override ke 11.1.1). `exceljs` 4.4.0 adalah rilis terbaru; "perbaikan" yang disarankan npm adalah downgrade ke 3.4.0 (ditolak) |
| `deepmerge-ts` 7.1.5 | `prisma@6.19.3` → `@prisma/config` | high | GHSA-ggr8-5vv4-36mx (stack exhaustion saat menggabungkan graf objek rekursif) | **Tidak di runtime bot.** Dipakai CLI Prisma saat memuat konfigurasi; repo tidak punya `prisma.config.ts`; `@prisma/client` (runtime) tidak memuat `@prisma/config` | **Diperbaiki** dengan override sempit dan terkunci (bagian 1). Tinjau ulang saat naik ke Prisma 7 |
| `js-yaml` 3.x, `argparse`, `sprintf-js` (moderate, dev) | `@istanbuljs/load-nyc-config` → `babel-plugin-istanbul` (rantai Jest/cakupan) | moderate | beberapa | Tidak: hanya mem-parsing berkas konfigurasi nyc (repo tidak punya) saat menjalankan tes | **Ditunda** (alat pengembangan; override ke js-yaml 4 berisiko merusak pemuatan konfigurasi) |

`sharp` 0.35.5 menutup kerentanan libvips/librsvg/libheif; aplikasi hanya mendekode JPEG/PNG/WebP setelah cek *magic bytes*, tidak pernah SVG atau HEIF.

Skrip instalasi: hanya Prisma dan sharp yang diizinkan (`allowScripts`); `tesseract.js` dan `@scarf/scarf` **ditolak**. Jest 30 membawa satu
skrip, `unrs-resolver` (pemeriksa binding native resolver), yang **tidak disetujui**: seluruh tes tetap lulus tanpa menjalankannya.

## 3. Rahasia

| Fakta | Bukti |
|---|---|
| Hanya `.env.example` yang di-commit; tidak ada berkas `.env*` lain di riwayat | `git log --all --name-only` |
| Tidak ada nilai rahasia nyata dari `.env` di working tree yang akan di-commit atau di riwayat git | pencarian nilai rahasia di berkas ter-stage dan `git log -S` |
| Tidak ada blok kunci privat di riwayat | `grep` pada `git log -p` |
| String berbentuk token di riwayat hanya fixture uji palsu berawalan `123…` | pemindaian riwayat |
| Token bot ada di `.env` (git-ignored; satu-satunya berkas env) | – |

Kesimpulan: tidak ada rahasia yang bocor ke repositori. Bila token pernah ditempel di kanal lain (percakapan, tangkapan layar), perlakukan sebagai terekspos ke kanal itu dan putar (bagian 4).

## 4. Prosedur memutar token Telegram (tanpa menyebut token di chat)

1. Pastikan bot memang memakai token yang kamu maksud: `curl http://127.0.0.1:3100/health/ready` (readiness), dan `getMe`
   dari terminalmu sendiri (tanpa menempelkan token ke chat).
2. Rencanakan jeda singkat: pesan yang masuk saat bot berhenti **tidak hilang**, Telegram menyimpannya sampai bot polling lagi.
3. Di Telegram buka **@BotFather** → `/revoke` → pilih bot → BotFather menerbitkan token baru dan **mencabut yang lama**.
4. Perbarui token **hanya lewat editor** (jangan lewat argumen perintah atau chat): `.env` → `TELEGRAM_BOT_TOKEN=`. Hanya ada
   satu berkas `.env`.
5. Hentikan bot (Ctrl+C), lalu jalankan lagi `npm run start:dev`.
6. Verifikasi: `/health/ready` menjawab `ok`; kirim satu pesan uji; periksa balasan.
7. Pastikan token lama tidak lagi dipakai: dari terminalmu panggil `getMe` dengan token lama → harus `Unauthorized`.
8. Hapus rujukan token lama di tempat lain yang kamu simpan (catatan, pengelola kata sandi). Jangan menyalin nilainya ke dokumen.
