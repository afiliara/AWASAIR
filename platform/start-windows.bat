@echo off
REM Menjalankan AwasLink: dashboard + konsol + Data Logger (port 8080) dan broker MQTT (port 1883).
cd /d "%~dp0awaslink"
if not exist node_modules (
  echo Menginstal dependensi AwasLink...
  call npm install
)
echo.
echo Dashboard warga : http://localhost:8080
echo Konsol teknisi  : http://localhost:8080/console/
echo Data Logger     : http://localhost:8080/data/
echo Simulator (jendela lain): cd awaslink ^&^& npm run simulator -- --token TOKEN_PERANGKAT
echo.
npm start
