# Albion Market Receiver

> Jalur **privat** pengumpulan data harga Albion Online untuk **Albion Market Lab**. Status: **perencanaan — implementasi belum dimulai**.

**Hanya menggunakan scan pribadi.** Tidak mengambil harga dari AODP Community API, dan tidak mengirim hasil scan ke server komunitas.

## Tujuan
Menerima event market dari collector yang berjalan secara lokal saat pemain membuka market, menormalisasi harga, dan memperbarui snapshot harga di **Google Sheets**. Receiver tidak mengerjakan perhitungan crafting.

```text
Albion Online (market dibuka manual)
    -> collector lokal (Mac M1; kompatibilitas perlu diuji)
    -> endpoint receiver pribadi
    -> validasi + normalisasi + deduplikasi
    -> Google Sheets (harga terkini)
    -> endpoint baca harga (read-only untuk website)
```

## Langkah pertama: proof of concept collector
Sebelum membangun parser atau schema final:
1. Verifikasi collector yang dipilih dapat berjalan dan menangkap data market pada **Mac M1**.
2. Cek format event/payload asli, item ID, city, quality, sisi BUY/SELL, dan timestamp yang tersedia.
3. Pastikan konfigurasi benar-benar **private-only**: tidak ada pengiriman paralel ke endpoint komunitas.
4. Buktikan satu scan dapat diterima receiver dalam bentuk yang bisa dinormalisasi.

Jangan menganggap dukungan Mac M1 atau format event AODP sudah terbukti sebelum PoC.

## Penyimpanan harga: Google Sheets
Tabel terstruktur **`Market Prices`** sudah dibuat (schema akan divalidasi ulang sesudah PoC). **Satu baris per** `(server, item_id, city, quality)`.

| Kolom | Makna |
| --- | --- |
| `server` | Server Albion, untuk proyek ini **East/Asia** |
| `item_id` | ID item kanonis dari game |
| `city` | Kota asal observasi |
| `quality` | Kualitas yang dilaporkan event, bila relevan |
| `highest_buy_price` | Harga buy order tertinggi terakhir yang diketahui |
| `highest_buy_observed_at` | Waktu observasi harga BUY |
| `lowest_sell_price` | Harga sell order terendah terakhir yang diketahui |
| `lowest_sell_observed_at` | Waktu observasi harga SELL |
| `last_ingested_at` | Waktu receiver menerima/memproses update |

**Penting:**
- Timestamp BUY dan SELL **terpisah**. Bila scan hanya memuat salah satunya, jangan hapus nilai sisi lain.
- Update yang lebih tua **tidak boleh menimpa** observasi yang lebih baru.
- Harga kosong disimpan sebagai *unknown*, **bukan 0 silver**.
- `item_id` tidak dibatasi Ore/Hide/Fiber; Wood, Stone, refined item, artifact, dan item lain dapat ditambahkan saat teramati.
- Google Sheets menyimpan **snapshot harga terbaru** per kunci, bukan menambah baris sejarah tanpa batas pada setiap event.
- Lima Royal City menjadi pilihan pembelian pada calculator; receiver boleh mencatat kota lain apabila event valid.
- Workbook master yang baru ini terpisah dari spreadsheet BO lama. Jangan mencampurkan atau memigrasikan data komunitas lama ke workbook ini.

## API dan keamanan
- Endpoint **ingest** hanya menerima event dari collector yang diizinkan (autentikasi/token + validasi payload).
- Endpoint **read-only** hanya mengembalikan data harga yang diperlukan web, tidak mengekspos akses tulis maupun tab pribadi seperti `Catatan BO`.
- Simpan token dan kredensial di konfigurasi rahasia, **bukan** di GitHub.
- Gunakan batch update, deduplikasi, dan retry terbatas agar kuota Google Sheets/Apps Script efisien.
- Target deployment serverless/free tier; **tanpa VPS permanen** untuk MVP.

Pilihan implementasi (Apps Script / Cloudflare Worker + akses Sheets) diputuskan setelah PoC payload dan akses Google Sheets. Jangan mengunci teknologi sebelum itu.

## Selesai jika
- Market yang dibuka manual menghasilkan event ke endpoint **pribadi saja**.
- Event valid memperbarui baris harga yang tepat di Sheets.
- Observasi lama/duplikat tidak merusak snapshot terbaru.
- Website dapat membaca harga beserta timestamp; harga yang belum pernah discan tetap kosong.
- Tidak ada pemanggilan AODP Community API atau kontribusi ke komunitas.

## Workbook tujuan yang sudah dibuat (28 Oktober 2026)

Google Sheets proyek sekarang memiliki tab **`README`**, **`Items`**, **`Craft Recipes`**, **`Refining Recipes`**, dan **`Market Prices`**. Master item dan resep telah disiapkan; **belum ada satu pun harga market yang dimasukkan**. Workbook ini terpisah dari spreadsheet BO lama yang pernah digunakan.

**Kontrak tab `Market Prices` (header aktual; row 1):**

```text
server | item_id | city | quality | highest_buy_price | highest_buy_observed_at |
lowest_sell_price | lowest_sell_observed_at | last_ingested_at | source
```

- Upsert berdasarkan `(server, item_id, city, quality)`, khususnya server **East/Asia**.
- `highest_buy_observed_at` dan `lowest_sell_observed_at` independen; data lebih tua tidak menimpa data lebih baru.
- `source` harus menyatakan pengamatan **local collector**. Jangan melakukan fallback ke API komunitas.
- Harga dan timestamp yang belum ada tetap **kosong/null**, jangan diisi angka nol atau data dummy.
- Sheet akses ditangani dengan secret konfigurasi, **bukan URL publik/ID spreadsheet yang di-hardcode dalam repo**.
- Sinkronisasi data komunitas pada workbook lama tidak boleh disambungkan ke target baru ini.

Skema receiver final dan metode ingest menunggu **PoC packet collector Mac M1** agar sesuai format event yang nyata.

**Sumber harga tetap private-only:** tidak mengambil harga dari API komunitas dan tidak mengunggah hasil scan pribadi ke komunitas. Sheet harga masih kosong hingga receiver diimplementasikan.

## Ekosistem repositori

| Repositori | Tanggung jawab |
| --- | --- |
| [albion-item-catalog](https://github.com/albion-market-lab/albion-item-catalog) | Master data item dan resep crafting/refining |
| [albion-market-receiver](https://github.com/albion-market-lab/albion-market-receiver) | Menerima scan market pribadi dan menyimpan harga ke Google Sheets |
| [albion-crafting-calculator](https://github.com/albion-market-lab/albion-crafting-calculator) | Menghitung kebutuhan bahan, estimasi modal, dan rekomendasi kota BO |
| [albion-crafting-web](https://github.com/albion-market-lab/albion-crafting-web) | Antarmuka untuk merencanakan banyak target crafting |

**Alur:** Albion Online → collector lokal → receiver → Google Sheets → web UI + calculator. Katalog resep berasal dari data game, **bukan** dari Google Sheets.

## Di luar scope
Katalog resep, algoritma crafting, rekomendasi kota BO, dan UI simulasi.
