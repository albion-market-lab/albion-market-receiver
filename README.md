# Albion Market Receiver

> Jalur **privat** pengumpulan data harga Albion Online untuk **Albion Market Lab**. Status: **PoC collector Mac M1 private-only tervalidasi**.

**Hanya menggunakan scan pribadi.** Tidak mengambil harga dari AODP Community API, dan tidak mengirim hasil scan ke server komunitas.

## Tujuan
Menerima event market dari collector yang berjalan secara lokal saat pemain membuka market, menormalisasi harga, dan memperbarui snapshot harga di **Google Sheets**. Receiver tidak mengerjakan perhitungan crafting.

```text
Albion Online (market dibuka manual)
    -> collector lokal (Mac M1 melalui Rosetta; tervalidasi)
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

Listener PoC dapat dibangun dan dijalankan dengan:

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm build
corepack pnpm start:poc
```

Instruksi collector Mac M1, konfigurasi private-only, hasil capture nyata, dan mapping payload tersedia di [`docs/mac-m1-poc.md`](docs/mac-m1-poc.md).

Implementasi Task 08 untuk direct collector ingest melalui Vercel Hobby dan idempotent Apps Script `Market Prices` upsert dijelaskan di [`docs/task-08-secure-ingest.md`](docs/task-08-secure-ingest.md). Deployment dan gameplay live telah diverifikasi; secret tetap tidak disimpan di repository.

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
- Endpoint collector `POST /marketorders.ingest` tidak memakai autentikasi pada MVP karena client upstream tidak dapat menambahkan header; endpoint tetap membatasi ukuran dan memvalidasi payload secara ketat.
- Jalur Vercel ke Apps Script memakai shared secret dari Vercel Environment Variables dan Apps Script Properties agar akses tulis Sheet tidak terekspos.
- Endpoint **read-only** hanya mengembalikan data dari `Market Prices`, tidak mengekspos akses tulis maupun tab master/private.
- Simpan token dan kredensial di konfigurasi rahasia, **bukan** di GitHub.
- Gunakan batch update, deduplikasi, dan retry terbatas agar kuota Google Sheets/Apps Script efisien.
- Target deployment serverless/free tier; **tanpa VPS permanen** untuk MVP.

## Read-only price API

`GET /prices` mengembalikan snapshot yang cocok dengan kontrak `MarketPrice` calculator. `server` opsional dan default ke `East/Asia`; filter `itemIds` opsional, comma-separated atau berulang, maksimum 100 ID.

```bash
curl -G 'https://<VERCEL_DOMAIN>/prices' \
  --data-urlencode 'server=East/Asia' \
  --data-urlencode 'itemIds=T5_FIBER,T4_FIBER'
```

Mock response:

```json
{
  "server": "East/Asia",
  "items": [{
    "server": "East/Asia",
    "itemId": "T5_FIBER",
    "city": "Martlock",
    "quality": 1,
    "highestBuyPrice": 372,
    "highestBuyObservedAt": "2026-10-28T15:18:17.108Z",
    "lowestSellPrice": null,
    "lowestSellObservedAt": null
  }]
}
```

Hanya baris yang tersedia dikembalikan. Dataset atau filter tanpa hasil menghasilkan `200 {"server":"East/Asia","items":[]}`; harga yang belum ada tetap `null`, bukan nol. Input tidak valid menghasilkan 400, origin yang tidak diizinkan 403, method selain GET/OPTIONS 405, konfigurasi tidak lengkap 503, dan kegagalan Apps Script 502.

Environment Vercel:

| Variable | Nilai |
| --- | --- |
| `APPS_SCRIPT_URL` | URL `/exec` deployment Apps Script; server-only |
| `APPS_SCRIPT_SECRET` | Sama dengan Script Property `INGEST_SECRET`; server-only |
| `WEB_ORIGIN` | Origin web yang diizinkan CORS, contoh `https://example.vercel.app` |
| `PRICE_CACHE_TTL_SECONDS` | TTL CDN 1–300 detik; default 60 |

Apps Script menerima read action melalui POST ber-secret dari Vercel, tetapi endpoint browser tetap GET-only dan tidak pernah mengembalikan URL atau secret tersebut. Respons sukses di-cache singkat oleh Vercel CDN; timestamp observasi di body tidak diubah.

Deployment Task 09 memerlukan versi baru Apps Script, penambahan `WEB_ORIGIN` dan opsional `PRICE_CACHE_TTL_SECONDS` di Vercel, lalu deployment production Vercel baru. Smoke test endpoint dengan `curl`, kemudian uji dari origin web yang dikonfigurasi. Jangan memasukkan nilai secret ke repository atau bundle browser.

Production verification pada 29 Oktober 2026 berhasil untuk `https://albion-market-receiver.vercel.app/prices`: filtered GET mengembalikan snapshot nyata dengan HTTP 200, POST ditolak 405, origin lain ditolak 403, dan request GET kedua menghasilkan Vercel cache hit.

> **Audit note — website production verified (29 Oktober 2026):** `WEB_ORIGIN` menggunakan `https://albion-crafting-web.vercel.app`. Receiver telah dideploy ulang; request dari origin tersebut mendapat HTTP 200 dan header CORS yang sesuai, sedangkan origin localhost lama ditolak HTTP 403.

## Selesai jika
- Market yang dibuka manual menghasilkan event ke endpoint **pribadi saja**.
- Event valid memperbarui baris harga yang tepat di Sheets.
- Observasi lama/duplikat tidak merusak snapshot terbaru.
- Website dapat membaca harga beserta timestamp; harga yang belum pernah discan tetap kosong.
- Tidak ada pemanggilan AODP Community API atau kontribusi ke komunitas.

## Workbook tujuan yang sudah dibuat (28 Oktober 2026)

Google Sheets proyek sekarang memiliki tab **`README`**, **`Items`**, **`Craft Recipes`**, **`Refining Recipes`**, dan **`Market Prices`**. Master item dan resep telah disiapkan, dan harga market hasil collector lokal telah berhasil masuk. Workbook ini terpisah dari spreadsheet BO lama yang pernah digunakan.

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

Skema receiver dan metode ingest telah divalidasi terhadap event collector Mac M1 yang nyata.

**Sumber harga tetap private-only:** tidak mengambil harga dari API komunitas dan tidak mengunggah hasil scan pribadi ke komunitas.

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
