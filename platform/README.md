# AwasLink: Platform IoT AWASAIR (buatan sendiri)

Satu software self-hosted pengganti **Blynk + ThingSpeak**, mengikuti
[`docs/mqtt-contract.md`](../docs/mqtt-contract.md). Satu server, satu login, port web `8080` dan MQTT `1883`.

| Bagian | Alamat | Peran (setara) |
|---|---|---|
| **Dashboard warga** | `http://<ip>:8080/` | Desain UI/UX v5: status sungai, ketinggian, hujan, grafik, notifikasi, pengaturan ambang & buzzer |
| **Konsol teknisi** | `http://<ip>:8080/console/` | Blynk: perangkat & token, widget, datastream, aturan event, Telegram |
| **Data Logger** | `http://<ip>:8080/data/` | ThingSpeak: channel, Write/Read API key, riwayat, grafik per field, CSV, React, API `/update` & `/channels/...` |
| **Broker MQTT** | `mqtt://<ip>:1883`, `ws://<ip>:8080/mqtt` | Pengganti Mosquitto/HiveMQ, autentikasi token per perangkat |

```
[HC-SR04] [Rain sensor]
      \       /
        [ESP32] ──► LCD + Buzzer (logika keselamatan tetap di alat)
           │ MQTT (data, status, online, ack  ◄─ cmd)
           ▼
   ┌──────────────────────────── AwasLink ────────────────────────────┐
   │ broker MQTT ─► nilai terkini + event ─► dashboard warga / konsol │
   │             └► Data Logger (channel 1, tiap 15 detik) ─► CSV/API │
   │ notifikasi: browser, Telegram, webhook                           │
   └──────────────────────────────────────────────────────────────────┘
```

ESP32 cukup terhubung lewat MQTT. Server otomatis mencatat data ke Data Logger. Perangkat lain yang hanya bisa
HTTP tetap bisa mengirim lewat API gaya ThingSpeak (`/update?api_key=...`).

## 1. Menjalankan

Butuh **Node.js 22.13 atau lebih baru** (disarankan LTS terbaru). Database memakai SQLite bawaan Node.

**Windows:** klik dua kali `platform/start-windows.bat`.

**Manual:**

```bash
cd platform/awaslink
npm install        # sekali saja
npm start
```

Terminal menampilkan **auth token** perangkat dan **Write API key** channel #1.
Login admin default `admin` / `admin123`. Ganti lewat env atau `config.json` (salin dari `config.example.json`):

```bash
ADMIN_PASS=rahasia npm start                 # Linux/macOS
$env:ADMIN_PASS="rahasia"; npm start         # Windows PowerShell
```

| Variabel | Default | Keterangan |
|---|---|---|
| `PORT` | 8080 | Port web |
| `MQTT_PORT` | 1883 | Port broker MQTT |
| `ADMIN_USER`, `ADMIN_PASS` | admin / admin123 | Akun admin |
| `PUBLIC_VIEW` | true | Warga bisa melihat dashboard tanpa login (kontrol tetap butuh login) |
| `HISTORY_DAYS` | 30 | Lama riwayat nilai real-time disimpan |
| `RATE_LIMIT_SEC` | 5 | Jeda minimum antar `/update` HTTP per channel (ThingSpeak gratis = 15) |
| `DATA_DIR` | `./data` | Lokasi database |

**Berdampingan dengan `backend/` tim:** backend memakai port 3000, jadi tidak bentrok dengan 8080. Broker AwasLink dan
`npm run broker` sama-sama memakai port 1883, jadi jalankan salah satu saja. Backend tim bisa memakai broker AwasLink
dengan `MQTT_USERNAME=admin` dan `MQTT_PASSWORD=<password admin>`.

## 2. Demo tanpa hardware

```bash
cd platform/awaslink
npm run simulator -- --token <TOKEN_PERANGKAT>
```

Opsi: `--scenario siklus|normal|siaga|bahaya|error`, `--interval 2`. Logika status sama dengan
`backend/src/contract.js`. Simulator tim juga bisa dipakai: `MQTT_USERNAME=device MQTT_PASSWORD=<token> npm run sim`.

## 3. Menghubungkan ESP32 asli

1. Arduino IDE: board **esp32 by Espressif**, library **PubSubClient**, **LiquidCrystal I2C** (Frank de Brabander), **ArduinoJson** 7.x.
2. Di `firmware/awasair_esp32/`, salin `secrets.example.h` menjadi `secrets.h` (tidak ikut git), isi WiFi,
   `MQTT_HOST` (IP laptop server, bukan `localhost`), dan `MQTT_PASS` (auth token dari Konsol → perangkat → *Info & Koneksi*).
3. Sesuaikan `config.h`: `TINGGI_PASANG`, ambang awal, kategori ADC hujan (hasil kalibrasi).
4. Upload. Serial Monitor (115200) menampilkan pembacaan dan status MQTT.

**Windows Firewall:** izinkan Node di *Private network*, atau buka port 1883 dan 8080.

## 4. Fitur ala Blynk

| Konsep Blynk | Di AwasLink |
|---|---|
| Auth token | Token per perangkat = **password MQTT** (username bebas, mis. `device`) |
| Datastream | `level`, `jarak`, `adc`, `hujan`, `status` (in), `mute`, `siaga`, `bahaya` (out) |
| Widget | Status, Nilai, Gauge, Grafik, Switch, Slider, Tombol, Log (Konsol → **Atur widget**) |
| Sinkronisasi | Nilai *out* yang tampil = isi `ack` alat. Setelah perintah dikirim, dashboard menunggu konfirmasi |
| Events & notifications | Aturan event → riwayat, notifikasi browser + bunyi, **Telegram** |
| Online/offline | Dari koneksi MQTT dan data basi (> 30 detik = OFFLINE, tidak pernah dianggap aman) |
| HTTP API | `/external/api/update`, `/get`, `/write`, `/isHardwareConnected` |

Topic MQTT sama persis dengan kontrak (`awasair/sungai/data|status|online|cmd|ack`). Perangkat hanya boleh
publish/subscribe di bawah topic dasarnya sendiri dan tidak boleh publish ke `…/cmd`. Server menolak `siaga ≥ bahaya`.

**Notifikasi HP:** dashboard di HP → "Tambahkan ke layar utama" → menu profil → *Aktifkan notifikasi browser*
(selama halaman terbuka). Untuk notifikasi saat HP terkunci: Konsol → Pengaturan → token bot Telegram + chat ID.

## 5. Fitur ala ThingSpeak (Data Logger)

Channel #1 **AWASAIR - Sungai** terisi otomatis dari MQTT tiap 15 detik (atur di `config.datalog` perangkat):

| Field | Isi |
|---|---|
| field1 | Ketinggian air (cm) |
| field2 | Rain sensor (ADC) |
| field3 | Status (0=Normal, 1=Siaga, 2=Bahaya, -1=Error) |
| field4 | Jarak sensor (cm) |
| status | Teks status |

| Metode | Endpoint | Keterangan |
|---|---|---|
| GET/POST | `/update?api_key=W&field1=..&status=..` | Kirim data. Balasan: nomor entri, `0` bila gagal |
| POST | `/channels/:id/bulk_update.json` | Kirim banyak entri |
| GET | `/channels/:id/feeds.json?results=100` | Data. Filter: `results`, `minutes`, `days`, `start`, `end` |
| GET | `/channels/:id/feeds.csv` | Data dalam CSV |
| GET | `/channels/:id/feeds/last.json` | Entri terakhir |
| GET | `/channels/:id/fields/1.json`, `/fields/1/last.txt` | Satu field |
| GET | `/channels/:id/status.json` | Riwayat status |
| GET | `/channels/:id/stream` | Server-Sent Events (real-time) |

Channel privat butuh `api_key` (Read/Write key) atau header `X-THINGSPEAKAPIKEY`.
**React** (tab React): aksi otomatis *log*, *webhook*, atau *Telegram* saat data memenuhi kondisi.

## 6. Struktur

```
platform/
├── awaslink/
│   ├── server.js            broker MQTT + HTTP + WebSocket + SQLite
│   ├── datalog.js           Data Logger (channel, API ThingSpeak, CSV, React)
│   ├── public/              dashboard warga (desain UI/UX v5)
│   │   ├── live.css         tambahan gaya (style.css asli desainer tidak diubah)
│   │   ├── console/         konsol teknisi
│   │   └── data/            halaman Data Logger
│   └── tools/simulator.js   simulator ESP32 sesuai kontrak
├── start-windows.bat
└── start.sh
```

Data tersimpan di `awaslink/data/` (tidak ikut git). Hapus folder itu untuk reset (token & key dibuat ulang).

## 7. Troubleshooting

| Gejala | Penyebab umum |
|---|---|
| Serial: `rc=5` | Token salah atau sudah dibuat ulang |
| Serial: `rc=-2` | IP/port salah, firewall memblokir, atau beda jaringan |
| Dashboard "Menunggu" terus setelah ubah ambang | Alat offline atau tidak mengirim `ack` |
| Status abu-abu "OFFLINE" | Tidak ada data lebih dari 30 detik (sengaja tidak ditampilkan sebagai aman) |
| `/update` membalas `0` | Write key salah, atau kirim lebih cepat dari `RATE_LIMIT_SEC` |
| Ketinggian `---` / status ERROR | HC-SR04 tidak membaca: cek kabel, pembagi tegangan Echo, jarak < 2 cm |
| `node:sqlite` tidak ditemukan | Versi Node terlalu lama, perbarui ke ≥ 22.13 |
