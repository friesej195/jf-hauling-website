// Quote assistant UI: floating widget on every page, embedded on /quote.
(function () {
  const KEY = 'qa-state-v1';
  const ICON_TRUCK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 16v-4h9V9h5l3 3.5 3 .5v3"/><path d="M2 16h20"/><circle cx="6" cy="17.5" r="1.8"/><circle cx="15" cy="17.5" r="1.8"/><circle cx="19" cy="17.5" r="1.8"/></svg>';
  const ICON_SEND = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4z"/></svg>';
  const LAUNCH_HTML = '<span class="qa-launch-note">Get a quote in seconds</span><span class="qa-launch-label">Get a Quote</span>';
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const md = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  const money = (n) => '$' + Number(n).toLocaleString('en-CA');

  function build() {
    const el = document.createElement('div');
    el.className = 'qa';
    el.setAttribute('role', 'dialog'); el.setAttribute('aria-label', 'Instant quote');
    el.innerHTML = `
      <div class="qa-head"><div class="qa-avatar">${ICON_TRUCK}</div>
        <div><div class="qa-title">Instant Quote</div><div class="qa-sub">Answer a few questions for a ballpark price. Dispatch will follow up.</div></div>
        <button class="qa-x" aria-label="Close">×</button></div>
      <div class="qa-body" aria-live="polite"></div>
      <div class="qa-quick"></div>
      <form class="qa-form" autocomplete="on"><input type="text" aria-label="Your answer" placeholder="Type your answer…"><button type="submit" aria-label="Send">${ICON_SEND}</button></form>
      <div class="qa-foot">Estimates are ballpark figures pending dispatcher confirmation. <a href="#" class="qa-reset">Start over</a></div>`;
    return el;
  }

  let ui, state = { sessionId: null, items: [], last: null }, busy = false, started = false;
  function load() {
    try {
      if (typeof sessionStorage === 'undefined' || !sessionStorage) return { sessionId: null, items: [], last: null };
      return JSON.parse(sessionStorage.getItem(KEY)) || { sessionId: null, items: [], last: null };
    } catch (e) { return { sessionId: null, items: [], last: null }; }
  }
  function save() {
    try {
      if (typeof sessionStorage === 'undefined' || !sessionStorage) return;
      sessionStorage.setItem(KEY, JSON.stringify(state));
    } catch (e) {}
  }

  function mount(container) {
    ui = build();
    container.appendChild(ui);
    ui.body = ui.querySelector('.qa-body'); ui.quick = ui.querySelector('.qa-quick');
    ui.form = ui.querySelector('form'); ui.input = ui.form.querySelector('input'); ui.send = ui.form.querySelector('button');
    ui.form.addEventListener('submit', (e) => { e.preventDefault(); const v = ui.input.value.trim(); if (v) send(v, v); });
    ui.querySelector('.qa-reset').addEventListener('click', (e) => { e.preventDefault(); reset(); });
    return ui;
  }

  function addItem(item, persist = true) {
    if (persist) { state.items.push(item); save(); }
    let node;
    if (item.type === 'est') node = estCard(item.e);
    else { node = document.createElement('div'); node.className = 'qa-msg ' + item.from + (item.warn ? ' warn' : ''); node.innerHTML = md(item.text); }
    ui.body.appendChild(node);
    ui.body.scrollTop = ui.body.scrollHeight;
  }
  function estCard(e) {
    const d = document.createElement('div'); d.className = 'qa-est';
    d.innerHTML = `<small>Ballpark estimate (${esc(e.taxNote)})</small><div class="amt">${money(e.low)} – ${money(e.high)} <span style="font-size:1rem">${esc(e.currency)}</span></div>
      <small>Pending confirmation by our dispatcher.</small>
      ${e.muleNote ? `<div class="qa-mule">${esc(e.muleNote)}</div>` : ''}
      <details><summary>How we got this</summary><table>${e.lines.map((l) => `<tr><td>${esc(l.label)}</td><td>${money(l.amount.toFixed(0))}</td></tr>`).join('')}
      ${e.minimumApplied ? '<tr><td>Minimum charge applied</td><td></td></tr>' : ''}<tr><td><b>Midpoint</b></td><td><b>${money(e.subtotal)}</b></td></tr></table></details>
      ${e.isExample ? '<span class="ex">SAMPLE RATES — FOR DEMONSTRATION</span>' : ''}`;
    return d;
  }
  function typing(on) {
    const t = ui.body.querySelector('.qa-typing');
    if (on && !t) { const n = document.createElement('div'); n.className = 'qa-msg bot qa-typing'; n.innerHTML = '<i></i><i></i><i></i>'; ui.body.appendChild(n); ui.body.scrollTop = ui.body.scrollHeight; }
    if (!on && t) t.remove();
  }
  function controls(r) {
    ui.quick.innerHTML = '';
    ui.quick.classList.toggle('qa-widths', r.step === 'shedWidthFt');
    ui.quick.classList.toggle('qa-lengths', r.step === 'shedLengthFt');
    (r.quickReplies || []).forEach((q) => {
      const b = document.createElement('button'); b.type = 'button'; b.textContent = q.label;
      b.addEventListener('click', () => { if (q.value === 'limit:call') { const a = document.querySelector('a[href^="tel:"]'); if (a) location.href = a.href; } send(q.value, q.label); });
      ui.quick.appendChild(b);
    });
    const choiceOnly = r.input === 'choice';
    ui.form.hidden = choiceOnly;
    const types = { email: 'email', tel: 'tel', date: 'date' };
    ui.input.type = types[r.input] || 'text';
    if (r.input === 'date') {
      try { ui.input.min = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10); } catch (e) {}
    }
    ui.input.placeholder = r.input === 'none' ? 'Choose an option above, or type here…' : (r.placeholder || 'Type your answer…');
    ui.input.autocomplete = { name: 'name', company: 'organization', email: 'email', phone: 'tel' }[r.step] || 'off';
    ui.input.disabled = !!r.done; ui.send.disabled = !!r.done;
  }
  function render(r) {
    (r.messages || []).forEach((m, i) => {
      addItem({ from: 'bot', text: m, warn: r.step === 'overLimit' || (r.step === 'review' && r.flags && r.flags.length && i === r.messages.length - 1) });
    });
    if (r.estimate) addItem({ type: 'est', e: r.estimate });
    state.sessionId = r.sessionId; state.last = r; save();
    controls(r);
  }

  async function call(url, body) {
    if (typeof fetch !== 'function') throw new Error('Connection problem — please try again.');
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(j.error || 'Connection problem — please try again.');
    return j;
  }
  async function send(value, label) {
    if (busy) return;
    busy = true; ui.input.value = ''; ui.quick.innerHTML = '';
    addItem({ from: 'me', text: label });
    typing(true);
    try { const r = await call('/api/chat', { sessionId: state.sessionId, text: value }); await pause(350); typing(false); render(r); }
    catch (e) { typing(false); addItem({ from: 'bot', text: e.message, warn: true }); if (state.last) controls(state.last); }
    busy = false;
    if (!('ontouchstart' in window) && !ui.form.hidden) ui.input.focus();
  }
  const pause = (ms) => new Promise((r) => setTimeout(r, ms));
  async function begin() {
    if (started) return; started = true;
    if (state.sessionId && state.items.length) { state.items.forEach((it) => addItem(it, false)); if (state.last) controls(state.last); return; }
    typing(true);
    try { const r = await call('/api/chat/start'); typing(false); render(r); } catch (e) { typing(false); addItem({ from: 'bot', text: e.message, warn: true }, false); started = false; }
  }
  function reset() {
    state = { sessionId: null, items: [], last: null }; save();
    ui.body.innerHTML = ''; ui.quick.innerHTML = ''; started = false; begin();
  }

  function ensureLaunch() {
    let launch = document.getElementById('qa-launch');
    if (!launch) {
      launch = document.createElement('a');
      launch.id = 'qa-launch';
      launch.className = 'qa-launch';
      launch.href = '/quote';
      launch.innerHTML = LAUNCH_HTML;
      (document.body || document.documentElement).appendChild(launch);
    }
    return launch;
  }

  // Lift the pill above in-app browser toolbars when the visual viewport
  // doesn't reach the bottom of the layout viewport. Safe-area CSS covers
  // the home indicator; this only adds extra offset when a toolbar overlaps.
  function bindViewportPin(launch) {
    try {
      const vv = window.visualViewport;
      if (!vv || typeof vv.addEventListener !== 'function') return;
      const pin = () => {
        try {
          const overlap = Math.max(0, Math.round((window.innerHeight || 0) - (vv.height || 0) - (vv.offsetTop || 0)));
          const lift = overlap > 24 ? Math.min(overlap, 180) : 0;
          launch.style.bottom = lift ? 'calc(' + lift + 'px + 14px + env(safe-area-inset-bottom, 0px))' : '';
        } catch (e) {}
      };
      pin();
      vv.addEventListener('resize', pin);
      vv.addEventListener('scroll', pin);
    } catch (e) {}
  }

  try {
    const embed = document.getElementById('qa-embed');
    state = load();
    if (embed) {
      const stray = document.getElementById('qa-launch');
      if (stray) stray.hidden = true;
      mount(embed);
      begin();
      document.querySelectorAll('[data-qa-prefill]').forEach((b) => b.addEventListener('click', () => { try { ui.input.focus(); } catch (e) {} }));
    } else {
      const launch = ensureLaunch();
      try { if (document.body && launch.parentNode !== document.body) document.body.appendChild(launch); } catch (e) {}
      const pop = document.createElement('div');
      pop.className = 'qa-pop';
      (document.body || document.documentElement).appendChild(pop);
      mount(pop);
      const open = () => { pop.classList.add('open'); launch.style.display = window.innerWidth < 560 ? 'none' : ''; begin(); setTimeout(() => { try { ui.input.focus(); } catch (e) {} }, 50); };
      const close = () => { pop.classList.remove('open'); launch.style.display = ''; };
      launch.addEventListener('click', (e) => { if (e && e.preventDefault) e.preventDefault(); pop.classList.contains('open') ? close() : open(); });
      const x = ui.querySelector('.qa-x');
      if (x) x.addEventListener('click', close);
      document.querySelectorAll('[data-open-qa]').forEach((b) => b.addEventListener('click', (e) => { e.preventDefault(); open(); }));
      window.QA = { open, close };
      bindViewportPin(launch);
    }
  } catch (e) {
    try { if (!document.getElementById('qa-embed')) ensureLaunch(); } catch (e2) {}
  }
})();
