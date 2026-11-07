// Broker MQTT untuk pengembangan lokal (pengganti Mosquitto sementara).
// TCP 1883 untuk ESP32/simulator/backend, WebSocket 9001 untuk browser.
// TANPA autentikasi dan TLS: jangan dipakai di luar mesin sendiri.
import { createServer } from 'node:net';
import { createServer as createHttp } from 'node:http';
import { Aedes } from 'aedes';
import { WebSocketServer, createWebSocketStream } from 'ws';

const aedes = await Aedes.createBroker();

createServer(aedes.handle).listen(1883, () => console.log('[broker] mqtt://localhost:1883'));

const http = createHttp();
const wss = new WebSocketServer({ server: http });
wss.on('connection', (ws) => aedes.handle(createWebSocketStream(ws)));
http.listen(9001, () => console.log('[broker] ws://localhost:9001'));

aedes.on('client', (c) => console.log(`[broker] + ${c.id}`));
aedes.on('clientDisconnect', (c) => console.log(`[broker] - ${c.id}`));
