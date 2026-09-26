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

  // ── point the download cards at the newest release ───────────────────
  // Asset names carry the version, so the static hrefs are pinned to a
  // release that exists. Swap in the latest one's files if GitHub answers.
  const dlButtons = document.querySelectorAll('.dl-btn[data-asset]');
  if (dlButtons.length) {
    fetch('https://api.github.com/repos/Astralchemist/stickyinc/releases/latest')
      .then((r) => (r.ok ? r.json() : null))
      .then((release) => {
        if (!release || !Array.isArray(release.assets)) return;
        dlButtons.forEach((btn) => {
          const asset = release.assets.find((a) => a.name.endsWith(btn.dataset.asset));
          if (!asset) return;
          btn.href = asset.browser_download_url;
          const file = btn.closest('.dl-card')?.querySelector('.dl-file');
          if (file) file.textContent = asset.name;
        });
      })
      .catch(() => {});
  }
})();
