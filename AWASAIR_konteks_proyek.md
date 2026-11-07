# AWASAIR: Konteks Proyek (Hardware dan Software)

Dokumen ini merangkum konteks proyek AWASAIR agar bisa dipakai sebagai acuan tim atau sebagai konteks awal saat meminta bantuan (coding, laporan, presentasi).

## 1. Ringkasan Proyek

| Item | Isi |
|---|---|
| Nama proyek | AWASAIR |
| Mata kuliah | Teknologi IoT (Informatika, FTIS, Universitas Sebelas Maret) |
| Dosen pengampu | Abdul Aziz S.KOM., M.CS. |
| Tema | Smart Home / Mitigasi Bencana Lingkungan (Flood and Water Overflow Early Warning) |
| Jenis | Prototipe sistem IoT peringatan dini banjir sungai |
| Anggota | Aditya Hastungkara (L0123007), Afilia Rahmadani (L0123009), Aiko Nayla Putri (L0123012), Alya Dliya Zhafirah (L0123017), Andhika Alvin Adhzikra (L0123019) |

**Masalah.** Kenaikan muka air sungai saat hujan deras dapat meluap ke permukiman. Pemantauan manual membuat warga tidak tahu perubahan ketinggian air secara real-time.

**Solusi.** Perangkat di tepi sungai mengukur ketinggian muka air dan kondisi hujan, menentukan status (Normal, Siaga, Bahaya), membunyikan peringatan lokal, lalu mengirim data lewat MQTT agar warga bisa memantau dan menerima peringatan dari jarak jauh.

## 2. Arsitektur Sistem

```
[HC-SR04] [Rain sensor]
      \       /
        [ESP32] ---> [LCD I2C] + [Buzzer]   (output lokal)
           |
         WiFi
           |
   Router / Access Point   (gateway)
           |
        Internet
           |
    Broker MQTT (cloud)
        /        \
 Dashboard web   HP (web app / bot / push)
   (laptop)
```

| Lapisan | Komponen |
|---|---|
| IoT Devices | HC-SR04, rain sensor, ESP32, LCD, buzzer |
| Gateway | WiFi router / access point (ESP32 sebagai WiFi client) |
| Network | Internet (TCP/IP) |
| Cloud | Broker MQTT (HiveMQ Cloud / EMQX / Mosquitto) |
| User Interface | Dashboard web di laptop, web/mobile di HP |

Topologi jaringan: **star** dengan broker MQTT di pusat. ESP32 sebagai publisher data dan subscriber perintah. Dashboard dan HP sebagai subscriber data dan publisher perintah.

## 3. Hardware

### 3.1 Daftar Komponen

| Komponen | Spesifikasi kunci | Peran |
|---|---|---|
| ESP32 DevKit | Dual-core, WiFi + Bluetooth, logika 3,3 V, ADC 12 bit (0 sampai 4095) | Mikrokontroler dan klien MQTT |
| HC-SR04 | 5 V, jangkauan sekitar 2 sampai 400 cm, resolusi sekitar 0,3 cm | Mengukur jarak ke permukaan air |
| Rain sensor (FC-37 / YL-83) | Output analog (AO) dan digital (DO), 3,3 sampai 5 V | Mendeteksi kondisi hujan |
| LCD I2C 16x2 | Alamat umum 0x27, pin VCC, GND, SDA, SCL | Menampilkan status di lokasi |
| Buzzer aktif | Dikendalikan satu pin GPIO | Peringatan suara lokal |
| Catu daya | USB 5 V atau power bank | Sumber daya |

### 3.2 Pemetaan Pin

| Komponen | Pin komponen | Pin ESP32 | Catatan |
|---|---|---|---|
| HC-SR04 | VCC | VIN (5 V) | |
| HC-SR04 | GND | GND | |
| HC-SR04 | Trig | GPIO 5 | |
| HC-SR04 | Echo | GPIO 18 | Wajib pembagi tegangan (misal 1 kOhm + 2 kOhm), Echo mengeluarkan 5 V |
| Rain sensor | VCC | 3V3 | |
| Rain sensor | GND | GND | |
| Rain sensor | AO | GPIO 34 | Pin ADC1 (aman saat WiFi aktif) |
| LCD I2C | VCC | VIN (5 V) | |
| LCD I2C | GND | GND | |
| LCD I2C | SDA | GPIO 21 | |
| LCD I2C | SCL | GPIO 22 | |
| Buzzer | (+) | GPIO 23 | |
| Buzzer | (-) | GND | |

### 3.3 Catatan Hardware Penting

- **Pembagi tegangan di Echo.** GPIO ESP32 hanya toleran 3,3 V, sedangkan Echo HC-SR04 mengeluarkan 5 V.
- **ADC1 untuk rain sensor.** ADC2 (sebagian besar pin) tidak bisa dipakai saat WiFi aktif, jadi pakai GPIO 32 sampai 39.
- **HC-SR04 tidak tahan air.** Pasang di atas permukaan air (jembatan atau tiang), dalam casing pelindung dari percikan dan hujan, menghadap lurus ke bawah.
- **Rain sensor** diletakkan miring agar air tidak menggenang, dan jalur sensor bisa korosi bila selalu basah.
- **Kalibrasi tinggi pemasangan.** Ukur jarak sensor ke dasar atau titik nol sungai untuk menentukan `TINGGI_PASANG`.

## 4. Software

### 4.1 Komponen Software

| Komponen | Kegunaan |
|---|---|
| Arduino IDE / PlatformIO | Pemrograman dan upload firmware ESP32 |
| Library `WiFi` | Koneksi WiFi |
| Library `PubSubClient` | Klien MQTT |
| Library `LiquidCrystal_I2C` | Kontrol LCD I2C |
| Broker MQTT | HiveMQ Cloud, EMQX, atau Mosquitto |
| Dashboard web | HTML/JS dengan MQTT over WebSocket, atau Node-RED |
| Notifikasi HP | **Belum diputuskan** (lihat bagian 7) |

### 4.2 Logika Pengukuran

```
ketinggian_air = TINGGI_PASANG - jarak_terbaca
jarak (cm)     = (waktu_echo_us x 0,0343) / 2
```

### 4.3 Logika Status (rule-based threshold)

Ambang batas bersifat contoh, sesuaikan dengan lokasi.

| Status | Ketinggian air | Buzzer |
|---|---|---|
| Normal | kurang dari 200 cm | Mati |
| Siaga | 200 cm sampai kurang dari 240 cm | Putus-putus |
| Bahaya | 240 cm atau lebih | Kontinu |

**Kondisi hujan** (dari nilai ADC rain sensor) dipakai sebagai indikator tambahan. Pada kebanyakan modul nilai ADC **makin kecil saat makin basah**. Contoh kategori (wajib dikalibrasi):

| Kategori | Nilai ADC (contoh) |
|---|---|
| Kering | sekitar 4000 ke atas |
| Ringan | sekitar 2500 sampai 4000 |
| Sedang | sekitar 1500 sampai 2500 |
| Lebat | di bawah sekitar 1500 |

Contoh pemakaian: bila air mendekati ambang Siaga dan hujan lebat, dashboard menampilkan peringatan kewaspadaan.

### 4.4 Alur Firmware (satu siklus)

1. Inisialisasi sensor, LCD, WiFi, dan MQTT.
2. Baca HC-SR04 dan rain sensor.
3. Hitung ketinggian air dan kategori hujan.
4. Tentukan status (Normal, Siaga, Bahaya).
5. Atur buzzer sesuai status.
6. Tampilkan data di LCD.
7. Publish data ke broker MQTT.
8. Tunggu interval 5 sampai 10 detik, ulangi dari langkah 2.

Kerangka kode (ringkas, bukan final):

```cpp
#include <WiFi.h>
#include <PubSubClient.h>
#include <LiquidCrystal_I2C.h>

const int TRIG = 5, ECHO = 18, RAIN = 34, BUZZER = 23;
const float TINGGI_PASANG = 300.0;   // cm, sesuaikan
const float AMBANG_SIAGA = 200.0;    // cm
const float AMBANG_BAHAYA = 240.0;   // cm

LiquidCrystal_I2C lcd(0x27, 16, 2);
WiFiClient wifi;
PubSubClient mqtt(wifi);

float bacaJarakCm() {
  digitalWrite(TRIG, LOW);  delayMicroseconds(2);
  digitalWrite(TRIG, HIGH); delayMicroseconds(10);
  digitalWrite(TRIG, LOW);
  long us = pulseIn(ECHO, HIGH, 30000);
  return us * 0.0343 / 2.0;
}

void loop() {
  float jarak = bacaJarakCm();
  float level = TINGGI_PASANG - jarak;
  int adc = analogRead(RAIN);

  const char* status = level >= AMBANG_BAHAYA ? "BAHAYA"
                     : level >= AMBANG_SIAGA  ? "SIAGA" : "NORMAL";
  // atur buzzer, tampilkan LCD, publish JSON ke MQTT, delay interval
}
```

Saran: gunakan rata-rata atau median beberapa pembacaan HC-SR04 untuk meredam noise, dan tambahkan histeresis kecil pada ambang agar status tidak berkedip.

### 4.5 Komunikasi MQTT

| Parameter | Nilai |
|---|---|
| Port | 1883 (tanpa enkripsi) atau 8883 (TLS) |
| QoS | 1 untuk status dan perintah, 0 untuk data periodik |
| Format payload | JSON |
| Interval publish | 5 sampai 10 detik |

| Topic | Arah | Isi |
|---|---|---|
| `awasair/sungai/level` | ESP32 ke broker | Ketinggian air (cm) |
| `awasair/sungai/hujan` | ESP32 ke broker | Kategori hujan / nilai ADC |
| `awasair/sungai/status` | ESP32 ke broker | Normal / Siaga / Bahaya |
| `awasair/sungai/cmd` | Dashboard ke ESP32 | Perintah (mute buzzer, ubah ambang) |

Contoh payload gabungan:

```json
{"level":245,"hujan":"ringan","status":"BAHAYA"}
```

### 4.6 Antarmuka Pengguna

| Halaman | Isi |
|---|---|
| Beranda / Dashboard | Status sungai, ketinggian air, kondisi hujan, grafik, notifikasi terbaru, lokasi sensor |
| Grafik | Riwayat ketinggian air dan hujan |
| Notifikasi | Daftar peringatan dan perubahan status |
| Pengaturan | Ambang batas Siaga dan Bahaya, kontrol buzzer |

Perubahan di Pengaturan dikirim ke ESP32 lewat topic `awasair/sungai/cmd`. Kondisi hujan ditampilkan sebagai kategori (Ringan, Sedang, Lebat), bukan mm/jam.

## 5. Referensi Penelitian Terkait

- Budioko (2022): node sensor pemantau tinggi air sungai, FreeRTOS dan MQTT.
- Eka Febri Anggara dkk. (2024): monitor ketinggian air, ESP32 dan Blynk.
- Irawan dkk. (2026): MQTT berbasis WiFi untuk monitoring tinggi muka air laut, ESP32.
- Nauli dkk. (2025): alat pendeteksi ketinggian air sungai berbasis IoT.
- Wandi dan Ashari (2023): monitoring ketinggian air dan curah hujan untuk early warning banjir.
- Wicaksana dkk. (2026): metode rule-based untuk penentuan status pada early warning system banjir.

## 6. Status Pengerjaan Dokumen

| Bagian | Status |
|---|---|
| Bab 1 dan 2 (progres dan eksplorasi device) | Selesai |
| Bab 3 (studi literatur dan spesifikasi komponen) | Draf selesai, tabel perbandingan jurnal perlu dilengkapi dari isi jurnal |
| Bab 4 (perancangan detail) | Draf selesai, dengan diagram flowchart, arsitektur, topologi, dan wiring |
| Mockup UI HP dan laptop | Ada dari Bab 2, perlu ditempel di 4.5 |

## 7. Keputusan Terbuka dan Hal yang Perlu Diperbaiki

1. **Mekanisme notifikasi HP belum ditentukan.** Pilihan: web app yang terbuka (paling mudah, tidak masuk saat ditutup), bot Telegram (masuk saat HP terkunci, butuh program perantara seperti Node-RED), atau Firebase Cloud Messaging (paling rumit).
2. **Fitur kontrol jarak jauh** perlu dipastikan (misal mute buzzer dan ubah ambang via topic `cmd`), karena Bab 2 menyebut komunikasi dua arah.
3. **Ambang batas dan tinggi pemasangan** masih contoh, tentukan dari kondisi lokasi sebenarnya.
4. **Kalibrasi rain sensor** belum dilakukan.
5. **Broker MQTT** (HiveMQ Cloud, EMQX, atau Mosquitto) belum dipilih.
6. **Koreksi di Bab 1 dan 2:** "12C" seharusnya "I2C"; kalimat fungsi MQTT ("dari ESP32 ke cloud"); satuan hujan mm/jam pada mockup diganti kategori.
