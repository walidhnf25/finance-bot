# Invarian integritas keuangan

Setiap invarian di bawah ini punya (a) penegak di database atau kode, dan (b) tes yang gagal bila penegak itu dilemahkan. Mutan (`scripts/mutation-checks.js`)
membuktikan bahwa tes tersebut memang mendeteksi pelemahan.

| # | Invarian | Penegak | Tes / bukti |
|---|---|---|---|
| I1 | Uang **disimpan dan dihitung** sebagai bilangan bulat satuan minor (rupiah × 100), tanpa `float`. (Pengurai teks obrolan dan struk membaca angka lewat `number` JS dan membatasinya ≤ 10^13 sebelum diubah ke `Money`; ini batasan yang diketahui) | `Money` (BigInt); kolom `BIGINT` | `money.property.spec.ts` (14 tes, seed `20261016`): asosiatif, komutatif, bulat-balik teks, format tanpa eksponen/NaN, teks cacat ditolak |
| I2 | Nominal transaksi `0 < n ≤ 10^15` | `CHECK` di migrasi + `Money.isWithinLimit` | integrasi + mutan M31/M32 |
| I3 | Satu pesan Telegram → paling banyak satu pencatatan | `UNIQUE(user_id, idempotency_key)` | `ledger-properties.spec.ts`: pesan yang sama dikirim 25 kali serentak → tepat 1 baris (transaksi maupun transfer) |
| I4 | Konfirmasi struk terjadi tepat sekali | `SELECT … FOR UPDATE` + kunci `receipt:<id>` + `UNIQUE(transaction_id)` | 8 konfirmasi paralel → 1 transaksi (integrasi); mutan M11–M17 |
| I5 | Foto yang sama tidak membuat dua draf | `UNIQUE(user_id, image_sha256)` | integrasi |
| I6 | Transfer memindahkan nominal yang sama, antar dompet berbeda, secara atomik | satu baris `transfers` + `CHECK` nominal sama dan `from <> to` | `ledger-properties.spec.ts`: total semua dompet tidak berubah oleh transfer |
| I7 | Saldo diturunkan, tidak disimpan | tidak ada kolom saldo; laporan menjumlah dari transaksi aktif dan transfer | `ledger-properties.spec.ts`: urutan acak operasi cocok dengan model independen; saldo yang dibaca saat tulis beruntun selalu cocok dengan dirinya |
| I8 | Hapus bersifat lunak dan dapat diaudit | `deleted_at`; semua penjumlahan menyaring `deleted_at IS NULL` | integrasi + properti |
| I9 | Data satu pengguna tidak terbaca/terubah oleh pengguna lain | setiap panggilan Prisma pada model milik pengguna menyebut pemilik | `user-scoping.spec.ts` (statis, 4 tes) + `isolation-probes.spec.ts` (16 probe dinamis); mutan M54–M56 |
| I10 | Reset data satu pengguna tidak menyentuh pengguna lain dan dicatat | `UserDataResetRepository` per `userId`; aksi `USER_RESET` | `audit-and-retention.spec.ts`; mutan M60 |
| I11 | Model AI tidak dapat menulis uang | tanpa tools; keluaran divalidasi; dompet dari model dibuang; total tercetak mengalahkan model; draf `PENDING` butuh `ya` | `receipt-ai-safety.spec.ts` (124), mutan M18–M24, M30, M49, M50 |
| I12 | Retensi tidak pernah menghapus uang | `RetentionService` hanya menyentuh draf non-CONFIRMED, percakapan kedaluwarsa, audit | `audit-and-retention.spec.ts`; mutan M58 |

## Keputusan desain yang sengaja

- **Saldo boleh negatif (overdraft).** Pengguna mencatat apa yang terjadi; bot tidak menolak pencatatan karena saldo.
- **Hapus lunak, bukan keras**, untuk transaksi; transfer dihapus dengan jejak audit (`TRANSFER_DELETE`).
- **Jejak audit `audit_events` bukan bagian transaksi keuangan.** Ia best-effort (satu peringatan per menit bila gagal), hanya memuat id dan jenis,
  tidak punya FK ke `users` agar bertahan setelah reset, dengan `CHECK` panjang aksi 1–64 dan metadata ≤ 4096 byte. Ia **tidak anti-ubah** dan **tidak atomik**
  dengan perubahan yang dicatat: kegagalan menulis audit tidak menggagalkan pencatatan uang.
- **Aksi yang tersimpan:** `TX_CREATE`, `TX_EDIT`, `TX_DELETE`, `TRANSFER_CREATE`, `TRANSFER_DELETE`, `BUDGET_SET`, `RECEIPT_DRAFT`, `RECEIPT_CONFIRM`,
  `RECEIPT_CANCEL`, `USER_RESET`. `MESSAGE_IN/OUT` hanya log (isi pesan tidak disimpan).

## Yang tidak dijamin

Kebenaran angka yang diketik pengguna; keaslian struk; pembacaan OCR (selalu lewat pratinjau + `ya`); atomisitas jejak audit.
Satu pengguna berwenang yang menekan `ya` pada pratinjau yang salah akan mencatat angka yang salah. Sistem memberi peringatan `TOTAL_AMBIGUOUS` bila dua
baris total sejenis berbeda, tetapi tidak dapat memutuskan mana yang benar.
