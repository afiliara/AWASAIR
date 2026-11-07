@echo off
REM Menjalankan AwasSpeak (port 3001) dan AwasLink (port 8080 + MQTT 1883) di dua jendela.
cd /d "%~dp0"
if not exist awaslink\node_modules (
  echo Menginstal dependensi AwasLink...
  cd awaslink && call npm install && cd ..
)
start "AwasSpeak" cmd /k "cd /d %~dp0awasspeak && npm start"
start "AwasLink"  cmd /k "cd /d %~dp0awaslink && npm start"
echo.
echo AwasSpeak : http://localhost:3001
echo AwasLink  : http://localhost:8080
echo Untuk simulator: cd awaslink ^&^& npm run simulator -- --token TOKEN_AWASLINK
