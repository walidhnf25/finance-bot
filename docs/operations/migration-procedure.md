# Prosedur menerapkan migrasi database dengan aman

Migrasi disimpan di `prisma/migrations` dan diterapkan dengan `npm run prisma:deploy`. Menerapkan migrasi ke database yang berisi data nyata selalu didahului gladi dan cadangan.

## Isi migrasi

Skema lengkap dibuat oleh satu migrasi, `20261017000000_init`: tabel, enum, indeks, `CHECK` constraint (aturan uang, budget, draf struk, tabel audit), dan trigger pelindung tenant.

| Bagian | Efek |
|---|---|
| Tabel dan `CHECK` | nominal `BIGINT` satuan minor dengan batas, kunci idempotensi unik, aturan transfer/budget/draf struk |
| `audit_events` | jejak aksi dengan batas panjang aksi dan ukuran metadata |
| Trigger tenant | fungsi `finance_bot_assert_category_owner()` dan `finance_bot_assert_draft_transaction_owner()`, serta tiga trigger: `transactions_category_owner`, `budgets_category_owner` (sebelum INSERT atau UPDATE `category_id`/`user_id`: kategori harus milik pemilik baris atau kategori sistem) dan `receipt_drafts_transaction_owner` (draf hanya boleh menunjuk transaksi pemiliknya). Menolak dengan galat `23514` |
| Trigger kepemilikan kategori | fungsi `finance_bot_assert_category_owner_unchanged()` + trigger `categories_owner_unchanged` (sebelum UPDATE `user_id` pada `categories`): kategori yang masih dipakai tidak bisa pindah pemilik |

Trigger hanya menyala pada tulis baru. `CREATE TRIGGER` mengambil kunci `SHARE ROW EXCLUSIVE` sesaat (milidetik) pada tabel itu.

## Mengapa `/health/ready` bisa 503

`/health/ready` membandingkan setiap folder di `prisma/migrations` dengan tabel `_prisma_migrations` di database. Folder yang belum tercatat → `migrations: down` → HTTP 503 dengan laporan
(`"N migration(s) not applied: run \"npm run prisma:deploy\""`). Itu **status**, bukan kegagalan bot: chat tetap dilayani. Setelah migrasi diterapkan, status kembali 200.

## Bukti pengujian

| Pemeriksaan | Hasil |
|---|---|
| `npm run prisma:status` | tidak ada drift |
| `prisma migrate diff` migrasi ↔ `schema.prisma` | "No difference" (trigger tak dimodelkan Prisma) |
| **`npm run db:migrate-rehearsal`**: salinan database nyata (di-*stream* langsung, tanpa berkas dump; berada di tmpfs kontainer sekali-pakai yang dihapus **bersama volumenya**) | salinan cocok dengan sumber; migrasi diterapkan; **jumlah baris dan total uang identik sebelum dan sesudah**; `migrate status` bersih; semua pemeriksaan integritas lulus (artinya tidak ada baris nyata yang memakai kategori pengguna lain). Sidik jari hanya mencakup jumlah baris dan total uang; karena migrasinya tidak berisi DML, itu cukup, tetapi bukan perbandingan isi baris |
| `migrations.spec.ts` | migrasi diterapkan pada database kosong; hasilnya persis `schema.prisma` (`migrate diff`); `CHECK` uang dan tabel audit ditegakkan; keempat trigger terpasang dan menolak yang seharusnya |
| `tenant-guards.spec.ts` (termasuk SQL mentah) | trigger menolak yang seharusnya dan mengizinkan yang sah (kategori sendiri, kategori sistem, tanpa kategori) |
| Cadangan terenkripsi | latihan pemulihan penuh diuji dengan passphrase uji di `npm run test:failure` |

## Prosedur (urut)

```bash
npm run db:up                      # pastikan PostgreSQL hidup
npm run db:migrate-rehearsal       # gladi pada SALINAN data nyata; harus berakhir "RESULT: ... change none of it"
npm run db:backup -- pre-migrasi   # cadangan terenkripsi berlabel (minta passphrase)
npm run prisma:deploy              # menerapkan migrasi tertunda pada database operasional
npm run prisma:status              # harus: "Database schema is up to date!"
npm run db:verify                  # semua pemeriksaan integritas |0
curl http://127.0.0.1:3100/health/ready   # 200 "ok" (bot dijalankan)
```

Bot tidak perlu dihentikan; bila ingin sangat konservatif, hentikan `start:dev` selama langkah `prisma:deploy` (beberapa detik) lalu nyalakan lagi.

## Bila ada yang tidak beres (pemulihan)

1. `prisma:deploy` gagal di tengah: Prisma menjalankan tiap migrasi dalam satu transaksi; migrasi yang gagal tidak meninggalkan setengah jadi. Baca galatnya, jangan ulangi membabi buta; `npm run prisma:status` menunjukkan yang mana.
2. Ingin membatalkan trigger setelah diterapkan (tidak menyentuh data):
   ```sql
   DROP TRIGGER IF EXISTS categories_owner_unchanged ON categories;
   DROP TRIGGER IF EXISTS receipt_drafts_transaction_owner ON receipt_drafts;
   DROP TRIGGER IF EXISTS budgets_category_owner ON budgets;
   DROP TRIGGER IF EXISTS transactions_category_owner ON transactions;
   DROP FUNCTION IF EXISTS finance_bot_assert_category_owner_unchanged(), finance_bot_assert_draft_transaction_owner(), finance_bot_assert_category_owner();
   ```
   Cara yang menjaga riwayat: tulis migrasi baru ke depan yang menjalankan `DROP TRIGGER`/`DROP FUNCTION` di atas, jangan mengubah migrasi yang sudah diterapkan.
3. Data hilang/rusak (tidak diharapkan; migrasi tak mengubah data): pulihkan cadangan `pre-migrasi` ke database **baru** dengan `npm run db:restore`; jangan menimpa database kerja.
