(() => {
  const inlineCta = document.querySelector('[data-mobile-form-cta]');
  const stickyCta = document.querySelector('[data-mobile-form-sticky]');
  const form = document.getElementById('top-form');

  if (!inlineCta || !stickyCta || !form || !('IntersectionObserver' in window)) return;

  let inlineCtaVisible = true;
  let formVisible = false;

  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.target === inlineCta) inlineCtaVisible = entry.isIntersecting;
      if (entry.target === form) formVisible = entry.isIntersecting;
    }

    stickyCta.classList.toggle('is-visible', !inlineCtaVisible && !formVisible);
  });

  observer.observe(inlineCta);
  observer.observe(form);
})();
