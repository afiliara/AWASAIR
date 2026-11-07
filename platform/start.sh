#!/usr/bin/env bash
# Menjalankan AwasLink: dashboard + konsol + Data Logger (port 8080) dan broker MQTT (port 1883).
cd "$(dirname "$0")/awaslink"
[ -d node_modules ] || npm install
exec npm start
