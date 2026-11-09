/* Landing page AWASAIR.
 * - Mulai: landing menyusut menjadi sidebar kiri (atau header atas di HP).
 * - Klik logo di sidebar/header: landing membesar kembali dari posisi sidebar. */
(() => {
  "use strict";
  const root = document.documentElement;
  const el = document.getElementById("landing");
  if (!el) return;

  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const shell = document.querySelector(".app-shell");
  const brand = document.getElementById("landingBrand");
  const btn = document.getElementById("landingStart");
  const wait = (ms) => new Promise((r) => window.setTimeout(r, reduce ? 20 : ms));

  // Tetesan hujan latar
  const drops = document.getElementById("landingDrops");
  for (let i = 0; i < 22; i++) {
    const d = document.createElement("i");
    d.style.setProperty("--x", `${Math.round(Math.random() * 100)}%`);
    d.style.setProperty("--h", `${28 + Math.round(Math.random() * 40)}px`);
    d.style.setProperty("--t", `${(1.6 + Math.random() * 1.8).toFixed(2)}s`);
    d.style.setProperty("--d", `${(-Math.random() * 3).toFixed(2)}s`);
    drops.append(d);
  }

  let busy = false;

  /** Brand sasaran (di sidebar, atau di header atas pada layar kecil) dan ukuran panel akhirnya. */
  function dock() {
    const side = document.querySelector(".sidebar");
    const sideVisible = !!side && getComputedStyle(side).display !== "none";
    const brandEl = sideVisible ? side.querySelector(".brand") : document.querySelector(".mobile-header .brand");
    return {
      sideVisible,
      rect: brandEl.getBoundingClientRect(),
      size: sideVisible ? side.getBoundingClientRect().width : document.querySelector(".mobile-header").getBoundingClientRect().height,
    };
  }

  /** Transformasi yang memindahkan brand landing (tanpa transform) ke posisi brand sidebar. */
  function dockTransform(d) {
    brand.style.transform = "";
    const from = brand.getBoundingClientRect();
    const scale = d.rect.height / from.height;
    const dx = d.rect.left + d.rect.width / 2 - (from.left + from.width / 2);
    const dy = d.rect.top + d.rect.height / 2 - (from.top + from.height / 2);
    return `translate(${dx}px, ${dy}px) scale(${scale})`;
  }

  const setSize = (d, shrunk) => {
    const v = shrunk ? `${d.size}px` : "";
    if (d.sideVisible) el.style.width = v; else el.style.height = v;
  };

  async function start() {
    if (busy) return;
    busy = true;
    const d = dock();
    el.classList.add("is-leaving");
    root.classList.add("landing-reveal");
    brand.style.animation = "none";
    brand.style.transform = dockTransform(d);
    setSize(d, true);
    await wait(1050);
    el.classList.add("is-done");
    await wait(380);
    root.classList.remove("landing-on", "landing-reveal", "landing-back");
    shell?.removeAttribute("inert");
    try { sessionStorage.setItem("awasair_started", "1"); } catch { /* mode privat */ }
    window.dispatchEvent(new Event("resize")); // grafik menyesuaikan ukuran
    document.getElementById("content")?.focus({ preventScroll: true });
    busy = false;
  }

  /** Kembali ke landing: mulai dari ukuran sidebar, lalu membesar memenuhi layar. */
  async function back() {
    if (busy) return;
    busy = true;
    const d = dock();
    shell?.setAttribute("inert", "");
    // Siapkan keadaan "menyusut" tanpa animasi
    el.style.transition = "none";
    brand.style.transition = "none";
    brand.style.animation = "none";
    el.classList.add("is-leaving", "is-done");
    root.classList.add("landing-back");
    setSize(d, false);
    brand.style.transform = dockTransform(d);
    setSize(d, true);
    el.getBoundingClientRect(); // paksa reflow
    el.classList.remove("is-done");
    el.getBoundingClientRect();
    el.style.transition = "";
    brand.style.transition = "";
    // Membesar
    await wait(30);
    el.classList.remove("is-leaving");
    setSize(d, false);
    brand.style.transform = "";
    await wait(1050);
    btn.focus({ preventScroll: true });
    busy = false;
  }

  btn.addEventListener("click", start);

  // Klik logo di sidebar atau header HP: kembali ke landing
  document.addEventListener("click", (e) => {
    const link = e.target.closest(".sidebar .brand, .mobile-header .brand");
    if (!link) return;
    e.preventDefault();
    e.stopPropagation();
    back();
  }, true);

  // Pertama kali dibuka dalam sesi
  if (root.classList.contains("landing-on")) {
    shell?.setAttribute("inert", "");
    btn.focus({ preventScroll: true });
  }
})();

// Bayangan tipis pada topbar yang menempel setelah halaman di-scroll
(() => {
  const bar = document.querySelector(".topbar");
  if (!bar) return;
  const update = () => bar.classList.toggle("is-stuck", window.scrollY > 4);
  window.addEventListener("scroll", update, { passive: true });
  update();
})();
