/**
 * Certeza ID — Consola de Cumplimiento PUI (1-Hotel Pilot Ready)
 * Funciona tanto con el servidor Node.js/SQLite/PostgreSQL como desplegada en CDN estático.
 */

import {
  apiRequest,
  buildDemoCsvBlobUrl,
  downloadAuditCsv,
  getRuntimeMode,
  openConstancia
} from './api-client.js';
import { buildSamplePassportMrz, parseMrz } from './mrz.js';
import { buildLinuxInstallerScript, buildWindowsInstallerScript } from './installer.js';

let currentUser = null;
let appState = null;
let usersList = [];
let selectedHotelSlug = 'hotel-demo-monterrey';
let revealApiKey = false;

const ROLE_LABELS = {
  ASOCIACION_ADMIN: 'Administración General',
  HOTEL_ADMIN: 'Director / TI del Hotel',
  RECEPCION: 'Recepción (Modo Sigilo)'
};

const VIEW_META = {
  resumen: {
    title: 'Panel del hotel',
    subtitle: 'Estado de cumplimiento PUI SEGOB, huéspedes cifrados y pasos de activación.'
  },
  simulacion: {
    title: 'Prueba en vivo SEGOB ↔ Hotel',
    subtitle: 'Simula reportes oficiales de Gobernación y verifica el modo sigilo en recepción.'
  },
  recepcion: {
    title: 'Mostrador de recepción',
    subtitle: 'Registro rápido por CURP/INE o pasaporte extranjero MRZ con cero alarmas en pantalla.'
  },
  conectores: {
    title: 'Conectar PMS y carga CSV / XML',
    subtitle: 'Conecta Oracle OPERA, Cloudbeds o archivos diarios de llegadas sin cambiar tu sistema.'
  },
  tecnico: {
    title: 'Conexión SEGOB y equipo',
    subtitle: 'Configura credenciales oficiales ATDT, revisa entregas Outbox y administra accesos del hotel.'
  },
  pendientes: {
    title: 'Pendientes para conectar al PUI',
    subtitle: 'Checklist vivo de trámites ante gobierno, infraestructura técnica y certificación para salir en vivo con el hotel #1.'
  }
};

const CHECKLIST_STORAGE_KEY = 'certeza_id_pui_rollout_checklist_v1';
let activeChecklistFilter = 'ALL';

const ROLLOUT_TASKS = [
  {
    id: 'tramite-llave-mx',
    group: 'TRAMITE',
    groupTitle: '1. Trámites ante SEGOB / ATDT y datos del hotel',
    title: 'Dar de alta al hotel en Llave MX con e.firma vigente',
    desc: 'El representante legal registra el RFC del hotel en el portal oficial sin costo ($0) y designa al responsable técnico.',
    owner: 'Tú + Hotel',
    eta: '15 min · $0',
    linkLabel: 'Abrir portal oficial',
    linkUrl: 'https://www.plataformadebusqueda.gob.mx/inscripcion'
  },
  {
    id: 'tramite-sandbox-creds',
    group: 'TRAMITE',
    groupTitle: '1. Trámites ante SEGOB / ATDT y datos del hotel',
    title: 'Recibir credenciales oficiales del entorno Sandbox ATDT',
    desc: 'Gobernación entrega la URL oficial, usuario/contraseña PUI y rangos de IP autorizados para pruebas de conexión.',
    owner: 'SEGOB / ATDT',
    eta: '1 a 3 días'
  },
  {
    id: 'tramite-pms-elegido',
    group: 'TRAMITE',
    groupTitle: '1. Trámites ante SEGOB / ATDT y datos del hotel',
    title: 'Definir método de conexión del PMS del hotel #1',
    desc: 'Confirmar si conectaremos por agente local para Oracle OPERA/CSV/XML, webhook API o Mostrador Web directo.',
    owner: 'Tú + Hotel',
    eta: '30 min',
    gotoView: 'conectores',
    gotoLabel: 'Ver conectores'
  },
  {
    id: 'tramite-historico-12y',
    group: 'TRAMITE',
    groupTitle: '1. Trámites ante SEGOB / ATDT y datos del hotel',
    title: 'Importar histórico de huéspedes disponible (hasta 12 años)',
    desc: 'Cargar el historial del hotel para poder responder de inmediato las Fases 1 y 2 que exige el Manual Técnico PUI.',
    owner: 'Hotel + Técnico',
    eta: '1 día'
  },
  {
    id: 'tec-aws-https-ip',
    group: 'TECNICO',
    groupTitle: '2. Infraestructura y seguridad en servidor real (Tu técnico)',
    title: 'Desplegar backend real en AWS con dominio HTTPS e IP fija',
    desc: 'Subir src/server.js fuera de la demo estática con certificado TLS 1.2+, cabecera HSTS e IP saliente fija (NAT Gateway) para lista blanca de SEGOB.',
    owner: 'Técnico',
    eta: '1 a 2 días'
  },
  {
    id: 'tec-postgres-rls',
    group: 'TECNICO',
    groupTitle: '2. Infraestructura y seguridad en servidor real (Tu técnico)',
    title: 'Conectar PostgreSQL 16 + aislamiento RLS por RFC',
    desc: 'Sustituir SQLite de pruebas por pg.Pool usando sql/schema.postgres.sql, FORCE ROW LEVEL SECURITY y cola Outbox con FOR UPDATE SKIP LOCKED.',
    owner: 'Técnico',
    eta: '1 a 2 días'
  },
  {
    id: 'tec-kms-secretos',
    group: 'TECNICO',
    groupTitle: '2. Infraestructura y seguridad en servidor real (Tu técnico)',
    title: 'Migrar secretos y cifrado AES-256-GCM a AWS KMS',
    desc: 'Eliminar valores por defecto en src/security.js, activar arranque fail-fast y usar llaves dedicadas por hotel desde AWS Secrets Manager / KMS.',
    owner: 'Técnico',
    eta: '1 día'
  },
  {
    id: 'tec-waf-redis-2fa',
    group: 'TECNICO',
    groupTitle: '2. Infraestructura y seguridad en servidor real (Tu técnico)',
    title: 'Activar Redis rate limit, 2FA/TOTP y lista blanca WAF',
    desc: 'Migrar src/rateLimit.js a Redis, activar doble factor para administradores y restringir /api/pui/* exclusivamente a las IPs oficiales de SEGOB.',
    owner: 'Técnico',
    eta: '1 día'
  },
  {
    id: 'tec-sast-dast-agente',
    group: 'TECNICO',
    groupTitle: '2. Infraestructura y seguridad en servidor real (Tu técnico)',
    title: 'Endurecer agente PMS y generar reporte SAST / DAST / SCA',
    desc: 'Forzar HTTPS estricto y borrado seguro de archivos procesados en agent/pms-sync-agent.js, más escaneo de vulnerabilidades exigido por Anexo 2 DOF.',
    owner: 'Técnico',
    eta: '1 día'
  },
  {
    id: 'salida-sandbox-test',
    group: 'SALIDA',
    groupTitle: '3. Certificación oficial y arranque comercial',
    title: 'Aprobar pruebas oficiales en Sandbox (/activar-reporte-prueba)',
    desc: 'Ejecutar autenticación JWT, barrido histórico Fases 1–2, monitoreo silencioso Fase 3 y confirmar acuse HTTP 200 real desde SEGOB.',
    owner: 'Técnico + SEGOB',
    eta: '1 día',
    gotoView: 'tecnico',
    gotoLabel: 'Ir a conexión SEGOB'
  },
  {
    id: 'salida-produccion-constancia',
    group: 'SALIDA',
    groupTitle: '3. Certificación oficial y arranque comercial',
    title: 'Activar SEGOB_PRODUCCION y entregar Constancia Oficial PDF',
    desc: 'Cargar credenciales productivas, emitir la Constancia PDF con sello SHA-256 para auditorías y arrancar facturación con el hotel #1.',
    owner: 'Tú + Hotel',
    eta: '30 min',
    gotoView: 'tecnico',
    gotoLabel: 'Configurar producción'
  }
];

function loadChecklistState() {
  try {
    const raw = localStorage.getItem(CHECKLIST_STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveChecklistState(map) {
  try {
    localStorage.setItem(CHECKLIST_STORAGE_KEY, JSON.stringify(map));
  } catch {
    // ignore
  }
}

function renderRolloutChecklist() {
  const doneMap = loadChecklistState();
  const total = ROLLOUT_TASKS.length;
  const doneCount = ROLLOUT_TASKS.filter((t) => doneMap[t.id]).length;
  const pct = Math.round((doneCount / total) * 100);

  const ovCount = document.getElementById('overview-checklist-count');
  const ovBar = document.getElementById('overview-checklist-bar');
  const ovPct = document.getElementById('overview-checklist-pct');
  if (ovCount) ovCount.textContent = `${doneCount}/${total}`;
  if (ovBar) ovBar.style.width = `${pct}%`;
  if (ovPct) ovPct.textContent = `${pct}% listo`;

  const bar = document.getElementById('checklist-progress-bar');
  const lbl = document.getElementById('checklist-progress-label');
  if (bar) bar.style.width = `${pct}%`;
  if (lbl) lbl.textContent = `${doneCount} de ${total} completados (${pct}%)`;

  const tramiteLeft = ROLLOUT_TASKS.filter((t) => t.group === 'TRAMITE' && !doneMap[t.id]).length;
  const tecnicoLeft = ROLLOUT_TASKS.filter((t) => t.group === 'TECNICO' && !doneMap[t.id]).length;
  const stTr = document.getElementById('stat-tramite-left');
  const stTe = document.getElementById('stat-tecnico-left');
  if (stTr) stTr.textContent = tramiteLeft === 0 ? 'Bloque completado' : `${tramiteLeft} pasos pendientes`;
  if (stTe) stTe.textContent = tecnicoLeft === 0 ? 'Bloque completado' : `${tecnicoLeft} pasos pendientes`;

  const container = document.getElementById('checklist-groups');
  if (!container) return;

  const filtered = ROLLOUT_TASKS.filter((t) => {
    if (activeChecklistFilter === 'ALL') return true;
    if (activeChecklistFilter === 'PENDIENTES') return !doneMap[t.id];
    return t.group === activeChecklistFilter;
  });

  if (!filtered.length) {
    container.innerHTML =
      '<article class="card"><div class="empty-state">No hay pendientes en este filtro. Todos los pasos seleccionados están completados.</div></article>';
    return;
  }

  const groupsOrder = ['TRAMITE', 'TECNICO', 'SALIDA'];
  container.innerHTML = groupsOrder
    .map((gKey) => {
      const items = filtered.filter((t) => t.group === gKey);
      if (!items.length) return '';
      const groupDone = ROLLOUT_TASKS.filter((t) => t.group === gKey && doneMap[t.id]).length;
      const groupTotal = ROLLOUT_TASKS.filter((t) => t.group === gKey).length;
      return `
        <article class="card">
          <div class="checklist-group-head">
            <h3>${escapeHtml(items[0].groupTitle)}</h3>
            <span class="badge ${groupDone === groupTotal ? 'badge-active' : 'badge-neutral'}">${groupDone}/${groupTotal} listos</span>
          </div>
          <div class="checklist-items">
            ${items
              .map((t) => {
                const isDone = Boolean(doneMap[t.id]);
                const ownerClass = t.group === 'TECNICO' ? 'badge-pending' : t.group === 'SALIDA' ? 'badge-active' : 'badge-neutral';
                return `
                  <label class="checklist-row ${isDone ? 'is-done' : ''}">
                    <input type="checkbox" data-cl-id="${escapeHtml(t.id)}" ${isDone ? 'checked' : ''} />
                    <div class="checklist-row-body">
                      <strong>${escapeHtml(t.title)}</strong>
                      <p>
                        ${escapeHtml(t.desc)}
                        ${
                          t.linkUrl
                            ? ` <a href="${escapeHtml(t.linkUrl)}" target="_blank" rel="noopener">${escapeHtml(t.linkLabel)}</a>`
                            : ''
                        }
                        ${
                          t.gotoView
                            ? ` <button type="button" class="btn-link-inline" data-goto="${escapeHtml(t.gotoView)}">${escapeHtml(t.gotoLabel)}</button>`
                            : ''
                        }
                      </p>
                    </div>
                    <div class="checklist-row-tags">
                      <span class="badge ${ownerClass}">${escapeHtml(t.owner)}</span>
                      <span class="checklist-eta">${escapeHtml(t.eta)}</span>
                    </div>
                  </label>`;
              })
              .join('')}
          </div>
        </article>`;
    })
    .join('');
}

function buildChecklistWhatsAppSummary() {
  const doneMap = loadChecklistState();
  const doneCount = ROLLOUT_TASKS.filter((t) => doneMap[t.id]).length;
  const lines = [
    `Certeza ID — Avance para conectar al PUI (${doneCount}/${ROLLOUT_TASKS.length})`,
    ''
  ];
  for (const gKey of ['TRAMITE', 'TECNICO', 'SALIDA']) {
    const items = ROLLOUT_TASKS.filter((t) => t.group === gKey);
    lines.push(items[0].groupTitle);
    for (const t of items) {
      lines.push(`${doneMap[t.id] ? '[x]' : '[ ]'} ${t.title} (${t.owner} · ${t.eta})`);
    }
    lines.push('');
  }
  return lines.join('\n').trim();
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

function setupDeclarativeCopyButtons() {
  const timers = new WeakMap();

  function report(button, ok) {
    const tip = button.nextElementSibling;
    if (!tip || !tip.classList.contains('copy-tip')) return;
    clearTimeout(timers.get(button));
    tip.textContent = ok ? 'Copiado' : 'Error al copiar';
    timers.set(
      button,
      setTimeout(() => {
        tip.textContent = '';
      }, 1800)
    );
  }

  async function copy(button, target) {
    const text = target.dataset.copyValue
      ? target.dataset.copyValue
      : target.matches('input, textarea')
        ? target.value
        : target.innerText.trim();
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      report(button, true);
    } catch {
      report(button, false);
    }
  }

  if ('CommandEvent' in window) {
    document.addEventListener(
      'command',
      (event) => {
        if (event.command === '--copy') copy(event.source, event.target);
      },
      true
    );
  } else {
    document.addEventListener('click', (event) => {
      const button = event.target.closest('button[command="--copy"]');
      if (!button) return;
      const target = document.getElementById(button.getAttribute('commandfor'));
      if (target) copy(button, target);
    });
  }
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
  const isRec = role === 'RECEPCION';

  document.getElementById('session-user-name').textContent = currentUser.nombre;
  document.getElementById('session-user-role').textContent = ROLE_LABELS[role] || role;

  for (const btn of document.querySelectorAll('.nav-btn')) {
    const allowed = (btn.dataset.roles || '').split(',').includes(role);
    btn.hidden = !allowed;
  }

  document.getElementById('btn-topbar-constancia').hidden = isRec;
  document.getElementById('btn-quick-demo').hidden = isRec;
  document.getElementById('btn-reset-demo').hidden = isRec;

  switchView(isRec ? 'recepcion' : 'resumen');
}

function showAuthScreen(demoAccounts = []) {
  document.getElementById('app-shell').hidden = true;
  document.getElementById('auth-screen').hidden = false;

  const box = document.getElementById('demo-roles-box');
  const list = document.getElementById('demo-roles-list');
  const details = document.getElementById('auth-manual-details');

  if (demoAccounts.length > 0) {
    box.hidden = false;
    list.innerHTML = demoAccounts
      .map(
        (acc) => `
        <button
          type="button"
          class="demo-role-btn"
          data-demo-email="${escapeHtml(acc.email)}"
          data-demo-pass="${escapeHtml(acc.passwordDemo)}"
        >
          <span class="demo-role-head">
            <strong>${escapeHtml(acc.etiqueta)}</strong>
            <span class="demo-role-tag">${acc.rol === 'RECEPCION' ? 'Sigilo' : 'Control total'}</span>
          </span>
          <span class="demo-role-desc">${escapeHtml(acc.alcance)}</span>
        </button>`
      )
      .join('');
    if (details) details.open = false;
  } else {
    box.hidden = true;
    if (details) details.open = true;
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

async function fetchUsers() {
  if (!currentUser || currentUser.rol === 'RECEPCION') {
    usersList = [];
    return;
  }
  const { ok, data } = await apiRequest('/api/users');
  if (ok && Array.isArray(data.users)) {
    usersList = data.users;
    renderUsersTable();
  }
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
  await fetchUsers();
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
  if (selectId === 'global-hotel-select') {
    sel.hidden = appState.hotels.length <= 1;
  }
}

function renderAll() {
  if (!appState) return;
  const hotel = appState.hotels.find((h) => h.slug === selectedHotelSlug) || appState.hotels[0];
  const hotelGuests = appState.guests.filter((g) => !hotel || g.hotelSlug === hotel.slug);
  const activeAlerts = appState.alerts.filter((a) => a.activa && (!hotel || a.hotelSlug === hotel.slug));
  const deliveredOutbox = appState.outbox.filter((o) => o.estado === 'ENTREGADO' && (!hotel || o.hotelSlug === hotel.slug));
  const hotelAudit = appState.auditLog.filter((e) => !hotel || e.hotelSlug === hotel.slug);
  const cadenaOk = appState.integridadCadena?.integra !== false;
  const isStatic = getRuntimeMode() === 'static-pages';

  document.getElementById('kpi-guests-count').textContent = String(hotelGuests.length);
  document.getElementById('kpi-alerts-count').textContent = String(activeAlerts.length);
  document.getElementById('kpi-outbox-count').textContent = String(deliveredOutbox.length);
  document.getElementById('kpi-audit-count').textContent = String(hotelAudit.length);
  document.getElementById('kpi-chain-meta').textContent = cadenaOk
    ? 'Cadena SHA-256 íntegra'
    : 'Revisar integridad';
  document.getElementById('sidebar-chain-status').textContent = isStatic
    ? 'Demo interactiva · SHA-256 íntegro'
    : 'Servidor activo · SHA-256 íntegro';

  populateHotelSelect('global-hotel-select');
  populateHotelSelect('new-user-hotel');

  if (hotel) {
    document.getElementById('sidebar-hotel-name').textContent = hotel.nombre;
    document.getElementById('hero-hotel-status').textContent = hotel.estatus || 'Activo';
    document.getElementById('hero-hotel-name').textContent = hotel.nombre;
    document.getElementById('hero-hotel-meta').textContent = `RFC ${hotel.rfc} · ${hotel.ciudad} · ${hotel.habitaciones} habitaciones · ${hotel.pms}`;
    document.getElementById('hero-segob-mode').textContent = hotel.segobMode || 'SANDBOX_SIMULADO';
    document.getElementById('hero-llave-status').textContent = hotel.llaveMxStatus || 'Certificado Sandbox';

    document.getElementById('pms-panel-title').textContent = `2. Mostrador ${hotel.nombre} (Sigilo)`;
    document.getElementById('desk-hotel-title').textContent = `Terminal de Mostrador — ${hotel.nombre}`;

    const dlLink = document.getElementById('btn-download-csv-template');
    if (isStatic) {
      dlLink.href = buildDemoCsvBlobUrl();
      dlLink.download = `plantilla_huespedes_${hotel.slug}.csv`;
    } else {
      dlLink.href = `./api/pms/${hotel.slug}/csv-template`;
      dlLink.removeAttribute('download');
    }

    if (currentUser?.rol !== 'RECEPCION') {
      renderConnectorPanel(hotel);
      renderDofSpec(hotel);
      populateSegobConfigForm(hotel);
    }
  }

  renderOverviewAudit(hotelAudit);
  renderActiveAlerts();
  renderHotelGuests('hotel-guests-list');
  renderHotelGuests('desk-guests-list');
  renderAuditFeed(hotelAudit);
  renderOutboxFeed(hotel);
  renderRolloutChecklist();
}

function renderOverviewAudit(logs) {
  const container = document.getElementById('overview-audit-list');
  if (!container) return;
  const recent = logs.slice(0, 5);
  if (!recent.length) {
    container.innerHTML = '<div class="empty-state">Aún no hay eventos registrados.</div>';
    return;
  }
  container.innerHTML = recent
    .map(
      (entry) => `
      <div class="mini-item">
        <div class="mini-item-head">
          <span class="badge ${entry.critico ? 'badge-danger' : entry.direccion === 'HOTEL → SEGOB' ? 'badge-active' : 'badge-neutral'}">
            ${escapeHtml(entry.fase || entry.direccion)}
          </span>
          <span class="audit-time">${escapeHtml(formatTime(entry.timestamp))}</span>
        </div>
        <div class="mini-item-meta">${escapeHtml(entry.resumen)}</div>
      </div>`
    )
    .join('');
}

function populateSegobConfigForm(hotel) {
  document.getElementById('cfg-segob-mode').value = hotel.segobMode || 'SANDBOX_SIMULADO';
  document.getElementById('cfg-llave-mx').value = hotel.llaveMxStatus || 'Certificado Sandbox';
  document.getElementById('cfg-segob-url').value = hotel.segobBaseUrl || '';
  document.getElementById('cfg-segob-user').value = hotel.segobUsuario || '';
  document.getElementById('cfg-segob-pass').value = '';
}

function renderConnectorPanel(hotel) {
  document.getElementById('conn-hotel-rfc').textContent = `RFC: ${hotel.rfc}`;
  const key = hotel.pmsApiKey || '';
  const masked = key ? `${key.slice(0, 14)}••••••••••••••••` : 'Sin llave';
  const keyEl = document.getElementById('conn-api-key');
  keyEl.textContent = revealApiKey ? key : masked;
  keyEl.dataset.copyValue = key;
  document.getElementById('btn-toggle-key').textContent = revealApiKey ? 'Ocultar' : 'Mostrar';

  const origin = getRuntimeMode() === 'static-pages' ? 'https://api.certezaid.mx' : window.location.origin;
  const shownKey = revealApiKey ? key : '<TU_LLAVE_PMS>';
  const sampleCurp = appState.escenariosDemo?.huespedSinAlerta?.curp || 'TEGC850910HNLVRN05';

  document.getElementById('pms-agent-snippet').textContent = `# Ejecutar en servidor local de ${hotel.nombre} (Windows / Linux)
node agent/pms-sync-agent.js \\
  --dir "./exports-opera" \\
  --hotel "${hotel.slug}" \\
  --key "${shownKey}" \\
  --url "${origin}"`;

  document.getElementById('pms-webhook-snippet').textContent = `# Webhook de Check-in desde ${hotel.pms} → Certeza ID
curl -s -X POST "${origin}/api/pms/${hotel.slug}/checkin" \\
  -H "Content-Type: application/json" \\
  -H "X-Portico-PMS-Key: ${shownKey}" \\
  -d '{
    "nombre": "SOFIA MARTINEZ GARZA",
    "curp": "${sampleCurp}",
    "habitacion": "0804"
  }'`;
}

function renderActiveAlerts() {
  const container = document.getElementById('active-alerts-list');
  const list = appState.alerts.filter((a) => a.hotelSlug === selectedHotelSlug);

  if (!list.length) {
    container.innerHTML =
      '<div class="empty-state">No hay reportes de búsqueda activos. Usa un escenario rápido arriba para probar.</div>';
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
              ? '<span class="badge badge-danger">Fase 3 activa</span>'
              : '<span class="badge badge-neutral">Cerrado</span>'
          }
        </div>
        <div class="mini-item-meta">
          CURP: <code>${escapeHtml(a.curpEnmascarada)}</code> · ${escapeHtml(a.tipoAlerta)}
        </div>
        <div class="mini-item-head" style="margin-top: 0.4rem">
          <span class="mini-item-meta" style="margin-top: 0">Coincidencias enviadas: <strong>${a.coincidenciasReportadas}</strong></span>
          ${
            a.activa
              ? `<button type="button" class="btn-link-danger" data-deactivate="${escapeHtml(a.reporteId)}">Desactivar</button>`
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
          <span class="badge badge-neutral">Hab. ${escapeHtml(g.habitacion)}</span>
        </div>
        <div class="mini-item-meta">
          ID: <code>${escapeHtml(g.curpEnmascarada)}</code> · ${escapeHtml(g.tipo)}
        </div>
      </div>`
    )
    .join('');
}

function renderAuditFeed(logs) {
  const container = document.getElementById('audit-feed');
  const slice = logs.slice(0, 30);

  if (!slice.length) {
    container.innerHTML = '<div class="empty-state">Sin eventos registrados.</div>';
    return;
  }

  container.innerHTML = slice
    .map((entry) => {
      const badgeClass = entry.critico
        ? 'badge-danger'
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
            <summary>Ver evidencia JSON</summary>
            <pre>${escapeHtml(JSON.stringify(entry.payload, null, 2))}</pre>
          </details>
        </article>`;
    })
    .join('');
}

function renderOutboxFeed(hotel) {
  const container = document.getElementById('outbox-feed');
  if (!container) return;
  const items = (appState.outbox || []).filter((o) => !hotel || o.hotelSlug === hotel.slug).slice(0, 20);

  if (!items.length) {
    container.innerHTML =
      '<div class="empty-state">Aún no hay envíos salientes hacia SEGOB. Ejecuta una prueba en vivo para ver el acuse.</div>';
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
            ${escapeHtml(job.endpoint)} · Folio <code>${escapeHtml(job.reporteId)}</code>
          </p>
          <div class="audit-meta">
            Intentos: ${job.intentos}/${job.maxIntentos}
            ${job.ultimoHttp ? ` · HTTP ${job.ultimoHttp}` : ''}
            ${job.latenciaMs ? ` · ${job.latenciaMs} ms` : ''}
            ${job.acuseSegob ? ` · Acuse: ${escapeHtml(job.acuseSegob)}` : ''}
          </div>
        </article>`;
    })
    .join('');
}

function renderUsersTable() {
  const tbody = document.getElementById('users-tbody');
  if (!tbody) return;
  if (!usersList.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="cell-sub">Sin cuentas registradas.</td></tr>';
    return;
  }
  tbody.innerHTML = usersList
    .map((u) => {
      const hotelObj = appState?.hotels?.find((h) => h.slug === u.hotelSlug);
      const scopeLabel = hotelObj ? hotelObj.nombre : u.hotelSlug || 'Hotel Demo Monterrey';
      const isSelf = currentUser && u.email === currentUser.email;
      const roleClass = u.rol === 'RECEPCION' ? 'badge-neutral' : 'badge-active';
      const statusBadge = u.activo
        ? '<span class="badge badge-active">Activa</span>'
        : '<span class="badge badge-danger">Suspendida</span>';
      return `
        <tr>
          <td><strong>${escapeHtml(u.nombre)}</strong></td>
          <td><code>${escapeHtml(u.email)}</code></td>
          <td><span class="badge ${roleClass}">${escapeHtml(ROLE_LABELS[u.rol] || u.rol)}</span></td>
          <td>${escapeHtml(scopeLabel)}</td>
          <td>${statusBadge}</td>
          <td>
            ${
              isSelf
                ? '<span class="cell-sub">Sesión actual</span>'
                : `<button type="button" class="btn-secondary btn-sm" data-toggle-user="${u.id}" data-next-active="${u.activo ? '0' : '1'}">${u.activo ? 'Suspender' : 'Reactivar'}</button>`
            }
          </td>
        </tr>`;
    })
    .join('');
}

function renderDofSpec(hotel) {
  if (!hotel) return;
  const origin = getRuntimeMode() === 'static-pages' ? 'https://api.certezaid.mx' : window.location.origin;
  const slug = hotel.slug;
  const sampleCurp =
    appState.escenariosDemo?.alertaEnTiempoReal?.curp ||
    appState.escenariosDemo?.menorEnTiempoReal?.curp ||
    'GASR880514HNLRLZ08';

  const endpoints = [
    { method: 'POST', path: `/api/pui/${slug}/login`, desc: 'Emite token Bearer JWT para SEGOB' },
    { method: 'POST', path: `/api/pui/${slug}/activar-reporte`, desc: 'Recibe reporte oficial y ejecuta Fases 1, 2 y 3' },
    { method: 'POST', path: `/api/pui/${slug}/activar-reporte-prueba`, desc: 'Validación oficial en Sandbox ATDT' },
    { method: 'POST', path: `/api/pui/${slug}/desactivar-reporte`, desc: 'Cierra monitoreo continuo Fase 3' },
    { method: 'POST', path: `/api/pms/${slug}/checkin`, desc: 'Webhook PMS (cruce silencioso Fase 3)' },
    { method: 'POST', path: `/api/pms/${slug}/import-csv`, desc: 'Carga masiva CSV / XML de Oracle OPERA' }
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
  -d '{"id":"FUB-SANDBOX-001","curp":"${sampleCurp}"}'`;
}

async function checkCurpLive(raw, metaElId) {
  const box = document.getElementById(metaElId);
  if (!box) return;
  const val = raw.trim().toUpperCase();
  if (val.length < 18) {
    box.textContent = '';
    box.className = 'curp-meta';
    return;
  }
  const { data } = await apiRequest(`/api/curp/validar?curp=${encodeURIComponent(val)}`);
  if (data.valida) {
    box.className = 'curp-meta valid';
    box.textContent = `CURP válida RENAPO · ${data.entidad} · ${data.edad} años`;
  } else {
    box.className = 'curp-meta invalid';
    box.textContent = data.error;
  }
}

async function submitCheckinForm({ form, nombreId, curpId, habId, feedbackId, submitBtnId }) {
  if (!form.reportValidity()) return;
  const fb = document.getElementById(feedbackId);
  const btn = document.getElementById(submitBtnId);
  btn.disabled = true;
  try {
    const docTypeEl = form.querySelector('[name="docType"]');
    const isPassport = docTypeEl && docTypeEl.value === 'PASAPORTE';
    const body = {
      nombre: document.getElementById(nombreId).value.trim(),
      habitacion: document.getElementById(habId).value.trim()
    };
    if (isPassport) {
      body.esExtranjero = true;
      body.pasaporte = document.getElementById('desk-pasaporte').value.trim().toUpperCase();
      body.nacionalidad = document.getElementById('desk-nacionalidad').value.trim().toUpperCase() || 'EXT';
      body.fechaNacimiento = document.getElementById('desk-fnac').value || '';
    } else {
      body.curp = document.getElementById(curpId).value.trim().toUpperCase();
    }

    const { ok, data } = await apiRequest(`/api/pms/${selectedHotelSlug}/checkin`, {
      method: 'POST',
      body
    });
    if (!ok) {
      fb.className = 'inline-feedback err';
      fb.textContent = data.error || 'Error al registrar huésped.';
    } else {
      fb.className = 'inline-feedback ok';
      fb.textContent = data.mensaje_recepcion || 'Check-in completado correctamente.';
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
      fb.textContent = data.error || 'No se pudo procesar el archivo.';
      errBox.hidden = true;
      return;
    }

    fb.className = data.rechazados > 0 ? 'inline-feedback warn' : 'inline-feedback ok';
    fb.textContent = `Lote procesado en ${data.hotel}: ${data.insertados} huéspedes cifrados en bóveda (con cruce silencioso Fase 3) y ${data.rechazados} fila(s) rechazada(s) por CURP inválida.`;

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

  for (const btn of document.querySelectorAll('[data-goto]')) {
    btn.addEventListener('click', () => switchView(btn.dataset.goto));
  }

  document.getElementById('btn-quick-demo').addEventListener('click', () => switchView('simulacion'));
  document.getElementById('btn-hero-sim').addEventListener('click', () => switchView('simulacion'));
  document.getElementById('btn-topbar-constancia').addEventListener('click', () => openConstancia(selectedHotelSlug));
  document.getElementById('btn-hero-constancia').addEventListener('click', () => openConstancia(selectedHotelSlug));

  document.getElementById('global-hotel-select').addEventListener('change', (e) => syncHotelChange(e.target.value));

  // Escenarios rápidos PUI
  document.getElementById('btn-scenario-alerta').addEventListener('click', () => {
    const sc = appState.escenariosDemo.alertaEnTiempoReal || appState.escenariosDemo.menorEnTiempoReal;
    document.getElementById('segob-reporte-id').value = sc.reporteId;
    document.getElementById('segob-curp').value = sc.curp;
    document.getElementById('segob-tipo').value = 'Reporte PUI Activo';
    document.getElementById('pms-nombre').value = sc.nombre;
    document.getElementById('pms-curp').value = sc.curp;
    document.getElementById('pms-habitacion').value = sc.habitacion;
    checkCurpLive(sc.curp, 'pms-curp-live');
  });

  document.getElementById('btn-scenario-historico').addEventListener('click', () => {
    const sc = appState.escenariosDemo.coincidenciaHistorica;
    document.getElementById('segob-reporte-id').value = sc.reporteId;
    document.getElementById('segob-curp').value = sc.curp;
    document.getElementById('segob-tipo').value = 'Búsqueda Histórica PUI (Fases 1 y 2)';
  });

  document.getElementById('btn-scenario-normal').addEventListener('click', () => {
    const sc = appState.escenariosDemo.huespedSinAlerta;
    document.getElementById('pms-nombre').value = sc.nombre;
    document.getElementById('pms-curp').value = sc.curp;
    document.getElementById('pms-habitacion').value = sc.habitacion;
    checkCurpLive(sc.curp, 'pms-curp-live');
  });

  // Mostrador recepción
  const syncDeskDocType = (mode) => {
    const sel = document.getElementById('desk-doc-type');
    if (mode) sel.value = mode;
    const isPass = sel.value === 'PASAPORTE';
    document.getElementById('desk-curp-wrap').hidden = isPass;
    document.getElementById('desk-passport-wrap').hidden = !isPass;
    document.getElementById('desk-curp').required = !isPass;
    document.getElementById('desk-pasaporte').required = isPass;
  };
  document.getElementById('desk-doc-type').addEventListener('change', () => syncDeskDocType());

  const applyMrzScan = (raw) => {
    const meta = document.getElementById('desk-mrz-meta');
    const parsed = parseMrz(raw);
    if (!parsed.valido) {
      meta.className = 'curp-meta invalid';
      meta.textContent = parsed.error;
      return;
    }
    meta.className = 'curp-meta valid';
    meta.textContent = `MRZ ICAO válido (${parsed.formato}) · ${parsed.nacionalidad} · Pasaporte: ${parsed.numeroDocumento}`;
    document.getElementById('desk-nombre').value = parsed.nombreCompleto;
    syncDeskDocType('PASAPORTE');
    document.getElementById('desk-pasaporte').value = parsed.numeroDocumento;
    document.getElementById('desk-nacionalidad').value = parsed.nacionalidad;
    document.getElementById('desk-fnac').value = parsed.fechaNacimiento;
  };
  document.getElementById('desk-mrz-input').addEventListener('input', (e) => applyMrzScan(e.target.value));

  document.getElementById('btn-scan-passport').addEventListener('click', () => {
    document.getElementById('desk-mrz-box').hidden = false;
    const mrz = buildSamplePassportMrz();
    document.getElementById('desk-mrz-input').value = mrz;
    document.getElementById('desk-habitacion').value = '1810';
    applyMrzScan(mrz);
  });

  document.getElementById('btn-scan-ine').addEventListener('click', () => {
    syncDeskDocType('CURP');
    document.getElementById('desk-mrz-box').hidden = true;
    const sc = appState.escenariosDemo.escaneoIneEjecutivo;
    document.getElementById('desk-nombre').value = sc.nombre;
    document.getElementById('desk-curp').value = sc.curp;
    document.getElementById('desk-habitacion').value = sc.habitacion;
    checkCurpLive(sc.curp, 'desk-curp-live');
  });

  let curpTimer1;
  document.getElementById('pms-curp').addEventListener('input', (e) => {
    clearTimeout(curpTimer1);
    curpTimer1 = setTimeout(() => checkCurpLive(e.target.value, 'pms-curp-live'), 160);
  });

  let curpTimer2;
  document.getElementById('desk-curp').addEventListener('input', (e) => {
    clearTimeout(curpTimer2);
    curpTimer2 = setTimeout(() => checkCurpLive(e.target.value, 'desk-curp-live'), 160);
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
        fb.textContent = `Reporte ${data.id} activo en ${data.hotel}. Coincidencias históricas (Fases 1–2): ${data.coincidencias_historicas}. Monitoreo silencioso Fase 3 encendido.`;
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
      feedbackId: 'desk-feedback',
      submitBtnId: 'btn-desk-submit'
    });
  });

  // Conectores CSV / XML / Instaladores
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
    await runCsvImport(csvText, 'Lote demo CSV');
  });

  document.getElementById('btn-import-demo-xml').addEventListener('click', async () => {
    const sampleCurp = appState?.escenariosDemo?.huespedSinAlerta?.curp || 'TEGC850910HNLVRN05';
    const xmlSample = `<?xml version="1.0" encoding="UTF-8"?>
<OPERA_INHOUSE_EXPORT hotel="${selectedHotelSlug}">
  <G_RESERVATION>
    <FULL_NAME>ALEJANDRO GARZA SADA</FULL_NAME>
    <CURP>${sampleCurp}</CURP>
    <ROOM>1502</ROOM>
    <ARRIVAL>${new Date().toISOString()}</ARRIVAL>
  </G_RESERVATION>
  <G_RESERVATION>
    <FULL_NAME>MICHAEL JAMES ANDERSON</FULL_NAME>
    <PASSPORT>548920174</PASSPORT>
    <NATIONALITY>USA</NATIONALITY>
    <BIRTH_DATE>1984-06-19</BIRTH_DATE>
    <ROOM>1810</ROOM>
    <ARRIVAL>${new Date().toISOString()}</ARRIVAL>
  </G_RESERVATION>
</OPERA_INHOUSE_EXPORT>`;
    document.getElementById('csv-raw-text').value = xmlSample;
    await runCsvImport(xmlSample, 'Exportación XML Oracle OPERA 5');
  });

  document.getElementById('btn-toggle-key').addEventListener('click', () => {
    revealApiKey = !revealApiKey;
    const hotel = appState.hotels.find((h) => h.slug === selectedHotelSlug);
    if (hotel) renderConnectorPanel(hotel);
  });

  document.getElementById('btn-rotate-key').addEventListener('click', async () => {
    await apiRequest(`/api/pms/${selectedHotelSlug}/rotate-key`, { method: 'POST' });
    revealApiKey = true;
    await fetchState();
  });

  const downloadInstaller = (os) => {
    const hotel = appState?.hotels?.find((h) => h.slug === selectedHotelSlug);
    if (!hotel) return;
    if (getRuntimeMode() !== 'static-pages') {
      window.location.href = `./api/pms/${encodeURIComponent(hotel.slug)}/installer?os=${os}`;
      return;
    }
    const origin = 'https://api.certezaid.mx';
    const isLinux = os === 'linux';
    const content = isLinux
      ? buildLinuxInstallerScript({
          hotelNombre: hotel.nombre,
          hotelSlug: hotel.slug,
          rfc: hotel.rfc,
          apiKey: hotel.pmsApiKey,
          baseUrl: origin
        })
      : buildWindowsInstallerScript({
          hotelNombre: hotel.nombre,
          hotelSlug: hotel.slug,
          rfc: hotel.rfc,
          apiKey: hotel.pmsApiKey,
          baseUrl: origin
        });
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = isLinux
      ? `instalar-certeza-agent-${hotel.slug}.sh`
      : `Instalar-Certeza-Agent-${hotel.slug}.ps1`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  document.getElementById('btn-dl-installer-win').addEventListener('click', () => downloadInstaller('windows'));
  document.getElementById('btn-dl-installer-linux').addEventListener('click', () => downloadInstaller('linux'));

  // Configuración SEGOB y Outbox
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
        fb.textContent = `Configuración guardada para ${data.hotel.nombre} (${data.hotel.segobMode}).`;
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

  document.getElementById('btn-export-audit-sim').addEventListener('click', () => downloadAuditCsv(selectedHotelSlug));
  document.getElementById('btn-export-audit-tech').addEventListener('click', () => downloadAuditCsv(selectedHotelSlug));

  // Modal crear usuario
  const userDialog = document.getElementById('add-user-dialog');
  document.getElementById('btn-toggle-new-user-pass').addEventListener('click', () => {
    const input = document.getElementById('new-user-password');
    const btn = document.getElementById('btn-toggle-new-user-pass');
    const showing = input.type === 'text';
    input.type = showing ? 'password' : 'text';
    btn.textContent = showing ? 'Mostrar' : 'Ocultar';
  });

  document.getElementById('btn-open-add-user').addEventListener('click', () => {
    document.getElementById('form-add-user').reset();
    const fb = document.getElementById('add-user-feedback');
    fb.textContent = '';
    fb.className = 'inline-feedback';
    userDialog.showModal();
  });

  document.getElementById('btn-cancel-add-user').addEventListener('click', () => userDialog.close('cancel'));

  document.getElementById('form-add-user').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!e.currentTarget.reportValidity()) return;
    const fb = document.getElementById('add-user-feedback');
    const { ok, data } = await apiRequest('/api/users', {
      method: 'POST',
      body: {
        nombre: document.getElementById('new-user-nombre').value.trim(),
        email: document.getElementById('new-user-email').value.trim(),
        password: document.getElementById('new-user-password').value,
        rol: document.getElementById('new-user-rol').value,
        hotelSlug: document.getElementById('new-user-hotel').value || selectedHotelSlug
      }
    });
    if (!ok) {
      fb.className = 'inline-feedback err';
      fb.textContent = data.error || 'No se pudo crear la cuenta.';
      return;
    }
    userDialog.close('created');
    await fetchState();
  });

  document.getElementById('users-tbody').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-toggle-user]');
    if (!btn) return;
    btn.disabled = true;
    try {
      await apiRequest(`/api/users/${btn.dataset.toggleUser}`, {
        method: 'PATCH',
        body: { activo: btn.dataset.nextActive === '1' }
      });
      await fetchState();
    } finally {
      btn.disabled = false;
    }
  });

  // Modal agregar otra propiedad
  const hotelDialog = document.getElementById('add-hotel-dialog');
  document.getElementById('btn-open-add-hotel').addEventListener('click', () => {
    document.getElementById('form-add-hotel').reset();
    const fb = document.getElementById('add-hotel-feedback');
    fb.textContent = '';
    fb.className = 'inline-feedback';
    hotelDialog.showModal();
  });
  document.getElementById('btn-cancel-add-hotel').addEventListener('click', () => hotelDialog.close('cancel'));

  document.getElementById('form-add-hotel').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!e.currentTarget.reportValidity()) return;
    const fb = document.getElementById('add-hotel-feedback');
    const pms = document.getElementById('new-hotel-pms').value;
    const { ok, data } = await apiRequest('/api/hotels', {
      method: 'POST',
      body: {
        nombre: document.getElementById('new-hotel-nombre').value.trim(),
        rfc: document.getElementById('new-hotel-rfc').value.trim().toUpperCase(),
        habitaciones: Number(document.getElementById('new-hotel-hab').value),
        ciudad: document.getElementById('new-hotel-ciudad').value.trim() || 'Monterrey, N.L.',
        pms,
        modoIntegracion: pms.includes('CSV') ? 'Portal Web / CSV' : 'Conector PMS'
      }
    });
    if (!ok) {
      fb.className = 'inline-feedback err';
      fb.textContent = data.error || 'No se pudo registrar la propiedad.';
      return;
    }
    selectedHotelSlug = data.hotel.slug;
    hotelDialog.close('created');
    await fetchState();
    switchView('resumen');
  });

  document.getElementById('btn-reset-demo').addEventListener('click', async () => {
    await apiRequest('/api/demo/reset', { method: 'POST' });
    selectedHotelSlug = 'hotel-demo-monterrey';
    document.getElementById('csv-errors-box').hidden = true;
    document.getElementById('csv-raw-text').value = '';
    await fetchState();
  });

  // Gestor interactivo de pendientes PUI
  document.getElementById('checklist-groups')?.addEventListener('change', (e) => {
    const cb = e.target.closest('input[data-cl-id]');
    if (!cb) return;
    const map = loadChecklistState();
    map[cb.dataset.clId] = cb.checked;
    saveChecklistState(map);
    renderRolloutChecklist();
  });

  document.getElementById('checklist-groups')?.addEventListener('click', (e) => {
    const jump = e.target.closest('button[data-goto]');
    if (!jump) return;
    e.preventDefault();
    switchView(jump.dataset.goto);
  });

  for (const pill of document.querySelectorAll('.filter-pill[data-cl-filter]')) {
    pill.addEventListener('click', () => {
      activeChecklistFilter = pill.dataset.clFilter;
      for (const other of document.querySelectorAll('.filter-pill[data-cl-filter]')) {
        other.classList.toggle('is-active', other === pill);
      }
      renderRolloutChecklist();
    });
  }

  document.getElementById('btn-copy-checklist')?.addEventListener('click', async () => {
    const fb = document.getElementById('checklist-copy-feedback');
    try {
      await navigator.clipboard.writeText(buildChecklistWhatsAppSummary());
      if (fb) fb.textContent = 'Resumen copiado listo para WhatsApp o correo';
      setTimeout(() => {
        if (fb) fb.textContent = '';
      }, 2400);
    } catch {
      if (fb) fb.textContent = 'No se pudo copiar automáticamente';
    }
  });

  document.getElementById('btn-reset-checklist')?.addEventListener('click', () => {
    saveChecklistState({});
    renderRolloutChecklist();
  });
}

setupDialogClosedByFallback();
setupDeclarativeCopyButtons();
bindEvents();
bootstrapAuth();
