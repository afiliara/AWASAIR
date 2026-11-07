import { CONFIG } from './config.js';

async function get(path) {
  const res = await fetch(CONFIG.apiBase + path);
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json();
}

export const api = {
  state: () => get('/api/state'),
  readings: (minutes) => get(`/api/readings?minutes=${minutes}`),
  events: (limit = 50) => get(`/api/events?limit=${limit}`),
  async sendCmd(cmd) {
    const res = await fetch(`${CONFIG.apiBase}/api/cmd`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(CONFIG.apiKey && { 'X-API-Key': CONFIG.apiKey }) },
      body: JSON.stringify(cmd),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
  },
};
