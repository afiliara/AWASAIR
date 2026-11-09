/* AWASAIR — logika antarmuka (desain UI/UX v5), terhubung ke AwasLink.
 * Data: REST /api/... untuk data awal & riwayat, WebSocket /ws untuk pembaruan real-time.
 * Kontrak MQTT perangkat: docs/mqtt-contract.md (level, jarak, adc, hujan, status; ack: mute, siaga, bahaya).
 */
(() => {
  "use strict";

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  /* ------------------------------------------------------------ utilitas waktu */
  const WEEKDAYS = ["Min", "Sen", "Sel", "Rab", "Kam", "Jum", "Sab"];
  const MONTHS = ["Januari", "Februari", "Maret", "April", "Mei", "Juni", "Juli", "Agustus", "September", "Oktober", "November", "Desember"];
  const pad2 = (n) => String(n).padStart(2, "0");
  const hhmm = (d) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  const hhmmss = (d) => `${hhmm(d)}:${pad2(d.getSeconds())}`;
  const shortDate = (d) => `${WEEKDAYS[d.getDay()]}, ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
  const sameDay = (a, b) => a.toDateString() === b.toDateString();
  const isYesterday = (d) => { const y = new Date(); y.setDate(y.getDate() - 1); return sameDay(d, y); };
  const fmt1 = (v) => (Number.isFinite(v) ? (Math.round(v * 10) / 10).toLocaleString("id-ID") : "—");
  const store = {
    get: (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* mode privat */ } },
  };

  /* ------------------------------------------------------------ state */
  const state = {
    device: null, // perangkat AwasLink yang ditampilkan
    admin: false,
    roleKnown: false, // peran (admin/warga) baru diketahui setelah /api/me selesai
    wsOk: false,
    points: [], // riwayat ketinggian air [{t, v}] 24 jam terakhir
    values: {}, // nilai terakhir per datastream {key: {v, ts}}
    online: false,
    lastData: 0, // waktu data terakhir dari alat
    ackTs: 0,
    pending: null, // perintah yang menunggu ack
    range: Number(store.get("aw_range", 6)),
    historyRange: 6,
    notifications: [],
    lastRead: Number(store.get("aw_lastread", 0)),
  };

  const num = (k) => { const v = Number(state.values[k]?.v); return state.values[k] && Number.isFinite(v) ? v : null; };
  const str = (k) => (state.values[k] ? String(state.values[k].v) : null);
  const thresholds = () => ({ alert: num("siaga") ?? 200, danger: num("bahaya") ?? 240 });
  const staleSec = () => state.device?.config?.staleSeconds || 30;
  const isStale = () => !state.lastData || Date.now() - state.lastData > staleSec() * 1000;

  const sliceRange = (hours) => {
    const from = Date.now() - hours * 3600000;
    const pts = state.points.filter((p) => p.t >= from);
    return { values: pts.map((p) => p.v), times: pts.map((p) => new Date(p.t)) };
  };

  const STATUS = {
    danger: { label: "BAHAYA", icon: "#i-alert" },
    warning: { label: "SIAGA", icon: "#i-alert" },
    normal: { label: "NORMAL", icon: "#i-check" },
    error: { label: "ERROR", icon: "#i-alert" },
    offline: { label: "OFFLINE", icon: "#i-wifi" },
  };
  const statusFor = (v) => { const { alert, danger } = thresholds(); return v >= danger ? "danger" : v >= alert ? "warning" : "normal"; };
  // Aturan: data hilang, basi, offline, atau ERROR tidak pernah tampil sebagai aman.
  function currentKey() {
    if (!state.online || isStale()) return "offline";
    const s = (str("status") || "").toUpperCase();
    if (s === "BAHAYA") return "danger";
    if (s === "SIAGA") return "warning";
    if (s === "NORMAL") return "normal";
    if (s === "ERROR") return "error";
    const lv = num("level");
    return lv == null ? "offline" : statusFor(lv);
  }
  const NOTIF_ICON = { danger: "#i-siren", warning: "#i-bell", success: "#i-check", info: "#i-wifi" };

  /* ------------------------------------------------------------ API */
  async function api(method, url, body) {
    const r = await fetch(url, { method, credentials: "same-origin", headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
    const data = (r.headers.get("content-type") || "").includes("json") ? await r.json() : await r.text();
    if (!r.ok) { const e = new Error(data?.error || "HTTP " + r.status); e.status = r.status; throw e; }
    return data;
  }

  /* ------------------------------------------------------------ toast */
  let toastTimer;
  function toast(message) {
    const el = $("#toast");
    el.textContent = message;
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("show"), 3200);
  }

  /* ------------------------------------------------------------ render */
  function renderStatus() {
    const key = currentKey();
    const hero = $("#heroStatus");
    hero.dataset.state = key;
    $("#statusText").textContent = STATUS[key].label;
    $("#stateIconUse").setAttribute("href", STATUS[key].icon);

    const muted = num("mute") === 1;
    const hujan = (str("hujan") || "").toLowerCase();
    const lv = num("level");
    const { danger } = thresholds();
    // Aturan status: hujan lebat = BAHAYA walau air belum naik (docs/mqtt-contract.md)
    const karenaHujan = key === "danger" && hujan === "lebat" && (lv == null || lv < danger);
    const pill = $("#buzzerPill");
    let tone = key, text = "Kondisi aman", icon = "#i-check";
    if (key === "danger") {
      tone = muted ? "muted" : "danger";
      text = (karenaHujan ? "Hujan lebat · " : "") + (muted ? "buzzer dibisukan" : "buzzer aktif");
      text = text.charAt(0).toUpperCase() + text.slice(1);
      icon = muted ? "#i-bell-off" : "#i-siren";
    } else if (key === "warning") {
      text = muted ? "Waspada · buzzer dibisukan" : "Waspada kenaikan air";
      icon = "#i-alert";
    } else if (key === "normal" && hujan === "sedang") {
      text = muted ? "Hujan sedang · buzzer dibisukan" : "Hujan sedang · buzzer bip";
      icon = muted ? "#i-bell-off" : "#i-cloud-rain";
    } else if (key === "error") {
      tone = "offline"; text = "Sensor gagal membaca"; icon = "#i-alert";
    } else if (key === "offline") {
      tone = "offline"; text = state.online ? "Data terlambat" : "Perangkat offline"; icon = "#i-wifi";
    }
    pill.dataset.tone = tone;
    $("#buzzerPillText").textContent = text;
    $("#buzzerIconUse").setAttribute("href", icon);
  }

  function renderMetrics() {
    const v = num("level");
    $("#levelValue").textContent = fmt1(v);
    // perubahan 30 menit terakhir
    const target = Date.now() - 30 * 60000;
    let prev = null;
    for (const p of state.points) { if (p.t <= target) prev = p.v; else break; }
    if (prev == null && state.points.length) prev = state.points[0].v;
    const deltaEl = $("#levelDelta");
    if (v != null && prev != null) {
      const delta = Math.round((v - prev) * 10) / 10;
      deltaEl.hidden = false;
      deltaEl.dataset.dir = delta < 0 ? "down" : "up";
      $("#levelDeltaText").textContent = `${delta >= 0 ? "+" : "−"}${fmt1(Math.abs(delta))} cm`;
    } else deltaEl.hidden = true;
    const { alert, danger } = thresholds();
    $$("[data-alert-text]").forEach((el) => (el.textContent = alert));
    $$("[data-danger-text]").forEach((el) => (el.textContent = danger));
    const h = str("hujan");
    $("#rainValue").textContent = h ? h.charAt(0).toUpperCase() + h.slice(1) : "—";
  }

  function renderConnection() {
    const devOnline = state.online && !isStale();
    $$("[data-device-status]").forEach((el) => (el.textContent = devOnline ? "Online" : state.online ? "Data terlambat" : "Offline"));
    $(".online-pill")?.toggleAttribute("data-off", !devOnline);
    const card = $(".mqtt-card");
    card.toggleAttribute("data-off", !state.wsOk || !state.online);
    $("#mqttStatus").textContent = !state.wsOk ? "Server terputus" : state.online ? "Alat terhubung" : "Alat offline";
    $("#lastUpdate").textContent = state.lastData ? hhmmss(new Date(state.lastData)) : "--:--:--";
    $$("[data-conn-badge]").forEach((b) => { b.toggleAttribute("data-off", !devOnline); b.lastElementChild.textContent = devOnline ? "Data langsung" : "Tidak ada data baru"; });
    const chip = (el, ok, okText, badText) => { el.className = ok ? "chip-ok" : "chip-off"; el.textContent = ok ? okText : badText; };
    chip($("#serverChip"), state.wsOk, "Terhubung", "Terputus");
    chip($("#nodeChip"), devOnline, "Online", state.online ? "Data terlambat" : "Offline");
    const sensor = $("#statSensor");
    sensor.textContent = devOnline ? (str("status") === "ERROR" ? "Sensor ERROR" : "Terhubung") : state.online ? "Data terlambat" : "Offline";
    sensor.className = devOnline && str("status") !== "ERROR" ? "text-success" : "text-danger";
    $("#statSensorNote").textContent = state.lastData ? `Data terakhir ${hhmmss(new Date(state.lastData))}` : "Belum ada data";
    const ackChip = $("#ackChip");
    if (state.pending) { ackChip.className = "chip-wait"; ackChip.textContent = "Menunggu"; $("#ackNote").textContent = "Perintah terkirim, menunggu konfirmasi alat"; }
    else if (state.ackTs) { ackChip.className = "chip-ok"; ackChip.textContent = "Sinkron"; $("#ackNote").textContent = `Dikonfirmasi alat ${hhmm(new Date(state.ackTs))}`; }
  }

  // Event server -> kartu notifikasi desain
  function toNotif(e) {
    const m = e.message || "";
    let kind = "info", label = "SISTEM";
    if (/offline|online|terputus/i.test(m)) { kind = "info"; label = "SISTEM"; }
    else if (/BAHAYA/.test(m) || e.level === "critical") { kind = "danger"; label = "BAHAYA"; }
    else if (/SIAGA/.test(m)) { kind = "warning"; label = "SIAGA"; }
    else if (/NORMAL/.test(m)) { kind = "success"; label = "NORMAL"; }
    else if (/ERROR/.test(m)) { kind = "warning"; label = "ERROR"; }
    else if (/hujan/i.test(m)) { kind = "warning"; label = "HUJAN"; }
    else if (e.level === "warning") { kind = "warning"; label = "PERINGATAN"; }
    // Judul = kalimat pertama sampai titik ("BAHAYA! Ketinggian air 1.3 cm, hujan lebat."), sisanya detail
    const parts = m.split(/(?<=\.)\s+/);
    return { id: e.id, kind, label, title: parts[0], detail: parts.slice(1).join(" ") || m, ts: e.ts };
  }

  function notifItem(n, full) {
    const li = document.createElement("li");
    li.className = "notif-row" + (n.id <= state.lastRead ? " is-read" : "");
    li.dataset.kind = n.kind;

    const icon = document.createElement("span");
    icon.className = "notif-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.innerHTML = `<svg class="icon"><use href="${NOTIF_ICON[n.kind]}"/></svg>`;

    const pill = document.createElement("span");
    pill.className = "pill";
    pill.textContent = n.label;

    const text = document.createElement("p");
    text.className = "notif-text";
    text.textContent = n.title;
    if (full && n.detail && n.detail !== n.title) {
      const small = document.createElement("small");
      small.textContent = n.detail;
      text.appendChild(small);
    }

    const when = new Date(n.ts);
    const time = document.createElement("time");
    time.className = "notif-time";
    time.dateTime = when.toISOString();
    const day = sameDay(when, new Date()) ? "Hari ini" : isYesterday(when) ? "Kemarin" : `${when.getDate()}/${when.getMonth() + 1}`;
    time.textContent = full ? `${day} · ${hhmm(when)}` : (sameDay(when, new Date()) ? hhmm(when) : `${day} ${hhmm(when)}`);

    li.append(icon, pill, text, time);
    return li;
  }

  function renderNotifications() {
    const list = state.notifications;
    const recent = list.filter((n) => n.kind !== "info").slice(0, 3);
    $("#recentList").replaceChildren(...(recent.length ? recent.map((n) => notifItem(n, false)) : [emptyLi("Belum ada peringatan.")]));

    const filter = $("#notifFilter").value;
    const shown = list.filter((n) => filter === "all" || n.kind === filter);
    $("#allList").replaceChildren(...shown.map((n) => notifItem(n, true)));
    $("#emptyState").hidden = shown.length > 0;

    const unread = list.filter((n) => n.id > state.lastRead).length;
    $$("[data-unread-badge]").forEach((b) => {
      b.textContent = unread > 99 ? "99+" : unread;
      b.hidden = unread === 0;
      b.setAttribute("aria-label", `${unread} notifikasi belum dibaca`);
    });
  }
  function emptyLi(text) { const li = document.createElement("li"); li.className = "empty-state"; li.textContent = text; return li; }

  function renderSettings() {
    const { alert, danger } = thresholds();
    if (document.activeElement !== $("#alertInput")) $("#alertInput").value = alert;
    if (document.activeElement !== $("#dangerInput")) $("#dangerInput").value = danger;
    const buzzerOn = num("mute") !== 1;
    const sw = $("#buzzerSwitch");
    sw.setAttribute("aria-checked", String(buzzerOn));
    sw.setAttribute("aria-disabled", String(!state.admin));
    $("#buzzerDesc").textContent = state.pending && "mute" in state.pending ? "Menunggu konfirmasi alat…" : buzzerOn ? "Buzzer diizinkan aktif saat bahaya" : "Buzzer dibisukan secara manual";
    $$("#thresholdForm input, #thresholdForm button").forEach((el) => (el.disabled = !state.admin));
    const fb = $("#thresholdFeedback");
    if (!state.admin && !fb.textContent) { fb.dataset.tone = ""; fb.textContent = "Masuk sebagai admin (menu profil) untuk mengubah pengaturan."; }
    const rb = $("#roleBadge");
    rb.toggleAttribute("data-off", !state.admin);
    rb.lastElementChild.textContent = state.admin ? "Admin" : "Mode lihat saja";
    $("#profileName").textContent = state.admin ? "Admin AWASAIR" : "Warga";
    $("#profileRole").textContent = state.admin ? "Dapat mengubah pengaturan" : "Mode lihat saja";
    $("#authLabel").textContent = state.admin ? "Keluar" : "Masuk sebagai admin";
    $("#authIconUse").setAttribute("href", state.admin ? "#i-logout" : "#i-login");
    $("#authItem").classList.toggle("is-danger", state.admin);
    applyRole();
  }

  // Elemen .admin-only (menu teknis, Data & Ekspor, Konsol) hanya tampil untuk admin; .public-only hanya untuk warga.
  function applyRole() {
    $$(".admin-only").forEach((el) => { el.hidden = !state.admin; });
    $$(".public-only").forEach((el) => { el.hidden = state.admin; });
  }

  // Unduh data air 24 jam terakhir sebagai CSV (boleh untuk semua pengunjung).
  function downloadCsv() {
    if (!state.device) return toast("Data belum siap, coba lagi sebentar.");
    const link = document.createElement("a");
    link.href = `/api/devices/${encodeURIComponent(state.device.id)}/air.csv?minutes=1440`;
    link.download = "";
    link.click();
    toast("Mengunduh data air 24 jam terakhir (CSV).");
  }

  function renderStats() {
    const { values } = sliceRange(state.historyRange);
    const note = $("#statMaxNote");
    if (!values.length) { $("#statAvg").textContent = "— cm"; $("#statMax").textContent = "— cm"; note.textContent = "Belum ada data"; note.className = ""; return; }
    const avg = values.reduce((a, b) => a + b, 0) / values.length;
    const max = Math.max(...values);
    $("#statAvg").textContent = `${fmt1(avg)} cm`;
    $("#statMax").textContent = `${fmt1(max)} cm`;
    const key = statusFor(max);
    note.textContent = key === "danger" ? "Melewati ambang bahaya" : key === "warning" ? "Melewati ambang siaga" : "Di bawah ambang siaga";
    note.className = key === "normal" ? "text-success" : "text-danger";
  }

  function renderDevice() {
    if (!state.device) return;
    $("#nodeLabel").textContent = `Node: ${state.device.topic}`;
    $("#nodeTopic").textContent = state.device.topic;
  }

  function renderAll() {
    renderStatus();
    renderMetrics();
    renderConnection();
    renderNotifications();
    renderSettings();
    renderStats();
    renderDevice();
    redrawCharts();
  }

  /* ------------------------------------------------------------ grafik (canvas) */
  const FONT = '"ID Grotesk", "Inter", system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif';
  const charts = [];

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function drawChart(chart) {
    const { canvas } = chart;
    const rect = canvas.getBoundingClientRect();
    if (rect.width < 40 || rect.height < 40) return;
    const { values, times } = sliceRange(chart.range());
    const { alert, danger } = thresholds();
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const W = rect.width, H = rect.height;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    if (!values.length) {
      chart.geom = null;
      ctx.font = `600 13px ${FONT}`;
      ctx.fillStyle = "#5b7398";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("Belum ada data ketinggian air pada rentang ini", W / 2, H / 2);
      canvas.setAttribute("aria-label", "Grafik ketinggian air: belum ada data.");
      return;
    }

    const compact = W < 520;
    const pad = { l: compact ? 34 : 44, r: compact ? 12 : 18, t: compact ? 34 : 40, b: compact ? 28 : 34 };
    const cw = W - pad.l - pad.r, ch = H - pad.t - pad.b;
    const yMax = Math.ceil((Math.max(...values, danger) + 15) / 20) * 20;
    const yMin = Math.max(0, Math.floor((Math.min(...values, alert) - 10) / 50) * 50);
    // sumbu X berdasarkan waktu (data asli tidak selalu berjarak sama)
    const t0 = Date.now() - chart.range() * 3600000, t1 = Date.now();
    const X = (i) => pad.l + ((times[i].getTime() - t0) / (t1 - t0)) * cw;
    const Y = (v) => pad.t + ((yMax - v) / (yMax - yMin)) * ch;
    chart.geom = { pad, cw, n: values.length, X };

    // zona bahaya & siaga
    ctx.fillStyle = "rgba(255, 77, 96, .09)";
    ctx.fillRect(pad.l, Y(yMax), cw, Y(danger) - Y(yMax));
    ctx.fillStyle = "rgba(255, 184, 36, .13)";
    ctx.fillRect(pad.l, Y(danger), cw, Y(alert) - Y(danger));

    // garis bantu & label sumbu Y
    ctx.font = `500 ${compact ? 10.5 : 12}px ${FONT}`;
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    for (let k = 0; k <= 4; k++) {
      const v = yMin + (k * (yMax - yMin)) / 4;
      const y = Y(v);
      ctx.strokeStyle = "#e6eef8";
      ctx.lineWidth = 1;
      ctx.setLineDash([]);
      ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(W - pad.r, y); ctx.stroke();
      ctx.fillStyle = "#5b7398";
      ctx.fillText(Math.round(v), pad.l - 10, y);
    }

    // garis ambang + label
    [
      { v: danger, color: "#ef4057", label: `Bahaya ${danger} cm`, place: "above" },
      { v: alert, color: "#e8970f", label: `Siaga ${alert} cm`, place: "below" },
    ].forEach(({ v, color, label, place }) => {
      const y = Y(v);
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.4;
      ctx.setLineDash([6, 5]);
      ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(W - pad.r, y); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = color;
      ctx.font = `700 ${compact ? 10.5 : 12.5}px ${FONT}`;
      ctx.textBaseline = place === "above" ? "bottom" : "top";
      if (place === "above") { ctx.textAlign = "center"; ctx.fillText(label, pad.l + cw * 0.62, y - 6); }
      else { ctx.textAlign = "right"; ctx.fillText(label, W - pad.r - 4, y + 7); }
    });

    // area & garis data (putus bila ada jeda data > 2 menit, agar data hilang tidak terlihat mulus)
    const GAP = 120000;
    const segments = [];
    values.forEach((v, i) => {
      if (!i || times[i] - times[i - 1] > GAP) segments.push([]);
      segments[segments.length - 1].push(i);
    });
    const grad = ctx.createLinearGradient(0, pad.t, 0, H - pad.b);
    grad.addColorStop(0, "rgba(22, 119, 248, .26)");
    grad.addColorStop(1, "rgba(22, 119, 248, .02)");
    segments.forEach((seg) => {
      ctx.beginPath();
      seg.forEach((i, k) => (k ? ctx.lineTo(X(i), Y(values[i])) : ctx.moveTo(X(i), Y(values[i]))));
      ctx.lineTo(X(seg[seg.length - 1]), H - pad.b);
      ctx.lineTo(X(seg[0]), H - pad.b);
      ctx.closePath();
      ctx.fillStyle = grad;
      ctx.fill();
      ctx.beginPath();
      seg.forEach((i, k) => (k ? ctx.lineTo(X(i), Y(values[i])) : ctx.moveTo(X(i), Y(values[i]))));
      ctx.strokeStyle = "#1677f8";
      ctx.lineWidth = compact ? 2.4 : 3;
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      ctx.stroke();
    });

    // label sumbu X (5 titik waktu)
    ctx.font = `500 ${compact ? 10.5 : 12}px ${FONT}`;
    ctx.fillStyle = "#5b7398";
    ctx.textBaseline = "top";
    for (let k = 0; k <= 4; k++) {
      const t = new Date(t0 + (k * (t1 - t0)) / 4);
      ctx.textAlign = k === 0 ? "left" : k === 4 ? "right" : "center";
      ctx.fillText(hhmm(t), pad.l + (k * cw) / 4, H - pad.b + 10);
    }

    // titik terakhir + callout nilai
    const li = values.length - 1, lx = X(li), ly = Y(values[li]);
    const lastColor = statusFor(values[li]) === "danger" ? "#ef4057" : statusFor(values[li]) === "warning" ? "#f2a11f" : "#12a87a";
    ctx.beginPath(); ctx.arc(lx, ly, compact ? 5 : 6, 0, Math.PI * 2);
    ctx.fillStyle = lastColor; ctx.fill();
    ctx.lineWidth = 2.5; ctx.strokeStyle = "#fff"; ctx.stroke();
    const tag = `${fmt1(values[li])} cm`;
    ctx.font = `800 ${compact ? 11.5 : 13}px ${FONT}`;
    const tw = ctx.measureText(tag).width + 20, th = compact ? 24 : 28;
    const bx = Math.min(W - pad.r - tw + 6, Math.max(pad.l, lx - tw / 2));
    const by = Math.max(2, ly - th - 12);
    ctx.fillStyle = lastColor;
    roundRect(ctx, bx, by, tw, th, 8); ctx.fill();
    const px = Math.min(bx + tw - 10, Math.max(bx + 10, lx));
    ctx.beginPath(); ctx.moveTo(px - 6, by + th); ctx.lineTo(px, by + th + 6); ctx.lineTo(px + 6, by + th); ctx.closePath(); ctx.fill();
    ctx.fillStyle = "#fff"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(tag, bx + tw / 2, by + th / 2 + 0.5);

    // tooltip saat disentuh / di-hover
    if (chart.hover != null && chart.hover >= 0 && chart.hover < values.length) {
      const i = chart.hover, x = X(i), y = Y(values[i]);
      ctx.strokeStyle = "rgba(15, 42, 82, .35)"; ctx.lineWidth = 1; ctx.setLineDash([3, 4]);
      ctx.beginPath(); ctx.moveTo(x, pad.t); ctx.lineTo(x, H - pad.b); ctx.stroke(); ctx.setLineDash([]);
      ctx.beginPath(); ctx.arc(x, y, 5, 0, Math.PI * 2); ctx.fillStyle = "#1677f8"; ctx.fill();
      ctx.lineWidth = 2; ctx.strokeStyle = "#fff"; ctx.stroke();
      const line1 = `${fmt1(values[i])} cm`, line2 = hhmmss(times[i]);
      ctx.font = `800 12.5px ${FONT}`;
      const w1 = ctx.measureText(line1).width;
      ctx.font = `500 11.5px ${FONT}`;
      const w2 = ctx.measureText(line2).width;
      const bw = Math.max(w1, w2) + 22, bh = 44;
      let tx = x + 12; if (tx + bw > W - pad.r) tx = x - 12 - bw;
      const ty = Math.min(H - pad.b - bh, Math.max(pad.t, y - bh / 2));
      ctx.fillStyle = "#0f2f5c"; roundRect(ctx, tx, ty, bw, bh, 9); ctx.fill();
      ctx.fillStyle = "#fff"; ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
      ctx.font = `800 12.5px ${FONT}`; ctx.fillText(line1, tx + 11, ty + 19);
      ctx.fillStyle = "#b9cdea"; ctx.font = `500 11.5px ${FONT}`; ctx.fillText(line2, tx + 11, ty + 35);
    }

    canvas.setAttribute("aria-label", `Grafik ketinggian air ${chart.range()} jam terakhir. Nilai terakhir ${fmt1(values[li])} cm, ambang siaga ${alert} cm, ambang bahaya ${danger} cm.`);
  }

  function setupChart(canvas, range) {
    const chart = { canvas, range, hover: null, geom: null, raf: 0 };
    const schedule = () => { cancelAnimationFrame(chart.raf); chart.raf = requestAnimationFrame(() => drawChart(chart)); };
    const pick = (event) => {
      if (!chart.geom) return;
      const r = canvas.getBoundingClientRect();
      const x = event.clientX - r.left;
      const { values } = sliceRange(chart.range());
      let best = 0, bestD = Infinity;
      for (let i = 0; i < values.length; i++) { const d = Math.abs(chart.geom.X(i) - x); if (d < bestD) { bestD = d; best = i; } }
      chart.hover = best;
      schedule();
    };
    canvas.addEventListener("pointermove", pick);
    canvas.addEventListener("pointerdown", pick);
    canvas.addEventListener("pointerleave", () => { chart.hover = null; schedule(); });
    if ("ResizeObserver" in window) new ResizeObserver(schedule).observe(canvas.parentElement);
    chart.schedule = schedule;
    charts.push(chart);
    return chart;
  }
  function redrawCharts() { charts.forEach((c) => c.schedule && c.schedule()); }

  /* ------------------------------------------------------------ navigasi */
  const PAGES = ["beranda", "grafik", "notifikasi", "pengaturan"];
  function showPage(name, { focus = false } = {}) {
    if (name === "dashboard") name = "beranda";
    if (!PAGES.includes(name)) name = "beranda";
    if (name === "pengaturan" && state.roleKnown && !state.admin) name = "beranda"; // pengaturan hanya untuk admin
    PAGES.forEach((p) => { $("#page-" + p).hidden = p !== name; });
    $$("[data-nav]").forEach((a) => {
      if (!a.classList.contains("nav-item") && !a.classList.contains("bn-item")) return;
      if (a.dataset.nav === name) a.setAttribute("aria-current", "page");
      else a.removeAttribute("aria-current");
    });
    document.title = `${$("#page-" + name).dataset.title} · AWASAIR`;
    if (name === "pengaturan") renderSettings();
    redrawCharts();
    if (focus) { window.scrollTo({ top: 0 }); $("#content").focus({ preventScroll: true }); }
  }
  window.addEventListener("hashchange", () => showPage(location.hash.slice(1), { focus: true }));

  /* ------------------------------------------------------------ perintah ke alat */
  function sendCmd(values) {
    if (!state.admin) { toast("Masuk sebagai admin untuk mengubah pengaturan."); openLogin(); return Promise.resolve(false); }
    return api("POST", `/api/devices/${state.device.id}/write`, { values })
      .then((r) => {
        state.pending = r.pending ? values : null;
        renderConnection(); renderSettings();
        toast(r.pending ? "Perintah terkirim. Menunggu konfirmasi dari alat…" : "Perintah terkirim.");
        return true;
      })
      .catch((e) => { toast(e.message); return false; });
  }

  /* ------------------------------------------------------------ interaksi */
  function setRange(hours) {
    state.range = hours;
    store.set("aw_range", hours);
    $$(".seg-btn").forEach((b) => {
      const on = Number(b.dataset.range) === hours;
      b.classList.toggle("is-active", on);
      b.setAttribute("aria-pressed", String(on));
    });
    $("#rangeSelect").value = String(hours);
    $("#chartRangeText").textContent = `(${hours} Jam Terakhir)`;
    redrawCharts();
  }
  $$(".seg-btn").forEach((b) => b.addEventListener("click", () => setRange(Number(b.dataset.range))));
  $("#rangeSelect").addEventListener("change", (e) => setRange(Number(e.target.value)));
  $("#historyRange").addEventListener("change", (e) => { state.historyRange = Number(e.target.value); renderStats(); redrawCharts(); });

  $("#thresholdForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const a = Number($("#alertInput").value), d = Number($("#dangerInput").value);
    const fb = $("#thresholdFeedback");
    if (!Number.isInteger(a) || !Number.isInteger(d) || a < 1 || d > 400 || a >= d) {
      fb.dataset.tone = "error";
      fb.textContent = "Ambang tidak valid. Gunakan bilangan bulat 1–400 dan pastikan Siaga lebih rendah daripada Bahaya.";
      return;
    }
    if (await sendCmd({ siaga: a, bahaya: d })) {
      fb.dataset.tone = "ok";
      fb.textContent = "Ambang dikirim ke alat. Nilai di dashboard berubah setelah alat mengonfirmasi.";
    }
  });

  $("#buzzerSwitch").addEventListener("click", () => {
    const mutedNow = num("mute") === 1;
    sendCmd({ mute: !mutedNow });
  });

  $("#notifFilter").addEventListener("change", renderNotifications);
  $("#markAllRead").addEventListener("click", () => {
    state.lastRead = Math.max(state.lastRead, ...state.notifications.map((n) => n.id), 0);
    store.set("aw_lastread", state.lastRead);
    renderNotifications();
    toast("Semua notifikasi ditandai telah dibaca.");
  });

  $("#mapToggle").addEventListener("click", (e) => {
    const btn = e.currentTarget;
    const open = btn.getAttribute("aria-expanded") !== "true";
    btn.setAttribute("aria-expanded", String(open));
    $("#mapBody").hidden = !open;
  });
  $("#csvButton").addEventListener("click", downloadCsv);
  $("#mapDetail").addEventListener("click", () => toast(`Titik pantau: ${state.device?.name || "-"} (${state.device?.topic || "-"})`));

  // login admin
  const dlg = $("#loginDialog");
  function openLogin() { $("#loginError").textContent = ""; if (dlg.showModal) dlg.showModal(); else dlg.setAttribute("open", ""); }
  $("#loginCancel").addEventListener("click", () => dlg.close());
  $("#loginForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await api("POST", "/api/login", Object.fromEntries(new FormData(e.target)));
      dlg.close();
      location.reload(); // muat ulang agar koneksi real-time membawa sesi admin
    } catch (err) { $("#loginError").textContent = err.message; }
  });

  // menu profil
  const profileButton = $("#profileButton");
  const profileMenu = $("#profileMenu");
  function setMenu(open) {
    profileMenu.hidden = !open;
    profileButton.setAttribute("aria-expanded", String(open));
    if (open) profileMenu.querySelector(".menu-item")?.focus();
  }
  profileButton.addEventListener("click", (e) => { e.stopPropagation(); setMenu(profileMenu.hidden); });
  profileMenu.addEventListener("click", async (e) => {
    const action = e.target.closest("[data-profile-action]")?.dataset.profileAction;
    if (!action) return;
    setMenu(false);
    profileButton.focus();
    if (action === "auth") {
      if (state.admin) { await api("POST", "/api/logout"); location.reload(); } else openLogin();
    } else if (action === "notify") {
      if (!("Notification" in window)) return toast("Browser ini tidak mendukung notifikasi.");
      const r = await Notification.requestPermission();
      toast(r === "granted" ? "Notifikasi browser aktif. Peringatan muncul selama halaman ini terbuka." : "Izin notifikasi ditolak.");
    } else if (action === "csv") downloadCsv();
    else if (action === "console" && state.admin) location.href = "/console/";
    else if (action === "data" && state.admin) location.href = "/data/";
  });
  document.addEventListener("click", (e) => { if (!profileMenu.hidden && !e.target.closest(".profile")) setMenu(false); });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !profileMenu.hidden) { setMenu(false); profileButton.focus(); }
  });

  /* ------------------------------------------------------------ peringatan browser */
  function beep() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      for (let i = 0; i < 3; i++) {
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.frequency.value = 880; o.connect(g); g.connect(ctx.destination);
        g.gain.setValueAtTime(0.25, ctx.currentTime + i * 0.35); g.gain.setValueAtTime(0, ctx.currentTime + i * 0.35 + 0.2);
        o.start(ctx.currentTime + i * 0.35); o.stop(ctx.currentTime + i * 0.35 + 0.22);
      }
    } catch { /* audio diblokir sebelum ada interaksi */ }
  }
  function alertUser(ev) {
    if (ev.level === "info") return;
    if (ev.level === "critical") beep();
    toast(ev.message);
    if ("Notification" in window && Notification.permission === "granted") {
      try { new Notification(ev.level === "critical" ? "🚨 AWASAIR" : "⚠️ AWASAIR", { body: ev.message, icon: "/assets/logo-awasair.svg", tag: "awasair" }); } catch { /* abaikan */ }
    }
  }

  /* ------------------------------------------------------------ data & real-time */
  async function loadHistory() {
    const rows = await api("GET", `/api/devices/${state.device.id}/history?key=level&minutes=1440`);
    state.points = rows.map((r) => ({ t: r.ts, v: Number(r.v) })).filter((p) => Number.isFinite(p.v));
  }
  async function loadEvents() {
    const evs = await api("GET", `/api/devices/${state.device.id}/events?limit=100`);
    state.notifications = evs.map(toNotif);
  }

  function onMessage(m) {
    if (!state.device || m.d !== state.device.id) return;
    if (m.t === "v") {
      state.values[m.k] = { v: m.v, ts: m.ts };
      if (m.src === "device" || m.src === "api") state.lastData = m.ts;
      if (m.k === "level") {
        const v = Number(m.v);
        if (Number.isFinite(v)) state.points.push({ t: m.ts, v });
        const cut = Date.now() - 24 * 3600000;
        while (state.points.length && state.points[0].t < cut) state.points.shift();
      }
      if (m.src === "ack") state.ackTs = m.ts;
    } else if (m.t === "ack") {
      if (state.pending) toast("Alat mengonfirmasi pengaturan baru.");
      state.pending = null;
    } else if (m.t === "ack-timeout") {
      if (state.pending) { state.pending = null; toast("Alat belum mengonfirmasi perintah. Pastikan perangkat online."); }
    } else if (m.t === "online") {
      state.online = m.online;
    } else if (m.t === "event") {
      state.notifications.unshift(toNotif(m.ev));
      alertUser(m.ev);
    } else if (m.t === "config") {
      init();
      return;
    } else return;
    scheduleRender();
  }
  let renderRaf = 0;
  function scheduleRender() { cancelAnimationFrame(renderRaf); renderRaf = requestAnimationFrame(renderAll); }

  let wsRetry = 1000;
  function connectWs() {
    const ws = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/ws");
    ws.onopen = () => { wsRetry = 1000; state.wsOk = true; renderConnection(); };
    ws.onclose = () => {
      state.wsOk = false; renderConnection();
      setTimeout(() => { connectWs(); init(); }, wsRetry); // muat ulang data yang terlewat
      wsRetry = Math.min(wsRetry * 2, 15000);
    };
    ws.onmessage = (e) => { try { onMessage(JSON.parse(e.data)); } catch (err) { console.error(err); } };
  }

  async function init() {
    try {
      const me = await api("GET", "/api/me");
      state.admin = me.admin;
      state.roleKnown = true;
      applyRole();
      showPage(location.hash.slice(1));
      const devices = await api("GET", "/api/devices");
      const want = new URLSearchParams(location.search).get("device");
      state.device = devices.find((d) => d.id === want) || devices.find((d) => d.config?.contract === "awasair-v1") || devices[0];
      if (!state.device) { toast("Belum ada perangkat di AwasLink."); return; }
      state.values = state.device.values || {};
      state.online = state.device.online;
      state.lastData = state.device.last_seen || 0;
      state.ackTs = Math.max(0, ...["mute", "siaga", "bahaya"].map((k) => state.values[k]?.ts || 0));
      await Promise.all([loadHistory(), loadEvents()]);
      renderAll();
    } catch (e) {
      toast(e.status === 401 ? "Dashboard ini memerlukan login admin." : "Gagal memuat data: " + e.message);
      if (e.status === 401) openLogin();
    }
  }

  /* ------------------------------------------------------------ jam */
  function tick() {
    const now = new Date();
    $("#clockTime").textContent = hhmm(now);
    $("#clockDate").textContent = shortDate(now);
  }

  /* ------------------------------------------------------------ mulai */
  setupChart($("#levelChart"), () => state.range);
  setupChart($("#historyChart"), () => state.historyRange);
  setRange([6, 12, 24].includes(state.range) ? state.range : 6);
  tick();
  setInterval(tick, 1000);
  // cek data basi tiap 5 detik (status berubah ke OFFLINE bila alat berhenti mengirim)
  setInterval(() => { renderStatus(); renderConnection(); redrawCharts(); }, 5000);
  showPage(location.hash.slice(1) || "beranda");
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(redrawCharts);
  init().then(connectWs);
})();
