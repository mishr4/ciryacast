/* Mavion design system — shared motion.
   Header hairline appears on scroll; .reveal elements rise in on view. */
(function () {
  const header = document.querySelector('.mv-header');
  if (header) {
    const onScroll = () => header.classList.toggle('scrolled', window.scrollY > 8);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
  }

  const io = ('IntersectionObserver' in window)
    ? new IntersectionObserver((entries, obs) => {
        for (const e of entries) if (e.isIntersecting) { e.target.classList.add('in'); obs.unobserve(e.target); }
      }, { rootMargin: '0px 0px -6% 0px', threshold: 0.05 })
    : null;

  // Call after injecting dynamic content to reveal any new .reveal elements.
  window.mvReveal = (root) => {
    root = root || document;
    const els = root.querySelectorAll('.reveal:not(.in)');
    if (!io) { els.forEach(el => el.classList.add('in')); return; }
    els.forEach(el => io.observe(el));
  };

  document.addEventListener('DOMContentLoaded', () => window.mvReveal());
})();
