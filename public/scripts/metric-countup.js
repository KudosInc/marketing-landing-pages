/**
 * Counts each .metric-value up from zero the first time its card scrolls into
 * view. The final value stays in the HTML, so crawlers, no-JS visitors and
 * reduced-motion users all see the real number.
 */
(() => {
  const DURATION_MS = 1440;
  const values = document.querySelectorAll('.metric-value');

  if (!values.length || !('IntersectionObserver' in window)) return;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);

  const animate = (el) => {
    const { prefix, target, decimals, suffix } = el.dataset;
    const end = Number(target);
    const start = performance.now();

    const tick = (now) => {
      const progress = Math.min((now - start) / DURATION_MS, 1);
      el.textContent = prefix + (end * easeOutCubic(progress)).toFixed(Number(decimals)) + suffix;
      if (progress < 1) requestAnimationFrame(tick);
    };

    requestAnimationFrame(tick);
  };

  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      observer.unobserve(entry.target);
      animate(entry.target);
    }
  }, { threshold: 0.6 });

  for (const el of values) {
    const match = el.textContent.trim().match(/^(\D*)(\d+(?:\.\d+)?)(.*)$/);
    if (!match) continue;

    const [, prefix, number, suffix] = match;
    el.dataset.prefix = prefix;
    el.dataset.target = number;
    el.dataset.decimals = String((number.split('.')[1] || '').length);
    el.dataset.suffix = suffix;
    el.textContent = prefix + (0).toFixed(Number(el.dataset.decimals)) + suffix;
    observer.observe(el);
  }
})();
