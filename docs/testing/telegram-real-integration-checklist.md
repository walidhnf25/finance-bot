# Uji integrasi Telegram nyata

Tujuan: membuktikan alur lengkap dengan **Telegram sungguhan** (bukan tiruan). Tes otomatis memakai transport palsu; dokumen ini
memisahkan apa yang otomatis, apa yang sudah dicoba manual, dan apa yang masih menunggu kamu.

## 1. Apa yang dibuktikan oleh apa

| Lapisan | Apa yang dipakai | Status |
|---|---|---|
| Unit (`npm test`) | semuanya tiruan | **VERIFIED** — 694 test |
| Integrasi (`npm run test:integration`) | PostgreSQL asli, tanpa Telegram | **VERIFIED** — 112 test |
| E2E lewat HTTP webhook asli (`npm run test:e2e`) | aplikasi Nest utuh + PostgreSQL asli; **Telegram diganti penangkap**; Ollama diganti server palsu; OCR diganti stub | **VERIFIED** — 45 test |
| Soak terkendali (`npm run test:soak`) | transport **simulasi**, PostgreSQL asli, kegagalan disuntikkan, restart aplikasi berkala | **VERIFIED** — 90 detik: 2318 iterasi, 1408 catatan, 529 struk, 9 restart, 108 pemutaran ulang, 0 duplikat |
| Telegram nyata, polling, pesan masuk dan dibalas | token asli, jaringan nyata | **PARTIALLY VERIFIED** — 6 pesan diterima lewat polling dan dibalas (log tanpa galat); satu foto struk nyata diunduh dari Telegram, dibaca, dan menjadi draf |
| Telegram nyata: transaksi tercatat lewat chat, terlihat di query normal | token asli | **VERIFIED**: satu transaksi `finbottest1` Rp1.000, kunci idempotensi, `acceptance:check` lulus |
| Telegram nyata: konfirmasi struk sampai satu transaksi | foto struk nyata, token asli | **VERIFIED sekali**: satu transaksi EXPENSE Rp875.000, kunci `receipt:<draf>`, draf `CONFIRMED`, integritas lulus. `ya` ganda belum diuji nyata |
| Telegram nyata: pembatalan draf tidak membuat transaksi | foto struk nyata, token asli | **VERIFIED**: draf `CANCELLED`, nol transaksi, jumlah transaksi tetap 24, `db:verify` lulus |
| Pemutaran ulang update Telegram nyata | tidak dapat dipicu dari sini | **NOT POSSIBLE di sini**; dibuktikan sebagian di tingkat database (§3 langkah 5) dan penuh di tes e2e/soak |
| Multi-jam dengan Telegram nyata | – | **NOT DONE** (tidak praktis; soak simulasi dipakai sebagai gantinya) |

## 2. Matriks skenario otomatis (sudah hijau)

| Skenario | Di mana |
|---|---|
| pesan pengguna berwenang diproses | e2e `bot` |
| pengguna tak berwenang ditolak (tanpa balasan, tanpa baris pengguna, **foto tidak diunduh**) | e2e `hardening` |
| update ganda / dikirim ulang | e2e `bot`, e2e `hardening`, soak |
| pembuatan transaksi | e2e, integrasi |
| pembuatan draf struk, tampilan field, konfirmasi, pembatalan | e2e `receipt` |
| konfirmasi ganda tidak menggandakan | integrasi (8 paralel → 1), e2e `receipt`, e2e `hardening` |
| kegagalan Telegram saat membalas | e2e `bot` (503 lalu pulih, data tersimpan sekali) |
| kegagalan PostgreSQL saat mencatat / membuat draf / mengonfirmasi | e2e `hardening` (503, tidak ada baris setengah jadi, redelivery sukses tepat sekali) |
| timeout / kegagalan penyedia AI | e2e `hardening` (model menggantung → draf tetap dari OCR dalam < 8 detik; model kembali → dipakai lagi) |
| kegagalan unduh file Telegram | e2e `hardening` (503 lalu satu draf) |
| pemulihan setelah restart aplikasi | e2e `lifecycle`, soak |

## 3. Uji penerimaan nyata (kamu yang mengirim pesan)

Prasyarat: `curl http://127.0.0.1:3100/health/ready` menjawab `ok` (bot ready), bot berjalan dalam polling, kamu memakai akun yang ada di
`TELEGRAM_ALLOWED_USER_IDS`. **Gunakan data uji, bukan transaksi sungguhan**, dan beri penanda yang bisa dikenali. Jangan
menghapus atau mereset data yang ada.

**A. Transaksi teks**
1. Kirim ke @<nama-bot>: `beli FINBOTTEST1 1rb` (satu pesan).
2. Bot membalas "Berhasil dicatat".
3. (Opsional) kirim `ringkasan hari ini` untuk melihat transaksi itu lewat alur query normal aplikasi.

**B. Struk dikonfirmasi**
4. Kirim **foto struk** (boleh struk sungguhan atau struk sintetis; transaksinya hanya ujian).
5. Bot menampilkan draf. Balas `toko FINBOTTEST2` (mengubah nama toko menjadi penanda) → draf ditampilkan lagi.
6. Balas `ya` → "Berhasil dicatat". Balas `ya` **sekali lagi** → tidak boleh ada transaksi baru.

**C. Struk dibatalkan**
7. Kirim foto lain (berbeda), balas `batal`. Tidak boleh ada transaksi.

**D. Verifikasi (saya atau kamu)**

```bash
npm run acceptance:check -- FINBOTTEST1 FINBOTTEST2
```

Skrip membaca database (hanya-baca; probe duplikat di-rollback) dan memeriksa untuk setiap penanda: tepat **satu** transaksi
aktif; punya kunci idempotensi; PostgreSQL **menolak** baris kedua dengan kunci yang sama; transaksi struk terhubung ke tepat satu
draf `CONFIRMED`; status draf terbaru (CANCELLED untuk langkah C); dan **log tidak memuat teks uji maupun pola token**.

Hasil yang diharapkan: `RESULT: all acceptance checks passed.`

**E. Setelah selesai**
Hapus transaksi uji dari chat (`hapus` menghapus transaksi terakhir dengan konfirmasi), atau biarkan sebagai catatan uji.

## 4. Apa yang masih tidak bisa dibuktikan

- Struk yang sama dikirim ulang sebagai **berkas berbeda** (difoto lagi) menjadi draf baru; berkas dengan isi identik dicegah oleh `UNIQUE(user_id, image_sha256)`. Pratinjau memberi peringatan bila sudah ada pengeluaran dengan nominal dan tanggal yang sama, tetapi tidak memblokir: pengguna yang memutuskan (`ya` atau `batal`).
- Pemutaran ulang **update Telegram yang sama** dari Telegram nyata (Telegram tidak menyediakan cara memicunya); yang dibuktikan
  adalah penolakan database terhadap kunci ganda pada baris nyata dan pemutaran ulang di tes otomatis.
- Perilaku selama berjam-jam/berhari-hari dengan jaringan tidak stabil; soak simulasi dan tes kegagalan hanya pendekatan.
- Pembatasan laju Telegram (429) tidak dapat dipaksa; logika `retry_after` diuji dengan tiruan.
