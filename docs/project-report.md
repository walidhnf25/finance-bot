# Finance bot — Laporan proyek

Finance bot adalah bot Telegram untuk mencatat keuangan pribadi: transaksi, dompet tunai/digital, budget, ringkasan, ekspor Excel, dan foto struk yang dibaca dengan OCR. Data tersimpan di PostgreSQL. Telegram memakai long polling, jadi tidak butuh URL publik.

> **Tentang laporan ini.** Pemeriksaan di dalamnya dilakukan oleh pembangun proyek dan penilai otomatis; belum ada tinjauan keamanan oleh manusia atau pihak ketiga, dan ini bukan uji penetrasi. Setiap status menyebut apa yang benar-benar dijalankan; yang tidak dijalankan ditulis demikian.

## 1. Ringkasan

| Pertanyaan | Jawaban |
|---|---|
| Layak dipakai? | **Ya, dengan batasan terdokumentasi** (bagian 6) |
| Siap di server (VPS)? | **Siap dicoba, belum terbukti.** Ada `Dockerfile` dan layanan compose yang teruji di Docker Desktop dengan token palsu; belum diuji dengan token asli maupun di server sungguhan |
| Datanya benar dan aman dari kehilangan? | Terbukti pada PostgreSQL asli: pemeriksaan integritas lulus, soak tanpa satu pun duplikat, cadangan terenkripsi dan terbukti bisa dipulihkan |
| Seberapa dalam tinjauan keamanannya? | Kontrol teknis dibuktikan tes (arsitektur, pelingkupan pemilik, trigger database, mutasi, injeksi kegagalan). Belum ada audit manusia atau uji di server nyata |

## 2. Gambaran proyek

- Stack: NestJS 11, Prisma 6.19, PostgreSQL 16 (Docker), Telegram (klien sendiri lewat HTTP API Telegram, tanpa pustaka bot; polling), OCR `tesseract.js` (Indonesia + Inggris), Ollama (`qwen3:4b-instruct`, teks saja, opsional), `sharp` untuk pra-pemrosesan gambar, Redis/BullMQ (opsional). Node ≥ 20.
- Permukaan HTTP (lengkap): `GET /`, `GET /health`, `GET /health/live`, `GET /health/ready`, `GET /metrics`, `POST /telegram/webhook` (404 pada mode polling; pada mode webhook, secret wajib). Tanpa autentikasi, hanya loopback. Swagger mati secara default.
- Uang disimpan sebagai `BIGINT` satuan minor (rupiah × 100). Idempotensi ditegakkan database (`UNIQUE(user_id, idempotency_key)`).

### 2.1 Fitur bot

Daftar ini diambil dari menu bantuan yang benar-benar ditampilkan bot (`reply-builder.ts`).

| Area | Contoh yang dipahami bot | Catatan |
|---|---|---|
| Catat transaksi | `beli kopi 25rb`, `makan bakso kemarin 15rb`, `gaji 8 juta` | pemisah nominal `rb`/`juta`, tanggal relatif; kategori ditebak dari kata kunci (14 kategori sistem); parser berbasis aturan, bukan model |
| Beberapa transaksi sekaligus | `beli ayam 8rb, beli es teh 5rb` | setiap bagian berkunci idempotensi sendiri (`<id pesan>#n`) |
| Foto struk | kirim foto, cek draf, balas `ya` atau `batal`; koreksi dulu: `total 45rb`, `tanggal kemarin`, `dompet digital`, `toko …` | tidak ada pencatatan tanpa balasan `ya`; draf kedaluwarsa 30 menit |
| Ringkasan dan ekspor | `ringkasan hari ini / minggu ini / bulan ini`, `ringkasan 13/07/2026 - 14/07/2026`, `export …` | ekspor berupa berkas Excel (dan CSV); ringkasan per dompet |
| Dompet | `beli kopi 25rb cash`, `gaji 5 juta transfer` (juga qris, gopay, ovo, debit), `saldo`, `saldo awal cash 200rb`, `tarik tunai 500rb`, `pindah 300rb dari cash ke digital`, `atur dompet`, `default digital` | mode dompet per pengguna: cash saja, digital saja, atau keduanya; saldo per dompet menjumlah ke saldo total |
| Kelola transaksi terakhir | `edit jadi 30rb`, `edit ke digital`, `hapus`, `hapus transfer` | penghapusan bersifat *soft delete* (`deleted_at`), bisa dikembalikan lewat database |
| Budget | `budget makan 2 juta` | periode harian/mingguan/bulanan; peringatan saat melewati ambang (bawaan 80%) |
| Reset | `reset` | menghapus semua data pengguna itu, setelah pertanyaan konfirmasi ("Yakin mau reset SEMUA data?") |
| Bantuan dan orientasi | `help`; pengguna baru diminta memilih dompet dan saldo awal | dialog multi-langkah ditangani mesin percakapan (9 status) |

Akses dibatasi ke daftar pengguna yang diizinkan (bagian 2.4). Pesan per pengguna dibatasi 30 per menit, dan foto struk 20 per jam (bawaan).

### 2.2 Arsitektur

Aplikasi monolit modular NestJS dengan pola *ports and adapters*: setiap area ada di `src/modules/<area>/{domain,application,infrastructure}`. Lapisan, port, dan keputusan teknisnya dijelaskan di [arsitektur](architecture.md).
Di luar modul: `config` (validasi lingkungan, gagal menutup), `common` (logger, filter, utilitas), `shared` (uang, tanggal).

```
Telegram ──(long polling getUpdates | webhook POST)──► TelegramGateway (allowlist; pengirim tak berwenang diabaikan)
    ─► IncomingMessageHandler: pengurang pesan ganda ─► rate limit ─► daftarkan pengguna ─► audit
        ─► MessageOrchestrator ─► Parser (aturan) / Mesin percakapan
              ─► Layanan: transaksi · dompet · budget · laporan · struk
                    ─► Repository (Prisma) ─► PostgreSQL
        ◄─ ReplyBuilder ◄───────────────────────────────┘      balasan lewat TelegramGateway
```

Jalur foto struk:

```
foto ─► unduh dari Telegram ─► prepareImage (sharp): cek magic bytes, batas ukuran dan piksel, buang EXIF, sha256
     ─► Tesseract (ind+eng; percobaan kedua dengan pra-pemrosesan kuat bila total tak ketemu)
     ─► pembaca deterministik (aturan eksplisit)
     ─► [opsional] Ollama (mode auto: hanya bila pembaca ragu; total tercetak mengalahkan total model)
     ─► validasi keuangan ─► ReceiptDraft PENDING (kedaluwarsa 30 menit)
     ─► pengguna membalas "ya" ─► satu transaksi database (SELECT … FOR UPDATE, kunci receipt:<id draf>) ─► Transaction
```

Hal lintas-modul: konfigurasi divalidasi saat start dan menolak keadaan berbahaya; log memakai pino tanpa isi pesan; *audit* ke tabel `audit_events` (hanya id dan jenis aksi; best-effort) dan log; foto tidak pernah ditulis ke disk. Topologi: Node di host + PostgreSQL di Docker (`127.0.0.1:15432`); di server, tiga layanan compose (`postgres`, `migrate`, `app`) tanpa port terbuka.

### 2.3 Model data

Uang disimpan sebagai `BIGINT` satuan minor (rupiah × 100); semua cap waktu `timestamptz(3)`.

| Tabel | Isi | Aturan yang ditegakkan database |
|---|---|---|
| `users` | satu baris per pengguna Telegram; zona waktu, mode dompet, dompet bawaan | `telegram_id` unik |
| `categories` | kategori sistem (14) dan buatan pengguna, dengan kata kunci | unik `(user_id, name, type)` |
| `transactions` | pemasukan/pengeluaran, nominal, tanggal, dompet, `deleted_at` | `CHECK 0 < nominal ≤ 10^15`; unik `(user_id, idempotency_key)`; kategori `SET NULL` bila dihapus |
| `transfers` | pindah antar dompet (cash ↔ digital) | `CHECK` nominal sama dan `from_wallet <> to_wallet`; unik `(user_id, idempotency_key)` |
| `budgets` | batas per kategori atau keseluruhan, periode, ambang | `CHECK` nominal dan `1 ≤ ambang ≤ 100`; `CHECK` cakupan sesuai kategori; unik `(user_id, scope_key, period)` |
| `conversations` | status dialog multi-langkah per pengguna, muatan JSON, kedaluwarsa | satu baris per pengguna |
| `receipt_drafts` | draf struk (`PENDING`/`CONFIRMED`/`CANCELLED`/`EXPIRED`), hasil ekstraksi JSON, `image_sha256` | `CHECK` draf `CONFIRMED` wajib punya transaksi; unik `transaction_id`; unik `(user_id, image_sha256)` |
| `audit_events` | jejak aksi (id dan jenis saja) | metadata dibatasi ukurannya; dibersihkan oleh retensi |

Semua tabel anak berkunci asing ke `users` dengan `ON DELETE CASCADE`. Trigger database menolak baris yang menunjuk kategori atau transaksi milik pengguna lain. Kunci idempotensi: pesan teks `<id Telegram>:<id pesan>` (dengan `#n` bila satu pesan memuat beberapa transaksi); struk `receipt:<id draf>`. Enum: `TransactionType` (INCOME/EXPENSE), `Wallet` (CASH/DIGITAL), `WalletMode` (CASH/DIGITAL/BOTH), `BudgetPeriod`, `ConversationState` (9 nilai), `ReceiptStatus`. Pemeriksaan integritas (`npm run db:verify`) mencakup transaksi yatim, nominal tak valid, kunci ganda, transfer ke dompet sendiri, budget ganda, saldo awal ganda, dan tautan draf–transaksi yang tak cocok.

### 2.4 Referensi konfigurasi

Semua nilai divalidasi saat start (`src/config/env.validation.ts`); keadaan berbahaya membuat aplikasi menolak start. Salinan kerja ada di `.env.example`.

| Variabel | Bawaan | Catatan |
|---|---|---|
| `DATABASE_URL` | – (wajib) | harus URL `postgresql://` |
| `TELEGRAM_BOT_TOKEN` | – (wajib) | bentuk token BotFather |
| `TELEGRAM_ALLOWED_USER_IDS` | kosong | daftar id Telegram dipisah koma; **kosong tanpa `TELEGRAM_ALLOW_PUBLIC=true` = menolak start** (kosong tidak pernah dianggap "semua orang") |
| `TELEGRAM_ALLOW_PUBLIC` | `false` | bertentangan dengan allowlist; salah satu saja |
| `TELEGRAM_POLLING` | `true` | `false` = mode webhook, `TELEGRAM_WEBHOOK_SECRET` (16–256 karakter) wajib |
| `HOST` / `ALLOW_REMOTE_BIND` | `127.0.0.1` / `false` | alamat selain loopback butuh `ALLOW_REMOTE_BIND=true` (API tanpa login) |
| `PORT` | `3000` | |
| `NODE_ENV` | `development` | `development`/`production`/`test` |
| `USER_RATE_LIMIT_PER_MINUTE` | `30` | |
| `MAX_INPUT_CHARS` | `2000` | 100–4096; pesan lebih panjang dibalas singkat dan tidak diurai |
| `AI_PROVIDER` | `ollama` | `ollama` atau `none` |
| `OLLAMA_BASE_URL` / `OLLAMA_MODEL` | `http://127.0.0.1:11434` / kosong | model kosong = model pertama yang terpasang dan mendukung *completion* |
| `OLLAMA_TIMEOUT_MS` / `OLLAMA_MAX_RESPONSE_BYTES` | `120000` / `1048576` | |
| `OLLAMA_BREAKER_FAILURES` / `OLLAMA_BREAKER_COOLDOWN_SECONDS` | `3` / `30` | breaker: setelah N kegagalan beruntun model dijeda selama jeda itu, lalu satu probe |
| `RETENTION_INTERVAL_HOURS` / `RECEIPT_DRAFT_RETENTION_DAYS` / `AUDIT_RETENTION_DAYS` | `6` / `30` / `365` | pembersihan data non-keuangan; 0 = simpan selamanya; tidak pernah menyentuh transaksi/budget/kategori/draf `CONFIRMED` |
| `RECEIPT_AI_MODE` | `auto` | `auto` (model hanya bila ragu), `always`, `never` |
| `RECEIPT_MAX_FILE_SIZE_BYTES` / `RECEIPT_MAX_PIXELS` | `5242880` / `25000000` | |
| `RECEIPT_PENDING_TTL_MINUTES` / `RECEIPT_MAX_PER_HOUR` | `30` / `20` | |
| `REDIS_URL` dan turunannya | kosong | antrean opsional, lihat [queues.md](operations/queues.md) |
| `SWAGGER_ENABLED` / `SWAGGER_PATH` | `false` / `docs` | Swagger mati secara default |
| `TZ` / `LOG_LEVEL` / `LOG_PRETTY` / `APP_NAME` | `Asia/Jakarta` / `info` / `false` / `finance-bot` | |

Variabel operasional (di luar validator aplikasi): `POSTGRES_USER`/`POSTGRES_PASSWORD`/`POSTGRES_DB`/`POSTGRES_PORT` (compose; port bawaan 15432);
`FINANCE_BOT_BACKUP_PASSPHRASE_FILE`, `FINANCE_BOT_BACKUP_KEEP` (30), `FINANCE_BOT_BACKUP_ALLOW_PLAINTEXT` (cadangan); `FINANCE_BOT_LOG_DIR` (log cron);
`APP_OLLAMA_BASE_URL` dan `LOG_LEVEL_APP` (khusus layanan compose `app`, supaya `OLLAMA_BASE_URL=127.0.0.1` milik host tidak terbawa ke dalam kontainer).

## 3. Matriks penyelesaian

Legenda: **VERIFIED** = dijalankan dan lulus · **PARTIAL** = sebagian terbukti · **NOT DONE** = tidak dikerjakan/tidak terbukti.

| Area | Status | Bukti / catatan |
|---|---|---|
| Pencatatan teks, dompet, budget, ringkasan, ekspor | VERIFIED | unit, integrasi, e2e; Telegram nyata untuk transaksi teks |
| Foto struk: OCR → draf → konfirmasi → transaksi atomik | VERIFIED | integrasi (8 konfirmasi paralel → 1), e2e, soak; Telegram nyata: dua konfirmasi dan satu `batal` |
| Akurasi pembacaan struk | **PARTIAL** | 75 gambar sintetis + 1 foto nyata; total tepat 85% (57/67), 97% tanpa varian bintik-berat; **tidak ada klaim akurasi umum** ([evaluasi OCR](testing/receipt-ocr-evaluation.md)) |
| Integritas data | VERIFIED | `npm run db:verify`: 0 pelanggaran; juga dijalankan pada setiap salinan latihan restore |
| Cadangan terenkripsi + pemulihan | VERIFIED | GnuPG AES-256, dibaca balik, checksum; latihan restore `MATCHES` database hidup; passphrase salah, ciphertext rusak, dan checksum rusak terdeteksi |
| Cron + rotasi cadangan | VERIFIED (kontainer Linux) / **NOT DONE** (VPS nyata) | rotasi per label, kunci anti-tumpang-tindih, kegagalan tanpa passphrase |
| Ketahanan (kegagalan DB/AI/unduhan, tak berwenang, restart) | VERIFIED | e2e `hardening` dan `lifecycle`; soak; injeksi kegagalan nyata pada PostgreSQL dan Redis |
| Deployment Docker/VPS | **PARTIAL** | teruji di Docker Desktop, token palsu; belum dengan token asli atau VPS sungguhan |
| Telegram nyata, `ya` kedua dan pemutaran ulang update | **NOT DONE** | hanya terlihat satu transaksi per draf; bukti penuh ada di e2e/soak |
| Uji panjang (berjam-jam) dengan Telegram nyata | **NOT DONE** | |
| Model *vision* | NOT DONE | tidak terpasang; pembaca deterministik + model teks dipakai |

## 4. Bukti (gerbang akhir)

| Ukuran | Hasil |
|---|---|
| Unit / integrasi (PostgreSQL asli) / e2e (HTTP webhook asli) | **1.143 / 177 / 84** lulus, ditambah antrean **26** (Redis nyata) dan injeksi kegagalan **18** (Docker); `npm run verify` exit 0 |
| Typecheck, lint (0 error, 0 warning), format, build | lulus |
| Soak (simulasi Telegram, PostgreSQL asli, kegagalan disuntik, restart) | 10 menit: 14.788 iterasi, 8.889 catatan = 8.889 baris, 3.390 struk = 3.390 draf `CONFIRMED`, 2.505 kegagalan DB disuntik, 59 restart + 708 pemutaran ulang → **0 duplikat**; run 300 detik berikutnya: 5.856 iterasi, 3.506 catatan = 3.506 baris, 1.306 struk = 1.306 draf `CONFIRMED`, 23 restart + 276 pemutaran ulang → **0 duplikat** |
| Uji mutasi pada guard uang/identitas/data | **102 mutan**: 94 terbunuh asersi, 8 oleh error aplikasi saja, **0 selamat**, 0 tak valid |
| Image Docker | terbangun; migrasi dari database kosong, OCR, crash, penghentian rapi, persistensi, tanpa Ollama (kontainer terpisah, token palsu) |
| `npm run docker:verify` | hijau pada kontainer yang berjalan (memori 1 GiB, CPU 1,0, restart, hanya loopback) |

## 5. Keamanan

### 5.1 Metode dan keterbatasannya

Pemeriksaan keamanan dilakukan dengan tinjauan kode, tes yang menembus HTTP webhook asli dan PostgreSQL asli, uji mutasi pada guard, soak dengan kegagalan disuntik, tinjauan dependensi dan rahasia, pengujian cadangan, dan tinjauan baca-saja oleh penilai otomatis terpisah.
Masih tidak ada: tinjauan manusia atau pihak ketiga dan uji penetrasi. Pembangun dan penilai otomatis memakai jenis model yang sama, jadi titik buta bersama tidak dapat dikesampingkan.

### 5.2 Batas kepercayaan

| Batas | Penegakan | Bukti |
|---|---|---|
| Pengirim Telegram → pengguna | allowlist eksplisit; daftar kosong = tidak ada yang boleh; mode publik harus `TELEGRAM_ALLOW_PUBLIC=true`; secret webhook timing-safe, tanpa secret server menolak semua | unit, e2e, mutasi |
| Pengguna ↔ pengguna | setiap query baris memfilter `userId`; trigger database menolak baris yang menunjuk data pengguna lain | integrasi (mis. "tidak bisa membaca, mengubah, atau menghapus transaksi pengguna lain"), probe dinamis, `tenant-guards.spec.ts`, e2e, mutasi |
| Konfirmasi struk | `SELECT … FOR UPDATE`, atomik, terikat pemilik, tidak ganda | integrasi (8 paralel → 1), e2e, soak, mutasi |
| Foto → sistem | magic bytes, batas ukuran dan piksel, buang EXIF, tidak pernah ditulis ke disk | unit termasuk *bomb*, `no-disk-writes.spec.ts`, mutasi |
| Teks struk → model → database | teks struk diperlakukan sebagai data, model tanpa *tools*, keluaran divalidasi, `wallet` dari model dibuang, **tidak ada pencatatan tanpa balasan `ya`** | unit (termasuk korpus *prompt injection*), e2e, mutasi |
| Nominal | `Money.isWithinLimit` + `CHECK` di database | unit, integrasi, e2e, mutasi |
| Laju dan sumber daya | rate limit per pengguna, batas struk per jam, batas konkurensi AI (semaphore), antrean OCR terbatas, timeout dan batas ukuran respons | unit, e2e, soak, mutasi |
| HTTP → apa pun | bind loopback (alamat lain butuh `ALLOW_REMOTE_BIND=true`), Swagger mati, rute minim | unit, mutasi; permukaan diperiksa pada bot yang berjalan |
| Log | tanpa isi pesan, nominal, teks struk, atau token | e2e privasi log, `acceptance:check` memindai log |
| Cadangan | terenkripsi AES-256; restore hanya ke database baru; passphrase tidak pernah di baris perintah | uji passphrase benar/salah/rusak, latihan restore |
| Kontainer (VPS) | non-root, root read-only, tanpa capability, `no-new-privileges`, tanpa port terbuka, tanpa rahasia dalam image | diperiksa di kontainer uji |

### 5.3 Risiko terbuka dan diterima

Tingkat di bawah ini indikatif, bukan hasil audit.

| ID | Risiko | Tingkat | Status |
|---|---|---|---|
| R1 | `npm audit` produksi: temuan di rantai CLI Prisma (`deepmerge-ts`); ditangani dengan `overrides` terlingkup; tidak terjangkau di runtime bot | rendah | ditangani, lihat [dependensi](security/dependency-and-secret-review.md) |
| R2 | Cadangan hanya di komputer yang sama; tanpa enkripsi disk dari aplikasi | sedang | salin cadangan terenkripsi ke luar mesin secara berkala |
| R3 | Struk yang sama difoto ulang sebagai **berkas berbeda** tetap bisa menjadi dua draf dan dua transaksi bila pengguna membalas `ya` dua kali. Berkas dengan isi identik dicegah oleh `UNIQUE(user_id, image_sha256)`. Untuk berkas berbeda, pratinjau memberi peringatan `POSSIBLE_DUPLICATE` bila sudah ada pengeluaran dengan nominal dan tanggal (zona waktu pengguna) yang sama; pengguna yang memutuskan, dan kecocokan tidak memeriksa nama toko | rendah (integritas tidak rusak; hanya peringatan) | dikurangi: peringatan ada, pencegahan otomatis tidak |
| R4 | Pembaca struk bisa salah membaca digit total tanpa baris tunai/kembalian dan tanggal tanpa peringatan; keamanannya bertumpu pada pratinjau dan balasan `ya` dari pengguna | rendah–sedang | diterima sebagai batasan, terdokumentasi |
| R5 | `ya` kedua dan pemutaran ulang update belum terbukti dengan Telegram nyata | rendah | terbukti di e2e/soak, tidak bisa dipicu dari sini |
| R6 | Jalur Docker/VPS belum dicoba dengan token asli, Ollama di host Linux, atau server sungguhan | sedang saat deploy | terbuka, terdokumentasi di [vps-deploy.md](operations/vps-deploy.md) |
| R7 | Tidak ada autentikasi pada API HTTP (hanya loopback) | rendah selama tetap loopback | desain; jangan menambah rute data tanpa autentikasi |
| R8 | Tes statis pelingkupan pemilik adalah heuristik teks; pelindung nyata adalah trigger database. Tidak ada FK komposit; peran database non-superuser tersedia tapi belum diterapkan ([db-least-privilege.md](operations/db-least-privilege.md)) | rendah | terdokumentasi |
| R9 | Disk penuh membuat PostgreSQL PANIC dan menolak menyala sampai ada ruang; `db:backup` memeriksa ruang kosong ≥ 100 MB dan `npm run disk:check` melaporkan ruang | sedang bila disk penuh | dicatat di [runbook](runbook.md); pantau ruang disk |
| R10 | Antrean Redis (opsional): AOF `always`; `ya` mengonfirmasi draf PENDING terbaru; throughput tidak diukur | rendah | didokumentasikan di [queues.md](operations/queues.md) |
| R11 | Data bahasa OCR tidak dikunci hash; kata baca-saja ("total", "saldo") masih dikenali di mana pun dalam pesan | rendah | tercatat |

### 5.4 Langkah berikutnya

1. Jalankan uji Telegram nyata dengan akun uji ([langkah manual](testing/telegram-acceptance-manual.md)).
2. Tinjauan manusia atau pihak ketiga atas pengurai obrolan dan alur reset (bagian yang paling bernilai untuk data keuangan pribadi).
3. Jalankan di VPS dengan token asli sekali, periksa log, lalu perbarui laporan ini.
4. R4 (salah baca total tanpa peringatan) adalah pekerjaan nyata berikutnya yang paling mungkin; R3 masih bergantung pada pengguna membaca peringatan.

## 6. Batasan dan yang tidak diklaim

- Tidak ada klaim "aman" atau "bebas cacat": hanya bahwa tidak ada cacat yang diketahui yang membuat data atau uang salah.
- Tidak ada klaim akurasi OCR umum; himpunan uji sintetis tidak mewakili struk termal nyata.
- Tidak ada klaim kesiapan produksi di server: belum dicoba dengan token asli atau di VPS.
- Pengurai pesan obrolan bersifat heuristik; kata hapus, ubah, pindah, tarik, setor, budget, saldo awal, atur dompet, dan dompet utama hanya perintah di awal pesan (diuji juga dengan kalimat acak) dan angka satuan ukur tidak dibaca sebagai harga, tetapi pesan dengan banyak angka tetap tebakan (balasan menampilkan nominal yang dipakai).
- Hasil model AI tidak deterministik; keamanan bertumpu pada validasi kode dan konfirmasi pengguna, bukan pada kepatuhan model.
- Tinjauan dilakukan oleh pembangun dan penilai otomatis; tidak ada tinjauan manusia.

### 6.1 Yang sengaja tidak dibuat (dan mengapa)

| Tidak dibuat | Alasan |
|---|---|
| Model *vision* untuk membaca struk | tidak terpasang; OCR + pembaca deterministik + model teks sudah cukup dan lebih mudah divalidasi. Model vision bisa menambah salah-baca yang sulit diperiksa |
| Autentikasi pada API HTTP | API hanya loopback dan tidak memuat data keuangan (hanya banner, health, dan webhook yang dijaga secret); menambah login tanpa kebutuhan hanya menambah permukaan |
| Peringatan aktif (alerting) atas metrik | `/metrics` tersedia; tidak ada Prometheus/Grafana/alert yang dipasang (satu pengguna) |
| Redis/BullMQ sebagai keharusan | antrean opsional (mati secara bawaan, fallback dalam proses); kuota Redis bersama dan peran proses `gateway`/`worker` terpisah tidak dibuat (satu pengguna, satu proses) |
| Pemblokiran otomatis struk kembar | struk dari berkas berbeda hanya diberi peringatan (nominal + tanggal sama), tidak diblokir, karena dua pembelian kembar pada hari yang sama adalah hal yang sah |
| CI di GitHub | pengujian dijalankan dengan `npm run verify` |
| Skrip start/stop/auto-start Windows | bot dinyalakan manual |
| Dukungan database terkelola pada skrip cadangan | skrip memakai `docker exec` ke kontainer PostgreSQL; ganti ke `pg_dump` lewat jaringan bila suatu saat dibutuhkan |
| Audit independen dan tinjauan manusia | di luar kemampuan pembangun |

## 7. Operasi

| Tujuan | Cara |
|---|---|
| Menyalakan | `npm run db:up`, lalu `npm run start:dev` (Ctrl+C untuk berhenti); cek `curl http://127.0.0.1:3100/health/ready`. Perintah `sh`/`bash` dijalankan dari terminal **Git Bash** di Windows ([windows-operation.md](operations/windows-operation.md)) |
| Cadangan | `npm run db:backup` (terenkripsi, minta passphrase; label opsional `-- pre-migrasi`); `db:restore-rehearsal`; `db:restore` ke database **baru** |
| Integritas | `npm run db:verify`; `npm run acceptance:check -- <penanda>` setelah uji Telegram nyata |
| Server (VPS) | `docker compose --profile app up -d --build`; cron: `scripts/cron-job.sh backup` dan `rehearsal` ([vps-deploy.md](operations/vps-deploy.md), [vps-backup-cron.md](operations/vps-backup-cron.md)) |
| Tes | `npm run verify` (gerbang satu perintah), lalu `npm run test:soak`, `npm run test:mutation` dan `npm run docker:verify` secara terpisah |
| Pemantauan | `curl http://127.0.0.1:3100/health/ready` dan `/metrics` ([observabilitas](operations/observability-and-diagnostics.md)) |

Keputusan operasional: dijalankan manual, satu `.env`, skrip `sh scripts/...`, nama skrip Prisma (`prisma:deploy`, `prisma:migrate`, `prisma:status`, `prisma:studio`), `lint` hanya memeriksa dan `lint:fix` memperbaiki, label dan rotasi cadangan, `.gitattributes` untuk `*.sh`, Dockerfile dan layanan compose berprofil `app`.
Karena ini data keuangan pribadi: cadangan terenkripsi dan dibaca-balik, pemeriksaan integritas data dan skrip penerimaan, serta uji soak, mutasi, dan evaluasi OCR.

## Lihat juga

[Arsitektur](architecture.md) · [Keamanan](security.md) · [Model ancaman](security/threat-model.md) · [Perlindungan data](security/data-protection.md) · [Dependensi dan rahasia](security/dependency-and-secret-review.md) ·
[Evaluasi OCR](testing/receipt-ocr-evaluation.md) · [Strategi tes](testing/test-strategy-and-coverage.md) · [Kualitas tes](engineering/test-quality-review.md) · [Peningkatan keandalan dan keamanan](engineering/hardening-and-improvements.md) · [Deploy ke VPS](operations/vps-deploy.md) ·
[Cadangan terjadwal](operations/vps-backup-cron.md) · [Runbook](runbook.md)
