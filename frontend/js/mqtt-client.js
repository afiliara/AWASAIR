import { CONFIG } from './config.js';

const T = (name) => `${CONFIG.topicBase}/${name}`;
export const TOPICS = { data: T('data'), status: T('status'), online: T('online'), cmd: T('cmd'), ack: T('ack') };

// handlers: { onConnection(bool), onData(obj), onStatus(str), onOnline(str), onAck(obj) }
export function connectMqtt(handlers) {
  const client = window.mqtt.connect(CONFIG.mqttUrl, {
    clientId: `awasair-web-${Math.random().toString(16).slice(2, 8)}`,
    username: CONFIG.mqttUsername || undefined,
    password: CONFIG.mqttPassword || undefined,
    reconnectPeriod: 3000,
  });

  client.on('connect', () => {
    handlers.onConnection(true);
    client.subscribe([TOPICS.data, TOPICS.status, TOPICS.online, TOPICS.ack], { qos: 1 });
  });
  client.on('close', () => handlers.onConnection(false));
  client.on('error', (e) => console.warn('[mqtt]', e.message));

  client.on('message', (topic, payload) => {
    const text = payload.toString();
    try {
      if (topic === TOPICS.data) handlers.onData(JSON.parse(text));
      else if (topic === TOPICS.ack) handlers.onAck(JSON.parse(text));
      else if (topic === TOPICS.status) handlers.onStatus(text);
      else if (topic === TOPICS.online) handlers.onOnline(text);
    } catch (e) {
      console.warn('[mqtt] payload tidak valid pada', topic, text);
    }
  });

  return {
    get connected() { return client.connected; },
    publishCmd: (cmd) =>
      new Promise((resolve, reject) =>
        client.publish(TOPICS.cmd, JSON.stringify(cmd), { qos: 1 }, (err) => (err ? reject(err) : resolve())),
      ),
  };
}
