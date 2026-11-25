// Hospitality PUI ID — Guía de Hospedaje
// Navegación adaptable (modern-web-guidance: navbar) y acordeón FAQ (modern-web-guidance: accordion)

(() => {
  // 1. Popover polyfill condicional (solo si el navegador no soporta Popover API nativa)
  if (!Object.hasOwn(HTMLElement.prototype, 'popover')) {
    import('https://unpkg.com/@oddbird/popover-polyfill@latest/dist/popover.min.js').catch(() => {});
  }

  // 2. Navegación adaptable medida por contenido real (sin breakpoints rígidos)
  const header = document.getElementById('site-header');
  const inner = document.getElementById('header-inner');
  const menu = document.getElementById('site-menu');
  let lastWidth = 0;

  function syncNavLayout() {
    if (!header || !inner || !menu) return;
    const isCurrentlyWide = header.classList.contains('is-wide');
    const currentWidth = header.clientWidth;
    if (!isCurrentlyWide && currentWidth <= lastWidth && lastWidth > 0) return;
    lastWidth = currentWidth;

    let wasOpen = false;
    try {
      wasOpen = !isCurrentlyWide && menu.matches(':popover-open');
    } catch {}

    header.classList.add('is-measuring', 'is-wide');
    menu.removeAttribute('popover');

    const fitsInline = inner.scrollWidth <= inner.clientWidth + 1;
    if (!fitsInline) {
      header.classList.remove('is-wide');
      menu.setAttribute('popover', 'auto');
      if (wasOpen && typeof menu.showPopover === 'function') {
        try {
          menu.showPopover();
        } catch {}
      }
    }
    requestAnimationFrame(() => header.classList.remove('is-measuring'));
  }

  if ('ResizeObserver' in window && header && menu) {
    const ro = new ResizeObserver(syncNavLayout);
    ro.observe(header);
    ro.observe(menu);
  }
  window.addEventListener('load', syncNavLayout);
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(syncNavLayout).catch(() => {});
  }
  syncNavLayout();

  // Cerrar popover al navegar a un ancla en modo compacto
  if (menu) {
    menu.addEventListener('click', (e) => {
      const anchor = e.target.closest('a[href^="#"]');
      if (!anchor || !header || header.classList.contains('is-wide')) return;
      try {
        if (menu.matches(':popover-open')) menu.hidePopover();
      } catch {}
    });
  }

  // 3. Botón Expandir/Contraer todas del acordeón FAQ (modern-web-guidance: accordion)
  function toggleAllDetails(button, container) {
    const expand = button.getAttribute('aria-expanded') !== 'true';
    for (const d of container.querySelectorAll(':scope > details')) {
      d.open = expand;
    }
    button.setAttribute('aria-expanded', String(expand));
  }

  if (Object.hasOwn(HTMLButtonElement.prototype, 'commandForElement')) {
    document.addEventListener(
      'command',
      (event) => {
        if (event.command !== '--toggle-all') return;
        toggleAllDetails(event.source, event.target);
      },
      { capture: true }
    );
  } else {
    document.addEventListener('click', (event) => {
      const btn = event.target.closest('[command="--toggle-all"]');
      if (!btn) return;
      const target = document.getElementById(btn.getAttribute('commandfor'));
      if (target) toggleAllDetails(btn, target);
    });
  }

  document.addEventListener(
    'toggle',
    (event) => {
      if (!event.target.matches('.accordion details')) return;
      const accordion = event.target.closest('.accordion');
      const btn = accordion?.querySelector('[command="--toggle-all"]');
      if (!btn) return;
      const items = accordion.querySelectorAll('details');
      btn.setAttribute('aria-expanded', String(Array.prototype.every.call(items, (d) => d.open)));
    },
    { capture: true }
  );

  // 4. Expandir todas las preguntas automáticamente al imprimir o exportar PDF
  const previousOpenState = new WeakMap();
  function expandAllForPrint() {
    for (const d of document.querySelectorAll('.accordion details')) {
      if (!previousOpenState.has(d)) previousOpenState.set(d, d.open);
      d.open = true;
    }
  }
  function restoreAfterPrint() {
    for (const d of document.querySelectorAll('.accordion details')) {
      if (previousOpenState.has(d)) {
        d.open = previousOpenState.get(d);
        previousOpenState.delete(d);
      }
    }
  }
  window.addEventListener('beforeprint', expandAllForPrint);
  window.addEventListener('afterprint', restoreAfterPrint);
  if (new URLSearchParams(window.location.search).has('print')) {
    expandAllForPrint();
  }

  // 5. Botón de guardado PDF
  document.getElementById('btn-print-closing')?.addEventListener('click', () => {
    expandAllForPrint();
    window.print();
  });
})();
