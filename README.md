# AWASAIR

Sistem peringatan dini banjir sungai berbasis IoT. Konteks lengkap: [AWASAIR_konteks_proyek.md](AWASAIR_konteks_proyek.md).

## Struktur
```
docs/mqtt-contract.md   Kontrak MQTT (sumber kebenaran firmware, backend, dashboard)
backend/                Node.js: subscriber MQTT, SQLite, REST API, melayani dashboard
  scripts/dev-broker.js   Broker lokal untuk pengembangan (pengganti Mosquitto)
  scripts/simulator.js    Peniru ESP32
frontend/               Dashboard (HTML/JS, MQTT over WebSocket, Chart.js)
firmware/awasair_esp32/ Firmware ESP32 (sesuai kontrak MQTT v1)
platform/               Platform IoT buatan sendiri, lihat platform/README.md
  awaslink/               Mirip Blynk: broker MQTT + dashboard real-time (desain UI v5) + kontrol + notifikasi
  awasspeak/              Mirip ThingSpeak: channel, API key, riwayat, grafik, ekspor CSV
```

## Menjalankan (tanpa hardware)
Butuh Node 22.5 atau lebih baru. Buka tiga terminal:

```bash
cd backend
npm install        # sekali saja

npm run broker     # 1. broker: mqtt://localhost:1883, ws://localhost:9001
npm start          # 2. backend + dashboard: http://localhost:3000
npm run sim        # 3. simulator ESP32
```
Buka http://localhost:3000.

Simulator: `npm run sim -- --scenario=normal|siaga|bahaya|error|siklus --interval=2`

Tes logika: `npm test`

Platform AwasLink dan AwasSpeak dijalankan terpisah, lihat [platform/README.md](platform/README.md).

## Alur data
```
ESP32/simulator → broker ─┬→ backend → SQLite → /api/readings, /api/events, /api/state
                          └→ dashboard (WebSocket, live)
dashboard → cmd → broker → ESP32 → ack → dashboard   (nilai tampil = yang berlaku di alat)
```

## Aturan yang dijaga
- Data hilang, basi, offline, atau ERROR tidak pernah tampil sebagai "aman".
- Perubahan pengaturan baru dianggap berlaku setelah perangkat mengirim `ack`.
- Logika status (ambang, histeresis 5 cm) ada di `backend/src/contract.js` dan harus sama dengan firmware.

## Belum dikerjakan
- Mosquitto + TLS + ACL untuk produksi (broker dev tidak punya autentikasi; broker AwasLink memakai token per perangkat)
- Notifikasi HP di `backend/src/notifier.js` masih stub (AwasLink sudah punya notifikasi browser dan Telegram)
- Kalibrasi tinggi pasang, ambang, dan ADC hujan di lokasi
