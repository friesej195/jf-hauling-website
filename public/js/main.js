(function () {
  const t = document.querySelector('.nav-toggle'), n = document.getElementById('nav');
  if (t && n) t.addEventListener('click', () => { const o = n.classList.toggle('open'); t.setAttribute('aria-expanded', o); });
  const here = location.pathname.replace(/\.html$/, '').replace(/\/index$/, '/') || '/';
  document.querySelectorAll('.nav a:not(.btn)').forEach((a) => { if (a.getAttribute('href') === here) a.classList.add('active'); });
  // Contact form
  const f = document.getElementById('contact-form');
  if (f) f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const st = f.querySelector('.form-status'); const btn = f.querySelector('button');
    btn.disabled = true; st.className = 'form-status'; st.textContent = 'Sending…';
    try {
      const r = await fetch('/api/contact', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.fromEntries(new FormData(f))) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'Something went wrong');
      f.reset(); st.className = 'form-status ok'; st.textContent = 'Thanks — your message was sent. We’ll be in touch soon.';
    } catch (err) { st.className = 'form-status err'; st.textContent = err.message; }
    btn.disabled = false;
  });
})();
