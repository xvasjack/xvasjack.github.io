(() => {
  const body = document.body;
  const toggle = document.querySelector("[data-menu-toggle]");
  const menu = document.querySelector("[data-menu]");
  const header = document.querySelector(".site-header");
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const params = new URLSearchParams(window.location.search);
  const qaReveal = params.get("qa") === "1";
  const qaScroll = params.get("scroll");
  const qaMenu = params.get("menu") === "1";

  if (qaReveal) {
    document.documentElement.classList.add("qa-reveal");
    document.body.classList.add("qa-reveal");
  }

  const closeMenu = () => {
    if (!toggle || !menu) {
      return;
    }

    menu.classList.remove("open");
    toggle.setAttribute("aria-expanded", "false");
    body.classList.remove("menu-open");
  };

  if (toggle && menu) {
    toggle.addEventListener("click", () => {
      const open = menu.classList.toggle("open");
      toggle.setAttribute("aria-expanded", String(open));
      body.classList.toggle("menu-open", open);
    });

    document.addEventListener("click", (event) => {
      if (!menu.classList.contains("open")) {
        return;
      }

      if (menu.contains(event.target) || toggle.contains(event.target)) {
        return;
      }

      closeMenu();
    });

    menu.querySelectorAll("a").forEach((item) => {
      item.addEventListener("click", closeMenu);
    });

    window.addEventListener("resize", () => {
      if (window.innerWidth > 920) {
        closeMenu();
      }
    });

    if (qaMenu && window.innerWidth <= 920) {
      menu.classList.add("open");
      toggle.setAttribute("aria-expanded", "true");
      body.classList.add("menu-open");
    }
  }

  const syncHeaderState = () => {
    if (!header) {
      return;
    }

    header.classList.toggle("scrolled", window.scrollY > 40);
  };

  syncHeaderState();
  window.addEventListener("scroll", syncHeaderState, { passive: true });

  const revealNodes = document.querySelectorAll(".reveal");

  if (reduceMotion || qaReveal) {
    revealNodes.forEach((node) => node.classList.add("is-in"));
  } else if ("IntersectionObserver" in window) {
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add("is-in");
            observer.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.14 }
    );

    revealNodes.forEach((node, index) => {
      if (!node.closest(".hero")) {
        node.style.transitionDelay = `${Math.min(index * 80, 240)}ms`;
      }
      observer.observe(node);
    });
  } else {
    revealNodes.forEach((node) => node.classList.add("is-in"));
  }

  document.querySelectorAll("[data-year]").forEach((node) => {
    node.textContent = new Date().getFullYear();
  });

  const requesterType = document.querySelector("[data-requester-type]");
  const requestType = document.querySelector("[data-request-type]");
  const institutionField = document.querySelector("[data-institution-field]");
  const institutionInput = document.querySelector("[data-institution-input]");
  const lotField = document.querySelector("[data-lot-field]");
  const lotInput = document.querySelector("[data-lot-input]");

  const syncFormFields = () => {
    if (requesterType && institutionField && institutionInput) {
      const requesterValue = requesterType.value.trim().toLowerCase();
      const institutionOptional = ["individual learner", "press", "other"].includes(requesterValue);
      institutionField.classList.toggle("field-hidden", institutionOptional);
      institutionInput.required = !institutionOptional;
      if (institutionOptional) {
        institutionInput.value = "";
      }
    }

    if (requestType && lotField && lotInput) {
      const requestValue = requestType.value.trim().toLowerCase();
      const needLot = requestValue === "coa by lot number";
      lotField.classList.toggle("field-hidden", !needLot);
      lotInput.required = needLot;
      if (!needLot) {
        lotInput.value = "";
      }
    }
  };

  if (requesterType || requestType) {
    syncFormFields();
    requesterType?.addEventListener("change", syncFormFields);
    requestType?.addEventListener("change", syncFormFields);
  }

  if (qaScroll) {
    window.setTimeout(() => {
      const target = document.getElementById(qaScroll);
      if (target) {
        target.scrollIntoView({ block: "start" });
      }
    }, 120);
  }

  const canvas = document.querySelector("[data-particles]");

  if (!canvas || reduceMotion || qaReveal) {
    return;
  }

  const context = canvas.getContext("2d");
  const section = canvas.closest(".hero-home--media");

  if (!context || !section) {
    return;
  }

  const particleCount = 34;
  let width = 0;
  let height = 0;
  let animationFrame = 0;
  let particles = [];

  const resizeCanvas = () => {
    const bounds = section.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    width = Math.max(Math.floor(bounds.width), 1);
    height = Math.max(Math.floor(bounds.height), 1);
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
  };

  const makeParticle = () => ({
    x: Math.random() * width,
    y: Math.random() * height,
    vx: (Math.random() - 0.5) * 0.28,
    vy: (Math.random() - 0.5) * 0.28,
    radius: 1.6 + Math.random() * 1.4
  });

  const resetParticles = () => {
    particles = Array.from({ length: particleCount }, makeParticle);
  };

  const draw = () => {
    context.clearRect(0, 0, width, height);

    particles.forEach((particle, index) => {
      particle.x += particle.vx;
      particle.y += particle.vy;

      if (particle.x <= 0 || particle.x >= width) {
        particle.vx *= -1;
      }

      if (particle.y <= 0 || particle.y >= height) {
        particle.vy *= -1;
      }

      context.beginPath();
      context.arc(particle.x, particle.y, particle.radius, 0, Math.PI * 2);
      context.fillStyle = "rgba(255,255,255,0.12)";
      context.fill();

      for (let otherIndex = index + 1; otherIndex < particles.length; otherIndex += 1) {
        const other = particles[otherIndex];
        const dx = particle.x - other.x;
        const dy = particle.y - other.y;
        const distance = Math.hypot(dx, dy);

        if (distance < 120) {
          context.beginPath();
          context.moveTo(particle.x, particle.y);
          context.lineTo(other.x, other.y);
          context.strokeStyle = `rgba(255,255,255,${0.06 * (1 - distance / 120)})`;
          context.lineWidth = 1;
          context.stroke();
        }
      }
    });

    animationFrame = window.requestAnimationFrame(draw);
  };

  resizeCanvas();
  resetParticles();
  draw();

  window.addEventListener("resize", () => {
    window.cancelAnimationFrame(animationFrame);
    resizeCanvas();
    resetParticles();
    draw();
  });
})();
