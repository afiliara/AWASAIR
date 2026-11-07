# Platform IoT AWASAIR (buatan sendiri)

Dua platform self-hosted pengganti layanan pihak ketiga, semuanya mengikuti
[`docs/mqtt-contract.md`](../docs/mqtt-contract.md):

| Software | Meniru | Fungsi utama | Port default |
|---|---|---|---|
| **AwasLink** (`awaslink/`) | Blynk | Broker MQTT bawaan dengan token per perangkat, dashboard warga (desain UI/UX v5) yang real-time, kontrol dua arah (`cmd` → `ack`), event + notifikasi (browser & Telegram), konsol widget untuk teknisi, HTTP API | Web `8080`, MQTT `1883` |
| **AwasSpeak** (`awasspeak/`) | ThingSpeak | Channel 8 field, Write/Read API key, penyimpanan data (SQLite), grafik riwayat, ekspor/impor CSV, React (aksi otomatis: webhook/Telegram), API kompatibel ThingSpeak | Web `3001` |

Firmware ESP32 ada di [`../firmware/awasair_esp32/`](../firmware/awasair_esp32/): MQTT ke AwasLink sesuai kontrak,
dan opsional HTTP ke AwasSpeak.

```
[HC-SR04] [Rain sensor]
      \       /
        [ESP32] ──► LCD + Buzzer (logika keselamatan tetap di alat)
        │     │
 MQTT 1883  HTTP /update (opsional)
        │     │
        ▼     ▼
  ┌──────────┐  ┌───────────┐
  │ AwasLink │  │ AwasSpeak │
  │ (Blynk)  │  │(ThingSpeak)│
  └────┬─────┘  └─────┬─────┘
   WebSocket      HTTP/SSE
       ▼              ▼
 Dashboard warga   Grafik riwayat, CSV
 (HP & laptop)     + React (webhook/Telegram)
 + Telegram
```

## 1. Kebutuhan

- **Node.js 22.13 atau lebih baru** (disarankan LTS terbaru). Keduanya memakai SQLite bawaan Node (`node:sqlite`).
- AwasSpeak **tanpa dependensi**. AwasLink butuh `npm install` (aedes, ws, mqtt).

## 2. Menjalankan

**Windows:** klik dua kali `platform/start-windows.bat`.

**Manual**, dua terminal:

```bash
cd platform/awasspeak
npm start                 # http://localhost:3001

cd platform/awaslink
npm install               # sekali saja
npm start                 # http://localhost:8080, MQTT di port 1883
```

Terminal menampilkan **auth token** perangkat (AwasLink) dan **Write API key** channel (AwasSpeak).

| Alamat | Isi |
|---|---|
| `http://<ip>:8080/` | Dashboard warga (desain UI/UX v5): Beranda, Grafik, Notifikasi, Pengaturan |
| `http://<ip>:8080/console/` | Konsol AwasLink untuk teknisi: perangkat, widget, datastream, aturan event, token |
| `http://<ip>:3001/` | AwasSpeak: channel, grafik, API key, CSV, React |

Login admin default: `admin` / `admin123`. **Ganti** lewat environment variable atau `config.json`
(salin dari `config.example.json`):

```bash
ADMIN_PASS=rahasia npm start                 # Linux/macOS
$env:ADMIN_PASS="rahasia"; npm start         # Windows PowerShell
```

| Variabel | AwasSpeak | AwasLink | Keterangan |
|---|---|---|---|
| `PORT` | 3001 | 8080 | Port web |
| `MQTT_PORT` | – | 1883 | Port broker MQTT |
| `ADMIN_USER`, `ADMIN_PASS` | ✓ | ✓ | Akun admin |
| `RATE_LIMIT_SEC` | 5 | – | Jeda minimum antar update per channel (ThingSpeak gratis = 15) |
| `PUBLIC_VIEW` | – | true | Warga bisa melihat dashboard tanpa login (kontrol tetap butuh login) |
| `HISTORY_DAYS` | – | 30 | Lama riwayat disimpan |
| `DATA_DIR` | `./data` | `./data` | Lokasi database |

**Berdampingan dengan `backend/` tim:** backend memakai port 3000, AwasSpeak 3001, jadi keduanya bisa jalan bersama.
Broker AwasLink dan `npm run broker` sama-sama memakai port 1883, jadi jalankan salah satu saja. Backend tim bisa memakai
broker AwasLink dengan `MQTT_USERNAME=admin` dan `MQTT_PASSWORD=<password admin>` (akses penuh).

## 3. Demo tanpa hardware

```bash
cd platform/awaslink
npm run simulator -- --token <TOKEN_AWASLINK> --speak http://localhost:3001 --speak-key <WRITE_KEY_AWASSPEAK>
```

Opsi: `--scenario siklus|normal|siaga|bahaya|error`, `--interval 2`. Simulator memakai logika status yang sama
dengan `backend/src/contract.js` (naik langsung, turun bertahap dengan histeresis 5 cm), mengirim `ack` saat start
dan setelah menerima `cmd`. Simulator milik backend (`backend/scripts/simulator.js`) juga bisa dipakai:
`MQTT_USERNAME=device MQTT_PASSWORD=<token> npm run sim`.

## 4. Menghubungkan ESP32 asli

1. Arduino IDE: board **esp32 by Espressif**, library **PubSubClient**, **LiquidCrystal I2C** (Frank de Brabander), **ArduinoJson** 7.x.
2. Di `firmware/awasair_esp32/`, salin `secrets.example.h` menjadi `secrets.h` (tidak ikut git), lalu isi:
   - `WIFI_SSID`, `WIFI_PASS`
   - `MQTT_HOST` dan `AWASSPEAK_URL`: **IP laptop** server (cek `ipconfig`), bukan `localhost`, dan harus satu jaringan.
   - `MQTT_PASS`: auth token dari konsol AwasLink → perangkat → *Info & Koneksi*.
   - `AWASSPEAK_WRITE_KEY`: dari AwasSpeak → channel → *API Keys* (atau `ENABLE_AWASSPEAK 0`).
3. Sesuaikan `config.h`: `TINGGI_PASANG`, ambang awal, kategori ADC hujan (hasil kalibrasi).
4. Upload. Serial Monitor (115200) menampilkan pembacaan, status MQTT, dan balasan AwasSpeak.

Firmware sudah diuji kompilasi untuk `esp32:esp32:esp32` (sekitar 81% flash).

**Windows Firewall:** izinkan Node di *Private network*, atau buka port 1883, 8080, dan 3001.

## 5. AwasLink (mirip Blynk)

| Konsep Blynk | Di AwasLink |
|---|---|
| Auth token | Token per perangkat, dipakai sebagai **password MQTT** (username bebas, mis. `device`) |
| Virtual pin / datastream | **Datastream**: `level`, `jarak`, `adc`, `hujan`, `status` (arah *in*), `mute`, `siaga`, `bahaya` (arah *out*) |
| Widget | Status, Nilai, Gauge, Grafik, Switch, Slider, Tombol, Log. Diatur di konsol lewat **Atur widget** |
| Sinkronisasi nilai | Nilai *out* yang tampil diambil dari `ack` alat. Saat perintah dikirim, dashboard menampilkan "Menunggu" sampai alat mengonfirmasi |
| Events & notifications | Aturan event per datastream → riwayat, notifikasi browser + bunyi, **Telegram** |
| Online/offline | Dari koneksi MQTT dan data basi (> 30 detik tanpa data = OFFLINE, tidak pernah dianggap aman) |
| HTTP API | `/external/api/update`, `/get`, `/write`, `/isHardwareConnected` |

Topic yang dipakai sama persis dengan kontrak:

| Topic | Arah | Contoh |
|---|---|---|
| `awasair/sungai/data` | ESP32 → server | `{"level":245.3,"jarak":54.7,"adc":1800,"hujan":"sedang","status":"BAHAYA"}` |
| `awasair/sungai/status` | ESP32 → server | `BAHAYA` (retained) |
| `awasair/sungai/online` | ESP32 → server | `online` / `offline` (LWT, retained) |
| `awasair/sungai/cmd` | server → ESP32 | `{"mute":true}` / `{"siaga":200,"bahaya":240}` |
| `awasair/sungai/ack` | ESP32 → server | `{"mute":false,"siaga":200,"bahaya":240}` (retained) |

Keamanan broker: perangkat hanya boleh publish/subscribe di bawah topic dasarnya sendiri dan tidak boleh publish ke `…/cmd`.
Server menolak `siaga ≥ bahaya` sebelum mengirim `cmd`, dan alat juga memvalidasi ulang.

**Notifikasi HP (keputusan terbuka no. 1):**
- *Web app*: buka dashboard di HP → "Tambahkan ke layar utama" → menu profil → **Aktifkan notifikasi browser** (muncul selama halaman terbuka).
- *Telegram* (tetap masuk walau HP terkunci): konsol → Pengaturan → isi token bot (@BotFather) dan chat ID (bisa grup warga) → **Kirim pesan tes**.

## 6. AwasSpeak (mirip ThingSpeak)

Channel bawaan **AWASAIR - Sungai** (publik):

| Field | Isi |
|---|---|
| field1 | Ketinggian air (cm) |
| field2 | Rain sensor (ADC) |
| field3 | Status (0=Normal, 1=Siaga, 2=Bahaya, -1=Error) |
| field4 | Jarak sensor (cm) |
| status | Teks status (`NORMAL`/`SIAGA`/`BAHAYA`/`ERROR`) |

| Metode | Endpoint | Keterangan |
|---|---|---|
| GET/POST | `/update?api_key=W&field1=..&status=..` | Kirim data. Balasan: nomor entri, `0` bila gagal |
| GET/POST | `/update.json` | Sama, balasan JSON |
| POST | `/channels/:id/bulk_update.json` | Kirim banyak entri sekaligus |
| GET | `/channels/:id/feeds.json?results=100` | Data. Filter: `results`, `minutes`, `days`, `start`, `end` |
| GET | `/channels/:id/feeds.csv` | Data dalam CSV |
| GET | `/channels/:id/feeds/last.json` | Entri terakhir |
| GET | `/channels/:id/fields/1.json` | Data satu field |
| GET | `/channels/:id/fields/1/last.txt` | Nilai terakhir satu field |
| GET | `/channels/:id/status.json` | Riwayat status |
| GET | `/channels/:id/stream` | Server-Sent Events (real-time) |

Channel privat butuh `api_key` (Read/Write key) atau header `X-THINGSPEAKAPIKEY`.
**React** (tab React): contoh bawaan "Air masuk status BAHAYA" (`field3 >= 2`), aksi *log*, *webhook*, atau *Telegram*.

## 7. Struktur

```
platform/
├── awaslink/
│   ├── server.js            broker MQTT + HTTP + WebSocket + SQLite
│   ├── public/              dashboard warga (desain UI/UX v5, tersambung ke data asli)
│   │   ├── live.css         tambahan gaya (style.css asli desainer tidak diubah)
│   │   └── console/         konsol teknisi (widget, datastream, event, token)
│   └── tools/simulator.js   simulator ESP32 sesuai kontrak
├── awasspeak/
│   ├── server.js            HTTP API + SQLite, tanpa dependensi
│   └── public/
├── start-windows.bat
└── start.sh
```

Data tersimpan di `awaslink/data/` dan `awasspeak/data/` (tidak ikut git). Hapus folder `data/` untuk reset
(token dan key dibuat ulang).

## 8. Troubleshooting

| Gejala | Penyebab umum |
|---|---|
| Serial: `rc=5` | Token AwasLink salah atau sudah dibuat ulang |
| Serial: `rc=-2` | IP/port salah, firewall memblokir, atau beda jaringan |
| Dashboard "Menunggu" terus setelah ubah ambang | Alat offline atau tidak mengirim `ack` |
| Status abu-abu "OFFLINE" | Tidak ada data lebih dari 30 detik (sengaja tidak ditampilkan sebagai aman) |
| AwasSpeak membalas `0` | Write key salah, atau kirim lebih cepat dari `RATE_LIMIT_SEC` |
| Ketinggian `---` / status ERROR | HC-SR04 tidak membaca: cek kabel, pembagi tegangan Echo, jarak < 2 cm |
| `node:sqlite` tidak ditemukan | Versi Node terlalu lama, perbarui ke ≥ 22.13 |
