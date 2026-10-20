# Strategi tes dan cakupan

Tanpa CI: gerbang satu perintah adalah `npm run verify`.

## 1. Tingkat tes

| Tingkat | Perintah | Jumlah | Memakai | Yang dibuktikan |
|---|---|---|---|---|
| Unit | `npm test` | **1.143** tes di 56 suite | tanpa database | aturan murni: uang, pengurai, validasi struk, breaker, antrean OCR, metrik, interpretasi ya/tidak, interceptor, logika verifikator Docker |
| Integrasi | `npm run test:integration` | **177** tes di 10 suite | PostgreSQL asli (`finance_bot_test` saja, dijaga `db-guard.ts`) | constraint DB, idempotensi, konkurensi, isolasi, migrasi pada data nyata, audit/retensi |
| E2E | `npm run test:e2e` | **84** tes di 6 suite | aplikasi utuh lewat HTTP webhook asli, Telegram diganti penangkap | alur pengguna, ketahanan, siklus hidup, observabilitas, privasi log |
| Antrean | `npm run test:queue` | **26** tes di 2 suite | **Redis nyata** (kontainer profil `queue`, database 15) + PostgreSQL | BullMQ: dedupe, retry, dead letter, payload palsu, restart, shutdown, konkurensi, jadwal; pembacaan struk lewat antrean, fallback saat Redis mati |
| Kegagalan | `npm run test:failure` | **18** tes di 4 suite | Docker: PostgreSQL dan Redis **sekali-pakai** yang di-stop/kill di bawah bot; skrip cadangan nyata; kontainer Linux | PostgreSQL mati/kill → 503, hidup, pulih, tepat sekali; Redis kill → fallback, pulih, AOF; cadangan terputus, ruang penuh, passphrase salah, file rusak, `.part` basi, gerbang integritas, peran database terbatas |
| Soak | `npm run test:soak` (`SOAK_SECONDS=…`) | 1 skenario | PostgreSQL asli, kegagalan disuntik, restart | invarian jangka panjang |
| Mutasi | `npm run test:mutation` | **102** mutan | salinan kerja sementara | tes benar-benar gagal bila guard dilemahkan |
| Evaluasi OCR | `npm run receipt:eval` | 75 gambar sintetis + 1 nyata | OCR nyata | akurasi terukur, bukan klaim umum |
| Live | `npm run receipt:live-check` | – | Ollama nyata | pemeriksaan manual pipeline OCR + model |

## 2. Teknik yang dipakai, dan di mana

| Teknik | Berkas | Catatan |
|---|---|---|
| **Properti** (PRNG ber-seed, buatan sendiri; kegagalan mencetak seed dan input) | `src/shared/utils/money.property.spec.ts` (14), `test/integration/ledger-properties.spec.ts` (15) | tanpa dependensi tambahan; 3.000 kasus per properti uang; urutan operasi acak dicocokkan dengan model independen pada PostgreSQL |
| **Konkurensi/ras** | `ledger-properties.spec.ts`, `receipt.spec.ts`, `audit-and-retention.spec.ts` | 25 pesan sama serentak → 1 baris; hapus 12× serentak → sekali; transfer serentak menjaga total; 8 konfirmasi paralel → 1 |
| **Kalimat acak ber-seed** | `rule-based.parser.fuzz.spec.ts` | 4.000 kalimat pengeluaran dengan kata perintah di tengah tidak boleh berubah menjadi niat yang mengubah data; 2.000 teks acak tidak membuat parser gagal |
| **Korpus bermusuhan** | `receipt-ai-safety.spec.ts` (124) | teks OCR berisi injeksi × dua model jinak/jahat tersimulasi; jawaban model bermusuhan; integritas prompt |
| **Arsitektur sebagai tes** | `src/architecture.spec.ts` (7) | arah dependensi, tanpa siklus, daftar pengecualian tidak boleh basi |
| **Pelingkupan pemilik statis + probe dinamis + trigger DB** | `src/user-scoping.spec.ts`, `isolation-probes.spec.ts` (16), `tenant-guards.spec.ts` | tes statis adalah *lint* teks, bukan bukti; pelindung nyata adalah trigger database |
| **Migrasi pada data nyata** | `migrations.spec.ts` | basis data sementara `<db>_migr` |
| **Injeksi kegagalan nyata** | `test/failure/*` | proses/kontainer sungguhan dimatikan; asersi pada perilaku yang terlihat pengguna (kode HTTP, pulih, tepat sekali) |
| **Mutasi terklasifikasi** | `scripts/mutation-checks.js` | jenis kill dipisah (assertion/error/timeout/crash); mutan tak terkompilasi = INVALID, bukan kill; `DRY=1` memeriksa semua mutan masih berlaku |
| **Regresi** | tersebar | setiap cacat yang ditemukan punya tes dan, bila relevan, mutan |

## 3. Cakupan (unit saja, `npm run test:cov`)

Pernyataan **71,70 %**, cabang **69,69 %**, fungsi **65,27 %**, baris **73,41 %**. Penyebut mengeluarkan `evaluation/`, `live-check`, `cli`, `main`. Cakupan unit tidak menghitung
tes integrasi/e2e yang menjalankan repository dan layanan terhadap PostgreSQL; angka itu sengaja **bukan** ukuran kualitas (lihat mutasi).
Tidak ada ambang cakupan yang dipaksakan; ambang yang dipasang tanpa dasar hanya mendorong tes kosong.

## 4. Hasil mutasi

Hasil run penuh terakhir dan klasifikasinya ada di [kualitas tes](../engineering/test-quality-review.md). Hanya kill jenis *assertion*
dihitung sebagai deteksi bermakna; kill jenis *error* (mis. pelanggaran unique) dilaporkan terpisah sebagai bukti lebih lemah.

## 5. Yang tidak diuji

Telegram nyata untuk parser, konfirmasi, dan antrean (token tidak dipakai oleh agen); Ollama nyata dengan model; VPS nyata; PostgreSQL mati total saat proses sudah berjalan
diuji lewat tes kegagalan; banyak pengguna serentak dan kualitas OCR pada struk termal nyata di luar satu foto tidak diuji.

## 6. Cara menjalankan semuanya

```bash
npm run db:up            # PostgreSQL (database uji dibuat otomatis: finance_bot_test)
npm run verify           # typecheck, lint, format, unit, integrasi, e2e, antrean, build, audit produksi
npm run test:soak        # SOAK_SECONDS=120 untuk singkat
npm run test:mutation    # lambat; jangan jalankan bersama tes lain (memakai finance_bot_test)
npm run docker:verify    # batas Docker yang berjalan vs docker-compose.yml
```
