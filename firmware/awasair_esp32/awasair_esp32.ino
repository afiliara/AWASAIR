/*
 * AWASAIR - Firmware ESP32
 * Peringatan dini banjir: HC-SR04 + rain sensor + LCD I2C + buzzer.
 * Komunikasi MQTT mengikuti docs/mqtt-contract.md (v1):
 *   publish  awasair/sungai/data    JSON {"level","jarak","adc","hujan","status"}  QoS0, tiap 5 detik
 *   publish  awasair/sungai/status  NORMAL|SIAGA|BAHAYA|ERROR  retained, saat berubah + sekali saat boot
 *   publish  awasair/sungai/online  online / offline (Last Will)  retained
 *   publish  awasair/sungai/ack     {"mute","siaga","bahaya"} yang BERLAKU  retained, saat boot + setelah cmd
 *   subscribe awasair/sungai/cmd    {"mute":true} / {"siaga":200,"bahaya":240}
 * Server AwasLink otomatis mencatat `data` ke Data Logger (ala ThingSpeak), jadi cukup MQTT.
 *
 * Library (Arduino IDE > Library Manager):
 *   PubSubClient (Nick O'Leary), LiquidCrystal I2C (Frank de Brabander), ArduinoJson 7.x
 * Board: "ESP32 Dev Module" (paket esp32 by Espressif)
 *
 * Langkah: salin secrets.example.h -> secrets.h, isi WiFi/token, upload.
 * Logika keselamatan (status + buzzer) berjalan di sini, tetap jalan walau WiFi/server mati.
 */
#include <WiFi.h>
#include <PubSubClient.h>
#include <LiquidCrystal_I2C.h>
#include <ArduinoJson.h>
#include <Preferences.h>
#include "config.h"
#include "secrets.h"

WiFiClient netClient;
PubSubClient mqtt(netClient);
LiquidCrystal_I2C lcd(LCD_ADDR, 16, 2);
Preferences prefs;

const char* T_DATA = TOPIC_BASE "/data";
const char* T_STATUS = TOPIC_BASE "/status";
const char* T_ONLINE = TOPIC_BASE "/online";
const char* T_CMD = TOPIC_BASE "/cmd";
const char* T_ACK = TOPIC_BASE "/ack";

// Konfigurasi yang berlaku (disimpan di flash, dilaporkan lewat `ack`)
float ambangSiaga = DEFAULT_SIAGA;
float ambangBahaya = DEFAULT_BAHAYA;
bool buzzerMute = false;

// Pengukuran terakhir
float jarakCm = NAN, levelCm = NAN;
int rainAdc = 4095;
const char* kategoriHujan = "kering";
enum Status { NORMAL = 0, SIAGA = 1, BAHAYA = 2, ERR = 3 };
Status status = NORMAL;
bool statusDikenal = false;  // false sampai pengukuran pertama
bool statusPerluKirim = true;
const char* STATUS_STR[] = {"NORMAL", "SIAGA", "BAHAYA", "ERROR"};

unsigned long tUkur = 0, tMqttRetry = 0, tWifiRetry = 0;
char clientId[32];

// ---------------------------------------------------------------- Sensor
float bacaJarakSekali() {
  digitalWrite(PIN_TRIG, LOW);  delayMicroseconds(2);
  digitalWrite(PIN_TRIG, HIGH); delayMicroseconds(10);
  digitalWrite(PIN_TRIG, LOW);
  unsigned long us = pulseIn(PIN_ECHO, HIGH, 30000);  // timeout 30 ms (~5 m)
  if (us == 0) return NAN;
  return us * 0.0343f / 2.0f;
}

// Median 5 pembacaan untuk meredam noise/pantulan liar. NAN bila semua gagal.
float bacaJarakMedian() {
  float v[5]; int n = 0;
  for (int i = 0; i < 5; i++) {
    float d = bacaJarakSekali();
    if (!isnan(d) && d >= 2 && d <= 400) v[n++] = d;
    delay(30);
  }
  if (n == 0) return NAN;
  for (int i = 1; i < n; i++) { float k = v[i]; int j = i - 1; while (j >= 0 && v[j] > k) { v[j + 1] = v[j]; j--; } v[j + 1] = k; }
  return v[n / 2];
}

// Sama dengan backend/src/contract.js: makin basah langsung, makin kering harus lewat batas + HISTERESIS_HUJAN.
const char* HUJAN_STR[] = {"kering", "ringan", "sedang", "lebat"};
int hujanIdx = 0;  // 0 kering, 1 ringan, 2 sedang, 3 lebat

const char* hitungKategoriHujan(int adc) {
  int raw = adc >= ADC_KERING ? 0 : adc >= ADC_RINGAN ? 1 : adc >= ADC_SEDANG ? 2 : 3;
  const int batas[] = {0, ADC_KERING, ADC_RINGAN, ADC_SEDANG};  // batas atas tiap kategori
  if (raw < hujanIdx && adc < batas[hujanIdx] + HISTERESIS_HUJAN) raw = hujanIdx;  // tahan agar tidak berkedip
  hujanIdx = raw;
  return HUJAN_STR[raw];
}

// Status gabungan air + hujan (sama dengan backend/src/contract.js, docs/mqtt-contract.md "Aturan status"):
//   - air: naik langsung saat melewati ambang, turun bertahap dengan histeresis
//   - hujan lebat: selalu BAHAYA walaupun air belum naik
//   - level tidak terbaca: ERROR (tidak pernah dianggap aman)
Status hitungStatus(float level, Status prev, bool hujanLebat) {
  if (isnan(level)) return ERR;
  int cur = (prev == ERR) ? 0 : (int)prev;
  int naik = level >= ambangBahaya ? 2 : level >= ambangSiaga ? 1 : 0;
  if (naik >= cur) cur = naik;
  else {
    while (cur > 0) {
      float batas = (cur == 2) ? ambangBahaya : ambangSiaga;
      if (level < batas - HISTERESIS) cur--;
      else break;
    }
  }
  if (hujanLebat) cur = 2;
  return (Status)cur;
}

// Jumlah pembacaan gagal berturut-turut sebelum status menjadi ERROR.
// Satu pembacaan meleset (pantulan liar, benda terlalu dekat) tidak langsung dianggap rusak.
#define MAKS_GAGAL 3
int gagalBeruntun = 0;

void ukur() {
  float j = bacaJarakMedian();
  // Lebih jauh dari titik nol/dasar sungai = mustahil secara fisik -> anggap pembacaan gagal
  if (!isnan(j) && j > TINGGI_PASANG + 10) j = NAN;
  if (isnan(j)) {
    if (++gagalBeruntun >= MAKS_GAGAL) { jarakCm = NAN; levelCm = NAN; }  // sensor benar-benar gagal
    // else: pertahankan nilai terakhir
  } else {
    gagalBeruntun = 0;
    jarakCm = j;
    levelCm = TINGGI_PASANG - j;
    if (levelCm < 0) levelCm = 0;
  }
  long sum = 0;
  for (int i = 0; i < 8; i++) { sum += analogRead(PIN_RAIN); delay(2); }
  rainAdc = sum / 8;
  kategoriHujan = hitungKategoriHujan(rainAdc);
  Status baru = hitungStatus(levelCm, status, hujanIdx == 3);
  if (!statusDikenal || baru != status) statusPerluKirim = true;
  status = baru;
  statusDikenal = true;
}

// ---------------------------------------------------------------- Buzzer (non-blocking)
// Memakai nada 2 kHz (PWM) agar buzzer AKTIF maupun PASIF sama-sama berbunyi.
#define NADA_BUZZER 2000
bool buzzerBunyi = false;

// Pola bunyi (urutan prioritas, yang lebih berbahaya menang):
//   BAHAYA (air >= ambang bahaya ATAU hujan lebat) : bunyi terus
//   SIAGA                                          : bip 200 ms tiap 1 detik
//   hujan lebat saat sensor air ERROR              : bip-bip (2x 150 ms) tiap 2 detik
//   hujan sedang, status NORMAL                    : bip 150 ms tiap 3 detik
void updateBuzzer() {
  bool on = false;
  if (!buzzerMute) {
    unsigned long t = millis();
    bool lebat = !strcmp(kategoriHujan, "lebat");
    bool sedang = !strcmp(kategoriHujan, "sedang");
    if (status == BAHAYA) on = true;
    else if (status == SIAGA) on = (t % 1000) < 200;
    else if (lebat && BUZZER_HUJAN_LEBAT) { unsigned long p = t % 2000; on = p < 150 || (p >= 300 && p < 450); }
    else if (sedang && BUZZER_HUJAN_SEDANG) on = (t % 3000) < 150;
  }
  if (on == buzzerBunyi) return;  // hanya ubah saat berganti, jangan restart nada tiap loop
  buzzerBunyi = on;
  if (on) tone(PIN_BUZZER, NADA_BUZZER);
  else { noTone(PIN_BUZZER); digitalWrite(PIN_BUZZER, LOW); }
}

// ---------------------------------------------------------------- LCD
void updateLcd() {
  char l1[17], l2[17];
  if (isnan(levelCm)) snprintf(l1, sizeof(l1), "Air: --- %-7s", STATUS_STR[status]);
  else snprintf(l1, sizeof(l1), "Air:%3dcm %-6s", (int)round(levelCm), STATUS_STR[status]);
  snprintf(l2, sizeof(l2), "Hujan:%-6s %c%c%c", kategoriHujan,
           WiFi.status() == WL_CONNECTED ? 'W' : '-', mqtt.connected() ? 'M' : '-', buzzerMute ? 'x' : ' ');
  lcd.setCursor(0, 0); lcd.print(l1);
  lcd.setCursor(0, 1); lcd.print(l2);
}

// ---------------------------------------------------------------- MQTT
void publishAck() {
  JsonDocument doc;
  doc["mute"] = buzzerMute;
  doc["siaga"] = ambangSiaga;
  doc["bahaya"] = ambangBahaya;
  char buf[96];
  serializeJson(doc, buf, sizeof(buf));
  mqtt.publish(T_ACK, buf, true);
}

void publishStatus() {
  if (!mqtt.connected() || !statusDikenal) return;
  if (mqtt.publish(T_STATUS, STATUS_STR[status], true)) statusPerluKirim = false;
}

void publishData() {
  if (!mqtt.connected()) return;
  JsonDocument doc;
  if (!isnan(levelCm)) {
    doc["level"] = roundf(levelCm * 10) / 10.0;
    doc["jarak"] = roundf(jarakCm * 10) / 10.0;
  }
  doc["adc"] = rainAdc;
  doc["hujan"] = kategoriHujan;
  doc["status"] = STATUS_STR[status];
  char buf[160];
  serializeJson(doc, buf, sizeof(buf));
  mqtt.publish(T_DATA, buf, false);
}

// cmd: semua field opsional. Nilai tidak valid ditolak, nilai lama dipertahankan.
void onMqttMessage(char* topic, byte* payload, unsigned int len) {
  JsonDocument doc;
  if (deserializeJson(doc, payload, len) || !doc.is<JsonObject>()) { Serial.println("[cmd] bukan JSON, ditolak"); return; }
  bool mute = buzzerMute; float siaga = ambangSiaga, bahaya = ambangBahaya;
  if (doc["mute"].is<bool>()) mute = doc["mute"].as<bool>();
  else if (!doc["mute"].isNull()) { Serial.println("[cmd] mute harus boolean"); return; }
  if (!doc["siaga"].isNull()) { if (!doc["siaga"].is<float>() || doc["siaga"].as<float>() <= 0) { Serial.println("[cmd] siaga tidak valid"); return; } siaga = doc["siaga"]; }
  if (!doc["bahaya"].isNull()) { if (!doc["bahaya"].is<float>() || doc["bahaya"].as<float>() <= 0) { Serial.println("[cmd] bahaya tidak valid"); return; } bahaya = doc["bahaya"]; }
  if (siaga >= bahaya) { Serial.println("[cmd] ditolak: siaga >= bahaya"); return; }

  buzzerMute = mute; ambangSiaga = siaga; ambangBahaya = bahaya;
  prefs.putBool("mute", buzzerMute);
  prefs.putFloat("siaga", ambangSiaga);
  prefs.putFloat("bahaya", ambangBahaya);
  Serial.printf("[cmd] diterapkan: mute=%d siaga=%.0f bahaya=%.0f\n", buzzerMute, ambangSiaga, ambangBahaya);
  publishAck();  // laporkan konfigurasi yang kini berlaku

  Status baru = hitungStatus(levelCm, status, hujanIdx == 3);
  if (baru != status) { status = baru; publishStatus(); }
  updateLcd();
}

void connectMqtt() {
  if (mqtt.connected() || WiFi.status() != WL_CONNECTED || millis() - tMqttRetry < 5000) return;
  tMqttRetry = millis();
  Serial.print("[mqtt] menghubungkan... ");
  if (mqtt.connect(clientId, MQTT_USER, MQTT_PASS, T_ONLINE, 1, true, "offline")) {
    Serial.println("OK");
    mqtt.publish(T_ONLINE, "online", true);
    mqtt.subscribe(T_CMD, 1);
    publishAck();
    statusPerluKirim = true;
    publishStatus();
  } else {
    Serial.printf("gagal, rc=%d (5 = token salah, -2 = host tidak terjangkau)\n", mqtt.state());
  }
}

// ---------------------------------------------------------------- WiFi
void jagaWifi() {
  if (WiFi.status() == WL_CONNECTED || millis() - tWifiRetry < 10000) return;
  tWifiRetry = millis();
  Serial.println("[wifi] menyambung ulang...");
  WiFi.disconnect();
  WiFi.begin(WIFI_SSID, WIFI_PASS);
}

// ---------------------------------------------------------------- Setup & loop
void setup() {
  Serial.begin(115200);
  pinMode(PIN_TRIG, OUTPUT);
  pinMode(PIN_ECHO, INPUT);
  pinMode(PIN_BUZZER, OUTPUT);
  analogReadResolution(12);

  lcd.init(); lcd.backlight();
  lcd.print("AWASAIR"); lcd.setCursor(0, 1); lcd.print("Menyiapkan...");

  prefs.begin("awasair", false);
  ambangSiaga = prefs.getFloat("siaga", DEFAULT_SIAGA);
  ambangBahaya = prefs.getFloat("bahaya", DEFAULT_BAHAYA);
  buzzerMute = prefs.getBool("mute", false);
  if (ambangSiaga >= ambangBahaya) { ambangSiaga = DEFAULT_SIAGA; ambangBahaya = DEFAULT_BAHAYA; }

  snprintf(clientId, sizeof(clientId), "awasair-%06llx", ESP.getEfuseMac() & 0xFFFFFF);
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  for (int i = 0; i < 20 && WiFi.status() != WL_CONNECTED; i++) delay(500);
  Serial.printf("[wifi] %s, IP %s\n", WiFi.status() == WL_CONNECTED ? "terhubung" : "belum terhubung", WiFi.localIP().toString().c_str());

  mqtt.setServer(MQTT_HOST, MQTT_PORT);
  mqtt.setCallback(onMqttMessage);
  mqtt.setKeepAlive(15);
  mqtt.setBufferSize(512);
  lcd.clear();
}

void loop() {
  jagaWifi();
  connectMqtt();
  mqtt.loop();
  updateBuzzer();  // dipanggil terus agar pola SIAGA halus

  unsigned long now = millis();
  if (tUkur == 0 || now - tUkur >= INTERVAL_MS) {
    tUkur = now;
    ukur();
    updateLcd();
    publishData();                          // data dulu: server membuat notifikasi dengan level terbaru
    if (statusPerluKirim) publishStatus();
    Serial.printf("level=%.1f cm  jarak=%.1f cm  adc=%d (%s)  status=%s%s\n", levelCm, jarakCm, rainAdc, kategoriHujan,
                  STATUS_STR[status], buzzerMute ? " [mute]" : "");
  }
}
