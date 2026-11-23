/**
 * Portico Hospitality — Hospitality Trust & Compliance
 * Frontend con autenticación RBAC real, terminal de recepción discreta,
 * importador CSV/PMS, configuración SEGOB Sandbox/Producción y cola Outbox.
 * Funciona tanto con el servidor Node.js/SQLite/PostgreSQL como desplegado en GitHub Pages.
 */

import {
  apiRequest,
  buildDemoCsvBlobUrl,
  getRuntimeMode,
  openConstancia
} from './api-client.js';

const fmtMxn = new Intl.NumberFormat('es-MX', {
  style: 'currency',
  currency: 'MXN',
  maximumFractionDigits: 0
});

let currentUser = null;
let appState = null;
let selectedHotelSlug = 'crowne-plaza-monterrey';
let revealApiKey = false;

const ROLE_LABELS = {
  ASOCIACION_ADMIN: 'Consejo Asociación (Admin)',
  HOTEL_ADMIN: 'Gerencia TI / Hotel (Aislado por RFC)',
  RECEPCION: 'Recepción Mostrador (Sigilo)'
};

const VIEW_META = {
  resumen: {
    title: 'Portico Hospitality — Resumen Ejecutivo y Retorno para la Asociación',
    subtitle:
      'Cumplimiento PUI (SEGOB / RENAPO) y protección hotelera sobre arquitectura propia multi-RFC con aislamiento RBAC.'
  },
  simulacion: {
    title: 'Simulación en Vivo: SEGOB (PUI) ↔ PMS del Hotel',
    subtitle:
      'Demostración real de autenticación JWT, Fases 1 y 2 históricas, monitoreo silencioso Fase 3 y cola Outbox hacia SEGOB.'
  },
  recepcion: {
    title: 'Modo Recepción — Terminal de Mostrador (Sigilo Activo)',
    subtitle:
      'Vista exclusiva del recepcionista: escaneo rápido de INE/CURP, control legal de menores y cero visibilidad de alertas SEGOB.'
  },
  conectores: {
    title: 'Conectores PMS, Agente Local OPERA y Carga CSV',
    subtitle:
      'Integra Oracle OPERA, Cloudbeds, agente local sin puertos abiertos o archivos CSV con validación RENAPO automática.'
  },
  hoteles: {
    title: 'Hoteles Afiliados y Constancias de Cumplimiento PDF',
    subtitle:
      'Cada razón social opera su bóveda aislada por RFC y emite evidencias auditables con sello criptográfico SHA-256.'
  },
  tecnico: {
    title: 'DOF, Conexión Real a SEGOB y Cola Outbox',
    subtitle:
      'Configura credenciales oficiales de SEGOB (Sandbox / Producción) y monitorea entregas confirmadas con backoff exponencial.'
  }
};

function setupFormValidationAccessibility() {
  const announcer = document.createElement('div');
  announcer.setAttribute('aria-live', 'polite');
  announcer.classList.add('visually-hidden');
  document.body.append(announcer);

  let announceTimer;
  let announcedField;
  const flagged = new WeakSet();
  const announced = new WeakSet();
  const supportsUserInvalid = CSS.supports('selector(:user-invalid)');
  const dirtyMap = new WeakMap();

  const linkError = (el, shown) => {
    const errorId = el.dataset.error;
    if (!errorId) return;
    const ids = (el.getAttribute('aria-describedby') || '')
      .split(/\s+/)
      .filter((id) => id && id !== errorId);
    if (shown) ids.push(errorId);
    if (ids.length) el.setAttribute('aria-describedby', ids.join(' '));
    else el.removeAttribute('aria-describedby');
  };

  const announceError = (el) => {
    const error = document.getElementById(el.dataset.error);
    if (!error) return;
    const label = el.labels?.[0] ? `${el.labels[0].textContent.trim()}: ` : '';
    clearTimeout(announceTimer);
    announcer.textContent = '';
    announcedField = el;
    announceTimer = setTimeout(() => {
      announcer.textContent = label + error.textContent.trim();
    }, 450);
  };

  const syncAria = (el, shouldAnnounce = false) => {
    if (!el?.matches?.('input:not([type="range"]):not([type="file"]), select, textarea')) return;
    const invalid = supportsUserInvalid
      ? el.matches(':user-invalid')
      : el.classList.contains('user-invalid-fallback');
    if (invalid) {
      if (shouldAnnounce && !announced.has(el)) {
        announceError(el);
        announced.add(el);
      }
      el.setAttribute('aria-invalid', 'true');
      linkError(el, true);
      flagged.add(el);
    } else if (flagged.has(el) || el.getAttribute('aria-invalid') !== 'true') {
      el.setAttribute('aria-invalid', 'false');
      linkError(el, false);
      flagged.delete(el);
      announced.delete(el);
      if (announcedField === el) {
        clearTimeout(announceTimer);
        announcer.textContent = '';
      }
    }
  };

  document.querySelectorAll('input:not([type="range"]):not([type="file"]), select, textarea').forEach((el) =>
    syncAria(el)
  );

  document.addEventListener(
    'blur',
    (e) => {
      const el = e.target;
      if (!supportsUserInvalid && el?.checkValidity) {
        const st = dirtyMap.get(el) || { interacted: false, blurred: false };
        st.blurred = true;
        dirtyMap.set(el, st);
        if (st.interacted) el.classList.toggle('user-invalid-fallback', !el.validity.valid);
      }
      syncAria(el, true);
    },
    true
  );

  document.addEventListener('input', (e) => {
    const el = e.target;
    if (!supportsUserInvalid && el?.checkValidity) {
      const st = dirtyMap.get(el) || { interacted: false, blurred: false };
      st.interacted = true;
      dirtyMap.set(el, st);
      if (st.blurred) el.classList.toggle('user-invalid-fallback', !el.validity.valid);
    }
    if (el?.hasAttribute?.('aria-invalid')) syncAria(el);
  });

  document.addEventListener(
    'invalid',
    (e) => {
      if (!supportsUserInvalid && e.target?.classList) {
        e.target.classList.add('user-invalid-fallback');
      }
      announced.add(e.target);
      syncAria(e.target);
    },
    true
  );

  document.addEventListener(
    'reset',
    (e) => {
      setTimeout(() => {
        for (const el of e.target.elements || []) {
          el.classList?.remove('user-invalid-fallback');
          dirtyMap.delete(el);
          syncAria(el);
        }
      });
    },
    true
  );
}

function setupDialogClosedByFallback() {
  if ('closedBy' in HTMLDialogElement.prototype) return;
  const isOutside = (e, dialog) => {
    const r = dialog.getBoundingClientRect();
    return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
  };
  for (const dialog of document.querySelectorAll('dialog[closedby="any"]')) {
    let pressedOutside = false;
    dialog.addEventListener('pointerdown', (e) => {
      pressedOutside = isOutside(e, dialog);
    });
    dialog.addEventListener('pointerup', (e) => {
      if (pressedOutside && isOutside(e, dialog)) dialog.close();
    });
  }
}

function updateRangeFallbackProgress(input) {
  if (CSS.supports('accent-color', '#0d6858')) return;
  const min = Number(input.min || 0);
  const max = Number(input.max || 100);
  const val = Number(input.value || 0);
  const pct = max > min ? ((val - min) / (max - min)) * 100 : 0;
  input.style.setProperty('--progress', `${pct}%`);
}

function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatTime(iso) {
  try {
    return new Intl.DateTimeFormat('es-MX', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      day: '2-digit',
      month: 'short'
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

function switchView(viewId) {
  for (const btn of document.querySelectorAll('.nav-btn')) {
    const active = btn.dataset.view === viewId;
    if (active) btn.setAttribute('aria-current', 'page');
    else btn.removeAttribute('aria-current');
  }
  for (const sec of document.querySelectorAll('.view-section')) {
    sec.hidden = sec.id !== `view-${viewId}`;
  }
  const meta = VIEW_META[viewId] || VIEW_META.resumen;
  document.getElementById('page-title').textContent = meta.title;
  document.getElementById('page-subtitle').textContent = meta.subtitle;
}

function applyRoleVisibility() {
  if (!currentUser) return;
  const role = currentUser.rol;

  document.getElementById('session-user-name').textContent = currentUser.nombre;
  document.getElementById('session-user-role').textContent = ROLE_LABELS[role] || role;

  let firstAllowedView = null;
  for (const btn of document.querySelectorAll('.nav-btn')) {
    const allowed = (btn.dataset.roles || '').split(',').includes(role);
    btn.hidden = !allowed;
    if (allowed && !firstAllowedView) firstAllowedView = btn.dataset.view;
  }

  document.getElementById('btn-open-add-hotel').hidden = role !== 'ASOCIACION_ADMIN';
  document.getElementById('btn-add-hotel-table').hidden = role !== 'ASOCIACION_ADMIN';
  document.getElementById('btn-quick-demo').hidden = role === 'RECEPCION';
  document.getElementById('btn-reset-demo').hidden = role !== 'ASOCIACION_ADMIN';

  const defaultView =
    role === 'RECEPCION' ? 'recepcion' : role === 'HOTEL_ADMIN' ? 'simulacion' : firstAllowedView || 'resumen';
  switchView(defaultView);
}

function showAuthScreen(demoAccounts = []) {
  document.getElementById('app-shell').hidden = true;
  document.getElementById('auth-screen').hidden = false;

  const box = document.getElementById('demo-roles-box');
  const list = document.getElementById('demo-roles-list');
  if (demoAccounts.length > 0) {
    box.hidden = false;
    list.innerHTML = demoAccounts
      .map(
        (acc) => `
        <button type="button" class="demo-role-btn" data-demo-email="${escapeHtml(acc.email)}" data-demo-pass="${escapeHtml(acc.passwordDemo)}">
          <strong>${escapeHtml(acc.etiqueta)}</strong>
          <span>${escapeHtml(acc.alcance)}</span>
        </button>`
      )
      .join('');
  } else {
    box.hidden = true;
  }
}

function showAppShell() {
  document.getElementById('auth-screen').hidden = true;
  document.getElementById('app-shell').hidden = false;
  applyRoleVisibility();
}

async function performLogin(email, password) {
  const fb = document.getElementById('login-feedback');
  const btn = document.getElementById('btn-login-submit');
  btn.disabled = true;
  fb.textContent = '';
  fb.className = 'inline-feedback';

  try {
    const { ok, data } = await apiRequest('/api/auth/login', {
      method: 'POST',
      body: { email, password }
    });
    if (!ok) {
      fb.className = 'inline-feedback err';
      fb.textContent = data.error || 'No se pudo iniciar sesión.';
      return false;
    }
    currentUser = data.user;
    if (currentUser.hotelSlug) selectedHotelSlug = currentUser.hotelSlug;
    showAppShell();
    await fetchState();
    return true;
  } finally {
    btn.disabled = false;
  }
}

async function bootstrapAuth() {
  const { data } = await apiRequest('/api/auth/me');
  if (data.authenticated && data.user) {
    currentUser = data.user;
    if (currentUser.hotelSlug) selectedHotelSlug = currentUser.hotelSlug;
    showAppShell();
    await fetchState();
  } else {
    showAuthScreen(data.demoAccounts || []);
  }
}

function updateRoiCalculator() {
  const hotelsEl = document.getElementById('roi-hotels');
  const extEl = document.getElementById('roi-external');
  const feeEl = document.getElementById('roi-assoc-fee');
  const devEl = document.getElementById('roi-dev-cost');
  const foundersEl = document.getElementById('roi-founders');

  for (const el of [hotelsEl, extEl, feeEl, devEl, foundersEl]) {
    updateRangeFallbackProgress(el);
  }

  const hotels = Number(hotelsEl.value);
  const extMonthly = Number(extEl.value);
  const assocFee = Number(feeEl.value);
  const devCost = Number(devEl.value);
  const founders = Number(foundersEl.value);

  const setupPerHotel = 4500;
  const sharedCloudMonthly = 6000;

  const extMonthlyTotal = hotels * extMonthly;
  const extY1 = hotels * extMonthly * 12;
  const extY3 = hotels * extMonthly * 36;
  const hotelsPayY3 = hotels * assocFee * 36;
  const hotelsSavingsY3 = Math.max(0, extY3 - hotelsPayY3);
  const cloudPerHotel = Math.max(1, Math.round(sharedCloudMonthly / hotels));
  const assocNetAnnual = hotels * assocFee * 12 - sharedCloudMonthly * 12;
  const gremioPaybackMonths = extMonthlyTotal > 0 ? (devCost / extMonthlyTotal).toFixed(1) : null;

  const perFounder = Math.ceil(devCost / founders);
  const monthlyNet = assocNetAnnual / 12;
  const paybackMonths = monthlyNet > 0 ? Math.ceil(devCost / monthlyNet) : null;

  document.getElementById('roi-hotels-out').textContent = `${hotels} hoteles`;
  document.getElementById('roi-external-out').textContent = `${fmtMxn.format(extMonthly)} MXN`;
  document.getElementById('roi-assoc-fee-out').textContent = `${fmtMxn.format(assocFee)} MXN`;
  document.getElementById('roi-dev-cost-out').textContent = `${fmtMxn.format(devCost)} MXN`;
  document.getElementById('roi-founders-out').textContent = `${founders} hoteles`;

  document.getElementById('roi-ext-y1').textContent = `${fmtMxn.format(extY1)} MXN / año`;
  document.getElementById('roi-ext-y3').textContent = `${fmtMxn.format(extY3)} MXN`;
  document.getElementById('roi-cloud-per-hotel').textContent = `${fmtMxn.format(cloudPerHotel)} MXN`;
  document.getElementById('roi-hotels-savings').textContent = `${fmtMxn.format(hotelsSavingsY3)} MXN`;
  document.getElementById('roi-assoc-net').textContent =
    assocNetAnnual >= 0
      ? `${fmtMxn.format(assocNetAnnual)} MXN / año`
      : `Subsidiado (${fmtMxn.format(Math.abs(assocNetAnnual))} MXN / año)`;

  const gremioPaybackEl = document.getElementById('roi-gremio-payback');
  if (gremioPaybackEl) {
    gremioPaybackEl.textContent = gremioPaybackMonths
      ? `${gremioPaybackMonths} meses`
      : 'Inmediato';
  }

  document.getElementById('roi-per-founder').textContent = `${fmtMxn.format(perFounder)} MXN`;
  document.getElementById('roi-payback-months').textContent = paybackMonths
    ? `${paybackMonths} meses`
    : 'Membresía incluida';
}

async function fetchState() {
  const { status, data } = await apiRequest('/api/state');
  if (status === 401) {
    currentUser = null;
    await bootstrapAuth();
    return;
  }
  appState = data;
  if (!appState.hotels.some((h) => h.slug === selectedHotelSlug)) {
    selectedHotelSlug = appState.hotels[0]?.slug || '';
  }
  renderAll();
}

function populateHotelSelect(selectId) {
  const sel = document.getElementById(selectId);
  if (!sel) return;
  sel.innerHTML = appState.hotels
    .map(
      (h) =>
        `<option value="${escapeHtml(h.slug)}" ${h.slug === selectedHotelSlug ? 'selected' : ''}>${escapeHtml(h.nombre)} (${escapeHtml(h.rfc)})</option>`
    )
    .join('');
  sel.disabled = appState.hotels.length <= 1;
}

function renderAll() {
  if (!appState) return;
  const activeAlerts = appState.alerts.filter((a) => a.activa);
  const deliveredOutbox = appState.outbox.filter((o) => o.estado === 'ENTREGADO');
  const cadenaOk = appState.integridadCadena?.integra !== false;
  const isStatic = getRuntimeMode() === 'static-pages';

  document.getElementById('kpi-hotels-count').textContent = String(appState.hotels.length);
  document.getElementById('kpi-alerts-count').textContent = String(activeAlerts.length);
  document.getElementById('kpi-outbox-count').textContent = String(deliveredOutbox.length);
  document.getElementById('kpi-audit-count').textContent = String(appState.auditLog.length);
  document.getElementById('kpi-chain-meta').textContent = cadenaOk
    ? 'Cadena SHA-256 íntegra'
    : 'Revisar integridad de bitácora';
  document.getElementById('sidebar-chain-status').textContent = isStatic
    ? 'GitHub Pages 24/7 · SHA-256 íntegro'
    : cadenaOk
      ? 'SQLite ACID · SHA-256 íntegro'
      : 'SQLite ACID · Revisar cadena';

  populateHotelSelect('sim-hotel-select');
  populateHotelSelect('desk-hotel-select');
  populateHotelSelect('conn-hotel-select');

  const currentHotel = appState.hotels.find((h) => h.slug === selectedHotelSlug) || appState.hotels[0];
  if (currentHotel) {
    document.getElementById('pms-panel-title').textContent = `2. Recepción PMS — ${currentHotel.nombre}`;
    document.getElementById('desk-hotel-title').textContent = `Terminal de Mostrador — ${currentHotel.nombre}`;
    const dlLink = document.getElementById('btn-download-csv-template');
    if (isStatic) {
      dlLink.href = buildDemoCsvBlobUrl(currentHotel.slug);
      dlLink.download = `plantilla_huespedes_${currentHotel.slug}.csv`;
    } else {
      dlLink.href = `./api/pms/${currentHotel.slug}/csv-template`;
      dlLink.removeAttribute('download');
    }
    if (currentUser?.rol !== 'RECEPCION') {
      renderConnectorPanel(currentHotel);
      renderDofSpec(currentHotel);
      populateSegobConfigForm(currentHotel);
    }
  }

  renderActiveAlerts();
  renderHotelGuests('hotel-guests-list');
  renderHotelGuests('desk-guests-list');
  renderAuditFeed();
  renderOutboxFeed();
  renderHotelsTable();
}

function populateSegobConfigForm(hotel) {
  document.getElementById('cfg-segob-mode').value = hotel.segobMode || 'SANDBOX_SIMULADO';
  document.getElementById('cfg-llave-mx').value = hotel.llaveMxStatus || 'Pendiente';
  document.getElementById('cfg-segob-url').value = hotel.segobBaseUrl || '';
  document.getElementById('cfg-segob-user').value = hotel.segobUsuario || '';
  document.getElementById('cfg-segob-pass').value = '';
}

function renderConnectorPanel(hotel) {
  document.getElementById('conn-hotel-rfc').textContent = `RFC: ${hotel.rfc}`;
  const key = hotel.pmsApiKey || '';
  const masked = key ? `${key.slice(0, 16)}••••••••••••••••` : 'Sin llave';
  document.getElementById('conn-api-key').textContent = revealApiKey ? key : masked;
  document.getElementById('btn-toggle-key').textContent = revealApiKey ? 'Ocultar llave' : 'Mostrar llave';

  const origin = getRuntimeMode() === 'static-pages' ? 'https://api.porticohospitality.mx' : window.location.origin;
  const shownKey = revealApiKey ? key : '<TU_LLAVE_PMS>';

  document.getElementById('pms-agent-snippet').textContent = `# Ejecutar en servidor local de ${hotel.nombre} (Windows / Linux)
node agent/pms-sync-agent.js \\
  --dir "./exports-opera" \\
  --hotel "${hotel.slug}" \\
  --key "${shownKey}" \\
  --url "${origin}"`;

  document.getElementById('pms-webhook-snippet').textContent = `# Webhook de Check-in desde ${hotel.pms} → Portico Hospitality
curl -s -X POST "${origin}/api/pms/${hotel.slug}/checkin" \\
  -H "Content-Type: application/json" \\
  -H "X-Portico-PMS-Key: ${shownKey}" \\
  -d '{
    "nombre": "SOFIA MARTINEZ GARZA",
    "curp": "${appState.escenariosDemo.huespedSinAlerta.curp}",
    "habitacion": "0804"
  }'`;
}

function renderActiveAlerts() {
  const container = document.getElementById('active-alerts-list');
  const list = appState.alerts.filter((a) => a.hotelSlug === selectedHotelSlug);

  if (!list.length) {
    container.innerHTML =
      '<div class="empty-state">No hay reportes de búsqueda cargados para este hotel. Usa un escenario rápido arriba para probar.</div>';
    return;
  }

  container.innerHTML = list
    .map(
      (a) => `
      <div class="mini-item">
        <div class="mini-item-head">
          <code>${escapeHtml(a.reporteId)}</code>
          ${
            a.activa
              ? `<span class="badge badge-danger">Fase 3 activa</span>`
              : `<span class="badge badge-neutral">Desactivada</span>`
          }
        </div>
        <div class="mini-item-meta">
          CURP: <code>${escapeHtml(a.curpEnmascarada)}</code> · ${escapeHtml(a.tipoAlerta)} · ${escapeHtml(a.cifrado)}
        </div>
        <div class="mini-item-head" style="margin-top: 0.35rem; margin-bottom: 0;">
          <span class="mini-item-meta">Coincidencias enviadas a SEGOB: <strong>${a.coincidenciasReportadas}</strong></span>
          ${
            a.activa
              ? `<button type="button" class="btn-link-danger" data-deactivate="${escapeHtml(a.reporteId)}">Desactivar reporte</button>`
              : ''
          }
        </div>
      </div>`
    )
    .join('');
}

function renderHotelGuests(targetId) {
  const container = document.getElementById(targetId);
  if (!container) return;
  const list = appState.guests.filter((g) => g.hotelSlug === selectedHotelSlug).slice(0, 6);

  if (!list.length) {
    container.innerHTML = '<div class="empty-state">Aún no hay registros de huéspedes en este hotel.</div>';
    return;
  }

  container.innerHTML = list
    .map(
      (g) => `
      <div class="mini-item">
        <div class="mini-item-head">
          <strong>${escapeHtml(g.nombre)}</strong>
          <span class="badge ${g.esMenor ? 'badge-pending' : 'badge-neutral'}">${g.esMenor ? 'Menor de edad' : `Hab. ${escapeHtml(g.habitacion)}`}</span>
        </div>
        <div class="mini-item-meta">
          CURP: <code>${escapeHtml(g.curpEnmascarada)}</code> · ${escapeHtml(g.tipo)}
        </div>
      </div>`
    )
    .join('');
}

function renderAuditFeed() {
  const container = document.getElementById('audit-feed');
  const logs = appState.auditLog.slice(0, 40);

  if (!logs.length) {
    container.innerHTML = '<div class="empty-state">Sin eventos registrados.</div>';
    return;
  }

  container.innerHTML = logs
    .map((entry) => {
      const badgeClass = entry.critico
        ? 'badge-danger'
        : entry.fase === 'PROTOCOLO MENORES LGT'
          ? 'badge-pending'
          : entry.direccion === 'HOTEL → SEGOB'
            ? 'badge-active'
            : 'badge-neutral';

      return `
        <article class="audit-entry ${entry.critico ? 'critico' : ''}">
          <div class="audit-head">
            <span class="badge ${badgeClass}">${escapeHtml(entry.fase || entry.direccion)}</span>
            <span class="audit-time">${escapeHtml(formatTime(entry.timestamp))}</span>
          </div>
          <p class="audit-summary">${escapeHtml(entry.resumen)}</p>
          <div class="audit-meta">
            ${escapeHtml(entry.direccion)} · ${escapeHtml(entry.endpoint)} · SHA-256: ${escapeHtml((entry.hash || '').slice(0, 14))}…
          </div>
          <details>
            <summary>Ver trama JSON y evidencia auditable</summary>
            <pre>${escapeHtml(JSON.stringify(entry.payload, null, 2))}</pre>
          </details>
        </article>`;
    })
    .join('');
}

function renderOutboxFeed() {
  const container = document.getElementById('outbox-feed');
  if (!container) return;
  const items = (appState.outbox || []).slice(0, 25);

  if (!items.length) {
    container.innerHTML =
      '<div class="empty-state">Aún no se han encolado notificaciones salientes hacia SEGOB. Ejecuta una simulación para ver la entrega y acuse.</div>';
    return;
  }

  container.innerHTML = items
    .map((job) => {
      const badgeClass =
        job.estado === 'ENTREGADO'
          ? 'badge-active'
          : job.estado === 'ERROR_PERMANENTE'
            ? 'badge-danger'
            : 'badge-pending';
      return `
        <article class="audit-entry">
          <div class="audit-head">
            <span class="badge ${badgeClass}">${escapeHtml(job.estado)} · ${escapeHtml(job.fase)}</span>
            <span class="audit-time">${escapeHtml(formatTime(job.entregadoEn || job.creadoEn))}</span>
          </div>
          <p class="audit-summary">
            ${escapeHtml(job.endpoint)} · Reporte <code>${escapeHtml(job.reporteId)}</code> (${escapeHtml(job.hotelSlug)})
          </p>
          <div class="audit-meta">
            Intentos: ${job.intentos}/${job.maxIntentos}
            ${job.ultimoHttp ? ` · HTTP ${job.ultimoHttp}` : ''}
            ${job.latenciaMs ? ` · ${job.latenciaMs} ms` : ''}
            ${job.acuseSegob ? ` · Acuse: ${escapeHtml(job.acuseSegob)}` : ''}
            ${job.ultimoError ? ` · Error: ${escapeHtml(job.ultimoError)}` : ''}
          </div>
        </article>`;
    })
    .join('');
}

function renderHotelsTable() {
  const tbody = document.getElementById('hotels-tbody');
  tbody.innerHTML = appState.hotels
    .map((h) => {
      const statusClass =
        h.estatus === 'Piloto Activo' || h.estatus === 'Activo'
          ? 'badge-active'
          : h.estatus === 'Siguiente Fase'
            ? 'badge-pending'
            : 'badge-neutral';
      return `
        <tr>
          <th scope="row">
            ${escapeHtml(h.nombre)}
            <span class="cell-sub">${escapeHtml(h.ciudad)}</span>
          </th>
          <td>
            ${escapeHtml(h.grupo)}
            <span class="cell-sub">RFC: ${escapeHtml(h.rfc)}</span>
          </td>
          <td>${escapeHtml(h.habitaciones)}</td>
          <td>
            ${escapeHtml(h.pms)}
            <span class="cell-sub">${escapeHtml(h.modoIntegracion)}</span>
          </td>
          <td>
            ${escapeHtml(h.segobMode || 'SANDBOX_SIMULADO')}
            <span class="cell-sub">${escapeHtml(h.llaveMxStatus)}</span>
          </td>
          <td><span class="badge ${statusClass}">${escapeHtml(h.estatus)}</span></td>
          <td>
            <div class="row-actions">
              <button type="button" class="btn-secondary btn-sm" data-open-cert="${escapeHtml(h.slug)}">
                Constancia PDF
              </button>
              <button type="button" class="btn-secondary btn-sm" data-open-conn="${escapeHtml(h.slug)}">
                CSV / API
              </button>
            </div>
          </td>
        </tr>`;
    })
    .join('');
}

function renderDofSpec(hotel) {
  if (!hotel) return;
  const origin = getRuntimeMode() === 'static-pages' ? 'https://api.porticohospitality.mx' : window.location.origin;
  const slug = hotel.slug;
  const endpoints = [
    { method: 'POST', path: `/api/pui/${slug}/login`, desc: 'Emite token Bearer JWT (HS256)' },
    { method: 'POST', path: `/api/pui/${slug}/activar-reporte`, desc: 'Recibe alerta SEGOB y ejecuta Fases 1, 2 y 3' },
    { method: 'POST', path: `/api/pui/${slug}/activar-reporte-prueba`, desc: 'Validación oficial en entorno Sandbox' },
    { method: 'POST', path: `/api/pui/${slug}/desactivar-reporte`, desc: 'Detiene monitoreo continuo Fase 3' },
    { method: 'POST', path: `/api/pms/${slug}/checkin`, desc: 'Webhook PMS (X-Portico-PMS-Key) — Fase 3 silenciosa' },
    { method: 'POST', path: `/api/pms/${slug}/import-csv`, desc: 'Carga masiva CSV / Agente local OPERA' },
    { method: 'GET', path: `/constancia/${slug}`, desc: 'Constancia Oficial imprimible / PDF con sello SHA-256' }
  ];

  document.getElementById('dof-endpoints-list').innerHTML = endpoints
    .map(
      (ep) => `
      <div class="endpoint-row">
        <span class="method-pill">${ep.method}</span>
        <code>${escapeHtml(ep.path)}</code>
        <span class="endpoint-desc">${escapeHtml(ep.desc)}</span>
      </div>`
    )
    .join('');

  document.getElementById('curl-snippet').textContent = `# 1. Autenticación SEGOB (JWT) para ${hotel.nombre}
TOKEN=$(curl -s -X POST "${origin}/api/pui/${slug}/login" \\
  -H "Content-Type: application/json" \\
  -d '{"usuario":"${hotel.usuarioPui}","password":"<CLAVE_PUI>"}' | node -e "console.log(JSON.parse(require('fs').readFileSync(0,'utf8')).token)")

# 2. Activar reporte de prueba (Fases 1, 2 y 3)
curl -s -X POST "${origin}/api/pui/${slug}/activar-reporte-prueba" \\
  -H "Authorization: Bearer $TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{"id":"FUB-SANDBOX-001","curp":"${appState.escenariosDemo.menorEnTiempoReal.curp}"}'`;
}

async function checkCurpLive(raw, metaElId, minorBoxId) {
  const box = document.getElementById(metaElId);
  const minorBox = document.getElementById(minorBoxId);
  const val = raw.trim().toUpperCase();
  if (val.length < 18) {
    box.textContent = '';
    box.className = 'curp-meta';
    if (minorBox) minorBox.hidden = true;
    return;
  }
  const { data } = await apiRequest(`/api/curp/validar?curp=${encodeURIComponent(val)}`);
  if (data.valida) {
    box.className = 'curp-meta valid';
    box.textContent = `CURP válida · ${data.entidad} · Edad estimada: ${data.edad} años${data.esMenor ? ' (Menor de edad — Ley General de Turismo)' : ''}`;
    if (minorBox) minorBox.hidden = !data.esMenor;
  } else {
    box.className = 'curp-meta invalid';
    box.textContent = data.error;
    if (minorBox) minorBox.hidden = true;
  }
}

async function submitCheckinForm({
  form,
  nombreId,
  curpId,
  habId,
  acompId,
  parentescoId,
  feedbackId,
  submitBtnId
}) {
  if (!form.reportValidity()) return;
  const fb = document.getElementById(feedbackId);
  const btn = document.getElementById(submitBtnId);
  btn.disabled = true;
  try {
    const parentescoEl = document.getElementById(parentescoId);
    const { ok, data } = await apiRequest(`/api/pms/${selectedHotelSlug}/checkin`, {
      method: 'POST',
      body: {
        nombre: document.getElementById(nombreId).value.trim(),
        curp: document.getElementById(curpId).value.trim().toUpperCase(),
        habitacion: document.getElementById(habId).value.trim(),
        acompanante: document.getElementById(acompId).value.trim(),
        parentescoDocumento: parentescoEl?.value || null
      }
    });
    if (!ok) {
      fb.className = 'inline-feedback err';
      fb.textContent = data.error || 'Error al registrar huésped.';
    } else {
      fb.className = data.verificacion_menor_turismo
        ? 'inline-feedback warn'
        : 'inline-feedback ok';
      fb.textContent = data.verificacion_menor_turismo
        ? `${data.mensaje_recepcion} ${data.verificacion_menor_turismo}`
        : data.mensaje_recepcion;
      await fetchState();
    }
  } finally {
    btn.disabled = false;
  }
}

async function runCsvImport(csvText, origen) {
  const fb = document.getElementById('csv-feedback');
  const errBox = document.getElementById('csv-errors-box');
  const errList = document.getElementById('csv-errors-list');
  const btn = document.getElementById('btn-submit-csv');

  btn.disabled = true;
  try {
    const { ok, data } = await apiRequest(`/api/pms/${selectedHotelSlug}/import-csv`, {
      method: 'POST',
      body: { csvText, origen }
    });
    if (!ok) {
      fb.className = 'inline-feedback err';
      fb.textContent = data.error || 'No se pudo procesar el archivo CSV.';
      errBox.hidden = true;
      return;
    }

    fb.className = data.rechazados > 0 ? 'inline-feedback warn' : 'inline-feedback ok';
    fb.textContent = `Importación completada en ${data.hotel}: ${data.insertados} huéspedes válidos cargados y cifrados en bóveda (con cruce silencioso Fase 3) y ${data.rechazados} fila(s) rechazada(s) por CURP inválida.`;

    if (data.errores?.length) {
      errBox.hidden = false;
      errList.innerHTML = data.errores
        .map(
          (er) => `
          <div class="mini-item">
            <div class="mini-item-head">
              <strong>Línea ${er.linea}</strong>
              <code>${escapeHtml(er.curp || '(vacía)')}</code>
            </div>
            <div class="mini-item-meta">${escapeHtml(er.motivo)}</div>
          </div>`
        )
        .join('');
    } else {
      errBox.hidden = true;
    }

    await fetchState();
  } finally {
    btn.disabled = false;
  }
}

function syncHotelChange(newSlug) {
  selectedHotelSlug = newSlug;
  revealApiKey = false;
  for (const id of ['segob-feedback', 'pms-feedback', 'desk-feedback', 'csv-feedback', 'segob-cfg-feedback']) {
    const el = document.getElementById(id);
    if (el) {
      el.textContent = '';
      el.className = 'inline-feedback';
    }
  }
  renderAll();
}

function bindEvents() {
  const loginPassInput = document.getElementById('login-password');
  const togglePassBtn = document.getElementById('btn-toggle-login-pass');
  togglePassBtn.addEventListener('click', () => {
    const showing = loginPassInput.type === 'text';
    loginPassInput.type = showing ? 'password' : 'text';
    togglePassBtn.textContent = showing ? 'Mostrar' : 'Ocultar';
  });

  document.getElementById('form-login').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!e.currentTarget.reportValidity()) return;
    await performLogin(document.getElementById('login-email').value.trim(), loginPassInput.value);
  });

  document.getElementById('demo-roles-list').addEventListener('click', async (e) => {
    const btn = e.target.closest('.demo-role-btn');
    if (!btn) return;
    document.getElementById('login-email').value = btn.dataset.demoEmail;
    loginPassInput.value = btn.dataset.demoPass;
    await performLogin(btn.dataset.demoEmail, btn.dataset.demoPass);
  });

  document.getElementById('btn-logout').addEventListener('click', async () => {
    await apiRequest('/api/auth/logout', { method: 'POST' });
    currentUser = null;
    appState = null;
    await bootstrapAuth();
  });

  for (const btn of document.querySelectorAll('.nav-btn')) {
    btn.addEventListener('click', () => switchView(btn.dataset.view));
  }

  document.getElementById('btn-quick-demo').addEventListener('click', () => switchView('simulacion'));

  for (const id of ['roi-hotels', 'roi-external', 'roi-assoc-fee', 'roi-dev-cost', 'roi-founders']) {
    document.getElementById(id).addEventListener('input', updateRoiCalculator);
  }

  for (const selId of ['sim-hotel-select', 'desk-hotel-select', 'conn-hotel-select']) {
    document.getElementById(selId).addEventListener('change', (e) => syncHotelChange(e.target.value));
  }

  document.getElementById('btn-scenario-menor').addEventListener('click', () => {
    const sc = appState.escenariosDemo.menorEnTiempoReal;
    if (appState.hotels.some((h) => h.slug === 'crowne-plaza-monterrey')) {
      selectedHotelSlug = 'crowne-plaza-monterrey';
    }
    document.getElementById('segob-reporte-id').value = sc.reporteId;
    document.getElementById('segob-curp').value = sc.curp;
    document.getElementById('segob-tipo').value = sc.tipoAlerta;
    document.getElementById('pms-nombre').value = sc.nombre;
    document.getElementById('pms-curp').value = sc.curp;
    document.getElementById('pms-habitacion').value = sc.habitacion;
    document.getElementById('pms-acompanante').value = sc.acompanante;
    document.getElementById('pms-parentesco').value = sc.parentescoDocumento || 'NO_ACREDITO';
    checkCurpLive(sc.curp, 'pms-curp-live', 'pms-minor-box');
    renderAll();
  });

  document.getElementById('btn-scenario-historico').addEventListener('click', () => {
    const sc = appState.escenariosDemo.coincidenciaHistorica;
    if (appState.hotels.some((h) => h.slug === 'crowne-plaza-monterrey')) {
      selectedHotelSlug = 'crowne-plaza-monterrey';
    }
    document.getElementById('segob-reporte-id').value = sc.reporteId;
    document.getElementById('segob-curp').value = sc.curp;
    document.getElementById('segob-tipo').value = sc.tipoAlerta;
    renderAll();
  });

  document.getElementById('btn-scenario-normal').addEventListener('click', () => {
    const sc = appState.escenariosDemo.huespedSinAlerta;
    document.getElementById('pms-nombre').value = sc.nombre;
    document.getElementById('pms-curp').value = sc.curp;
    document.getElementById('pms-habitacion').value = sc.habitacion;
    document.getElementById('pms-acompanante').value = '';
    document.getElementById('pms-parentesco').value = '';
    checkCurpLive(sc.curp, 'pms-curp-live', 'pms-minor-box');
  });

  document.getElementById('btn-scan-ine').addEventListener('click', () => {
    const sc = appState.escenariosDemo.escaneoIneEjecutivo;
    document.getElementById('desk-nombre').value = sc.nombre;
    document.getElementById('desk-curp').value = sc.curp;
    document.getElementById('desk-habitacion').value = sc.habitacion;
    document.getElementById('desk-acompanante').value = '';
    document.getElementById('desk-parentesco').value = '';
    checkCurpLive(sc.curp, 'desk-curp-live', 'desk-minor-box');
  });

  document.getElementById('btn-scan-minor').addEventListener('click', () => {
    const sc = appState.escenariosDemo.menorEnTiempoReal;
    document.getElementById('desk-nombre').value = sc.nombre;
    document.getElementById('desk-curp').value = sc.curp;
    document.getElementById('desk-habitacion').value = sc.habitacion;
    document.getElementById('desk-acompanante').value = sc.acompanante;
    document.getElementById('desk-parentesco').value = 'NO_ACREDITO';
    checkCurpLive(sc.curp, 'desk-curp-live', 'desk-minor-box');
  });

  let curpTimer1;
  document.getElementById('pms-curp').addEventListener('input', (e) => {
    clearTimeout(curpTimer1);
    curpTimer1 = setTimeout(() => checkCurpLive(e.target.value, 'pms-curp-live', 'pms-minor-box'), 160);
  });

  let curpTimer2;
  document.getElementById('desk-curp').addEventListener('input', (e) => {
    clearTimeout(curpTimer2);
    curpTimer2 = setTimeout(() => checkCurpLive(e.target.value, 'desk-curp-live', 'desk-minor-box'), 160);
  });

  document.getElementById('form-segob-alert').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!e.currentTarget.reportValidity()) return;

    const fb = document.getElementById('segob-feedback');
    const btn = document.getElementById('btn-activar-alerta');
    btn.disabled = true;
    try {
      const { ok, data } = await apiRequest('/api/demo/segob-action', {
        method: 'POST',
        body: {
          accion: 'activar',
          hotelSlug: selectedHotelSlug,
          id: document.getElementById('segob-reporte-id').value.trim(),
          curp: document.getElementById('segob-curp').value.trim().toUpperCase(),
          tipo_alerta: document.getElementById('segob-tipo').value
        }
      });
      if (!ok) {
        fb.className = 'inline-feedback err';
        fb.textContent = data.error || 'No se pudo activar el reporte.';
      } else {
        fb.className = 'inline-feedback ok';
        fb.textContent = `Reporte ${data.id} activo en ${data.hotel}. Coincidencias históricas (Fases 1–2): ${data.coincidencias_historicas}. Fase 3 encendida y cola Outbox procesada.`;
        await fetchState();
      }
    } finally {
      btn.disabled = false;
    }
  });

  document.getElementById('active-alerts-list').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-deactivate]');
    if (!btn) return;
    btn.disabled = true;
    await apiRequest('/api/demo/segob-action', {
      method: 'POST',
      body: { accion: 'desactivar', hotelSlug: selectedHotelSlug, id: btn.dataset.deactivate }
    });
    await fetchState();
  });

  document.getElementById('form-pms-checkin').addEventListener('submit', (e) => {
    e.preventDefault();
    submitCheckinForm({
      form: e.currentTarget,
      nombreId: 'pms-nombre',
      curpId: 'pms-curp',
      habId: 'pms-habitacion',
      acompId: 'pms-acompanante',
      parentescoId: 'pms-parentesco',
      feedbackId: 'pms-feedback',
      submitBtnId: 'btn-submit-checkin'
    });
  });

  document.getElementById('form-desk-checkin').addEventListener('submit', (e) => {
    e.preventDefault();
    submitCheckinForm({
      form: e.currentTarget,
      nombreId: 'desk-nombre',
      curpId: 'desk-curp',
      habId: 'desk-habitacion',
      acompId: 'desk-acompanante',
      parentescoId: 'desk-parentesco',
      feedbackId: 'desk-feedback',
      submitBtnId: 'btn-desk-submit'
    });
  });

  document.getElementById('csv-file-input').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    document.getElementById('csv-raw-text').value = await file.text();
  });

  document.getElementById('form-csv-import').addEventListener('submit', async (e) => {
    e.preventDefault();
    await runCsvImport(document.getElementById('csv-raw-text').value, 'Archivo CSV / PMS');
  });

  document.getElementById('btn-import-demo-batch').addEventListener('click', async () => {
    const { data: csvText } = await apiRequest(`/api/pms/${selectedHotelSlug}/csv-template?demo=1`);
    document.getElementById('csv-raw-text').value = csvText;
    await runCsvImport(csvText, 'Lote demo exportación OPERA/CSV');
  });

  document.getElementById('btn-toggle-key').addEventListener('click', () => {
    revealApiKey = !revealApiKey;
    const hotel = appState.hotels.find((h) => h.slug === selectedHotelSlug);
    if (hotel) renderConnectorPanel(hotel);
  });

  document.getElementById('btn-copy-key').addEventListener('click', async () => {
    const hotel = appState.hotels.find((h) => h.slug === selectedHotelSlug);
    if (!hotel?.pmsApiKey) return;
    try {
      await navigator.clipboard.writeText(hotel.pmsApiKey);
      const btn = document.getElementById('btn-copy-key');
      const prev = btn.textContent;
      btn.textContent = 'Copiada';
      setTimeout(() => {
        btn.textContent = prev;
      }, 1400);
    } catch {
      revealApiKey = true;
      renderConnectorPanel(hotel);
    }
  });

  document.getElementById('btn-rotate-key').addEventListener('click', async () => {
    await apiRequest(`/api/pms/${selectedHotelSlug}/rotate-key`, { method: 'POST' });
    revealApiKey = true;
    await fetchState();
  });

  document.getElementById('form-segob-config').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fb = document.getElementById('segob-cfg-feedback');
    const btn = document.getElementById('btn-save-segob-cfg');
    btn.disabled = true;
    try {
      const { ok, data } = await apiRequest(`/api/hotels/${selectedHotelSlug}/segob-config`, {
        method: 'PUT',
        body: {
          segobMode: document.getElementById('cfg-segob-mode').value,
          llaveMxStatus: document.getElementById('cfg-llave-mx').value,
          segobBaseUrl: document.getElementById('cfg-segob-url').value.trim(),
          segobUsuario: document.getElementById('cfg-segob-user').value.trim(),
          segobClave: document.getElementById('cfg-segob-pass').value
        }
      });
      if (!ok) {
        fb.className = 'inline-feedback err';
        fb.textContent = data.error || 'Error al guardar configuración.';
      } else {
        fb.className = 'inline-feedback ok';
        fb.textContent = `Configuración guardada para ${data.hotel.nombre} (modo: ${data.hotel.segobMode}).`;
        await fetchState();
      }
    } finally {
      btn.disabled = false;
    }
  });

  document.getElementById('btn-retry-outbox').addEventListener('click', async () => {
    const btn = document.getElementById('btn-retry-outbox');
    btn.disabled = true;
    try {
      await apiRequest('/api/outbox/retry', { method: 'POST' });
      await fetchState();
    } finally {
      btn.disabled = false;
    }
  });

  document.getElementById('hotels-tbody').addEventListener('click', (e) => {
    const certBtn = e.target.closest('[data-open-cert]');
    if (certBtn) {
      openConstancia(certBtn.dataset.openCert);
      return;
    }
    const connBtn = e.target.closest('[data-open-conn]');
    if (connBtn) {
      syncHotelChange(connBtn.dataset.openConn);
      switchView('conectores');
    }
  });

  const dialog = document.getElementById('add-hotel-dialog');
  const openDialog = () => {
    document.getElementById('form-add-hotel').reset();
    const fb = document.getElementById('add-hotel-feedback');
    fb.textContent = '';
    fb.className = 'inline-feedback';
    dialog.showModal();
  };

  document.getElementById('btn-open-add-hotel').addEventListener('click', openDialog);
  document.getElementById('btn-add-hotel-table').addEventListener('click', openDialog);
  document.getElementById('btn-cancel-add-hotel').addEventListener('click', () => dialog.close('cancel'));
  dialog.addEventListener('close', () => {
    dialog.returnValue = '';
  });

  document.getElementById('form-add-hotel').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!e.currentTarget.reportValidity()) return;
    const fb = document.getElementById('add-hotel-feedback');

    const { ok, data } = await apiRequest('/api/hotels', {
      method: 'POST',
      body: {
        nombre: document.getElementById('new-hotel-nombre').value.trim(),
        rfc: document.getElementById('new-hotel-rfc').value.trim().toUpperCase(),
        habitaciones: Number(document.getElementById('new-hotel-hab').value),
        grupo: document.getElementById('new-hotel-grupo').value.trim() || 'Hotel Afiliado',
        ciudad: document.getElementById('new-hotel-ciudad').value.trim() || 'Monterrey, N.L.',
        pms: document.getElementById('new-hotel-pms').value,
        modoIntegracion: document.getElementById('new-hotel-pms').value.includes('CSV')
          ? 'Portal Web / CSV'
          : 'API / Conector PMS'
      }
    });
    if (!ok) {
      fb.className = 'inline-feedback err';
      fb.textContent = data.error || 'No se pudo registrar el hotel.';
      return;
    }
    selectedHotelSlug = data.hotel.slug;
    dialog.close('created');
    await fetchState();
    switchView('hoteles');
  });

  document.getElementById('btn-reset-demo').addEventListener('click', async () => {
    await apiRequest('/api/demo/reset', { method: 'POST' });
    syncHotelChange('crowne-plaza-monterrey');
    document.getElementById('csv-errors-box').hidden = true;
    document.getElementById('csv-raw-text').value = '';
    document.getElementById('pms-minor-box').hidden = true;
    document.getElementById('desk-minor-box').hidden = true;
  });
}

setupFormValidationAccessibility();
setupDialogClosedByFallback();
bindEvents();
updateRoiCalculator();
bootstrapAuth();
