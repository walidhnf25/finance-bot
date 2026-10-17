# Peran database non-superuser (least privilege)

Saat ini bot terhubung ke PostgreSQL sebagai `POSTGRES_USER` dari compose, yang adalah **superuser** database itu. Artinya, bila ada bug atau injeksi di bot, ia secara teknis dapat
mengubah skema, mematikan trigger penjaga tenant (`ALTER TABLE … DISABLE TRIGGER`) atau melewatinya (`SET session_replication_role = replica`). Dengan peran terbatas, semua itu ditolak oleh PostgreSQL sendiri.

**Status:** disiapkan dan **dibuktikan pada database sekali-pakai** (`test/failure/least-privilege.failure-spec.ts`, 3 tes: bot berfungsi penuh; peran tak bisa membuat objek/role/database;
tak bisa `ALTER`/`DROP`/`TRUNCATE`, mematikan atau melewati trigger). **Belum diterapkan pada database operasional**: itu perubahan akses pada database hidup, jadi butuh persetujuanmu.

## Yang berubah dan yang tidak

| | Sekarang | Setelah |
|---|---|---|
| Bot (runtime) | superuser | `finance_bot_app`: hanya SELECT/INSERT/UPDATE/DELETE pada tabel, USAGE pada sekuens, tanpa DDL, tanpa superuser |
| Migrasi (`prisma:deploy`) | superuser | tetap pemilik/superuser, dijalankan dengan URL terpisah |
| Data, skema, cadangan | – | tidak berubah |

## Langkah (pemilik)

1. Cadangan: `npm run db:backup -- pre-leastpriv`.
2. Buat peran (jalankan sekali sebagai pemilik; ganti `<SANDI-ACAK>` dan nama pemilik bila beda):
   ```sql
   CREATE ROLE finance_bot_app LOGIN PASSWORD '<SANDI-ACAK>' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
   GRANT CONNECT ON DATABASE "finance_bot" TO finance_bot_app;
   GRANT USAGE ON SCHEMA public TO finance_bot_app;
   GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO finance_bot_app;
   REVOKE INSERT, UPDATE, DELETE ON "_prisma_migrations" FROM finance_bot_app;   -- bot hanya membaca riwayat migrasi (untuk /health/ready)
   GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO finance_bot_app;
   ALTER DEFAULT PRIVILEGES FOR ROLE finance_bot IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO finance_bot_app;
   ALTER DEFAULT PRIVILEGES FOR ROLE finance_bot IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO finance_bot_app;
   REVOKE CREATE ON SCHEMA public FROM PUBLIC;
   REVOKE TEMPORARY ON DATABASE "finance_bot" FROM PUBLIC;                        -- tidak ada tabel TEMP buatan peran lain
   ```
   Fungsi trigger tenant juga **mengunci `search_path` dan memakai nama tabel berkualifikasi skema** (`public.categories`), jadi tabel TEMP bernama sama tidak dapat menggantikannya (diuji, termasuk saat hak TEMP sengaja diberikan).
   Dengan: `docker exec -i finance-bot-postgres psql -U <pemilik> -d finance_bot < berkas.sql` (berkas di luar repositori; **jangan** menaruh sandi di repositori).
3. Pisahkan dua URL: bot memakai `finance_bot_app` (`DATABASE_URL` di `.env`); migrasi dan cadangan tetap memakai pemilik. Karena `prisma migrate` membaca `DATABASE_URL`, berikan URL pemilik **tanpa menaruh sandinya di baris perintah** (riwayat shell menyimpannya): simpan di berkas di luar repositori, mis. `~/.finance-bot-owner.env` berisi satu baris `DATABASE_URL=…`, lalu
   `set -a; . ~/.finance-bot-owner.env; set +a; npm run prisma:deploy` (Git Bash; di PowerShell isi `$env:DATABASE_URL` lewat `Read-Host -AsSecureString` atau berkas yang dibaca skrip, dan hapus variabelnya sesudahnya).
   Skrip cadangan memakai `docker exec` dengan pemilik dan tidak terpengaruh.

   **VPS/compose:** layanan `app` dan `migrate` di `docker-compose.yml` membangun URL dari `POSTGRES_USER` (superuser) dan memakai satu URL yang sama. Peran terbatas **belum** didukung di compose; menerapkannya di server berarti menambah variabel terpisah untuk `app` (peran terbatas) dan `migrate` (pemilik) — perubahan terpisah yang perlu diuji tersendiri. Sampai itu, server tetap memakai superuser.
4. Mulai ulang bot; periksa `/health/ready` = 200 dan kirim satu pesan uji.
5. Pembatalan: ganti `DATABASE_URL` kembali ke pemilik; peran dapat dibiarkan atau `DROP OWNED BY finance_bot_app; DROP ROLE finance_bot_app;`.

## Foreign key komposit — dievaluasi, tidak dipasang

FK komposit dievaluasi dan tidak dipasang karena: (1) kategori sistem punya `user_id` NULL sehingga FK `(category_id, user_id)` tak dapat menyatakan "milikku **atau** milik bersama"; (2) `receipt_drafts.transaction_id` belum punya FK sama sekali, dan menambahkannya (dengan `UNIQUE(id, user_id)` pada `transactions`) mengubah model Prisma dan urutan penghapusan pada reset data — perubahan skema pada database hidup dengan manfaat tambahan kecil di atas trigger yang sudah menutup jalur yang sama dan diuji (`tenant-guards.spec.ts`, 13 tes).
Keputusan ini bisa ditinjau ulang; bila diinginkan, itu perubahan terpisah dengan gladi `db:migrate-rehearsal` sendiri.
