(() => {
  "use strict";

  const ROOT_SELECTOR = ".delivera-auth-shell";

  function ensureStyle() {
    if (document.getElementById("deliveraAuthStyle")) return;
    const style = document.createElement("style");
    style.id = "deliveraAuthStyle";
    style.textContent = `
      html:has(${ROOT_SELECTOR}),body:has(${ROOT_SELECTOR}){overflow:hidden!important}
      ${ROOT_SELECTOR}{position:fixed;inset:0;z-index:2147483000;overflow:auto;background:radial-gradient(circle at 50% 35%,#2b180c 0,#15110e 32%,#090a0c 72%);color:#fff;font-family:Inter,Arial,sans-serif}
      .delivera-auth-stage{box-sizing:border-box;width:min(100%,960px);min-height:100dvh;margin:auto;padding:24px 28px;display:grid;grid-template-rows:auto minmax(230px,1fr) auto;gap:18px}
      .delivera-auth-title{position:relative;align-self:start;justify-self:center;margin:0;padding:16px 24px 18px;text-align:center;color:#fff;font-size:clamp(25px,3.2vw,36px);font-weight:800;line-height:1.15;letter-spacing:-.02em}
      .delivera-auth-title:after{content:"";position:absolute;left:50%;bottom:4px;width:54px;height:4px;border-radius:999px;background:#ff6900;transform:translateX(-50%);box-shadow:0 0 18px rgba(255,105,0,.5)}
      .delivera-auth-brand{align-self:center;justify-self:center;width:min(46vh,520px);max-width:72vw;aspect-ratio:1;min-width:230px;min-height:230px;padding:7px;border:1px solid rgba(255,120,35,.22);border-radius:30px;background:rgba(255,255,255,.025);box-shadow:0 24px 70px rgba(0,0,0,.36)}
      .delivera-auth-brand img{display:block;width:100%;height:100%;border-radius:24px;object-fit:contain;background:#fff}
      .delivera-auth-panel{box-sizing:border-box;align-self:end;width:min(100%,740px);margin:0 auto;padding:20px 22px 22px;border:1px solid rgba(255,255,255,.1);border-top-color:rgba(255,123,40,.48);border-radius:18px;background:rgba(24,24,26,.96);box-shadow:0 18px 55px rgba(0,0,0,.42)}
      .delivera-auth-description{margin:0 0 15px;color:#c9c3be;font-size:13px;text-align:center}
      .delivera-auth-form{display:grid;gap:13px}
      .delivera-auth-form-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px 14px}
      .delivera-auth-field{display:grid;gap:6px;min-width:0;color:#fff;font-size:13px;font-weight:700}
      .delivera-auth-field.full{grid-column:1/-1}
      .delivera-auth-field input{box-sizing:border-box;width:100%;height:46px;padding:0 13px;border:1px solid #4b4b50;border-radius:10px;outline:0;background:#f7f7f8;color:#171719;font:500 15px Inter,Arial,sans-serif;transition:border-color .18s,box-shadow .18s}
      .delivera-auth-field input:focus{border-color:#ff6b00;box-shadow:0 0 0 3px rgba(255,107,0,.18)}
      .delivera-auth-separator{grid-column:1/-1;display:flex;align-items:center;gap:12px;color:#dab89f;font-size:12px;text-align:center}
      .delivera-auth-separator:before,.delivera-auth-separator:after{content:"";height:1px;flex:1;background:rgba(255,255,255,.25)}
      .delivera-auth-error{min-height:18px;margin:0;color:#ffb4ab;font-size:13px;font-weight:700;text-align:center}
      .delivera-auth-submit{justify-self:end;min-width:155px;min-height:48px;padding:0 25px;border:0;border-radius:10px;background:#f56600;color:#fff;font-size:15px;font-weight:800;box-shadow:0 7px 18px rgba(245,102,0,.22);cursor:pointer;transition:background .18s,transform .18s}
      .delivera-auth-submit:hover{background:#ff7a20;transform:translateY(-1px)}.delivera-auth-submit:disabled{opacity:.6;cursor:wait;transform:none}
      @media(max-width:620px){${ROOT_SELECTOR}{background:linear-gradient(180deg,#16100c,#090a0c)}.delivera-auth-stage{padding:14px 12px;grid-template-rows:auto minmax(210px,1fr) auto;gap:12px}.delivera-auth-title{padding:11px 14px 15px;font-size:25px}.delivera-auth-brand{width:min(38vh,360px);max-width:82vw;min-width:210px;min-height:210px;border-radius:24px}.delivera-auth-brand img{border-radius:19px}.delivera-auth-panel{padding:16px 15px;border-radius:15px}.delivera-auth-form-grid{grid-template-columns:1fr}.delivera-auth-field.full,.delivera-auth-separator{grid-column:1}.delivera-auth-submit{width:100%}}
      @media(max-height:760px) and (min-width:621px){.delivera-auth-stage{padding-top:12px;padding-bottom:12px;grid-template-rows:auto minmax(180px,1fr) auto;gap:10px}.delivera-auth-title{padding-top:9px;padding-bottom:13px}.delivera-auth-brand{width:min(36vh,320px);min-width:205px;min-height:205px}.delivera-auth-stage:has(.delivera-auth-separator) .delivera-auth-brand{width:min(29vh,240px);min-width:198px;min-height:198px}.delivera-auth-panel{padding-top:14px;padding-bottom:14px}.delivera-auth-description{margin-bottom:9px}.delivera-auth-field input{height:42px}.delivera-auth-form{gap:8px}.delivera-auth-form-grid{gap:8px 12px}}
    `;
    document.head.appendChild(style);
  }

  function hide() {
    document.querySelector(ROOT_SELECTOR)?.remove();
  }

  function show({ title, description = "", fields = "", onSubmit, submitLabel = "Giriş Yap" }) {
    ensureStyle();
    hide();
    const root = document.createElement("div");
    root.className = "delivera-auth-shell delivera-login";
    root.innerHTML = `<main class="delivera-auth-stage" aria-labelledby="deliveraAuthTitle">
      <h1 id="deliveraAuthTitle" class="delivera-auth-title"></h1>
      <div class="delivera-auth-brand"><img src="/assets/restomap-package-logo.png?v=1" alt="RESTOMAP Tamamı Paket Takip Sistemi"></div>
      <section class="delivera-auth-panel">
        <p class="delivera-auth-description"></p>
        <form class="delivera-auth-form">
          <div class="delivera-auth-form-grid">${fields}</div>
          <p class="delivera-auth-error" role="alert" aria-live="polite"></p>
          <button class="delivera-auth-submit" type="submit"></button>
        </form>
      </section>
    </main>`;
    root.querySelector(".delivera-auth-title").textContent = title;
    const descriptionNode = root.querySelector(".delivera-auth-description");
    descriptionNode.textContent = description;
    descriptionNode.hidden = !description;
    const button = root.querySelector(".delivera-auth-submit");
    button.textContent = submitLabel;
    const form = root.querySelector("form");
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const errorNode = root.querySelector(".delivera-auth-error");
      errorNode.textContent = "";
      button.disabled = true;
      try {
        await onSubmit(new FormData(form), root);
      } catch (error) {
        errorNode.textContent = error?.message || "Giriş yapılamadı.";
      } finally {
        if (root.isConnected) button.disabled = false;
      }
    });
    document.body.appendChild(root);
    setTimeout(() => root.querySelector("input")?.focus(), 0);
    return root;
  }

  window.RestomapLoginShell = { show, hide };
  window.DeliveraLoginShell = window.RestomapLoginShell;
})();
