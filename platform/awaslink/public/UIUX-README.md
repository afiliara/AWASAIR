# AWASAIR — Dashboard Peringatan Dini Banjir (UI/UX)

Prototipe antarmuka web untuk sistem peringatan dini banjir dan luapan air AWASAIR.
Tampilan responsif untuk desktop, tablet, dan HP. Tanpa framework dan tanpa library eksternal.

## Cara menjalankan
1. Ekstrak ZIP.
2. Buka folder `awasair_ui` di VS Code.
3. Jalankan `index.html` dengan ekstensi Live Server, atau buka langsung di browser.

## Struktur file
- `index.html` — struktur halaman: sidebar, header, Beranda, Grafik, Notifikasi, Pengaturan, navigasi bawah (HP), serta sprite ikon dan logo.
- `style.css` — seluruh tampilan, termasuk token warna, layout desktop, tablet (≤1180 px), dan HP (≤860 px).
- `app.js` — data contoh, status sungai otomatis, grafik canvas, routing halaman, notifikasi, pengaturan, dan menu profil.
- `assets/logo-awasair.svg` — logo huruf A (juga dipakai sebagai favicon).
- `assets/hero-scene.svg` — ilustrasi cadangan hero, tampil bila foto online tidak termuat.
- `assets/fonts/` — font Inter (semua teks) dan Space Grotesk (tulisan AWASAIR) (lisensi SIL Open Font License, lihat file OFL di folder ini).

## Fitur yang berjalan
- Navigasi antarhalaman lewat sidebar (desktop) atau navigasi bawah (HP). Alamat memakai hash (`#beranda`, `#grafik`, `#notifikasi`, `#pengaturan`), sehingga tombol Back browser ikut bekerja.
- Status sungai **BAHAYA / SIAGA / NORMAL** dihitung otomatis dari ketinggian air dan ambang batas.
- Label buzzer di hero mengikuti status dan sakelar buzzer di Pengaturan.
- Grafik ketinggian air 6/12/24 jam, berisi zona siaga dan bahaya, garis ambang, label nilai terakhir, serta tooltip saat di-hover atau disentuh.
- Halaman Grafik menampilkan rata-rata dan maksimum yang dihitung dari rentang terpilih.
- Notifikasi bisa disaring per status dan ditandai sudah dibaca. Badge jumlah belum dibaca ikut diperbarui.
- Pengaturan ambang batas memvalidasi input (bilangan bulat 1–400, Siaga harus lebih rendah dari Bahaya).
- Peta lokasi sensor bisa dilipat, dan menu profil bisa ditutup dengan tombol Escape.

## Catatan penting
- Semua data (ketinggian air, notifikasi, status MQTT) masih **data contoh**. Waktu pada grafik dan notifikasi dihitung mundur dari jam saat halaman dibuka.
- Untuk simulasi perubahan data setiap 5 detik, ubah `ENABLE_DEMO_DRIFT` di `app.js` menjadi `true`.
- Foto hero diambil dari Unsplash dan butuh internet. Tanpa internet, hero otomatis memakai `assets/hero-scene.svg`.
- Sebelum dipakai sungguhan, hubungkan UI ke backend yang terautentikasi dan MQTT over WebSocket. Logika keselamatan (misalnya buzzer saat bahaya) tetap harus berjalan di mikrokontroler, bukan bergantung pada dashboard.
