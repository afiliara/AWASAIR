// MiniChart: grafik garis deret waktu berbasis <canvas>, tanpa library eksternal.
// Dipakai oleh AwasSpeak dan AwasLink.
//   const c = new MiniChart(canvasEl, { color:'#2a7de1', unit:'cm', lines:[{value:200,label:'Siaga',color:'#e0a800'}] })
//   c.setData([{ t: Date|number|string, v: number }, ...])
(function () {
  function niceStep(range, ticks) {
    const raw = range / Math.max(ticks, 1);
    const mag = Math.pow(10, Math.floor(Math.log10(raw || 1)));
    const n = raw / mag;
    return (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * mag;
  }
  const pad2 = (n) => String(n).padStart(2, '0');
  function fmtTime(ms, span) {
    const d = new Date(ms);
    if (span > 2 * 86400000) return pad2(d.getDate()) + '/' + pad2(d.getMonth() + 1);
    if (span > 3600000) return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
  }
  function fmtFull(ms) {
    const d = new Date(ms);
    return pad2(d.getDate()) + '/' + pad2(d.getMonth() + 1) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
  }
  function cssVar(el, name, fallback) {
    const v = getComputedStyle(el).getPropertyValue(name).trim();
    return v || fallback;
  }

  class MiniChart {
    constructor(canvas, opts = {}) {
      this.c = canvas;
      this.o = Object.assign({ color: '#2a7de1', unit: '', lines: [], min: null, max: null, fill: true }, opts);
      this.data = [];
      this.hover = null;
      this.ro = new ResizeObserver(() => this.draw());
      this.ro.observe(canvas);
      canvas.addEventListener('mousemove', (e) => { this.hover = e.offsetX; this.draw(); });
      canvas.addEventListener('mouseleave', () => { this.hover = null; this.draw(); });
      canvas.addEventListener('touchstart', (e) => { const r = canvas.getBoundingClientRect(); this.hover = e.touches[0].clientX - r.left; this.draw(); }, { passive: true });
    }
    setData(points) {
      this.data = points
        .filter((p) => p.v !== null && p.v !== undefined && p.v !== '')
        .map((p) => ({ t: new Date(p.t).getTime(), v: Number(p.v) }))
        .filter((p) => Number.isFinite(p.v) && Number.isFinite(p.t))
        .sort((a, b) => a.t - b.t);
      this.draw();
    }
    push(p, maxPoints = 500) {
      if (p.v === null || p.v === undefined || p.v === '') return;
      const t = new Date(p.t).getTime(); const v = Number(p.v);
      if (!Number.isFinite(v)) return;
      this.data.push({ t, v });
      if (this.data.length > maxPoints) this.data.shift();
      this.draw();
    }
    setLines(lines) { this.o.lines = lines || []; this.draw(); }
    draw() {
      const c = this.c; const dpr = window.devicePixelRatio || 1;
      const W = c.clientWidth; const H = c.clientHeight;
      if (!W || !H) return;
      if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) { c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); }
      const g = c.getContext('2d');
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, W, H);
      const muted = cssVar(c, '--muted', '#888');
      const grid = cssVar(c, '--grid', 'rgba(128,128,128,.18)');
      const fg = cssVar(c, '--fg', '#222');
      const bg = cssVar(c, '--card', '#fff');
      g.font = '11px system-ui, sans-serif';
      const L = 44, R = 10, T = 10, B = 22;
      const pw = W - L - R, ph = H - T - B;
      const d = this.data;
      if (!d.length) {
        g.fillStyle = muted; g.textAlign = 'center'; g.fillText('Belum ada data', W / 2, H / 2); return;
      }
      let ymin = Math.min(...d.map((p) => p.v)); let ymax = Math.max(...d.map((p) => p.v));
      for (const l of this.o.lines) { ymin = Math.min(ymin, l.value); ymax = Math.max(ymax, l.value); }
      if (this.o.min != null) ymin = Math.min(ymin, this.o.min);
      if (this.o.max != null) ymax = Math.max(ymax, this.o.max);
      if (ymin === ymax) { ymin -= 1; ymax += 1; }
      const step = niceStep(ymax - ymin, 4);
      ymin = Math.floor(ymin / step) * step; ymax = Math.ceil(ymax / step) * step;
      const t0 = d[0].t; const t1 = d.length > 1 ? d[d.length - 1].t : t0 + 1000;
      const X = (t) => L + ((t - t0) / (t1 - t0 || 1)) * pw;
      const Y = (v) => T + ph - ((v - ymin) / (ymax - ymin)) * ph;

      // grid + label Y
      g.strokeStyle = grid; g.lineWidth = 1; g.fillStyle = muted; g.textAlign = 'right'; g.textBaseline = 'middle';
      for (let v = ymin; v <= ymax + step / 2; v += step) {
        const y = Math.round(Y(v)) + 0.5;
        g.beginPath(); g.moveTo(L, y); g.lineTo(W - R, y); g.stroke();
        g.fillText(+v.toFixed(2), L - 6, y);
      }
      // label X
      g.textAlign = 'center'; g.textBaseline = 'top';
      const nx = Math.max(2, Math.floor(pw / 90));
      for (let i = 0; i <= nx; i++) {
        const t = t0 + ((t1 - t0) * i) / nx;
        g.fillText(fmtTime(t, t1 - t0), Math.min(Math.max(X(t), L + 20), W - R - 20), H - B + 6);
      }
      // garis ambang
      for (const l of this.o.lines) {
        const y = Y(l.value);
        g.strokeStyle = l.color || '#e0a800'; g.setLineDash([5, 4]);
        g.beginPath(); g.moveTo(L, y); g.lineTo(W - R, y); g.stroke(); g.setLineDash([]);
        if (l.label) { g.fillStyle = l.color || '#e0a800'; g.textAlign = 'left'; g.textBaseline = 'bottom'; g.fillText(l.label, L + 4, y - 2); }
      }
      // area + garis data
      const col = this.o.color;
      g.beginPath();
      d.forEach((p, i) => (i ? g.lineTo(X(p.t), Y(p.v)) : g.moveTo(X(p.t), Y(p.v))));
      if (this.o.fill && d.length > 1) {
        g.save(); g.lineTo(X(d[d.length - 1].t), T + ph); g.lineTo(X(d[0].t), T + ph); g.closePath();
        g.globalAlpha = 0.12; g.fillStyle = col; g.fill(); g.restore();
        g.beginPath(); d.forEach((p, i) => (i ? g.lineTo(X(p.t), Y(p.v)) : g.moveTo(X(p.t), Y(p.v))));
      }
      g.strokeStyle = col; g.lineWidth = 2; g.lineJoin = 'round'; g.stroke();
      if (d.length < 60) { g.fillStyle = col; d.forEach((p) => { g.beginPath(); g.arc(X(p.t), Y(p.v), 2.5, 0, 7); g.fill(); }); }

      // tooltip
      if (this.hover != null && this.hover >= L) {
        const tt = t0 + ((this.hover - L) / pw) * (t1 - t0);
        let best = d[0];
        for (const p of d) if (Math.abs(p.t - tt) < Math.abs(best.t - tt)) best = p;
        const x = X(best.t), y = Y(best.v);
        g.strokeStyle = muted; g.beginPath(); g.moveTo(x, T); g.lineTo(x, T + ph); g.stroke();
        g.fillStyle = col; g.beginPath(); g.arc(x, y, 4, 0, 7); g.fill();
        const label = `${+best.v.toFixed(2)} ${this.o.unit}`.trim(); const sub = fmtFull(best.t);
        g.font = 'bold 12px system-ui, sans-serif'; const w = Math.max(g.measureText(label).width, 90) + 14;
        const bx = Math.min(Math.max(x - w / 2, 2), W - w - 2); const by = Math.max(y - 46, 2);
        g.fillStyle = bg; g.strokeStyle = grid; g.beginPath(); g.rect(bx, by, w, 38); g.fill(); g.stroke();
        g.fillStyle = fg; g.textAlign = 'left'; g.textBaseline = 'top'; g.fillText(label, bx + 7, by + 5);
        g.font = '11px system-ui, sans-serif'; g.fillStyle = muted; g.fillText(sub, bx + 7, by + 21);
      }
    }
  }
  window.MiniChart = MiniChart;
})();
