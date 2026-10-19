# Peningkatan keandalan, keamanan, dan pengujian

Dokumen ini mencatat peningkatan yang ditambahkan pada finance bot untuk keandalan pemrosesan update, perlindungan terhadap pencatatan ganda, privasi log, dan ketahanan tes, beserta bukti pengujiannya. Gambaran proyek ada di [laporan proyek](../project-report.md).

> Pemeriksaan dilakukan oleh pembangun dan alat otomatis. Dokumen ini **bukan** audit manusia atau uji penetrasi. Setiap status menyebut apa yang benar-benar dijalankan; yang tidak dijalankan ditulis demikian.

## 1. Ringkasan

| Peningkatan | Prioritas | Hasil |
|---|---|---|
| Update dari chat yang sama diproses satu per satu, berurutan | P2 | dialog bertahap tetap benar pada mode webhook |
| Peringatan `POSSIBLE_DUPLICATE` untuk struk yang sama dari berkas berbeda | P2 | pengguna diberi tahu sebelum mencatat dua kali; tidak memblokir |
| Redaksi log diperluas, header `x-powered-by` dimatikan | P3 | secret webhook, kunci API, passphrase, dan URL database/Redis tidak ikut tercatat bila seluruh objek ter-log tanpa sengaja |
| Tes injeksi kegagalan menunggu pemulihan crash PostgreSQL | P3 | tes tidak lagi rapuh terhadap waktu pemulihan |

Gerbang akhir: `npm run verify` exit 0 (1.111 unit, 177 integrasi, 84 e2e, 26 antrean, 0 kerentanan produksi), 18 tes injeksi kegagalan lulus, uji mutasi 97 mutan dengan 0 selamat.

## 2. Kondisi per area

Status: `VERIFIED` (terbukti oleh tes atau perintah yang dijalankan), `IMPROVED` (ditingkatkan di dokumen ini), `PARTIAL`, `NOT RUN`, `BLOCKED`.

| Area | Kondisi | Status | Bukti |
|---|---|---|---|
| Arsitektur | domain / application / infrastructure per modul; arah dependensi ditegakkan tes | VERIFIED | `src/architecture.spec.ts` (7 tes: impor, siklus, pengecualian tidak basi) |
| Dependensi | npm, lockfile konsisten; `npm audit` produksi 0 (override terlingkup `deepmerge-ts`) | VERIFIED | `package.json` `overrides`; [dependensi dan rahasia](../security/dependency-and-secret-review.md) |
| Konfigurasi | validator fail-closed: allowlist kosong = tak seorang pun, bind non-loopback butuh izin, Redis non-loopback tanpa sandi ditolak, boolean ketat | VERIFIED | `src/config/env.validation.ts` + spec |
| Database | `BIGINT` satuan minor, `CHECK`, unique idempotensi, `FOR UPDATE`, trigger tenant, tabel audit; satu migrasi `init` diuji pada database kosong | VERIFIED | `prisma/migrations/20261017000000_init/migration.sql`, `tenant-guards.spec.ts`, `migrations.spec.ts` |
| Telegram | polling berurutan, offset maju setelah sukses; dedupe pesan dan kunci idempotensi; retry terbatas; allowlist; rate limit; shutdown terbatas; urutan per chat | VERIFIED; IMPROVED | `telegram.poller.ts`, `update-processor.ts` |
| OCR dan AI | validasi gambar, Tesseract, parser deterministik, model opsional (breaker, semaphore), draf, konfirmasi `ya`, idempotensi, peringatan struk kembar | VERIFIED; IMPROVED | `src/modules/receipt/**`, `receipt-ai-safety.spec.ts` (124) |
| Keamanan | pelingkupan pemilik: statis + 16 probe dinamis + trigger DB; redaksi log; loopback bind; `/metrics` cek peer dan Host | VERIFIED; IMPROVED | `user-scoping.spec.ts`, `isolation-probes.spec.ts`, `tenant-guards.spec.ts`, `logger.module.spec.ts` |
| Observabilitas | `/health/live`, `/health/ready` (DB, migrasi, AI, OCR, antrean), `/metrics`, tabel `audit_events`, retensi | VERIFIED | `health.service.ts`, `metrics.service.ts`, `retention.service.ts` |
| Pengujian | 1.111 unit, 177 integrasi, 84 e2e, 26 antrean, 18 injeksi kegagalan, properti, ras, soak, 97 mutan, evaluasi OCR | VERIFIED; IMPROVED | [kualitas tes](test-quality-review.md), [strategi tes](../testing/test-strategy-and-coverage.md) |
| Operasi | cadangan terenkripsi, rotasi, latihan restore, gladi migrasi, `docker:verify`, `disk:check`, compose berprofil dan dikeraskan | VERIFIED | `scripts/*.sh`, `scripts/disk-check.js`, `docker-compose.yml` |
| Antrean | Redis/BullMQ opsional (`receipts`, `maintenance`), fallback dalam proses, payload divalidasi konsumen | VERIFIED | `src/modules/queue/**`, `test/queue` |
| Peran database terbatas | disiapkan dan dibuktikan pada DB sekali-pakai, belum diterapkan di database hidup | VERIFIED (bukti) / BLOCKED (penerapan) | `test/failure/least-privilege.failure-spec.ts`, [peran DB terbatas](../operations/db-least-privilege.md) |

## 3. Peningkatan

### 3.1 Urutan pemrosesan update per chat (P2)
- **Latar belakang:** pada mode polling update diproses satu per satu, tetapi pada mode webhook dua update dari chat yang sama dapat diproses serentak. Dialog bertahap ("beli kopi" lalu "25rb") bisa membaca state sebelum langkah pertama selesai. Transaksi tetap aman karena idempotensi dan `FOR UPDATE`; yang terdampak adalah keteraturan dialog.
- **Perubahan:** `src/modules/bot/infrastructure/update-processor.ts` memakai antrean rantai promise per `chat.id`. Entri dihapus saat chat tidak punya pekerjaan (memori tidak tumbuh), kegagalan satu update tidak memblokir berikutnya, dan chat berbeda tidak saling menunggu.
- **Tes:** `update-processor.spec.ts` (+5): tidak memulai update kedua sebelum yang pertama selesai, urutan terjaga untuk banyak update, chat berbeda paralel, lanjut setelah kegagalan, tanpa kebocoran peta. Mutan M90 terbunuh asersi.
- **Risiko regresi:** rendah; pada polling perilakunya sama.

### 3.2 Peringatan struk yang sama dari berkas berbeda (P2)
- **Latar belakang:** hash berkas hanya mencegah foto yang byte-nya identik. Foto ulang struk yang sama menghasilkan dua draf dan, bila keduanya dibalas `ya`, dua transaksi.
- **Perubahan:** peringatan `POSSIBLE_DUPLICATE` muncul di pratinjau bila pengguna sudah punya pengeluaran dengan nominal sama pada hari yang sama (zona waktu pengguna), yang tidak terhapus dan milik pengguna itu sendiri. Hanya peringatan; pengguna tetap memutuskan `ya` atau `batal`. Dihitung ulang setiap koreksi `total` atau `tanggal`. Berkas: `receipt-extraction.ts`, `receipt.repository.ts` (port `hasExpenseLike`), `prisma-receipt.repository.ts`, `receipt.service.ts`, `reply-builder.ts`. Tidak ada perubahan skema atau migrasi.
- **Tes:** integrasi +8 (nominal dan hari, batas setengah-terbuka, lintas pengguna, terhapus dan pemasukan, peringatan pada foto kedua, cek ulang setelah koreksi, tetap setelah dimuat ulang), e2e +1 (alur webhook penuh), unit +3. Mutan M91–M95 terbunuh asersi.
- **Batasan:** kecocokan memakai nominal dan tanggal, bukan nama toko, sehingga dua pembelian sah dengan nominal sama pada hari yang sama ikut diberi peringatan. Dampaknya satu baris teks.

### 3.3 Redaksi log dan header respons (P3)
- **Latar belakang:** redaksi pino semula hanya menutup `authorization`, `cookie`, `password`, dan `token`. Header `x-telegram-bot-api-secret-token`, `botToken`, `secret`, `apiKey`, `passphrase`, dan URL database/Redis tidak tercakup bila seluruh objek tercatat tanpa sengaja. Respons mencantumkan `x-powered-by: Express`.
- **Perubahan:** `LOG_REDACT_PATHS` diperluas (`src/common/logger/logger.module.ts`) dan `x-powered-by` dimatikan (`src/app.setup.ts`).
- **Tes:** `logger.module.spec.ts` (13, memakai pino sungguhan) dan satu tes e2e untuk header. Mutan M96 dan M97 terbunuh asersi.
- **Catatan:** aplikasi memang mencatat galat berdasarkan nama kelas saja; ini jaring pengaman, bukan perbaikan kebocoran yang teramati.

### 3.4 Ketahanan tes injeksi kegagalan (P3)
- **Latar belakang:** tes "interrupted backup" menjalankan `DROP TABLE` segera setelah menyalakan ulang PostgreSQL yang di-kill di tengah dump 100 MB. Pemulihan crash membuat query gagal "database system is starting up" (teramati sekali dari tiga run).
- **Perubahan:** tes menunggu sampai database menjawab sebelum membersihkan. Asersi tentang cadangan tidak dilemahkan.

## 4. Hasil pengujian

Dijalankan di Windows 11, Node 24, Docker Desktop.

| Pemeriksaan | Perintah | Lingkungan | Hasil | Exit code |
|---|---|---|---|---|
| Gerbang penuh | `npm run verify` | PostgreSQL `finance_bot_test` + Redis sekali-pakai | 1.111 unit (55 suite), 177 integrasi, 84 e2e, 26 antrean lulus; 0 kerentanan produksi | 0 |
| Typecheck, lint, format | `npm run typecheck`, `lint`, `format:check` | lokal | bersih | 0 |
| Injeksi kegagalan | `npm run test:failure` | PostgreSQL dan Redis sekali-pakai di Docker, skrip cadangan nyata | 18 lulus | 0 |
| Uji mutasi | `npm run test:mutation` | salinan kerja, `finance_bot_test` | 97 mutan: 89 terbunuh asersi, 8 oleh error aplikasi, 0 selamat, 0 tak valid | 0 |
| Cakupan unit | `npm run test:cov` | lokal | pernyataan 71,70 %, cabang 69,69 %, fungsi 65,27 %, baris 73,41 % | 0 |
| Evaluasi OCR | `npm run receipt:eval` | Tesseract nyata, 75 gambar sintetis | total tepat 85 % (57/67), tanggal 96 % (49/51), toko 81 %, draf salah 1 % (ditandai), OCR median 168 ms, p95 11,5 s | 0 |
| Pemeriksaan live Ollama | `npm run receipt:live-check` | Ollama nyata `qwen3:4b-instruct` | struk sintetis terbaca benar (total 16.500) | 0 |
| Batas Docker | `npm run docker:verify` | kontainer PostgreSQL yang berjalan | semua batas aktif | 0 |
| Ruang disk | `npm run disk:check` | volume PostgreSQL dan folder cadangan | OK | 0 |
| Soak | `npm run test:soak` | — | **NOT RUN** pada putaran ini; run 600 detik sebelumnya: 0 duplikat | — |
| Restore rehearsal cadangan nyata | `npm run db:restore-rehearsal` | — | **NOT RUN**; butuh passphrase interaktif pemilik. Skenario cadangan, restore, passphrase salah, dan berkas rusak tercakup di `test:failure` dengan passphrase uji | — |
| Telegram nyata | — | — | **NOT RUN**; panduan manual: [uji Telegram manual](../testing/telegram-acceptance-manual.md) | — |

Unit memakai mock dan fixture; integrasi dan e2e memakai PostgreSQL nyata dengan Telegram diganti penangkap dan Ollama palsu; antrean memakai Redis nyata; injeksi kegagalan memakai PostgreSQL dan Redis kontainer nyata yang di-stop atau di-kill. Evaluasi OCR memakai data sintetis dan tidak mewakili akurasi pada struk nyata.

## 5. Temuan keamanan

| Temuan | Severity | Perbaikan | Risiko tersisa |
|---|---|---|---|
| Redaksi log kurang lengkap | rendah | `LOG_REDACT_PATHS` diperluas + tes pino nyata | jaring pengaman; log tidak sengaja memuat objek itu |
| `x-powered-by` aktif | informasi | dimatikan + tes e2e | tidak ada |
| Pemrosesan update serentak pada webhook | rendah (integritas aman) | urutan per chat | mode webhook bukan bawaan |
| Aplikasi terhubung sebagai superuser | sedang bila bot disusupi | peran terbatas sudah dibuktikan, belum diterapkan | BLOCKED — butuh persetujuan pemilik |
| Struk kembar dari berkas berbeda | rendah | peringatan | pengguna masih bisa mengonfirmasi dua kali |
| Pengurai chat heuristik; salah baca digit total OCR tanpa baris tunai/kembalian | rendah–sedang | konfirmasi `ya` wajib | tetap risiko ([evaluasi OCR](../testing/receipt-ocr-evaluation.md)) |

Yang dilakukan hanya tinjauan kode, tes otomatis, uji mutasi, dan audit dependensi. Uji penetrasi tidak dilakukan.

## 6. Kesiapan operasi

- Menyalakan: `npm run db:up`, `npm run start:dev`; cek `/health/ready`. Tidak ada skrip start/stop/autostart.
- Cadangan dan pemulihan: `db:backup` terenkripsi, dibaca balik, checksum, rotasi; `db:restore-rehearsal`; `db:restore` hanya ke database baru. Salinan luar mesin menjadi tugas pemilik.
- Ruang disk: `db:backup` menolak bila ruang kosong < 100 MB, dan `disk:check` melaporkan ruang (perintah manual, bukan pemantauan otomatis).
- Ollama dan Redis opsional; bot tetap berjalan tanpa keduanya.
- Deployment VPS belum diuji, jadi tidak ada klaim siap server.

## 7. Batasan yang tersisa

| Status | Item | Langkah lanjutan |
|---|---|---|
| KNOWN LIMITATION | Tidak ada audit manusia atau uji penetrasi | tinjauan atas pengurai chat dan alur reset |
| KNOWN LIMITATION | Peringatan duplikasi struk memakai nominal + tanggal, tidak memeriksa nama toko, dan tidak memblokir | tambah kemiripan toko bila perlu |
| KNOWN LIMITATION | Salah baca digit total OCR tanpa baris tunai/kembalian tidak terdeteksi | perlu data struk nyata |
| KNOWN LIMITATION | Dengan satu migrasi `init`, uji "migrasi pada data lama" tidak berjalan | pasang kembali polanya (deploy sampai N, isi data, terapkan N+1) saat migrasi kedua ditambahkan |
| NOT RUN | Soak, restore rehearsal atas cadangan nyata, Telegram nyata | lihat bagian 4 |
| NOT VERIFIED | Perilaku di VPS, token asli di kontainer, Ollama di host Linux | deployment di luar cakupan |
| BLOCKED | Menerapkan peran database non-superuser pada database hidup | butuh persetujuan pemilik |
