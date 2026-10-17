# Tinjauan performa dan sumber daya

Satu pengguna, satu proses; tujuan tinjauan ini adalah **tidak ada pertumbuhan tak terbatas** dan **tidak ada pekerjaan tak terbatas**, bukan throughput.
Semua angka di bawah berasal dari run di satu mesin Windows (Docker Desktop, tanpa GPU); tidak ada klaim kapasitas.

## 1. Apa yang dibatasi

| Sumber daya | Batas | Perilaku di batas | Bukti |
|---|---|---|---|
| Foto menunggu OCR | `MAX_OCR_PENDING = 6` (satu berjalan, sisanya antre) | yang ke-7 gagal **cepat** (`busy`); balasan "sedang sibuk"; metrik `receipts_total{outcome="busy"}` | `ocr.spec.ts` (50 foto serentak → 48 `busy` pada batas uji 2); mutan M47, M48 |
| Permintaan model | `Semaphore(1)` + timeout `OLLAMA_TIMEOUT_MS` (120 d) + batas respons 1 MiB + breaker | model mati → 3 kegagalan lalu ditolak seketika selama 30 d; pembaca deterministik mengambil alih | `ollama.client.spec.ts`; mutan M44–M46, M66 |
| Ukuran gambar | `RECEIPT_MAX_FILE_SIZE_BYTES` 5 MiB, `RECEIPT_MAX_PIXELS` 25 juta, dicek sebelum dekode | ditolak dengan pesan | `image-processor.spec.ts`; mutan M25–M27 |
| Struk per pengguna | `RECEIPT_MAX_PER_HOUR` 20 | ditolak | mutan M28 |
| Pesan | `USER_RATE_LIMIT_PER_MINUTE` 30 (jendela geser), `MAX_INPUT_CHARS` 2000 | dibalas singkat, tidak diurai | mutan M33, M51 |
| Kardinalitas metrik | label dari himpunan tetap, selain itu `other` | tidak bisa membesar oleh input | `metrics.service.spec.ts`; mutan M53 |
| Tabel audit | metadata ≤ 1024 karakter (kode) / 4096 byte (DB); retensi 365 hari | dipangkas / dihapus berkala | `audit-and-retention.spec.ts` |
| Draf struk & percakapan | kedaluwarsa 30 menit; draf CANCELLED/EXPIRED dihapus setelah 30 hari | dihapus oleh `RetentionService` | idem |
| Kontainer (VPS) | `mem_limit: 1g` pada `app`; `mem_limit: 1g`, `cpus: 1.0` pada `postgres` | OOM-kill kontainer, bukan host; `restart: unless-stopped` | `npm run docker:verify`, `docker-limits.spec.ts` |
| Log kontainer | `max-size 10m × 5` | dirotasi Docker | `docker-compose.yml` |

## 2. Soak (bukan uji beban)

`npm run test:soak`: transport Telegram simulasi, PostgreSQL asli, kegagalan disuntik, restart aplikasi berkala. Menguji invarian, bukan kecepatan.

| Run | Hasil |
|---|---|
| 120 detik, seed 78197 | 2.250 iterasi (18,7/detik); 1.319 catatan dimaksudkan = 1.319 baris; 546 konfirmasi struk = 546 draf `CONFIRMED`; 371 galat tulis DB disuntik; 118 gagal balasan Telegram; 116 kegagalan model; 489 pengiriman ulang (369 pemutaran duplikat) + 9 restart (108 pemutaran sesudah restart) → **0 duplikat, 0 503 tak terduga**. Heap 500 → 507 MB (datar) |
| 600 detik | 14.788 iterasi, 8.889 catatan = 8.889 baris, 3.390 struk = 3.390 `CONFIRMED`, 2.505 kegagalan DB disuntik, 59 restart + 708 pemutaran ulang → 0 duplikat |

Batasan: soak memakai transport simulasi dan OCR/AI palsu; ia tidak mengukur latensi OCR nyata atau tekanan memori Tesseract.

### 2b. Antrean latar belakang (opsional)

| Aspek | Nilai | Catatan |
|---|---|---|
| Konkurensi pekerja struk | 1 (maks 4) | OCR serial dan model `Semaphore(1)`: menaikkan angka ini **tidak terbukti** menambah kecepatan; tidak diukur |
| Redis | `maxmemory 256mb`, `noeviction`, 384 MB / 0,5 CPU | satu job ≈ beberapa ratus byte (referensi saja); batas Redis penuh → enqueue gagal → fallback dalam proses |
| Riwayat job | selesai 200 / 24 jam; gagal 1000 / 7 hari | terbatas |
| Enqueue | batas 3 d; gagal cepat | tanpa antrean offline |
| Shutdown | menunggu job ≤ 20 d, lalu paksa; tidak menggantung bila Redis mati | diuji |
| Overhead antrean vs dalam-proses | **tidak diukur** | pada tes, balasan "Struk diterima" langsung; draf menyusul setelah OCR |

## 3. Latensi yang diketahui

Dari evaluasi OCR (`testing/receipt-ocr-evaluation.md`): OCR mayoritas < 0,3 detik, p95 ±10 detik (percobaan kedua pada gambar sulit); model teks 4B di CPU 17–18 detik median dan 25–31 detik p95.
Karena itu `RECEIPT_AI_MODE=auto` (model hanya bila pembaca ragu) adalah bawaan. **Diukur:** `receipt:eval` (75 gambar sintetis + 1 nyata) OCR median **150 ms**, p95 **10,6 s**, total tepat 85 % (57/67); `receipt:live-check` dengan Ollama nyata (`qwen3:4b-instruct`, tanpa vision, CPU) membaca struk sintetis dalam **34,9 s** (total benar 16.500).

## 4. Titik panas yang diketahui

- **Satu OCR sekaligus.** Foto beruntun mengantre; enam foto sekaligus = ±beberapa detik tambahan, lebih dari itu `busy`. Untuk satu pengguna ini memadai.
- **Model di CPU.** 25–31 detik p95; pembaca deterministik tetap menghasilkan draf bila model lambat atau mati.
- **`build()` saldo dompet memakai beberapa kueri tanpa snapshot** ; tidak berdampak pada satu pengguna berurutan.
- **Webhook** (bukan bawaan): tidak dipotong 15 detik, jadi satu permintaan struk dapat menahan koneksi selama OCR + AI; polling tidak terpengaruh.

## 5. Tidak diuji

Beban banyak pengguna (bot ini satu pengguna per allowlist); disk penuh; PostgreSQL yang benar-benar mati saat start (hanya galat tulis yang disuntik); Tesseract di bawah tekanan memori kontainer 1 GiB pada VPS nyata.
