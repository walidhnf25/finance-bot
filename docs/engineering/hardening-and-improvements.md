# Peningkatan keandalan, keamanan, dan pengujian

Dokumen ini mencatat peningkatan yang ditambahkan pada finance bot untuk keandalan pemrosesan update, perlindungan terhadap pencatatan ganda, ketepatan pengurai pesan, privasi log, dan ketahanan tes, beserta bukti pengujiannya. Gambaran proyek ada di [laporan proyek](../project-report.md).

> Pemeriksaan dilakukan oleh pembangun dan alat otomatis. Dokumen ini **bukan** audit manusia atau uji penetrasi. Setiap status menyebut apa yang benar-benar dijalankan; yang tidak dijalankan ditulis demikian.

## 1. Ringkasan

| Peningkatan | Prioritas | Hasil |
|---|---|---|
| Update dari chat yang sama diproses satu per satu, berurutan | P2 | dialog bertahap tetap benar pada mode webhook |
| Peringatan `POSSIBLE_DUPLICATE` untuk struk yang sama dari berkas berbeda | P2 | pengguna diberi tahu sebelum mencatat dua kali; tidak memblokir |
| Perintah pemindahan dompet, budget, saldo awal, atur dompet, dan dompet utama hanya berlaku di awal pesan | P2 | "ongkos pindah rumah 500rb" tercatat sebagai pengeluaran, bukan transfer antar dompet |
| Redaksi log diperluas, header `x-powered-by` dimatikan | P3 | secret webhook, kunci API, passphrase, dan URL database/Redis tidak ikut tercatat bila seluruh objek ter-log tanpa sengaja |
| Tes injeksi kegagalan menunggu pemulihan crash PostgreSQL | P3 | tes tidak lagi rapuh terhadap waktu pemulihan |

Gerbang akhir: `npm run verify` exit 0 (1.143 unit, 177 integrasi, 84 e2e, 26 antrean, 0 kerentanan produksi), 18 tes injeksi kegagalan lulus, uji mutasi 102 mutan dengan 0 selamat, soak 300 detik tanpa duplikat, latihan restore atas salinan data nyata cocok.

## 2. Kondisi per area

Status: `VERIFIED` (terbukti oleh tes atau perintah yang dijalankan), `IMPROVED` (ditingkatkan di dokumen ini), `PARTIAL`, `NOT RUN`, `BLOCKED`.

| Area | Kondisi | Status | Bukti |
|---|---|---|---|
| Arsitektur | domain / application / infrastructure per modul; arah dependensi ditegakkan tes | VERIFIED | `src/architecture.spec.ts` (7 tes: impor, siklus, pengecualian tidak basi) |
| Dependensi | npm, lockfile konsisten; `npm audit` produksi 0 (override terlingkup `deepmerge-ts`) | VERIFIED | `package.json` `overrides`; [dependensi dan rahasia](../security/dependency-and-secret-review.md) |
| Konfigurasi | validator fail-closed: allowlist kosong = tak seorang pun, bind non-loopback butuh izin, Redis non-loopback tanpa sandi ditolak, boolean ketat | VERIFIED | `src/config/env.validation.ts` + spec |
| Database | `BIGINT` satuan minor, `CHECK`, unique idempotensi, `FOR UPDATE`, trigger tenant, tabel audit; satu migrasi `init` diuji pada database kosong | VERIFIED | `prisma/migrations/20261017000000_init/migration.sql`, `tenant-guards.spec.ts`, `migrations.spec.ts` |
| Telegram | polling berurutan, offset maju setelah sukses; dedupe pesan dan kunci idempotensi; retry terbatas; allowlist; rate limit; shutdown terbatas; urutan per chat | VERIFIED; IMPROVED | `telegram.poller.ts`, `update-processor.ts` |
| Pengurai pesan | perintah yang mengubah data hanya di awal pesan: hapus, ubah, reset, pindah, tarik, setor, budget, saldo awal, atur dompet, dompet utama | VERIFIED; IMPROVED | `rule-based.parser.spec.ts`, `rule-based.parser.fuzz.spec.ts` |
| OCR dan AI | validasi gambar, Tesseract, parser deterministik, model opsional (breaker, semaphore), draf, konfirmasi `ya`, idempotensi, peringatan struk kembar | VERIFIED; IMPROVED | `src/modules/receipt/**`, `receipt-ai-safety.spec.ts` (124) |
| Keamanan | pelingkupan pemilik: statis + 16 probe dinamis + trigger DB; redaksi log; loopback bind; `/metrics` cek peer dan Host | VERIFIED; IMPROVED | `user-scoping.spec.ts`, `isolation-probes.spec.ts`, `tenant-guards.spec.ts`, `logger.module.spec.ts` |
| Observabilitas | `/health/live`, `/health/ready` (DB, migrasi, AI, OCR, antrean), `/metrics`, tabel `audit_events`, retensi | VERIFIED | `health.service.ts`, `metrics.service.ts`, `retention.service.ts` |
| Pengujian | 1.143 unit, 177 integrasi, 84 e2e, 26 antrean, 18 injeksi kegagalan, properti, ras, kalimat acak, soak, 102 mutan, evaluasi OCR | VERIFIED; IMPROVED | [kualitas tes](test-quality-review.md), [strategi tes](../testing/test-strategy-and-coverage.md) |
| Operasi | cadangan terenkripsi, rotasi, latihan restore, gladi migrasi, `docker:verify`, `disk:check`, compose berprofil dan dikeraskan | VERIFIED | `scripts/*.sh`, `scripts/disk-check.js`, `docker-compose.yml` |
| Antrean | Redis/BullMQ opsional (`receipts`, `maintenance`), fallback dalam proses, payload divalidasi konsumen | VERIFIED | `src/modules/queue/**`, `test/queue` |
| Peran database terbatas | dibuktikan pada database sekali-pakai, belum diterapkan di database hidup | VERIFIED (bukti) / BLOCKED (penerapan) | `test/failure/least-privilege.failure-spec.ts`, [peran DB terbatas](../operations/db-least-privilege.md) |

## 3. Peningkatan

### 3.1 Urutan pemrosesan update per chat (P2)
- **Latar belakang:** pada mode polling update diproses satu per satu, tetapi pada mode webhook dua update dari chat yang sama dapat diproses serentak. Dialog bertahap ("beli kopi" lalu "25rb") bisa membaca state sebelum langkah pertama selesai. Transaksi tetap aman karena idempotensi dan `FOR UPDATE`; yang terdampak adalah keteraturan dialog.
- **Perubahan:** `src/modules/bot/infrastructure/update-processor.ts` memakai antrean rantai promise per `chat.id`. Entri dihapus saat chat tidak punya pekerjaan (memori tidak tumbuh), kegagalan satu update tidak memblokir berikutnya, dan chat berbeda tidak saling menunggu.
- **Tes:** `update-processor.spec.ts` (+5). Mutan M90 terbunuh asersi.
- **Risiko regresi:** rendah; pada polling perilakunya sama.

### 3.2 Peringatan struk yang sama dari berkas berbeda (P2)
- **Latar belakang:** hash berkas hanya mencegah foto yang byte-nya identik. Foto ulang struk yang sama menghasilkan dua draf dan, bila keduanya dibalas `ya`, dua transaksi.
- **Perubahan:** peringatan `POSSIBLE_DUPLICATE` muncul di pratinjau bila pengguna sudah punya pengeluaran dengan nominal sama pada hari yang sama (zona waktu pengguna), yang tidak terhapus dan milik pengguna itu sendiri. Hanya peringatan; pengguna tetap memutuskan `ya` atau `batal`. Dihitung ulang setiap koreksi `total` atau `tanggal`. Berkas: `receipt-extraction.ts`, `receipt.repository.ts` (port `hasExpenseLike`), `prisma-receipt.repository.ts`, `receipt.service.ts`, `reply-builder.ts`. Tidak ada perubahan skema atau migrasi.
- **Tes:** integrasi +8, e2e +1, unit +3. Mutan M91–M95 terbunuh asersi.
- **Batasan:** kecocokan memakai nominal dan tanggal, bukan nama toko, sehingga dua pembelian sah dengan nominal sama pada hari yang sama ikut diberi peringatan. Dampaknya satu baris teks.

### 3.3 Perintah pengaturan dan pemindahan dompet hanya di awal pesan (P2)
- **Latar belakang:** pengujian dengan kalimat yang dibangkitkan acak (`rule-based.parser.fuzz.spec.ts`, benih tetap) menunjukkan bahwa kata perintah di tengah kalimat pengeluaran masih mengubah pengaturan: "ongkos pindah rumah 500rb" dan "pindah kos 1jt" terbaca sebagai transfer antar dompet, "makan siang budget 20rb" sebagai pengaturan budget, dan "beli tas atur dompet 50rb" sebagai pertanyaan pengaturan dompet. Pengeluaran sungguhan tidak tercatat dan tampil sebagai pemindahan saldo. Perintah hapus, ubah, reset, dan bantuan sudah dibatasi di awal pesan; yang lain belum.
- **Perubahan:** `src/modules/parser/rule-based/rule-based.parser.ts`.
  - Pemindahan dompet (`pindah`, `tarik`, `setor`) hanya dikenali bila kata perintahnya ada di awal pesan dan tidak ada kata lain selain nominal, nama dompet, dan kata pengisi ("tolong", "uang", "dari", "ke", …). Contoh yang tetap berlaku: "pindah 300rb dari cash ke digital", "tolong tarik tunai 500rb", "setor tunai 200rb".
  - Budget dan saldo awal hanya dikenali di awal pesan, atau setelah kata pengantar seperti "tolong", "atur", "set" ("tolong atur budget makan 2jt", "atur saldo awal digital 1jt").
  - Atur dompet harus di awal pesan dan tanpa angka; dompet utama harus pesan pendek tanpa angka; penghapusan transfer hanya bila kata hapus/batal ada di awal.
- **Tes:** `rule-based.parser.spec.ts` (+30 kasus: 11 kalimat pengeluaran yang harus tetap dicatat, 18 perintah yang harus tetap bekerja, 1 pemeriksaan saldo awal), dan `rule-based.parser.fuzz.spec.ts` (4.000 kalimat pengeluaran dengan kata perintah di tengah: tidak boleh ada yang berubah menjadi niat yang mengubah data; 2.000 teks acak tidak membuat parser gagal). Mutan M98–M102 terbunuh asersi.
- **Batasan:** pengurai tetap heuristik. Kata baca-saja ("total", "saldo", "ringkasan") masih dikenali di mana pun karena hanya menampilkan data; pesan dengan banyak angka tetap tebakan, dan balasan menampilkan nominal yang dipakai.

### 3.4 Redaksi log dan header respons (P3)
- **Latar belakang:** redaksi pino semula hanya menutup `authorization`, `cookie`, `password`, dan `token`. Header `x-telegram-bot-api-secret-token`, `botToken`, `secret`, `apiKey`, `passphrase`, dan URL database/Redis tidak tercakup bila seluruh objek tercatat tanpa sengaja. Respons mencantumkan `x-powered-by: Express`.
- **Perubahan:** `LOG_REDACT_PATHS` diperluas (`src/common/logger/logger.module.ts`) dan `x-powered-by` dimatikan (`src/app.setup.ts`).
- **Tes:** `logger.module.spec.ts` (13, memakai pino sungguhan) dan satu tes e2e untuk header. Mutan M96 dan M97 terbunuh asersi.
- **Catatan:** aplikasi memang mencatat galat berdasarkan nama kelas saja; ini jaring pengaman, bukan perbaikan kebocoran yang teramati.

### 3.5 Ketahanan tes injeksi kegagalan (P3)
- **Latar belakang:** tes "interrupted backup" menjalankan `DROP TABLE` segera setelah menyalakan ulang PostgreSQL yang di-kill di tengah dump 100 MB. Pemulihan crash membuat query gagal "database system is starting up" (teramati sekali dari tiga run).
- **Perubahan:** tes menunggu sampai database menjawab sebelum membersihkan. Asersi tentang cadangan tidak dilemahkan.

## 4. Hasil pengujian

Dijalankan di Windows 11, Node 24, Docker Desktop.

| Pemeriksaan | Perintah | Lingkungan | Hasil | Exit code |
|---|---|---|---|---|
| Gerbang penuh | `npm run verify` | PostgreSQL `finance_bot_test` + Redis sekali-pakai | 1.143 unit (56 suite), 177 integrasi, 84 e2e, 26 antrean lulus; 0 kerentanan produksi | 0 |
| Typecheck, lint, format | `npm run typecheck`, `lint`, `format:check` | Node 24 | bersih | 0 |
| Injeksi kegagalan | `npm run test:failure` | PostgreSQL dan Redis sekali-pakai di Docker, skrip cadangan nyata | 18 lulus (termasuk peran database non-superuser) | 0 |
| Uji mutasi | `npm run test:mutation` | salinan kerja, `finance_bot_test` | 102 mutan: 94 terbunuh asersi, 8 oleh error aplikasi, 0 selamat, 0 tak valid | 0 |
| Soak | `SOAK_SECONDS=300 npm run test:soak` | PostgreSQL asli, transport simulasi, kegagalan disuntik, restart berkala | 5.856 iterasi; 3.506 catatan = 3.506 baris; 1.306 struk dikonfirmasi = 1.306 baris = 1.306 draf `CONFIRMED`; 961 kegagalan DB disuntik, 0 respons 503 tak terduga; 23 restart + 276 pemutaran ulang setelah restart; 0 duplikat | 0 |
| Latihan restore atas salinan data nyata | `db:backup` lalu `db:restore-rehearsal` | salinan terenkripsi dibuat dengan passphrase acak sekali-pakai (dihapus sesudahnya), dipulihkan di kontainer sekali-pakai | checksum OK, pemeriksaan integritas lulus, **cocok dengan database hidup** (25 transaksi, 11 pengguna, 14 kategori, total uang sama); passphrase salah ditolak (`Bad session key`); tidak ada kontainer atau berkas sisa | 0 |
| Gladi migrasi | `npm run db:migrate-rehearsal` | salinan database hidup | tidak ada migrasi tertunda, jadi tidak ada yang digladi; kesamaan skema migrasi `init` dengan database hidup sudah dibuktikan lewat perbandingan `pg_dump` | 0 |
| Cakupan unit | `npm run test:cov` | Node 24 | pernyataan 71,70 %, cabang 69,69 %, fungsi 65,27 %, baris 73,41 % (diukur sebelum peningkatan 3.3) | 0 |
| Evaluasi OCR | `npm run receipt:eval` | Tesseract nyata, 75 gambar sintetis | total tepat 85 % (57/67), tanggal 96 % (49/51), toko 81 %, draf salah 1 % (ditandai), OCR median 168 ms, p95 11,5 s | 0 |
| Pemeriksaan live Ollama | `npm run receipt:live-check` | Ollama nyata `qwen3:4b-instruct` | struk sintetis terbaca benar (total 16.500) | 0 |
| Batas Docker | `npm run docker:verify` | kontainer PostgreSQL yang berjalan | semua batas aktif | 0 |
| Ruang disk | `npm run disk:check` | volume PostgreSQL dan folder cadangan | OK | 0 |
| Pemindaian rahasia pada keluaran | pencarian nilai token, kata sandi, dan secret webhook dari `.env` | `logs/`, `data/`, `evaluation-reports/`, `coverage/`, `dist/` | 0 kemunculan | — |
| Restore rehearsal dengan passphrase pemilik | `npm run db:restore-rehearsal` | — | **NOT RUN** pada cadangan buatan pemilik (butuh passphrase interaktif); alur yang sama terbukti di atas dan di `test:failure` | — |
| Telegram nyata | — | — | **BLOCKED — OWNER APPROVAL REQUIRED**: butuh token dan akun uji terpisah milik pemilik; langkah: [uji Telegram manual](../testing/telegram-acceptance-manual.md) | — |

Unit memakai mock dan fixture; integrasi dan e2e memakai PostgreSQL nyata dengan Telegram diganti penangkap dan Ollama palsu; antrean memakai Redis nyata; injeksi kegagalan memakai PostgreSQL dan Redis kontainer nyata yang di-stop atau di-kill. Evaluasi OCR memakai data sintetis dan tidak mewakili akurasi pada struk nyata.

## 5. Temuan keamanan dan risiko tersisa

| Temuan | Severity | Bukti | Dampak | Perbaikan yang diterapkan | Risiko tersisa |
|---|---|---|---|---|---|
| Aplikasi terhubung sebagai superuser database | sedang | `POSTGRES_USER` pada `docker-compose.yml` adalah superuser bawaan image | bila bot disusupi, ia dapat mengubah skema atau mematikan trigger pelindung | peran non-superuser sudah dibuktikan pada database sekali-pakai: tidak bisa DDL, mematikan atau melewati trigger, atau menulis riwayat migrasi | **BLOCKED — OWNER APPROVAL REQUIRED**: belum diterapkan di database hidup; langkah di [peran DB terbatas](../operations/db-least-privilege.md) |
| Isolasi antar-pengguna | rendah | tes statis pelingkupan pemilik, 16 probe dinamis, 13 tes trigger dengan SQL mentah, `db:verify` mendeteksi pelanggaran | pengguna A tidak bisa membaca, mengubah, menghapus, atau mengonfirmasi data pengguna B | trigger database menolak baris yang menunjuk data pengguna lain | tidak ada FK komposit (kategori sistem berpemilik NULL); trigger menutup jalur yang sama dan diuji |
| Salah baca nominal OCR | rendah–sedang | evaluasi: total tepat 85 %, 1 draf salah (ditandai), 1 tanggal salah diam-diam | nominal salah bila pengguna membalas `ya` tanpa membaca pratinjau | pembaca deterministik mengalahkan model; total harus tertelusur ke teks; peringatan untuk total tak jelas; konfirmasi `ya` wajib; koreksi `total …` | digit yang salah baca tanpa baris tunai/kembalian tidak terdeteksi |
| Struk duplikat masih bisa dikonfirmasi dua kali | rendah | e2e: pratinjau berperingatan masih bisa dibalas `ya` | dua transaksi sama bila pengguna mengabaikan peringatan | peringatan `POSSIBLE_DUPLICATE` (3.2); transaksi bisa dihapus dengan `hapus` | sengaja tidak memblokir karena dua pembelian sah dengan nominal sama pada hari yang sama itu mungkin |
| Pengurai chat salah menafsirkan kalimat | rendah–sedang | pengujian kalimat acak (3.3) | pengeluaran tercatat sebagai pengaturan atau transfer | perintah yang mengubah data hanya di awal pesan | heuristik; pesan ambigu dengan banyak angka tetap tebakan |
| Perlindungan log dan rahasia | rendah | pemindaian keluaran: 0 nilai rahasia; tes pino nyata | bocor bila objek berisi rahasia ikut tercatat | redaksi diperluas (3.4); galat dicatat berdasarkan nama kelas | log tidak pernah sengaja memuat objek konfigurasi; jaring pengaman hanya untuk kelalaian di masa depan |
| Cadangan hanya di mesin yang sama | sedang | `backups/db` di folder proyek | kehilangan disk berarti kehilangan cadangan | cadangan terenkripsi, dibaca balik, checksum, rotasi; prosedur menyalin ke media lain di [runbook](../runbook.md) | menyalin ke luar mesin adalah tugas pemilik (sudah diterima) |
| Galat, retry, dan idempotensi | rendah | soak 300 detik: 0 duplikat, 0 respons 503 tak terduga; tes injeksi kegagalan; M09–M14 | pencatatan ganda atau hilang saat gagal di tengah | `UNIQUE(user_id, idempotency_key)`, `FOR UPDATE`, offset maju setelah sukses, retry terbatas | tidak ada klaim untuk kegagalan di luar yang disimulasikan |

Yang dilakukan hanya tinjauan kode, tes otomatis, uji mutasi, dan audit dependensi. Uji penetrasi tidak dilakukan.

## 6. Kesiapan operasi

- Menyalakan: `npm run db:up`, `npm run start:dev`; cek `/health/ready`. Tidak ada skrip start/stop/autostart.
- Cadangan dan pemulihan: `db:backup` terenkripsi, dibaca balik, checksum, rotasi; `db:restore-rehearsal`; `db:restore` hanya ke database baru.
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
| NOT RUN | Latihan restore dengan cadangan buatan pemilik (passphrase pemilik) | jalankan `npm run db:restore-rehearsal` dari terminal Git Bash; passphrase diketik di prompt |
| NOT VERIFIED | Perilaku di VPS, token asli di kontainer, Ollama di host Linux | deployment di luar cakupan |
| BLOCKED — OWNER APPROVAL REQUIRED | Telegram nyata dengan akun uji terpisah | ikuti [uji Telegram manual](../testing/telegram-acceptance-manual.md), lalu `npm run acceptance:check` |
| BLOCKED — OWNER APPROVAL REQUIRED | Menerapkan peran database non-superuser pada database hidup | cadangan terenkripsi dulu, lalu langkah di [peran DB terbatas](../operations/db-least-privilege.md) |
