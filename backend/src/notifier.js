// Titik sambung notifikasi. Saat ini hanya mencatat ke konsol.
// Keputusan notifikasi HP (Telegram / web) belum final: isi fungsi send() nanti,
// pemanggil di mqtt.js tidak perlu diubah.

const WORTH_ALERTING = new Set(['SIAGA', 'BAHAYA', 'ERROR']);

export function createNotifier({ log = console.log } = {}) {
  async function send(event) {
    log(`[notif] ${event.message}`);
    // TODO: kirim ke Telegram Bot API di sini.
  }

  return {
    // Dipanggil untuk setiap event; hanya yang penting yang diteruskan.
    async notify(event) {
      const penting =
        (event.type === 'status' && WORTH_ALERTING.has(event.value)) ||
        (event.type === 'status' && event.prev && WORTH_ALERTING.has(event.prev)) || // pemulihan
        (event.type === 'online' && event.value === 'offline');
      if (penting) await send(event);
    },
  };
}
