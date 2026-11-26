// Certeza ID — Probador Interactivo en Vivo + Navegación Adaptable + Preguntas Frecuentes

(() => {
  if (!Object.hasOwn(HTMLElement.prototype, 'popover')) {
    import('https://unpkg.com/@oddbird/popover-polyfill@latest/dist/popover-polyfill.min.js').catch(() => {});
  }

  // Navegación adaptable
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

  if (menu) {
    menu.addEventListener('click', (e) => {
      const anchor = e.target.closest('a[href^="#"]');
      if (!anchor || !header || header.classList.contains('is-wide')) return;
      try {
        if (menu.matches(':popover-open')) menu.hidePopover();
      } catch {}
    });
  }

  // Acordeón de preguntas frecuentes
  function toggleAllDetails(button, container) {
    const expand = button.getAttribute('aria-expanded') !== 'true';
    for (const d of container.querySelectorAll('details')) {
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

  // Impresión / Guardar PDF
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
  document.getElementById('btn-print-closing')?.addEventListener('click', () => {
    expandAllForPrint();
    window.print();
  });

  // Probador interactivo contra 50 casos de prueba
  const reg = window.HOSPITALITY_SANDBOX_REGISTRY;
  if (!reg) return;

  const simForm = document.getElementById('live-sim-form');
  const simInput = document.getElementById('sim-input');
  const btnRandom = document.getElementById('btn-random-case');
  const deskPill = document.getElementById('desk-status-pill');
  const deskBanner = document.getElementById('desk-banner');
  const deskName = document.getElementById('desk-name');
  const deskId = document.getElementById('desk-id');
  const deskValidation = document.getElementById('desk-validation');
  const deskMinor = document.getElementById('desk-minor');
  const deskRoom = document.getElementById('desk-room');
  const segobPill = document.getElementById('segob-status-pill');
  const segobSummary = document.getElementById('segob-summary-banner');
  const segobJson = document.getElementById('segob-json-output');
  const segobSha = document.getElementById('segob-sha-preview');
  const metricLatency = document.getElementById('metric-latency');
  const btnCopyJson = document.getElementById('btn-copy-json');

  const tbody = document.getElementById('sandbox-table-body');
  const searchInput = document.getElementById('registry-search');
  const countLabel = document.getElementById('sandbox-count-label');
  const btnToggleRows = document.getElementById('btn-toggle-all-rows');

  let activeFilter = 'ALL';
  let showAllRows = false;
  let lastPayloadText = '';

  async function sha256Hex(text) {
    if (window.crypto?.subtle) {
      const data = new TextEncoder().encode(text);
      const buf = await window.crypto.subtle.digest('SHA-256', data);
      return Array.from(new Uint8Array(buf))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
    }
    return 'sha256-fallback-' + text.length.toString(16).padStart(16, '0');
  }

  function makeUuid() {
    if (window.crypto?.randomUUID) return window.crypto.randomUUID();
    return 'f0a1b2c3-d4e5-4678-9abc-def012345678';
  }

  function setQuickChipActive(id) {
    for (const btn of document.querySelectorAll('[data-quick-id]')) {
      btn.classList.toggle('is-active', btn.getAttribute('data-quick-id') === id);
    }
  }

  async function runLiveCheckin(rawQuery) {
    const t0 = performance.now();
    const query = String(rawQuery || '').trim().toUpperCase();
    if (!query) return;

    const match = reg.buscarPorIdentificador(query);
    const nowIso = new Date().toISOString();
    const eventUuid = makeUuid();
    const roomNum = String(300 + (query.charCodeAt(0) % 12) * 100 + (query.charCodeAt(query.length - 1) % 28));

    let curpInfo = null;
    let isValidDoc = false;
    let docLabel = '';
    let guestName = 'Huésped de prueba libre';
    let esMenor = false;
    let edadLabel = '—';
    let needsLgtBlock = false;

    if (match) {
      setQuickChipActive(match.id);
      guestName = match.nombre;
      esMenor = Boolean(match.esMenor);
      needsLgtBlock = esMenor && match.parentesco === 'NO_ACREDITO';
      isValidDoc = true;
      if (match.documento === 'PASAPORTE') {
        docLabel = `Pasaporte válido (${match.nacionalidad})`;
        edadLabel = `${match.edad} años, ${esMenor ? (needsLgtBlock ? 'menor sin documento de tutela' : 'menor con tutela verificada') : 'adulto'}`;
      } else {
        curpInfo = reg.validarCurpRenapo(match.curp);
        docLabel = `CURP válida (${match.estado})`;
        edadLabel = `${match.edad} años, ${esMenor ? (needsLgtBlock ? 'menor sin documento de tutela' : 'menor con tutela verificada') : 'adulto'}`;
      }
    } else if (/^[A-Z0-9]{18}$/.test(query)) {
      setQuickChipActive('');
      curpInfo = reg.validarCurpRenapo(query);
      if (!curpInfo.valida) {
        const dt = Math.max(0.2, performance.now() - t0).toFixed(1);
        if (metricLatency) metricLatency.textContent = `${dt} ms`;
        deskPill.className = 'status-pill status-alert';
        deskPill.textContent = 'CURP incorrecta';
        deskBanner.className = 'desk-banner is-error';
        deskBanner.innerHTML = `<strong>CURP no válida</strong>${curpInfo.error}`;
        deskName.textContent = 'Registro detenido en recepción';
        deskId.textContent = query;
        deskValidation.textContent = 'No pasó la validación oficial';
        deskMinor.textContent = '—';
        deskRoom.textContent = 'Habitación: Ninguna';
        segobPill.className = 'status-pill status-warn';
        segobPill.textContent = 'Sin envío';
        if (segobSummary) {
          segobSummary.className = 'desk-banner is-lgt';
          segobSummary.innerHTML =
            '<strong>No se envió ningún reporte</strong>La CURP tiene un error de captura, por lo que el sistema pide corregirla antes de registrar.';
        }
        const errPayload = {
          resultado: 'CURP_INVALIDA',
          motivo: curpInfo.error,
          curp_recibida: query,
          envio_segob: false,
          timestamp: nowIso
        };
        lastPayloadText = JSON.stringify(errPayload, null, 2);
        segobJson.textContent = lastPayloadText;
        segobSha.textContent = 'Sin sello generado';
        return;
      }
      isValidDoc = true;
      esMenor = curpInfo.esMenor;
      needsLgtBlock = esMenor;
      docLabel = `CURP válida (${curpInfo.entidad})`;
      edadLabel = `${curpInfo.edad} años, ${esMenor ? 'menor de edad (verificar parentesco)' : 'adulto'}`;
    } else {
      setQuickChipActive('');
      isValidDoc = query.length >= 6;
      docLabel = isValidDoc ? 'Documento verificado' : 'Faltan caracteres';
      edadLabel = 'No especificada';
    }

    // Monitor izquierdo: Recepción
    deskName.textContent = guestName;
    deskId.textContent = match ? match.identificador : query;
    deskValidation.textContent = docLabel;
    deskMinor.textContent = edadLabel;

    if (needsLgtBlock) {
      deskPill.className = 'status-pill status-warn';
      deskPill.textContent = 'Verificar menor';
      deskBanner.className = 'desk-banner is-lgt';
      deskBanner.innerHTML =
        '<strong>Pedir documento de parentesco (Ley de Turismo)</strong>' +
        'El huésped es menor de edad y no acredita vínculo con el adulto acompañante. El hotel debe negar el hospedaje y avisar a la autoridad.';
      deskRoom.textContent = 'Habitación retenida';
    } else {
      deskPill.className = 'status-pill status-ok';
      deskPill.textContent = 'Registro normal';
      deskBanner.className = 'desk-banner is-ok';
      deskBanner.innerHTML =
        '<strong>Registro completado sin alarmas en pantalla</strong>' +
        'El recepcionista atiende con total normalidad y sin ponerse en riesgo.';
      deskRoom.textContent = `Habitación asignada: ${roomNum}`;
    }

    // Monitor derecho: Aviso silencioso a SEGOB
    const isHit = Boolean(match && match.tieneAlertaPui);
    const payloadObj = isHit
      ? {
          protocolo: 'PUI-DOF-FASE-3-TIEMPO-REAL',
          modo: 'PRUEBA_SINTETICA',
          coincidencia: true,
          folio_fub: match.fub,
          uuid_evento: eventUuid,
          identificador: match.identificador,
          tipo_documento: match.documento,
          tipo_alerta: match.tipo,
          alerta_visible_en_recepcion: false,
          protocolo_menores_activado: needsLgtBlock,
          estatus_entrega_segob: 'Recibido por SEGOB',
          timestamp_utc: nowIso
        }
      : {
          protocolo: 'PUI-CONTROL-LOCAL',
          modo: 'PRUEBA_SINTETICA',
          coincidencia: false,
          uuid_evento: eventUuid,
          identificador_validado: match ? match.identificador : query,
          datos_enviados_a_segob: 0,
          privacidad: 'Guardado exclusivamente dentro de la bóveda privada del hotel',
          protocolo_menores_activado: needsLgtBlock,
          timestamp_utc: nowIso
        };

    const rawJson = JSON.stringify(payloadObj, null, 2);
    const digest = await sha256Hex(rawJson);
    const dt = Math.max(0.3, performance.now() - t0).toFixed(1);
    if (metricLatency) metricLatency.textContent = `${dt} ms`;

    const sealedPayload = {
      ...payloadObj,
      latencia_ms: Number(dt),
      sello_sha256: digest
    };
    lastPayloadText = JSON.stringify(sealedPayload, null, 2);
    segobJson.textContent = lastPayloadText;
    segobSha.textContent = `Folio de respaldo guardado (${dt} ms)`;

    if (isHit) {
      segobPill.className = 'status-pill status-alert';
      segobPill.textContent = 'Aviso enviado en silencio';
      if (segobSummary) {
        segobSummary.className = 'desk-banner is-error';
        segobSummary.innerHTML =
          `<strong>Coincidencia detectada (${match.fub})</strong>` +
          `Se envió el aviso cifrado directamente a Gobernación (${match.tipo}) sin mostrar absolutamente nada en la pantalla de recepción.`;
      }
    } else {
      segobPill.className = 'status-pill status-ok';
      segobPill.textContent = 'Sin coincidencias';
      if (segobSummary) {
        segobSummary.className = 'desk-banner is-ok';
        segobSummary.innerHTML =
          '<strong>Cero datos enviados a terceros</strong>' +
          'El huésped no tiene reporte activo. Su registro permanece cifrado únicamente dentro de la bóveda privada de tu hotel.';
      }
    }

    // Cinta de estado simple
    const setPipe = (stepId, labelId, cls, txt) => {
      const el = document.getElementById(stepId);
      const lb = document.getElementById(labelId);
      if (el) el.className = `pipe-step ${cls}`;
      if (lb) lb.textContent = txt;
    };
    setPipe('pipe-step-1', 'pipe-s1', 'is-ok', 'Verificada');
    setPipe('pipe-step-2', 'pipe-s2', 'is-ok', 'Aislada por RFC');
    setPipe('pipe-step-3', 'pipe-s3', needsLgtBlock ? 'is-warn' : 'is-ok', needsLgtBlock ? 'Pedir parentesco' : 'Sin alarmas');
    setPipe('pipe-step-4', 'pipe-s4', isHit ? 'is-alert' : 'is-ok', isHit ? 'Enviado en silencio' : 'No requerido');
  }

  simForm?.addEventListener('submit', (e) => {
    e.preventDefault();
    runLiveCheckin(simInput.value);
  });

  for (const btn of document.querySelectorAll('[data-quick-id]')) {
    btn.addEventListener('click', () => {
      const rec = reg.buscarPorIdentificador(btn.getAttribute('data-quick-id'));
      if (!rec) return;
      simInput.value = rec.identificador;
      runLiveCheckin(rec.identificador);
    });
  }

  btnRandom?.addEventListener('click', () => {
    const rec = reg.records[Math.floor(Math.random() * reg.records.length)];
    simInput.value = rec.identificador;
    runLiveCheckin(rec.identificador);
  });

  btnCopyJson?.addEventListener('click', async () => {
    if (!lastPayloadText) return;
    try {
      await navigator.clipboard.writeText(lastPayloadText);
      const prev = btnCopyJson.textContent;
      btnCopyJson.textContent = 'Comprobante copiado';
      setTimeout(() => {
        btnCopyJson.textContent = prev;
      }, 1800);
    } catch {}
  });

  // Explorador de 50 casos
  function getFilteredRecords() {
    const q = String(searchInput?.value || '').trim().toLowerCase();
    return reg.records.filter((r) => {
      if (activeFilter === 'MENOR_PUI' && r.categoria !== 'MENOR_PUI') return false;
      if (activeFilter === 'ADULTO_PUI' && r.categoria !== 'ADULTO_PUI') return false;
      if (activeFilter === 'EXTRANJERO' && r.documento !== 'PASAPORTE') return false;
      if (activeFilter === 'CONTROL' && r.tieneAlertaPui) return false;
      if (!q) return true;
      return (
        r.nombre.toLowerCase().includes(q) ||
        r.identificador.toLowerCase().includes(q) ||
        r.estado.toLowerCase().includes(q) ||
        (r.fub && r.fub.toLowerCase().includes(q)) ||
        r.tipo.toLowerCase().includes(q)
      );
    });
  }

  function renderSandboxTable() {
    if (!tbody) return;
    const filtered = getFilteredRecords();
    const limit = showAllRows ? filtered.length : Math.min(10, filtered.length);
    const slice = filtered.slice(0, limit);

    tbody.innerHTML = '';
    for (const r of slice) {
      const tr = document.createElement('tr');
      const badgeClass = r.tieneAlertaPui ? (r.esMenor ? 'status-warn' : 'status-alert') : 'status-ok';
      const badgeText = r.tieneAlertaPui ? (r.esMenor ? 'Aviso + menores' : 'Aviso silencioso') : 'Sin alerta';

      tr.innerHTML = `
        <th scope="row">${r.nombre}<span class="cell-note">${r.edad} años (${r.documento === 'PASAPORTE' ? 'Pasaporte' : 'CURP'})</span></th>
        <td class="code-cell">${r.identificador}</td>
        <td>${r.estado}<span class="cell-note">${r.tipo}</span></td>
        <td><span class="status-pill ${badgeClass}">${badgeText}</span></td>
        <td><button type="button" class="row-test-btn" data-run-id="${r.identificador}">Probar</button></td>
      `;
      tbody.appendChild(tr);
    }

    if (countLabel) {
      countLabel.textContent = `Mostrando ${slice.length} de ${filtered.length} casos de prueba`;
    }
    if (btnToggleRows) {
      btnToggleRows.hidden = filtered.length <= 10;
      btnToggleRows.textContent = showAllRows ? 'Ver menos' : `Ver los ${filtered.length} casos`;
    }
  }

  for (const btn of document.querySelectorAll('[data-filter]')) {
    btn.addEventListener('click', () => {
      activeFilter = btn.getAttribute('data-filter');
      for (const other of document.querySelectorAll('[data-filter]')) {
        other.classList.toggle('is-active', other === btn);
      }
      renderSandboxTable();
    });
  }

  searchInput?.addEventListener('input', renderSandboxTable);

  btnToggleRows?.addEventListener('click', () => {
    showAllRows = !showAllRows;
    renderSandboxTable();
  });

  tbody?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-run-id]');
    if (!btn) return;
    const id = btn.getAttribute('data-run-id');
    simInput.value = id;
    runLiveCheckin(id);
    document.getElementById('inicio')?.scrollIntoView({ behavior: 'smooth' });
  });

  renderSandboxTable();
  const initialCase = reg.buscarPorIdentificador('SBX-001');
  if (initialCase && simInput) {
    simInput.value = initialCase.identificador;
    runLiveCheckin(initialCase.identificador);
  }
})();
