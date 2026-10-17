# Perlindungan data

> Tinjauan oleh pembangun dan penilai otomatis, **bukan** audit manusia.

## 1. Di mana data pribadi berada

| Lokasi | Isi | Terlindungi bagaimana |
|---|---|---|
| Volume Docker `pgdata` (PostgreSQL) | semua transaksi, pengguna, budget, draf struk | tidak dienkripsi oleh aplikasi; hanya bisa dijangkau lewat `127.0.0.1:15432` dengan kata sandi acak, atau lewat Docker |
| `backups/db/*.dump.gpg` | cadangan database | **terenkripsi** (GnuPG AES-256), lihat §2 |
| `.env` | token bot, kata sandi database | git-ignored; tidak pernah dicetak oleh skrip |
| `logs/` | peristiwa aplikasi: panjang pesan, jenis kejadian, kode status | tanpa isi pesan/nominal/teks struk; token disamarkan; dirotasi 14 hari |
| `data/tessdata/` | model bahasa OCR (bukan data pribadi) | git-ignored |
| Foto struk | **tidak pernah ditulis ke disk** (dijaga tes `no-disk-writes.spec.ts`) | hanya di memori selama diproses |

Enkripsi *at rest* untuk volume Docker dan seluruh disk **tidak** disediakan aplikasi. Rekomendasi: aktifkan BitLocker/enkripsi perangkat Windows
(status BitLocker tidak dapat diperiksa tanpa hak administrator, jadi tidak diverifikasi di sini).

## 2. Cadangan terenkripsi

**Alat dan format:** GnuPG 2.4 (sudah ada bersama Git for Windows), enkripsi simetris `--cipher-algo AES256`, derivasi kunci
iterated+salted SHA-256 (`--s2k-mode 3 --s2k-count 65011712`), kemasan OpenPGP dengan perlindungan integritas (MDC). Bukan
kriptografi buatan sendiri: dipilih format OpenPGP yang mapan dan bisa dibuka alat standar mana pun.

**Alur `npm run db:backup`:** `pg_dump` (dalam kontainer) → `gpg` (stdin→stdout) → berkas `.part` → verifikasi (didekripsi di
memori dan dibaca `pg_restore --list`) → baru diganti nama menjadi `finance-bot-<UTC>.dump.gpg` + `.sha256`. Jika `pg_dump` atau `gpg`
gagal, `pipefail` menghentikan proses dan berkas sementara dihapus: **tidak ada cadangan yang diam-diam tidak terenkripsi**.
Plaintext hanya dengan opt-out eksplisit `FINANCE_BOT_BACKUP_ALLOW_PLAINTEXT=1` (dengan peringatan).

**Passphrase:** tidak pernah di baris perintah (terlihat di daftar proses), tidak ditulis di samping cadangan, tidak dicetak.
Sumbernya: (a) berkas yang kamu tentukan lewat `FINANCE_BOT_BACKUP_PASSPHRASE_FILE` (baris pertama = passphrase) **di luar repositori**
(skrip memperingatkan bila berada di dalamnya), atau (b) prompt interaktif dengan konfirmasi di terminal. Diteruskan ke `gpg` lewat
file descriptor privat (`--passphrase-fd`).

**Pemulihan:** `restore-rehearsal` dan `restore-db.sh` mendekripsi **di memori langsung ke `pg_restore`** (tanpa berkas plaintext
sementara), memverifikasi checksum dulu, dan menolak menimpa database kerja.

**Diuji (dengan passphrase uji sekali pakai):**

| Skenario | Hasil |
|---|---|
| Backup tanpa sumber passphrase (non-interaktif) | ditolak, exit 1, tidak ada berkas |
| Backup terenkripsi | berkas tidak diawali magic `PGDMP` dan nama tabel tidak terlihat; dapat dibaca balik |
| Latihan restore dari berkas `.gpg` | checksum OK, **pemeriksaan integritas lulus pada salinan**, hasil cocok dengan database hidup |
| Passphrase salah | `Bad session key`, exit non-zero, kontainer sementara dibersihkan |
| Ciphertext dirusak (tanpa berkas checksum) | `encrypted message has been manipulated`, exit non-zero |
| Ciphertext dirusak (dengan checksum) | `Checksum mismatch`, exit 1 |

**Peringatan pemulihan kunci:** jika passphrase hilang, cadangan terenkripsi **tidak dapat dipulihkan oleh siapa pun**. Simpan
passphrase di pengelola kata sandi dan satu salinan offline; simpan cadangan di media terpisah dari komputer ini.

## 3. Akses database

| Pemeriksaan | Hasil |
|---|---|
| Port terbit | `docker port`: `5432/tcp -> 127.0.0.1:15432`; `netstat`: mendengarkan hanya di `127.0.0.1` (tidak di LAN) |
| Kredensial | kata sandi acak di `.env` (git-ignored); skrip tidak membacanya (mereka memakai `docker exec` dan socket kontainer) dan log tidak memuatnya |
| Jaringan kontainer vs host | pada pemakaian dari host, aplikasi terhubung ke port loopback; pada layanan compose `app`, aplikasi ada di jaringan Docker yang sama tanpa port terbuka |
| Batasan | pengguna Windows mana pun yang boleh memakai Docker dapat membaca database (`docker exec`), dan proses mana pun di mesin yang sama dapat mencoba `127.0.0.1:15432` bila tahu kata sandinya. Loopback bukan batas keamanan sempurna di mesin multi-pengguna |

## 4. API HTTP

Inventaris rute (kode + diperiksa pada bot yang berjalan, mode production, polling):

| Rute | Perilaku | Data yang terbuka |
|---|---|---|
| `GET /` | 200 | nama layanan dan teks tetap |
| `GET /health`, `/health/live`, `/health/ready` | 200/503 | status komponen dengan string tetap (tanpa URL, kredensial, isi galat) |
| `GET /metrics` | hanya loopback dan header `Host` loopback | penghitung tetap tanpa data pengguna |
| `POST /telegram/webhook` | **404 pada mode polling**; pada mode webhook: secret **wajib** dan dibandingkan timing-safe, tanpa secret server menolak semuanya | – |
| Swagger (`/docs`, `/docs-json`, `/docs-yaml`) | **404** (mati secara default); hanya aktif bila `SWAGGER_ENABLED=true` | spesifikasi rute (di atas) |

Pengikatan: `127.0.0.1` (alamat non-loopback butuh `ALLOW_REMOTE_BIND=true` eksplisit; startup menolak jika tidak).

**Penilaian:** tidak ada rute yang mengembalikan data keuangan, dan satu-satunya rute yang mengubah keadaan (webhook) dijaga secret
serta mati pada mode polling. Maka **tidak diperlukan sistem autentikasi tambahan** untuk model penggunaan ini; loopback bukan
satu-satunya pertahanan, karena rute yang tersisa tidak berisi data sensitif. Syarat: **jangan menambahkan rute yang membaca/menulis
data tanpa autentikasi** dan jangan membuka `ALLOW_REMOTE_BIND` tanpa lapisan sendiri.
