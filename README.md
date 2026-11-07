# AWASAIR

Sistem peringatan dini banjir sungai berbasis IoT. Konteks lengkap: [AWASAIR_konteks_proyek.md](AWASAIR_konteks_proyek.md).

## Struktur
```
docs/mqtt-contract.md   Kontrak MQTT (sumber kebenaran firmware, backend, dashboard)
backend/                Node.js: subscriber MQTT, SQLite, REST API, melayani dashboard
  scripts/dev-broker.js   Broker lokal untuk pengembangan (pengganti Mosquitto)
  scripts/simulator.js    Peniru ESP32
frontend/               Dashboard (HTML/JS, MQTT over WebSocket, Chart.js)
firmware/               (belum dibuat) ESP32
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
- Firmware ESP32 (`firmware/`)
- Mosquitto + TLS + ACL untuk produksi (broker dev tidak punya autentikasi)
- Notifikasi HP (`backend/src/notifier.js` masih stub)
- Kalibrasi tinggi pasang, ambang, dan ADC hujan di lokasi
