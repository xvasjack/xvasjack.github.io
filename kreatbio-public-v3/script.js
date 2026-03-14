(() => {
  const toggle = document.querySelector('[data-menu-toggle]');
  const menu = document.querySelector('[data-menu]');
  const body = document.body;

  if (toggle && menu) {
    toggle.addEventListener('click', () => {
      const open = menu.classList.toggle('open');
      toggle.setAttribute('aria-expanded', String(open));
      body.classList.toggle('menu-open', open);
    });

    document.addEventListener('click', (event) => {
      if (!menu.classList.contains('open')) {
        return;
      }

      if (menu.contains(event.target) || toggle.contains(event.target)) {
        return;
      }

      menu.classList.remove('open');
      toggle.setAttribute('aria-expanded', 'false');
      body.classList.remove('menu-open');
    });

    menu.querySelectorAll('a').forEach((item) => {
      item.addEventListener('click', () => {
        menu.classList.remove('open');
        toggle.setAttribute('aria-expanded', 'false');
        body.classList.remove('menu-open');
      });
    });
  }

  const revealNodes = document.querySelectorAll('.reveal');

  if ('IntersectionObserver' in window) {
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add('is-in');
            observer.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.14 }
    );

    revealNodes.forEach((el, i) => {
      el.style.transitionDelay = `${Math.min(i * 60, 220)}ms`;
      observer.observe(el);
    });
  } else {
    revealNodes.forEach((el) => el.classList.add('is-in'));
  }

  document.querySelectorAll('[data-year]').forEach((node) => {
    node.textContent = new Date().getFullYear();
  });
})();
