// Konfigurasi perangkat AWASAIR. Kredensial ada di secrets.h (salin dari secrets.example.h).
// Topic, ambang, histeresis, dan kategori hujan harus sama dengan docs/mqtt-contract.md.
#pragma once

#define TOPIC_BASE "awasair/sungai"

// --- Pin (sesuai pemetaan pin proyek) ---
#define PIN_TRIG   5
#define PIN_ECHO   18   // WAJIB lewat pembagi tegangan 1k + 2k (Echo = 5 V)
#define PIN_RAIN   34   // ADC1, aman dipakai saat WiFi aktif
#define PIN_BUZZER 23
#define LCD_ADDR   0x27

// --- Kalibrasi lokasi ---
// Nilai di bawah untuk sungai. Untuk demo meja (thinwall 6 cm, sensor 15 cm di atas dasar):
//   TINGGI_PASANG 15, DEFAULT_SIAGA 3, DEFAULT_BAHAYA 5, HISTERESIS 0.5
#define TINGGI_PASANG   300.0f  // cm, jarak sensor ke titik nol/dasar sungai
#define DEFAULT_SIAGA   200.0f  // cm (bisa diubah lewat cmd)
#define DEFAULT_BAHAYA  240.0f  // cm (bisa diubah lewat cmd)
#define HISTERESIS      5.0f    // cm
#define INTERVAL_MS     5000UL  // publish `data` tiap 5 detik (kontrak: 5-10 detik)

// Kategori hujan (ADC, makin kecil makin basah). WAJIB dikalibrasi.
// Hujan lebat (ADC < ADC_SEDANG) membuat status BAHAYA walaupun air belum naik (lihat "Aturan status").
#define ADC_KERING 4000
#define ADC_RINGAN 2500
#define ADC_SEDANG 1500
#define HISTERESIS_HUJAN 100  // ADC: kategori baru membaik setelah lewat batas + 100 (anti berkedip)

// Buzzer saat hujan (1 = aktif, 0 = mati). Hujan lebat sudah termasuk BAHAYA (bunyi terus).
#define BUZZER_HUJAN_SEDANG 1   // satu bip tiap 3 detik saat status NORMAL
#define BUZZER_HUJAN_LEBAT  1   // bip-bip tiap 2 detik bila sensor air ERROR saat hujan lebat
