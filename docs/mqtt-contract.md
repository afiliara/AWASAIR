# Kontrak MQTT AWASAIR (v1)

Satu-satunya sumber kebenaran antara **firmware ESP32**, **backend**, **dashboard**, dan **simulator**.
Kalau ada yang berubah, ubah di sini dulu, lalu `backend/src/contract.js`, baru kode lain.

Prefix semua topic: `awasair/sungai/`

| Topic | Arah | QoS | Retained | Kapan |
|---|---|---|---|---|
| `data` | ESP32 → broker | 0 | tidak | Tiap 5 sampai 10 detik |
| `status` | ESP32 → broker | 1 | **ya** | Hanya saat status berubah (dan sekali saat boot) |
| `online` | ESP32 → broker | 1 | **ya** | `online` saat connect, `offline` lewat Last Will |
| `cmd` | dashboard/backend → ESP32 | 1 | tidak | Saat pengguna mengubah pengaturan |
| `ack` | ESP32 → broker | 1 | **ya** | Setelah `cmd` diterapkan, dan sekali saat boot |

## `data`
```json
{"level":245.3,"jarak":54.7,"adc":1800,"hujan":"sedang","status":"BAHAYA"}
```
| Field | Tipe | Keterangan |
|---|---|---|
| `level` | number (cm) | `TINGGI_PASANG - jarak` |
| `jarak` | number (cm) | Jarak sensor ke permukaan air, setelah median |
| `adc` | integer 0 sampai 4095 | Nilai mentah rain sensor |
| `hujan` | string | `kering`, `ringan`, `sedang`, `lebat` |
| `status` | string | `NORMAL`, `SIAGA`, `BAHAYA`, `ERROR` |

Waktu **tidak** dikirim. Backend memberi cap waktu saat pesan diterima (ESP32 tidak punya RTC).
Bila pembacaan HC-SR04 gagal (timeout), kirim `{"status":"ERROR","adc":...}` tanpa `level` dan `jarak`.
`ERROR` tidak boleh dianggap aman.

## `status`
Teks polos: `NORMAL`, `SIAGA`, `BAHAYA`, atau `ERROR`.

## `online`
Teks polos: `online` atau `offline`. Last Will di-set ke `offline` (retained).

## `cmd`
Semua field opsional, boleh digabung.
```json
{"mute":true}
{"siaga":200,"bahaya":240}
```
| Field | Tipe | Aturan |
|---|---|---|
| `mute` | boolean | Membisukan buzzer. Status tetap dihitung, LCD tetap tampil. |
| `siaga` | number (cm) | Harus lebih kecil dari `bahaya` |
| `bahaya` | number (cm) | |

ESP32 menolak nilai tidak valid dan tetap mempertahankan nilai lama.

## `ack`
Konfigurasi yang **sedang berlaku** di perangkat, bukan salinan dari `cmd`.
```json
{"mute":false,"siaga":200,"bahaya":240}
```
Dashboard menampilkan nilai dari `ack`, sehingga yang terlihat selalu sama dengan yang dipakai alat.

## Ambang dan histeresis
| Status | Kondisi naik | Kondisi turun |
|---|---|---|
| NORMAL | level < siaga | |
| SIAGA | level ≥ siaga | level < siaga − 5 |
| BAHAYA | level ≥ bahaya | level < bahaya − 5 |

Histeresis 5 cm agar status tidak berkedip di sekitar ambang. Turun dilakukan satu tingkat demi satu tingkat.

## Aturan status (air + hujan)
Status akhir menggabungkan ketinggian air dan kategori hujan. Hujan lebat dianggap tanda bahaya
walaupun air belum naik, karena luapan biasanya menyusul.

| Hujan | Air | Status |
|---|---|---|
| lebat | apa pun | **BAHAYA** |
| kering / ringan / sedang | level < siaga | NORMAL |
| kering / ringan / sedang | level ≥ siaga | SIAGA |
| apa pun | level ≥ bahaya | BAHAYA |
| apa pun | level tidak terbaca | ERROR |

Setelah hujan lebat reda, status kembali mengikuti air (dengan histeresis di atas).
Implementasi: `hitungStatus(level, ambang, prev, histeresis, hujan)` di `backend/src/contract.js`.

## Kategori hujan (contoh, wajib dikalibrasi)
| ADC | Kategori |
|---|---|
| ≥ 4000 | kering |
| 2500 sampai 3999 | ringan |
| 1500 sampai 2499 | sedang |
| < 1500 | lebat |

Histeresis hujan: kategori langsung memburuk saat ADC turun melewati batas, tetapi baru membaik setelah
ADC naik melewati batas + 100 (misalnya lebat baru menjadi sedang saat ADC ≥ 1600). Ini mencegah status
BAHAYA berkedip saat nilai sensor hujan berada di sekitar 1500.

## Buzzer di perangkat
| Kondisi | Pola |
|---|---|
| BAHAYA (termasuk karena hujan lebat) | bunyi terus |
| SIAGA | bip tiap 1 detik |
| NORMAL + hujan sedang | bip tiap 3 detik |
| NORMAL + kering/ringan | diam |

`mute` membisukan semua pola.

## Akses (ACL)
| Pengguna | Publish | Subscribe |
|---|---|---|
| `device` (ESP32) | `data`, `status`, `online`, `ack` | `cmd` |
| `web` (dashboard, backend) | `cmd` | `data`, `status`, `online`, `ack` |
