(() => {
  const strip = document.querySelector('.demo-strip');
  const tasks = document.querySelectorAll('.demo-task');
  const countEl = document.getElementById('demo-count');
  if (!strip || !tasks.length || !countEl) return;

  // Let hover briefly pin the expanded state so the user can interact.
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

  // Subtle first-load cue: fade the pane in slightly late, once the page has settled.
  const revealOnce = () => {
    strip.classList.add('open');
    setTimeout(() => strip.classList.remove('open'), 2200);
  };
  if (document.readyState === 'complete') revealOnce();
  else window.addEventListener('load', () => setTimeout(revealOnce, 900));
})();
