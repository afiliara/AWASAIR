// Salin file ini menjadi secrets.h lalu isi. secrets.h tidak ikut ke git (.gitignore).
#pragma once

// --- WiFi ---
#define WIFI_SSID      "NamaWiFi"
#define WIFI_PASS      "PasswordWiFi"

// --- Broker MQTT (AwasLink) ---
// Pakai IP laptop/server (cek `ipconfig`), BUKAN "localhost".
#define MQTT_HOST      "192.168.1.10"
#define MQTT_PORT      1883
#define MQTT_USER      "device"
#define MQTT_PASS      "TEMPEL_AUTH_TOKEN_AWASLINK"   // AwasLink > Konsol > Info & Koneksi

