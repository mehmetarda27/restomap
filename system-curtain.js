(() => {
  "use strict";

  if (window.__deliveraSystemCurtainLoaded) return;
  window.__deliveraSystemCurtainLoaded = true;

  const STATUS_URL = "/api/system-curtain/status";
  const POLL_INTERVAL_MS = 4000;
  const REQUEST_TIMEOUT_MS = 3500;
  const ROOT_ID = "delivera-system-curtain";
  let root = null;
  let canvas = null;
  let context = null;
  let animationFrame = 0;
  let pollTimer = 0;
  let requestInFlight = false;
  let curtainActive = false;
  let columns = [];

  function installStyles() {
    if (document.getElementById("delivera-system-curtain-style")) return;
    const style = document.createElement("style");
    style.id = "delivera-system-curtain-style";
    style.textContent = `
      #${ROOT_ID} {
        position: fixed;
        inset: 0;
        z-index: 2147483647;
        display: grid;
        place-items: center;
        overflow: hidden;
        background: #020805;
        color: #eefcf4;
        opacity: 0;
        visibility: hidden;
        pointer-events: none;
        transition: opacity 220ms ease, visibility 0s linear 220ms;
        isolation: isolate;
        overscroll-behavior: contain;
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      #${ROOT_ID}.is-active {
        opacity: 1;
        visibility: visible;
        pointer-events: all;
        transition: opacity 220ms ease;
      }
      #${ROOT_ID} .delivera-curtain-canvas {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        opacity: .68;
      }
      #${ROOT_ID}::before {
        content: "";
        position: absolute;
        inset: 0;
        background: radial-gradient(circle at center, rgba(5, 36, 20, .25), rgba(0, 5, 3, .88) 72%);
        z-index: 1;
      }
      #${ROOT_ID} .delivera-curtain-card {
        position: relative;
        z-index: 2;
        width: min(650px, calc(100vw - 36px));
        padding: clamp(28px, 5vw, 54px);
        border: 1px solid rgba(50, 255, 132, .34);
        border-radius: 22px;
        background: rgba(1, 14, 8, .88);
        box-shadow: 0 28px 90px rgba(0, 0, 0, .64), inset 0 0 42px rgba(18, 190, 86, .06);
        text-align: center;
        backdrop-filter: blur(10px);
      }
      #${ROOT_ID} .delivera-curtain-symbol {
        display: grid;
        place-items: center;
        width: 68px;
        height: 68px;
        margin: 0 auto 24px;
        border: 1px solid rgba(53, 255, 137, .45);
        border-radius: 18px;
        background: rgba(21, 179, 84, .12);
        color: #45ff91;
        font: 700 28px/1 ui-monospace, SFMono-Regular, Consolas, monospace;
        box-shadow: 0 0 34px rgba(25, 255, 118, .12);
      }
      #${ROOT_ID} .delivera-curtain-kicker {
        margin: 0 0 12px;
        color: #4dff9a;
        font: 700 12px/1.4 ui-monospace, SFMono-Regular, Consolas, monospace;
        letter-spacing: .18em;
        text-transform: uppercase;
      }
      #${ROOT_ID} .delivera-curtain-title {
        margin: 0;
        color: #f5fff9;
        font-size: clamp(28px, 5vw, 44px);
        font-weight: 800;
        line-height: 1.08;
        letter-spacing: -.035em;
      }
      #${ROOT_ID} .delivera-curtain-copy {
        max-width: 480px;
        margin: 18px auto 0;
        color: rgba(226, 245, 234, .74);
        font-size: clamp(15px, 2.5vw, 18px);
        line-height: 1.65;
      }
      #${ROOT_ID} .delivera-curtain-code {
        display: inline-flex;
        align-items: center;
        gap: 9px;
        margin-top: 25px;
        padding: 10px 14px;
        border-radius: 999px;
        background: rgba(37, 255, 126, .08);
        color: #6dffa7;
        font: 600 12px/1.2 ui-monospace, SFMono-Regular, Consolas, monospace;
      }
      #${ROOT_ID} .delivera-curtain-code::before {
        content: "";
        width: 8px;
        height: 8px;
        border-radius: 999px;
        background: #39ff85;
        box-shadow: 0 0 12px #39ff85;
      }
      @media (prefers-reduced-motion: reduce) {
        #${ROOT_ID} { transition: none; }
        #${ROOT_ID} .delivera-curtain-canvas { display: none; }
      }
    `;
    document.head.appendChild(style);
  }

  function ensureRoot() {
    if (root?.isConnected) return root;
    installStyles();
    root = document.getElementById(ROOT_ID) || document.createElement("div");
    root.id = ROOT_ID;
    root.setAttribute("role", "alertdialog");
    root.setAttribute("aria-modal", "true");
    root.setAttribute("aria-hidden", "true");
    root.innerHTML = `
      <canvas class="delivera-curtain-canvas" aria-hidden="true"></canvas>
      <section class="delivera-curtain-card" aria-labelledby="delivera-curtain-title">
        <div class="delivera-curtain-symbol" aria-hidden="true">&gt;_</div>
        <p class="delivera-curtain-kicker">RESTOMAP · Sistem bildirimi</p>
        <h1 class="delivera-curtain-title" id="delivera-curtain-title">Sistem geçici olarak kullanılamıyor</h1>
        <p class="delivera-curtain-copy">Veri tabanı bağlantı hatası algılandı. Lütfen teknik destek ekibiyle iletişime geçin.</p>
        <div class="delivera-curtain-code">ERR_DATABASE_CONNECTION</div>
      </section>
    `;
    document.body.appendChild(root);
    canvas = root.querySelector("canvas");
    context = canvas?.getContext("2d") || null;
    root.addEventListener("wheel", (event) => event.preventDefault(), { passive: false });
    root.addEventListener("touchmove", (event) => event.preventDefault(), { passive: false });
    return root;
  }

  function sizeCanvas() {
    if (!canvas || !context) return;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(1, window.innerWidth);
    const height = Math.max(1, window.innerHeight);
    canvas.width = Math.floor(width * ratio);
    canvas.height = Math.floor(height * ratio);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    columns = Array.from({ length: Math.ceil(width / 18) }, () => Math.random() * -height / 18);
  }

  function drawMatrix() {
    if (!curtainActive || !context || !canvas) return;
    const width = window.innerWidth;
    const height = window.innerHeight;
    context.fillStyle = "rgba(0, 8, 4, .12)";
    context.fillRect(0, 0, width, height);
    context.fillStyle = "rgba(50, 255, 127, .72)";
    context.font = "14px ui-monospace, SFMono-Regular, Consolas, monospace";
    for (let index = 0; index < columns.length; index += 1) {
      const glyph = String.fromCharCode(0x30A0 + Math.floor(Math.random() * 96));
      const x = index * 18;
      const y = columns[index] * 18;
      context.fillText(glyph, x, y);
      if (y > height && Math.random() > .975) columns[index] = Math.random() * -30;
      columns[index] += .7 + Math.random() * .45;
    }
    animationFrame = window.requestAnimationFrame(drawMatrix);
  }

  function startAnimation() {
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    window.cancelAnimationFrame(animationFrame);
    sizeCanvas();
    drawMatrix();
  }

  function stopAnimation() {
    window.cancelAnimationFrame(animationFrame);
    animationFrame = 0;
    context?.clearRect(0, 0, window.innerWidth, window.innerHeight);
  }

  function applyState(active) {
    const nextActive = active === true;
    if (nextActive === curtainActive && root) return;
    curtainActive = nextActive;
    const overlay = ensureRoot();
    overlay.classList.toggle("is-active", curtainActive);
    overlay.setAttribute("aria-hidden", curtainActive ? "false" : "true");
    if (curtainActive) startAnimation();
    else stopAnimation();
    window.dispatchEvent(new CustomEvent("delivera:curtain-change", { detail: { active: curtainActive } }));
  }

  async function refreshState() {
    if (requestInFlight) return;
    requestInFlight = true;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(`${STATUS_URL}?t=${Date.now()}`, {
        method: "GET",
        cache: "no-store",
        credentials: "same-origin",
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });
      if (!response.ok) return;
      const payload = await response.json();
      if (payload && typeof payload.active === "boolean") applyState(payload.active);
    } catch {
      // Fail open: a curtain status error must never interrupt the panel runtime.
    } finally {
      window.clearTimeout(timeout);
      requestInFlight = false;
    }
  }

  function schedulePolling() {
    window.clearInterval(pollTimer);
    pollTimer = window.setInterval(refreshState, POLL_INTERVAL_MS);
  }

  function boot() {
    ensureRoot();
    refreshState();
    schedulePolling();
    window.addEventListener("online", refreshState);
    window.addEventListener("focus", refreshState);
    window.addEventListener("resize", () => {
      if (curtainActive) sizeCanvas();
    });
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) refreshState();
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot, { once: true });
  else boot();
})();
