#!/usr/bin/env bash
# Menjalankan AwasSpeak (port 3001) dan AwasLink (port 8080 + MQTT 1883). Ctrl+C menghentikan keduanya.
cd "$(dirname "$0")"
[ -d awaslink/node_modules ] || (cd awaslink && npm install)
(cd awasspeak && npm start) &
(cd awaslink && npm start) &
trap 'kill 0' INT TERM
wait
