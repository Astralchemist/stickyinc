(() => {
  // ── live pane demo (fixed, right edge) ───────────────────────────────
  const strip = document.querySelector('.demo-strip');
  const tasks = document.querySelectorAll('.demo-task');
  const countEl = document.getElementById('demo-count');

  if (strip && tasks.length && countEl) {
    let pinTimer = null;
    strip.addEventListener('mouseenter', () => {
      clearTimeout(pinTimer);
      strip.classList.add('open');
    });
    strip.addEventListener('mouseleave', () => {
      clearTimeout(pinTimer);
      pinTimer = setTimeout(() => strip.classList.remove('open'), 900);
    });

    const updateCount = () => {
      const open = Array.from(tasks).filter((t) => !t.classList.contains('done')).length;
      countEl.textContent = `${open} open`;
      strip.classList.toggle('has-due', open === 0);
    };

    tasks.forEach((task) => {
      task.addEventListener('click', (e) => {
        e.stopPropagation();
        task.classList.toggle('done');
        updateCount();
      });
    });

    const revealOnce = () => {
      strip.classList.add('open');
      setTimeout(() => strip.classList.remove('open'), 2200);
    };
    if (document.readyState === 'complete') revealOnce();
    else window.addEventListener('load', () => setTimeout(revealOnce, 900));
  }

  // ── highlight the download card that matches the visitor's platform ─
  const ua = navigator.userAgent || '';
  const platform = navigator.platform || '';
  let detected = null;
  if (/Mac|iPhone|iPad|iPod/.test(ua) || /Mac/.test(platform)) detected = 'mac';
  else if (/Win/.test(ua) || /Win/.test(platform)) detected = 'win';
  else if (/Linux|X11/.test(ua) || /Linux/.test(platform)) detected = 'linux';

  if (detected) {
    // Highlight the first card that matches. Multiple Windows / Linux cards
    // exist — we only decorate the first so the visitor sees a single primary.
    const match = document.querySelector(`.dl-card .dl-btn[data-platform="${detected}"]`);
    if (match) {
      const card = match.closest('.dl-card');
      if (card) card.classList.add('detected');
    }
  }
})();
