# Kualitas tes

Semua angka berasal dari run di mesin pengembangan.

## 1. Ukuran suite

| Suite | Jumlah | Catatan |
|---|---|---|
| Unit (`npm test`) | **1.111** (55 suite) | parser, uang, validasi struk, breaker, semaphore, jaminan "tidak menulis ke disk", antrean OCR, metrik |
| Integrasi (PostgreSQL asli) | **177** (10 suite) | constraint, idempotensi, konkurensi, isolasi, trigger tenant, migrasi pada database kosong, audit/retensi |
| E2E (HTTP webhook, PostgreSQL asli) | **84** (6 suite) | termasuk `hardening` (kegagalan DB/AI/unduh, tak berwenang, batas kalender, mode `auto`), `lifecycle` (koneksi dilepas, restart berulang), observabilitas, privasi log |
| Antrean (`npm run test:queue`) | **26** (2 suite) | Redis nyata |
| Injeksi kegagalan (`npm run test:failure`) | **18** (4 suite) | Docker: PostgreSQL/Redis dimatikan, cadangan, peran database terbatas |
| Soak (`npm run test:soak`) | 1 skenario | lihat §4 |
| Lint | 0 error, 0 warning | |
| Typecheck / format / build | lulus | |

Cakupan unit dan teknik tes dijelaskan di [strategi tes](../testing/test-strategy-and-coverage.md).

## 2. Uji mutasi: apa yang diukur dan bagaimana dilaporkan

Skrip `scripts/mutation-checks.js` (`npm run test:mutation`) menghapus atau melemahkan **satu** perlindungan pada **salinan** pohon kerja
dan menjalankan tes yang seharusnya gagal. Ini **sampel guard yang dipilih**, bukan pembangkit mutan otomatis seperti Stryker.

Setiap hasil diklasifikasi dari laporan JSON Jest, bukan dari menghitung teks:

| Kelas | Arti | Dihitung sebagai bukti kuat? |
|---|---|---|
| `KILLED (assertion)` | sebuah tes gagal pada asersi `expect(...)` | **Ya** |
| `KILLED (application error, no assertion)` | tes gagal karena error yang dilempar (mis. pelanggaran unique), bukan asersi | Sedang: mutan membuat aplikasi rusak secara terdeteksi |
| `KILLED (timeout only)` | tes habis waktu | Lemah |
| `KILLED (test run crashed: unrelated evidence)` | tidak ada laporan (kehabisan memori, loop tak berujung) | **Lemah**: bukan deteksi oleh asersi |
| `INVALID` | mutan tidak lolos kompilasi | Tidak dihitung sebagai pembunuhan (membuktikan nol) |
| `EQUIVALENT (documented)` | perilaku identik (ditandai manual) | – |
| `NOT APPLICABLE` | teks sumber berubah, mutan tak bisa diterapkan | – |
| `SURVIVED` | tidak ada tes yang gagal | **Celah uji** |

Skrip juga memverifikasi bahwa baseline hijau lebih dulu (perintah uji dijalankan tanpa mutan) dan tidak pernah memodifikasi repositori (salinan di folder
sementara; tautan `node_modules` dilepas sebelum salinan dihapus).

### Hasil (97 mutan)

| Kelas | Jumlah |
|---|---|
| Terbunuh oleh **asersi** | **89** |
| Terbunuh oleh error aplikasi (tanpa asersi) | 8 (M09, M10, M11, M12, M14, M69, M72, M77: pelanggaran unique, kunci baris, timeout webhook, fallback Redis, pemberitahuan job gagal) |
| Terbunuh hanya oleh timeout | 0 |
| Terbunuh oleh crash tak terkait | 0 |
| Tidak valid / setara / tidak berlaku | 0 / 0 / 0 |
| **Selamat** | **0** |

## 3. Kestabilan dan determinisme

| Isu | Penanganan |
|---|---|
| Tes e2e bergantung pada bulan berjalan (flaky di pergantian bulan) | semua pesan uji memakai jam tetap (`E2E_NOW` = 2026-07-15 12:00 WIB); aplikasi menurunkan "hari ini/bulan ini" dari waktu pesan |
| Batas bulan, tahun, kabisat | e2e dengan jam eksplisit (Asia/Jakarta = UTC+7): 23:30 31 Jan vs 00:30 1 Feb; 23:30 31 Des vs 00:30 1 Jan; 29 Feb 2028. Tes bermakna: bila kode memakai bulan UTC, tes batas bulan gagal |
| Tes membaca konfigurasi pribadi | `ignoreEnvFile` saat `NODE_ENV=test` |
| Peringatan "Jest did not exit" pada e2e | Ada (tidak menggantung; proses selesai beberapa detik kemudian). Penyebab yang dicurigai: soket keep-alive klien `fetch` ke server Ollama palsu. `--detectOpenHandles` tidak melaporkan apa pun. Tidak memengaruhi hasil |

## 4. Soak terkendali (`npm run test:soak`)

Transport **simulasi** (tidak ada lalu lintas ke Telegram), PostgreSQL asli (`finance_bot_test`), 30 pengguna simulasi, kegagalan disuntik (galat
penulisan database, galat konfirmasi, Telegram tidak terjangkau saat membalas, model gagal), pemutaran ulang update, restart aplikasi berkala.

| Ukuran (run 600 detik, seed 2026) | Hasil |
|---|---|
| Iterasi / lama / kecepatan | 14.788 / 600 s / 24,6 per detik |
| Catatan yang dimaksudkan vs baris di database | 8.889 = **8.889** |
| Struk dikonfirmasi vs baris struk vs draf CONFIRMED | 3.390 = **3.390** = **3.390** |
| Struk dibatalkan | 1.052 (tidak ada transaksi) |
| Kegagalan database disuntikkan / respons 503 tak terduga / status lain | 2.505 / **0** / **0** |
| Pemutaran ulang (redelivery) | 3.206 |
| Restart aplikasi / pemutaran ulang update lama setelah restart | **59 / 708**, **0 duplikat** |
| Kegagalan balasan Telegram / kegagalan model | 701 / 686 (semuanya pulih) |
| Kunci idempotensi ganda, draf CONFIRMED yatim, transaksi yatim | 0 / 0 / 0 |
| Heap proses uji | 465 → 506 MB (harness menumpuk data; lihat paragraf memori di bawah) |

**Memori (diukur, dengan penjelasan).** Pada run 600 detik heap proses uji naik 465 → 506 MB. Itu **bukan** bukti kebocoran aplikasi:
harness sendiri menumpuk data (penangkap pesan Telegram palsu menyimpan setiap pesan, Ollama palsu menyimpan setiap permintaan, Jest menyimpan
setiap panggilan mock). Soak 300 detik **tanpa restart** dengan penumpukan itu dikosongkan tiap 5 detik: iterasi 7.919, catatan 4.760 = 4.760 baris,
struk 1.785 = 1.785 baris = 1.785 draf CONFIRMED, 0 respons tak terduga, **heap datar: 465 → 470 MB**.
Sebagai pembanding, run yang sama tanpa pengosongan naik 274 → 295 MB. Batasan: ini heap dalam proses Jest selama 5–10 menit, bukan proses bot produksi
selama berhari-hari; memori bot sungguhan (idle, polling) hanya diukur sekali: working set 25 MB, private 112 MB setelah ±2,5 jam.

Soak bukan uji stres terhadap Telegram dan tidak mengirim apa pun ke Telegram.

## 5. Yang belum dicakup tes otomatis

- Telegram sungguhan (lihat [uji Telegram nyata](../testing/telegram-real-integration-checklist.md)).
- OCR pada foto struk nyata yang beragam (lihat [evaluasi OCR](../testing/receipt-ocr-evaluation.md)).
- Jalur model *vision* (tidak ada model).
- Skrip bash cadangan/pemulihan diuji lewat `npm run test:failure` (Docker), bukan Jest biasa.
