# Uji penerimaan Telegram nyata — langkah manual (pemilik)

**Status: BELUM DIJALANKAN di Telegram nyata.** Agen AI tidak bisa mengirim pesan *masuk* sebagai akunmu (hanya bot yang dapat mengirim, dan itu hanya mengisi percakapanmu dengan pesan palsu). Semua skenario di bawah sudah lulus
pada bot yang sama lewat webhook HTTP nyata dengan Telegram diganti penangkap (`test/e2e/acceptance.e2e-spec.ts`, 28 tes) — jadi yang diuji ulang di sini hanya hal yang tak bisa dibuktikan tanpa Telegram: pengenalan akun, format
balasan, foto dari ponsel.

Persiapan: bot berjalan (`npm run db:up`, `npm run start:dev`), migrasi sudah diterapkan ([migration-procedure.md](../operations/migration-procedure.md)), `/health/ready` = 200.

**Jangan menguji perintah destruktif (`reset`, #1-#4, #18-#19 yang melibatkan `ya`) pada akun yang memegang keuangan nyatamu.** Dua pengaman, pakai keduanya:
1. **Akun uji terpisah.** Tambahkan id Telegram akun kedua ke `TELEGRAM_ALLOWED_USER_IDS` (dipisah koma), mulai ulang bot, dan jalankan seluruh daftar dari akun itu. `reset` hanya menghapus data pengirimnya sendiri (per pengguna), jadi ledger akun utamamu tidak terlibat. Hapus id itu dari `.env` sesudahnya.
2. **Cadangan dulu:** `npm run db:backup -- pre-acceptance` sebelum mulai (bila kamu berkeras memakai akun utama, ini wajib).

| # | Kirim | Harus terjadi | Gagal bila |
|---|---|---|---|
| 1 | `reset` | bot menanyakan konfirmasi penghapusan | langsung menghapus |
| 2 | `makan siang 30rb ya` | **tercatat sebagai pengeluaran Rp30.000**; data lain utuh | data terhapus, atau pesan diabaikan |
| 3 | `reset`, lalu `jangan ya` | batal; semua data utuh | data terhapus |
| 4 | `reset`, lalu `batal` | batal | – |
| 5 | `beli kopi 25rb` | tercatat Rp25.000 | – |
| 6 | `ganti oli motor 150rb` | tercatat **pengeluaran baru** Rp150.000; kopi tetap Rp25.000 | kopi berubah jadi 150rb |
| 7 | `ubah jadi 40rb` | transaksi terakhir menjadi Rp40.000 | – |
| 8 | `gaji 5 juta` | pemasukan Rp5.000.000 | – |
| 9 | `tarik tunai 100rb` (bila memakai dua dompet) | "Transfer dicatat"; total saldo tidak berubah | total berubah |
| 10 | `beli kopi 2 gelas 30000` | Rp30.000 (bukan Rp2) | Rp2 |
| 11 | `beras 25kg 300000` | Rp300.000 (bukan Rp25) | Rp25 |
| 12 | `beras 25kg` | tidak tercatat ("belum paham") | tercatat Rp25 |
| 13 | `beli mobil 99999999999999rb` | ditolak "terlalu besar" | tercatat |
| 14 | kirim pesan > 2000 karakter | ditolak "terlalu panjang" | diproses |
| 15 | (tidak bisa dipicu manual) Telegram mengirim ulang update yang sama | tercatat sekali | dua kali — dibuktikan otomatis di e2e dan soak, bukan di sini |
| 16 | foto struk jelas | pratinjau draf; **belum** tercatat | langsung tercatat |
| 17 | `ya` (setelah #16) | tercatat sekali; `ya` lagi tidak menambah | dua transaksi |
| 18 | foto struk lagi, lalu `makan siang 30rb ya` | pengeluaran Rp30.000 tercatat; **struk belum dikonfirmasi** (masih draf) | struk ikut tercatat |
| 19 | foto struk lagi, lalu `jangan ya` | draf dibatalkan | tercatat |
| 20 | berkas bukan gambar sebagai foto/dokumen | ditolak dengan pesan foto | – |
| 21 | foto buram/gelap | "belum bisa membaca"; tidak ada draf | draf dengan angka ngawur tanpa peringatan |

Kegagalan layanan (lakukan satu per satu, lalu nyalakan lagi):

| Uji | Cara | Harus terjadi |
|---|---|---|
| Ollama mati | hentikan Ollama, kirim struk | struk tetap dibaca (pembaca deterministik), `/health/ready` menunjukkan `ai: degraded` |
| PostgreSQL mati | `docker stop finance-bot-postgres`, kirim `beli kopi 5rb`, lalu `docker start finance-bot-postgres` | tidak ada balasan "berhasil"; setelah hidup, Telegram mengirim ulang dan **tercatat sekali** |
| Redis (hanya bila antrean aktif) | `docker compose --profile queue stop redis`, kirim struk | struk tetap dibaca di dalam proses; `/health/ready` `queue: degraded`; nyalakan lagi → "Struk diterima" kembali |

Catat hasil (lulus/gagal + tangkapan layar) di berkas ini atau kirim ke asisten; jangan menyertakan token.
