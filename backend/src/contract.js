// Implementasi kontrak di docs/mqtt-contract.md.
// Logika di sini juga dipakai simulator, supaya sama dengan firmware.

export const TOPIC_BASE = 'awasair/sungai';

export const TOPICS = {
  data: `${TOPIC_BASE}/data`,
  status: `${TOPIC_BASE}/status`,
  online: `${TOPIC_BASE}/online`,
  cmd: `${TOPIC_BASE}/cmd`,
  ack: `${TOPIC_BASE}/ack`,
};

export const STATUS = ['NORMAL', 'SIAGA', 'BAHAYA', 'ERROR'];
export const HUJAN = ['kering', 'ringan', 'sedang', 'lebat'];

export const DEFAULTS = {
  siaga: 200,
  bahaya: 240,
  tinggiPasang: 300,
  histeresis: 5,
  histeresisHujan: 100, // ADC: kategori hujan baru membaik setelah melewati batas + 100
};

// Batas atas ADC tiap kategori (nilai >= batas berarti lebih kering dari kategori itu).
const BATAS_HUJAN = { lebat: 1500, sedang: 2500, ringan: 4000 };

// prev = kategori sebelumnya (untuk histeresis). Makin basah langsung, makin kering harus lewat batas + margin.
export function kategoriHujan(adc, prev = null, margin = DEFAULTS.histeresisHujan) {
  const raw = adc >= 4000 ? 'kering' : adc >= 2500 ? 'ringan' : adc >= 1500 ? 'sedang' : 'lebat';
  if (prev && HUJAN.indexOf(raw) < HUJAN.indexOf(prev) && adc < BATAS_HUJAN[prev] + margin) return prev;
  return raw;
}

// Status gabungan ketinggian air dan hujan (lihat docs/mqtt-contract.md, "Aturan status"):
//   - Air: naik langsung saat melewati ambang, turun bertahap dengan histeresis.
//   - Hujan lebat: selalu BAHAYA, walaupun air belum naik.
//   - Level tidak terbaca: ERROR (tidak pernah dianggap aman).
// prev = status sebelumnya, hujan = kategori hujan saat ini.
export function hitungStatus(level, { siaga, bahaya }, prev = null, hist = DEFAULTS.histeresis, hujan = null) {
  if (!Number.isFinite(level)) return 'ERROR';
  const rank = { NORMAL: 0, SIAGA: 1, BAHAYA: 2 };
  const nama = ['NORMAL', 'SIAGA', 'BAHAYA'];
  let cur = rank[prev] ?? 0;
  const naik = level >= bahaya ? 2 : level >= siaga ? 1 : 0;
  if (naik >= cur) cur = naik;
  else {
    while (cur > 0) {
      const batas = cur === 2 ? bahaya : siaga;
      if (level < batas - hist) cur--;
      else break;
    }
  }
  if (hujan === 'lebat') cur = 2;
  return nama[cur];
}

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

// Mengembalikan objek bersih, atau null bila tidak sesuai kontrak.
export function parseData(raw) {
  let o;
  try {
    o = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!o || typeof o !== 'object' || !STATUS.includes(o.status)) return null;
  if (o.status !== 'ERROR' && !isNum(o.level)) return null;
  return {
    level: isNum(o.level) ? o.level : null,
    jarak: isNum(o.jarak) ? o.jarak : null,
    adc: isNum(o.adc) ? Math.round(o.adc) : null,
    hujan: HUJAN.includes(o.hujan) ? o.hujan : null,
    status: o.status,
  };
}

// Validasi cmd. Mengembalikan { ok, cmd } atau { ok:false, error }.
export function validateCmd(o) {
  if (!o || typeof o !== 'object') return { ok: false, error: 'cmd harus objek' };
  const cmd = {};
  if ('mute' in o) {
    if (typeof o.mute !== 'boolean') return { ok: false, error: 'mute harus boolean' };
    cmd.mute = o.mute;
  }
  if ('siaga' in o) {
    if (!isNum(o.siaga) || o.siaga <= 0) return { ok: false, error: 'siaga harus angka positif' };
    cmd.siaga = o.siaga;
  }
  if ('bahaya' in o) {
    if (!isNum(o.bahaya) || o.bahaya <= 0) return { ok: false, error: 'bahaya harus angka positif' };
    cmd.bahaya = o.bahaya;
  }
  if ('siaga' in cmd && 'bahaya' in cmd && cmd.siaga >= cmd.bahaya) {
    return { ok: false, error: 'siaga harus lebih kecil dari bahaya' };
  }
  if (Object.keys(cmd).length === 0) return { ok: false, error: 'cmd kosong' };
  return { ok: true, cmd };
}
