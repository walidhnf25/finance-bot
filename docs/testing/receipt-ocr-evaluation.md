# Evaluasi kualitas OCR struk

> **Baca ini dulu.** Angka di bawah berasal dari **struk sintetis** yang dibuat program (75 gambar dari 15 struk dasar) dan
> **satu** foto struk sungguhan. Itu cukup untuk menemukan kelemahan dan membandingkan varian, **bukan** untuk mengklaim
> akurasi umum pada struk Indonesia nyata (kertas termal pudar, miring, lecek, silau, tulisan tangan). Tidak ada persentase
> di sini yang boleh dibaca sebagai "akurasi sistem".

## 1. Alur dan hal yang tidak boleh berubah

```
Gambar → validasi berkas → OCR (Tesseract ind+eng; ulang sekali dengan pra-pemrosesan kuat bila tidak ada total yang dapat dipakai)
       → pembacaan deterministik (aturan eksplisit)
       → [opsional] Ollama menyusun JSON (mode auto/always)
       → validasi keuangan oleh kode → DRAF → konfirmasi pengguna → satu transaksi atomik di PostgreSQL
```

Invarian yang dipertahankan dan dijaga tes: keluaran AI tidak pernah langsung mencatat transaksi; struk tetap draf sampai
dikonfirmasi; konfirmasi terikat pada pengguna dan idempoten; field yang tidak terbaca tetap kosong (tanggal tidak terbaca →
peringatan, bukan diam-diam diganti hari ini; tanggal di masa depan diganti hari ini **dengan peringatan**; tanggal lama
**dipertahankan dengan peringatan**); total yang salah tidak diterima diam-diam (peringatan jika tidak tertelusur ke teks,
jika bertentangan dengan baris tunai/kembalian, jika model dan teks berbeda, atau jika tidak ada baris total); kegagalan
model tidak bisa membuat transaksi palsu.

## 2. Himpunan uji

15 struk dasar (nama toko Indonesia, format rupiah berbeda: `875.000`, `Rp. 875.000,-`, `IDR 30.500,00`, `52,000`, `875000`;
label total berbeda: `TOTAL`, `Total Belanja`, `GRAND TOTAL`, `Total Bayar`, `Total Tagihan`, `Jumlah`, `Netto`; tata letak: jumlah di
baris yang sama / di baris berikutnya / titik-titik; diskon negatif, PPN, service; `Total Item/Qty/Pajak`; kembalian lebih besar
dari total; total jutaan; nama toko panjang; tanpa tanggal; **tanpa baris total yang jelas**; dua kata "total" bertingkat; format tanggal:
`16 November 2019`, `12 Okt 2026`, `03-08-26`, `15.09.2026`, `2026-09-30`, `31/12/2026`, `Minggu, 6 September 2026`).

Setiap struk dibuat dalam beberapa varian (deterministik):

| Varian | Jumlah gambar | Maksud |
|---|---|---|
| clean | 15 | teks bersih |
| rotated | 8 | miring 4° / −6° |
| blurry | 7 | kabur |
| lowres | 8 | resolusi sangat rendah + kompresi JPEG |
| faded | 7 | kontras rendah, tinta pudar |
| thermal | 15 | kertas kekuningan, tinta abu pucat, noise ringan, JPEG (perkiraan foto struk thermal) |
| noisy | 8 | **sengaja keras**: bintik warna berat di latar gelap kontras rendah |
| cropped-total | 4 | bagian bawah terpotong: total **tidak ada** di gambar |
| cropped-top | 3 | header terpotong |

8 gambar tidak punya total yang bisa ditentukan manusia (4 terpotong + 4 `no-label`); untuk gambar ini yang benar adalah **menolak
atau memberi peringatan**, bukan menebak. Gambar sintetis tidak pernah di-commit (dibuat ulang setiap kali); tidak ada struk
pribadi di repo.

**Struk pribadi milikmu** dapat dievaluasi di mesinmu sendiri: `npm run receipt:eval -- --dir <folder>` dengan pasangan `x.jpg` + `x.json`
(`{"total":875000,"date":"2019-11-16","merchant":"..."}`). Jangan commit folder itu. Laporan (`evaluation-reports/`, git-ignored)
berisi id kasus dan angka, bukan teks struk.

## 3. Metrik

- **Total tepat**: total draf = total sebenarnya (hanya untuk gambar yang punya total).
- **Tanggal tepat**: di antara draf yang dihasilkan dan yang tanggalnya jelas terlihat.
- **Nama toko**: kemiripan ≥ 80% (jarak edit) atau saling memuat.
- **Draf salah** ("false transaction creation"): draf dihasilkan dengan total yang tidak sama dengan kebenaran (atau pada struk tanpa total);
  dipecah menjadi **ditandai** (ada peringatan total) dan **diam-diam** (tanpa peringatan). Ingat: draf tidak mencatat apa pun sebelum
  konfirmasi pengguna; ini ukuran risiko "pengguna menekan ya tanpa membaca".
- **Kesalahan OCR vs parser**: OCR salah bila digit total sebenarnya tidak ada di teks OCR; parser salah bila ada tetapi angka lain terpilih.
- **Latensi**: OCR (termasuk percobaan kedua), parsing, model.

## 4. Hasil

### 4.1 Parser deterministik (OCR + aturan, tanpa model)

Himpunan uji: 75 gambar sintetis.

| Ukuran | Hasil |
|---|---|
| Total tepat, semua | 57/67 = 85% |
| Total tepat tanpa varian bintik-berat | **57/59 = 97%** |
| Varian bintik-berat (OCR gagal) | 0/8 (aman: semua ditolak, tidak menebak) |
| Draf salah | **1/75 = 1%, ditandai** |
| Struk tanpa total jelas → ditolak | 8/8 |
| Kesalahan parser (digit ada, angka salah dipilih) | 1 (label "Jumlah" rusak jadi sampah oleh OCR) |
| Kesalahan OCR | 9 (hampir semuanya varian bintik-berat) |
| Tanggal tepat | 96% (49/51) |
| Nama toko | 81% |

Per varian (total tepat): clean 14/14 · lowres 8/8 · blurry 6/6 · faded 6/6 · cropped-top 3/3 · thermal 13/14 · rotated 7/8 · **noisy 0/8**.

Aturan eksplisit yang dijaga tes regresi (`heuristic-regression.spec.ts`, 51 tes): baris pembayaran (`Bayar`, `Tunai`) tidak diambil sebagai total;
`IDR 30.500,00` terbaca 30.500; label `Netto` dikenal; jumlah di baris berikutnya terbaca; `Total Pajak/Service/Item` tidak menang atas total sebenarnya;
label `TOTAL` yang dibaca OCR sebagai `ToTar` tetap dikenali; pemeriksaan silang dengan tunai−kembalian.

### 4.2 Model (Ollama `qwen3:4b-instruct`, teks saja) vs deterministik

Diukur pada 15 gambar `clean` dan 15 gambar `thermal` dengan kebijakan **"baris total di teks menang atas model"**:

| Ukuran | Deterministik | Dengan model (mode `always`) |
|---|---|---|
| Total tepat (clean / thermal) | 14/14 / 13/14 | 14/14 / 13/14 |
| Tanggal tepat | 13/13 / 12/12 | 13/14 / 13/14 |
| Nama toko | 14/15 / 13/15 | **15/15 / 15/15** |
| Draf salah (clean / thermal) | 0 / 0 | 1 / 2 — **semuanya ditandai** (`TOTAL_UNLABELLED`, `TOTAL_NOT_IN_TEXT`), 0 diam-diam |
| Struk tanpa total jelas | ditolak 100% | model **menebak** (ditandai) |
| Latensi median / p95 | < 1 ms / < 3 ms | **17–18 s / 25–31 s** (CPU) |

Bila model menang atas teks, total tepat hanya 86% (12/14) dengan 20% draf salah, 1 tanpa peringatan.
**Keputusan:** model tidak lebih akurat pada total, jauh lebih lambat, dan hanya lebih baik pada nama toko. Maka mode default `RECEIPT_AI_MODE=auto`:
model hanya dipanggil bila pembacaan deterministik tidak menemukan total berlabel yang konsisten; `always` dan `never` tersedia. Kalau
model dipakai, total pada baris berlabel tetap menang dan perbedaan ditandai `TOTAL_DISPUTED`.

### 4.3 Satu foto struk sungguhan (n = 1, bukan statistik)

Struk toko elektronik tercetak (milikmu, tidak di-commit): OCR membaca semua baris; total 875.000 benar; tanggal "Sabtu, 16 November 2019"
terbaca; nama toko benar; peringatan `DATE_OLD` muncul (tanggal > 3 tahun, dipertahankan). Satu foto tidak membuktikan apa pun
tentang kondisi lain.

### 4.4 Keterbatasan yang masih ada

- **Varian bintik-berat gagal total** (0/8): OCR Tesseract tidak membaca; hasilnya aman (ditolak, pengguna mengetik), tetapi tidak berguna.
- **Salah baca digit** tetap mungkin: pada satu struk miring `875.000` terbaca `815.000`; tertangkap hanya karena bertentangan dengan tunai−kembalian
  (draf ditandai). Tanpa baris tunai/kembalian, salah baca digit total **tidak terdeteksi** (peringatan hanya muncul bila angka tidak tertelusur ke teks OCR, dan pada kasus ini ia tertelusur).
- **Tanggal bisa salah baca diam-diam**: `comma-style:rotated` membaca `20/07/2026` sebagai `2026-01-20` tanpa peringatan (hasil `07` → `01`). Tanggal selalu tampil di pratinjau dan bisa dikoreksi (`tanggal …`).
- Himpunan sintetis tidak menangkap: kertas termal nyata dengan pudar tidak merata, lipatan, silau, foto dari jauh, tulisan tangan, struk berbahasa/aksara lain, struk panjang yang diambil per bagian.
- Latensi OCR p95 ±10 s berasal dari percobaan kedua pada gambar sulit; mayoritas gambar < 0,3 s.

## 5. Keputusan model vision

Ollama hanya memiliki `qwen3:4b` dan `qwen3:4b-instruct` (kemampuan: `completion`, `tools`, `thinking`; **tanpa `vision`**), jadi jalur gambar-langsung
tidak dapat dijalankan. **Tidak ada model yang diunduh.** Jalur vision ada di kode dan dijaga: ditolak bila model tidak melaporkan `vision` di `/api/show`.
Syarat sebelum mengadopsinya: (1) kamu menyetujui unduhan dengan ukuran dan kebutuhan memori yang disebutkan; (2) kemampuan `vision` terverifikasi dari
metadata; (3) diuji pada **himpunan evaluasi yang sama** (`npm run receipt:eval -- --with-model`) dan dibandingkan dengan OCR saja; (4) dipakai hanya jika
manfaat terukur (khususnya pada varian yang gagal) sebanding dengan tambahan latensi dan memori. Mengingat model teks 4B saja sudah 17–30 detik di CPU,
model vision berukuran serupa kemungkinan lebih lambat; keputusan ditunda sampai ada data.

## 6. Cara menjalankan ulang

```bash
npm run receipt:fetch-langdata        # sekali, mengunduh data bahasa OCR
npm run receipt:eval                  # 75 gambar sintetis, OCR + deterministik (±2 menit)
npm run receipt:eval -- --with-model  # tambah Ollama (lambat: ±20 s per gambar); --only clean|thermal|... --limit N
npm run receipt:eval -- --dir D:\struk-ku        # gambar milikmu (x.jpg + x.json)
npm run receipt:live-check -- foto.jpg --ocr     # satu foto + teks mentah OCR
```
