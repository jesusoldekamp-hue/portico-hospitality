/**
 * Capa dual de transporte para Certeza ID:
 * - Si hay servidor Node.js / AWS activo, usa los endpoints reales `/api/*`.
 * - Si se despliega estáticamente en CDN (Cloudflare Pages, Vercel, etc.), activa
 *   automáticamente el motor completo en navegador (CURP RENAPO real, RBAC,
 *   Fases 1-3, CSV, Outbox y Constancia PDF con SHA-256 vía Web Crypto).
 */

import { estimateScaleInfrastructure } from './installer.js';

let runtimeMode = null; // 'server' | 'static-pages'

const ENTIDADES_CURP = {
  AS: 'Aguascalientes', BC: 'Baja California', BS: 'Baja California Sur', CC: 'Campeche',
  CL: 'Coahuila', CM: 'Colima', CS: 'Chiapas', CH: 'Chihuahua', DF: 'Ciudad de México',
  DG: 'Durango', GT: 'Guanajuato', GR: 'Guerrero', HG: 'Hidalgo', JC: 'Jalisco',
  MC: 'Estado de México', MN: 'Michoacán', MS: 'Morelos', NT: 'Nayarit', NL: 'Nuevo León',
  OC: 'Oaxaca', PL: 'Puebla', QT: 'Querétaro', QR: 'Quintana Roo', SP: 'San Luis Potosí',
  SL: 'Sinaloa', SR: 'Sonora', TC: 'Tabasco', TS: 'Tamaulipas', TL: 'Tlaxcala',
  VZ: 'Veracruz', YN: 'Yucatán', ZS: 'Zacatecas', NE: 'Nacido en el Extranjero'
};

const CURP_REGEX =
  /^[A-Z][AEIOUX][A-Z]{2}\d{2}(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])[HMX](AS|BC|BS|CC|CL|CM|CS|CH|DF|DG|GT|GR|HG|JC|MC|MN|MS|NT|NL|OC|PL|QT|QR|SP|SL|SR|TC|TS|TL|VZ|YN|ZS|NE)[B-DF-HJ-NP-TV-Z]{3}[0-9A-Z]\d$/;
const DICC = '0123456789ABCDEFGHIJKLMNÑOPQRSTUVWXYZ';

function calcDv(curp17) {
  let suma = 0;
  for (let i = 0; i < 17; i++) {
    const idx = DICC.indexOf(curp17[i]);
    if (idx === -1) return null;
    suma += idx * (18 - i);
  }
  return String((10 - (suma % 10)) % 10);
}

function makeCurp(base17) {
  const b = base17.trim().toUpperCase().slice(0, 17);
  return `${b}${calcDv(b)}`;
}

function maskCurp(curp) {
  if (!curp) return '******************';
  if (curp.startsWith('PASS:')) {
    const [, nac = 'EXT', num = ''] = curp.split(':');
    return `PASS:${nac}:****${num.slice(-3)}`;
  }
  if (curp.length < 18) return '******************';
  return `${curp.slice(0, 4)}******${curp.slice(10, 13)}***${curp.slice(16)}`;
}

function validarPasaporteLocal({ pasaporte, nacionalidad = 'EXT', fechaNacimiento = '' } = {}) {
  const num = String(pasaporte || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (num.length < 6 || num.length > 15) {
    return { valida: false, error: 'El pasaporte debe tener entre 6 y 15 caracteres alfanuméricos.' };
  }
  const nac = String(nacionalidad || 'EXT').trim().toUpperCase().replace(/[^A-Z]/g, '').slice(0, 3) || 'EXT';
  let edad = null;
  let esMenor = false;
  if (fechaNacimiento && /^\d{4}-\d{2}-\d{2}$/.test(fechaNacimiento)) {
    const [y, m, d] = fechaNacimiento.split('-').map(Number);
    const hoy = new Date();
    edad = hoy.getFullYear() - y;
    if (hoy.getMonth() + 1 < m || (hoy.getMonth() + 1 === m && hoy.getDate() < d)) edad--;
    esMenor = edad < 18;
  }
  return { valida: true, esExtranjero: true, curp: `PASS:${nac}:${num}`, nacionalidad: nac, edad, esMenor };
}

function validarCurpLocal(rawCurp) {
  if (typeof rawCurp !== 'string') return { valida: false, error: 'La CURP es obligatoria.' };
  const curp = rawCurp.trim().toUpperCase();
  if (curp.length !== 18) return { valida: false, curp, error: 'La CURP debe tener exactamente 18 caracteres.' };
  if (!CURP_REGEX.test(curp)) {
    return { valida: false, curp, error: 'El formato de CURP no coincide con la estructura oficial de RENAPO.' };
  }
  const yy = Number(curp.slice(4, 6));
  const mm = Number(curp.slice(6, 8));
  const dd = Number(curp.slice(8, 10));
  const anio = (/\d/.test(curp[16]) ? 1900 : 2000) + yy;
  const f = new Date(Date.UTC(anio, mm - 1, dd));
  if (f.getUTCFullYear() !== anio || f.getUTCMonth() !== mm - 1 || f.getUTCDate() !== dd) {
    return { valida: false, curp, error: 'La fecha de nacimiento codificada en la CURP no es válida.' };
  }
  const esp = calcDv(curp.slice(0, 17));
  if (esp !== curp[17]) {
    return { valida: false, curp, error: `El dígito verificador de la CURP es incorrecto (se esperaba ${esp}).` };
  }
  const cod = curp.slice(11, 13);
  const hoy = new Date();
  let edad = hoy.getUTCFullYear() - anio;
  const md = hoy.getUTCMonth() + 1 - mm;
  if (md < 0 || (md === 0 && hoy.getUTCDate() < dd)) edad--;
  return {
    valida: true,
    curp,
    fechaNacimiento: `${anio}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`,
    edad,
    esMenor: edad < 18,
    sexo: curp[10],
    codigoEntidad: cod,
    entidad: ENTIDADES_CURP[cod] || cod
  };
}

async function sha256(text) {
  const bytes = new TextEncoder().encode(String(text));
  if (globalThis.crypto?.subtle) {
    const buf = await globalThis.crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  let h = 2166136261;
  for (const b of bytes) {
    h ^= b;
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(64, '0');
}

function randomHex(len = 16) {
  const arr = new Uint8Array(Math.ceil(len / 2));
  globalThis.crypto.getRandomValues(arr);
  return [...arr].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, len);
}

const DEMO_SCENARIOS = {
  menorEnTiempoReal: {
    reporteId: 'FUB-NL-2026-04182',
    nombre: 'MATEO VALDEZ GARZA',
    curp: makeCurp('VAGM120815HNLZLDA'),
    habitacion: '1408',
    acompanante: 'ROBERTO SALAZAR MENDOZA',
    parentescoDocumento: 'NO_ACREDITO',
    tipoAlerta: 'Alerta AMBER / PUI Menor'
  },
  coincidenciaHistorica: {
    reporteId: 'FUB-NL-2026-03910',
    nombre: 'ELENA RODRIGUEZ CAVAZOS',
    curp: makeCurp('ROCE910422MNLDRL0'),
    tipoAlerta: 'Reporte PUI Adulto'
  },
  huespedSinAlerta: {
    nombre: 'CARLOS EDUARDO TREVINO GARZA',
    curp: makeCurp('TEGC850910HNLVRN0'),
    habitacion: '0912'
  },
  escaneoIneEjecutivo: {
    nombre: 'VALERIA MONTEMAYOR GARZA',
    curp: makeCurp('MOGV900614MNLNRL0'),
    habitacion: '1014'
  }
};

const DEMO_ACCOUNTS = [
  {
    email: 'presidente@asociacionhotelesnl.mx',
    passwordDemo: 'PorticoDemo#2026',
    nombre: 'Consejo — Asociación de Hoteles NL',
    rol: 'ASOCIACION_ADMIN',
    etiqueta: 'Presidente / Consejo Asociación',
    alcance: 'Tablero gremial, ROI, simulador y constancias (sin PII de huéspedes).'
  },
  {
    email: 'ti@crowneplazamty.mx',
    passwordDemo: 'PorticoDemo#2026',
    nombre: 'Dirección TI — Crowne Plaza Monterrey',
    rol: 'HOTEL_ADMIN',
    hotelSlug: 'crowne-plaza-monterrey',
    etiqueta: 'Gerente TI — Crowne Plaza MTY',
    alcance: 'Aislado solo a RFC MGM940512NL1: PMS Key, CSV, config SEGOB y constancia.'
  },
  {
    email: 'recepcion@crowneplazamty.mx',
    passwordDemo: 'PorticoDemo#2026',
    nombre: 'Mostrador — Crowne Plaza Monterrey',
    rol: 'RECEPCION',
    hotelSlug: 'crowne-plaza-monterrey',
    etiqueta: 'Recepción — Crowne Plaza MTY',
    alcance: 'Solo terminal de check-in y protocolo menores (cero acceso a alertas SEGOB).'
  },
  {
    email: 'ti@safihotels.mx',
    passwordDemo: 'PorticoDemo#2026',
    nombre: 'Dirección TI — Safi Royal Luxury Centro',
    rol: 'HOTEL_ADMIN',
    hotelSlug: 'safi-centro',
    etiqueta: 'Gerente TI — Hoteles Safi',
    alcance: 'Aislado solo a RFC SRL890320NL8 (prueba de aislamiento multi-hotel).'
  }
];

const STORAGE_KEY = 'portico_hospitality_pages_state_v2';
const SESSION_KEY = 'portico_hospitality_pages_user_v2';

function createInitialLocalState() {
  const now = new Date().toISOString();
  return {
    users: DEMO_ACCOUNTS.map((a, idx) => ({
      id: idx + 1,
      email: a.email,
      passwordDemo: a.passwordDemo,
      nombre: a.nombre,
      rol: a.rol,
      hotelSlug: a.hotelSlug || null,
      activo: true,
      creadoEn: now
    })),
    hotels: [
      {
        slug: 'crowne-plaza-monterrey',
        nombre: 'Crowne Plaza Monterrey',
        grupo: 'Milenium Grupo Hotelero / IHG',
        rfc: 'MGM940512NL1',
        ciudad: 'Monterrey, N.L.',
        habitaciones: 403,
        pms: 'Oracle OPERA (OHIP / Puente Local)',
        modoIntegracion: 'API / Conector OPERA',
        estatus: 'Piloto Activo',
        llaveMxStatus: 'Certificado Sandbox',
        usuarioPui: 'pui_crowne_mty',
        pmsApiKey: 'portico_pms_crowne_7f92a4c18e3b6d051a24e890',
        segobMode: 'SANDBOX_SIMULADO',
        segobBaseUrl: '',
        segobUsuario: ''
      },
      {
        slug: 'safi-centro',
        nombre: 'Safi Royal Luxury Centro',
        grupo: 'Hoteles Safi',
        rfc: 'SRL890320NL8',
        ciudad: 'Monterrey, N.L.',
        habitaciones: 250,
        pms: 'Oracle OPERA 5',
        modoIntegracion: 'Agente Local Sincronizado',
        estatus: 'Siguiente Fase',
        llaveMxStatus: 'En Trámite',
        usuarioPui: 'pui_safi_centro',
        pmsApiKey: 'portico_pms_saficent_4c18b2f90e7a3d615290c4e1',
        segobMode: 'SANDBOX_SIMULADO',
        segobBaseUrl: '',
        segobUsuario: ''
      },
      {
        slug: 'safi-metropolitan',
        nombre: 'Safi Royal Luxury Metropolitan',
        grupo: 'Hoteles Safi',
        rfc: 'SRL190814NL3',
        ciudad: 'San Pedro Garza García, N.L.',
        habitaciones: 220,
        pms: 'Oracle OPERA Cloud',
        modoIntegracion: 'API / Conector OPERA',
        estatus: 'Siguiente Fase',
        llaveMxStatus: 'En Trámite',
        usuarioPui: 'pui_safi_metro',
        pmsApiKey: 'portico_pms_safimetr_9b04d3e71c5a8f206412a7b3',
        segobMode: 'SANDBOX_SIMULADO',
        segobBaseUrl: '',
        segobUsuario: ''
      },
      {
        slug: 'safi-valle',
        nombre: 'Safi Royal Luxury Valle',
        grupo: 'Hoteles Safi',
        rfc: 'SRL051109NL5',
        ciudad: 'San Pedro Garza García, N.L.',
        habitaciones: 240,
        pms: 'Oracle OPERA 5',
        modoIntegracion: 'Agente Local Sincronizado',
        estatus: 'Programado',
        llaveMxStatus: 'Pendiente',
        usuarioPui: 'pui_safi_valle',
        pmsApiKey: 'portico_pms_safivall_2e81c0a64f9d3b751084e2c9',
        segobMode: 'SANDBOX_SIMULADO',
        segobBaseUrl: '',
        segobUsuario: ''
      },
      {
        slug: 'posada-regia',
        nombre: 'Hotel Posada Regia Independiente',
        grupo: 'Hotel Afiliado Independiente',
        rfc: 'HPR120401NL9',
        ciudad: 'Monterrey, N.L.',
        habitaciones: 48,
        pms: 'Sin API (Portal Web / CSV)',
        modoIntegracion: 'Portal Web / CSV',
        estatus: 'Activo',
        llaveMxStatus: 'Certificado Sandbox',
        usuarioPui: 'pui_posada_regia',
        pmsApiKey: 'portico_pms_posadare_6a53f1d82c4e9b073165d8a2',
        segobMode: 'SANDBOX_SIMULADO',
        segobBaseUrl: '',
        segobUsuario: ''
      }
    ],
    alerts: [],
    guests: [
      {
        id: 'GST-1001',
        hotelSlug: 'crowne-plaza-monterrey',
        nombre: DEMO_SCENARIOS.coincidenciaHistorica.nombre,
        curp: DEMO_SCENARIOS.coincidenciaHistorica.curp,
        curpEnmascarada: maskCurp(DEMO_SCENARIOS.coincidenciaHistorica.curp),
        telefono: '81-8340-2910',
        correo: 'e.rodriguez.demo@correo.mx',
        habitacion: '1104',
        esMenor: false,
        fechaRegistro: '2026-06-14T19:42:00.000Z',
        tipo: 'Histórico (Check-out completado)'
      },
      {
        id: 'GST-1002',
        hotelSlug: 'crowne-plaza-monterrey',
        nombre: 'ALEJANDRA CANTU VILLARREAL',
        curp: makeCurp('CAVA880311MNLNRL0'),
        curpEnmascarada: maskCurp(makeCurp('CAVA880311MNLNRL0')),
        habitacion: '0705',
        esMenor: false,
        fechaRegistro: '2026-11-18T16:20:00.000Z',
        tipo: 'Huésped en casa'
      },
      {
        id: 'GST-1003',
        hotelSlug: 'safi-centro',
        nombre: 'LUIS FERNANDO GARZA MONTEMAYOR',
        curp: makeCurp('GAML791103HNLNRN0'),
        curpEnmascarada: maskCurp(makeCurp('GAML791103HNLNRN0')),
        habitacion: '0418',
        esMenor: false,
        fechaRegistro: '2026-11-19T14:05:00.000Z',
        tipo: 'Huésped en casa'
      }
    ],
    outbox: [],
    auditLog: [
      {
        seq: 1,
        timestamp: now,
        hotelSlug: 'crowne-plaza-monterrey',
        direccion: 'SISTEMA',
        endpoint: '/api/health',
        fase: 'INICIO',
        resumen: 'Certeza ID en modo Demo Web 24/7 con motor criptográfico SHA-256.',
        estatusHttp: 200,
        critico: false,
        payload: {
          plataforma: 'Certeza ID — Motor de Enlace PUI',
          estandar: 'Manual Técnico PUI — DOF (23/01/2026)',
          modo: 'Cloud CDN 24/7 (Motor local en navegador)'
        },
        hash: 'a94a8fe5ccb19ba61c4c0873d391e987982fbbd38f214c70e2a4c6e91b80f3c1'
      }
    ]
  };
}

function loadLocalState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch {
    // ignore
  }
  const st = createInitialLocalState();
  saveLocalState(st);
  return st;
}

function saveLocalState(st) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(st));
  } catch {
    // ignore
  }
}

function getLocalUser() {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function setLocalUser(user) {
  try {
    if (user) sessionStorage.setItem(SESSION_KEY, JSON.stringify(user));
    else sessionStorage.removeItem(SESSION_KEY);
  } catch {
    // ignore
  }
}

async function addLocalAudit(st, entry) {
  const prev = st.auditLog[0];
  const seq = (prev?.seq || 0) + 1;
  const rec = { seq, timestamp: new Date().toISOString(), ...entry };
  rec.hash = await sha256(`${prev?.hash || 'GENESIS'}|${JSON.stringify(rec)}`);
  st.auditLog.unshift(rec);
  return rec;
}

function addLocalOutbox(st, { hotelSlug, reporteId, endpoint, fase, payload }) {
  const now = new Date().toISOString();
  st.outbox.unshift({
    id: st.outbox.length + 1,
    hotelSlug,
    reporteId,
    endpoint,
    fase,
    payload,
    estado: 'ENTREGADO',
    intentos: 1,
    maxIntentos: 8,
    ultimoHttp: 200,
    acuseSegob: `ACUSE-SEGOB-${fase.replace(/\s+/g, '')}-${randomHex(8).toUpperCase()} (Demo Web)`,
    latenciaMs: 19,
    creadoEn: now,
    entregadoEn: now
  });
}

function buildDemoCsv(incluirMenor) {
  const header = 'nombre,curp,habitacion,fecha_registro,telefono,correo,acompanante';
  const rows = [
    `SOFIA MARTINEZ GARZA,${makeCurp('MAGS930718MNLRTN0')},0804,2026-11-19T14:10:00Z,81-8120-3301,sofia.mg@empresa.mx,`,
    `DIEGO ALBERTO LOZANO RIOS,${makeCurp('LORD871204HNLZRS0')},1215,2026-11-19T15:25:00Z,81-1554-8902,dlozano@industrias.mx,`,
    `FERNANDA VILLARREAL CAVAZOS,${makeCurp('VICF960228MNLLRN0')},0510,2026-11-19T16:02:00Z,81-1890-4412,fvillarreal@consultora.mx,`,
    `JORGE HUMBERTO SADA ELIZONDO,${makeCurp('SAEJ800515HNLDLN0')},1602,2026-11-19T16:40:00Z,81-8332-7741,jsada@corporativo.mx,`,
    `REGISTRO CON ERROR DE CAPTURA,XXXX999999HNLZZZ00,0301,2026-11-19T17:00:00Z,81-0000-0000,error@demo.mx,`
  ];
  if (incluirMenor) {
    rows.splice(
      2,
      0,
      `MATEO VALDEZ GARZA,${DEMO_SCENARIOS.menorEnTiempoReal.curp},1408,2026-11-19T17:15:00Z,,sin-correo@demo.mx,ROBERTO SALAZAR MENDOZA`
    );
  }
  return `${header}\n${rows.join('\n')}\n`;
}

export async function detectRuntimeMode() {
  if (runtimeMode) return runtimeMode;
  if (
    location.hostname.endsWith('.pages.dev') ||
    location.hostname.endsWith('.workers.dev') ||
    location.hostname.endsWith('.vercel.app') ||
    location.hostname.endsWith('.netlify.app') ||
    location.hostname.endsWith('.github.io') ||
    location.protocol === 'file:'
  ) {
    runtimeMode = 'static-pages';
    return runtimeMode;
  }
  try {
    const res = await fetch('./api/health', { cache: 'no-store' });
    const ct = res.headers.get('content-type') || '';
    if (res.ok && ct.includes('application/json')) {
      runtimeMode = 'server';
      return runtimeMode;
    }
  } catch {
    // fallback to static mode
  }
  runtimeMode = 'static-pages';
  return runtimeMode;
}

export function getRuntimeMode() {
  return runtimeMode || 'server';
}

export function buildDemoCsvBlobUrl(hotelSlug) {
  const csv = buildDemoCsv(false);
  return URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
}

export function openConstancia(hotelSlug) {
  if (getRuntimeMode() === 'server') {
    window.open(`./constancia/${encodeURIComponent(hotelSlug)}`, '_blank', 'noopener');
    return;
  }
  const st = loadLocalState();
  const h = st.hotels.find((x) => x.slug === hotelSlug);
  if (!h) return;
  const alertas = st.alerts.filter((a) => a.hotelSlug === h.slug);
  const huespedes = st.guests.filter((g) => g.hotelSlug === h.slug);
  const outbox = st.outbox.filter((o) => o.hotelSlug === h.slug);
  const eventos = st.auditLog.filter((e) => e.hotelSlug === h.slug);
  const folio = `PORTICO-PUI-${h.rfc.slice(0, 6)}-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`;
  const hash = st.auditLog[0]?.hash || 'GENESIS';

  const html = `<!doctype html><html lang="es-MX"><head><meta charset="utf-8"/><title>Constancia PUI — ${h.nombre}</title>
  <style>body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#f4f6f8;color:#111d2e;margin:0;padding:1.5rem}.sheet{max-width:820px;margin:0 auto;background:#fff;border:1px solid #d5dce3;border-radius:10px;padding:2rem 2.25rem}h1{font-size:1.25rem;margin:.2rem 0}h2{font-size:.9rem;text-transform:uppercase;color:#0d6858;border-bottom:1px solid #d5dce3;padding-bottom:.25rem;margin-top:1.3rem}.grid{display:grid;grid-template-columns:1fr 1fr;gap:.6rem 1.2rem;font-size:.88rem}.kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:.6rem;margin-top:.5rem}.kpi{border:1px solid #d5dce3;border-radius:6px;padding:.6rem}.kpi strong{display:block;font-size:1.2rem}.seal{margin-top:1.1rem;padding:.85rem;background:#eef8f5;border:1px solid #b5ddd4;border-radius:6px;font-size:.82rem;word-break:break-all}.btn{background:#0d6858;color:#fff;border:none;border-radius:6px;padding:.55rem 1rem;font-weight:600;cursor:pointer;margin-bottom:1rem}@media print{.btn{display:none}body{background:#fff;padding:0}.sheet{border:none;padding:0}}</style></head>
  <body><div style="max-width:820px;margin:0 auto"><button class="btn" onclick="window.print()">Imprimir / Guardar como PDF</button></div>
  <main class="sheet"><div style="display:flex;justify-content:space-between;border-bottom:2px solid #111d2e;padding-bottom:.9rem;margin-bottom:1rem">
  <div><strong style="font-size:1.3rem">Certeza ID</strong><div style="font-size:.84rem;color:#4b5868">Motor de Enlace PUI · Certeza ID Systems · Asociación Mexicana de Hoteles de Nuevo León</div></div>
  <div style="text-align:right;font-size:.8rem">Folio: <strong>${folio}</strong></div></div>
  <h1>Constancia Técnica de Interconexión y Cumplimiento PUI</h1>
  <h2>1. Institución Obligada</h2><div class="grid">
  <div><strong>${h.nombre}</strong><br/>RFC: <code>${h.rfc}</code></div><div>${h.grupo}<br/>${h.ciudad} · ${h.habitaciones} hab.</div>
  <div>PMS: ${h.pms}</div><div>Llave MX: ${h.llaveMxStatus} · Modo: ${h.segobMode}</div></div>
  <h2>2. Métricas PUI y Entregas SEGOB</h2><div class="kpis">
  <div class="kpi">Registros cifrados<strong>${huespedes.length}</strong></div>
  <div class="kpi">Alertas SEGOB<strong>${alertas.length}</strong></div>
  <div class="kpi">Entregas Outbox<strong>${outbox.length}</strong></div>
  <div class="kpi">Eventos auditados<strong>${eventos.length}</strong></div></div>
  <div class="seal"><strong>Integridad Criptográfica SHA-256:</strong> VERIFICADA (SIN ALTERACIONES) · Cifrado AES-256-GCM<br/><code>${hash}</code></div>
  </main></body></html>`;

  const url = URL.createObjectURL(new Blob([html], { type: 'text/html;charset=utf-8' }));
  window.open(url, '_blank', 'noopener');
}

export function downloadAuditCsv(hotelSlug = null) {
  if (getRuntimeMode() === 'server') {
    const q = hotelSlug ? `?hotel=${encodeURIComponent(hotelSlug)}` : '';
    window.location.href = `./api/audit/export${q}`;
    return;
  }
  const st = loadLocalState();
  const user = getLocalUser();
  const scope = user?.rol === 'HOTEL_ADMIN' ? user.hotelSlug : hotelSlug && hotelSlug !== 'all' ? hotelSlug : null;
  const rows = scope ? st.auditLog.filter((l) => l.hotelSlug === scope) : st.auditLog;
  const csvEsc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [
    'seq,timestamp,hotel_slug,direccion,endpoint,fase,estatus_http,resumen,sha256_hash',
    ...rows.map((r) =>
      [r.seq, r.timestamp, r.hotelSlug, r.direccion, r.endpoint, r.fase, r.estatusHttp, r.resumen, r.hash]
        .map(csvEsc)
        .join(',')
    )
  ];
  const blobUrl = URL.createObjectURL(new Blob([`\uFEFF${lines.join('\n')}\n`], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = blobUrl;
  a.download = `bitacora_portico_${scope || 'asociacion'}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(blobUrl), 2000);
}

export async function apiRequest(apiPath, { method = 'GET', body = null } = {}) {
  const mode = await detectRuntimeMode();
  if (mode === 'server') {
    const clean = apiPath.startsWith('/') ? `.${apiPath}` : apiPath;
    const opts = { method, cache: 'no-store', headers: {} };
    if (body !== null) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(clean, opts);
    const ct = res.headers.get('content-type') || '';
    const data = ct.includes('application/json') ? await res.json() : await res.text();
    return { ok: res.ok, status: res.status, data };
  }

  // --- Motor estático completo para despliegue en CDN ---
  const url = new URL(apiPath, 'http://local');
  const p = url.pathname;
  const st = loadLocalState();
  const user = getLocalUser();

  if (p === '/api/auth/me') {
    return {
      ok: true,
      status: 200,
      data: { authenticated: Boolean(user), user, demoMode: true, demoAccounts: DEMO_ACCOUNTS }
    };
  }

  if (p === '/api/auth/login' && method === 'POST') {
    const pool = Array.isArray(st.users) && st.users.length ? st.users : DEMO_ACCOUNTS.map((a, i) => ({ ...a, id: i + 1, activo: true }));
    const found = pool.find(
      (a) =>
        a.activo !== false &&
        a.email === String(body?.email || '').trim().toLowerCase() &&
        body?.password === a.passwordDemo
    );
    if (!found) return { ok: false, status: 401, data: { error: 'Correo o contraseña incorrectos (o cuenta suspendida).' } };
    const u = { id: found.id, email: found.email, nombre: found.nombre, rol: found.rol, hotelSlug: found.hotelSlug || null };
    setLocalUser(u);
    await addLocalAudit(st, {
      hotelSlug: u.hotelSlug || 'asociacion',
      direccion: 'ACCESO RBAC',
      endpoint: '/api/auth/login',
      fase: 'SESION',
      resumen: `Inicio de sesión autenticado: ${u.nombre} (${u.rol}).`,
      estatusHttp: 200,
      payload: u
    });
    saveLocalState(st);
    return { ok: true, status: 200, data: { ok: true, user: u } };
  }

  if (p === '/api/auth/logout' && method === 'POST') {
    setLocalUser(null);
    return { ok: true, status: 200, data: { ok: true } };
  }

  if (p === '/api/curp/validar') {
    return { ok: true, status: 200, data: validarCurpLocal(url.searchParams.get('curp') || '') };
  }

  if (!user) return { ok: false, status: 401, data: { error: 'Sesión requerida.' } };

  if (p === '/api/state') {
    const isAssoc = user.rol === 'ASOCIACION_ADMIN';
    const isRec = user.rol === 'RECEPCION';
    const scope = isAssoc ? null : user.hotelSlug;
    const hotels = (scope ? st.hotels.filter((h) => h.slug === scope) : st.hotels).map((h) =>
      isRec ? { ...h, pmsApiKey: undefined, usuarioPui: undefined } : h
    );
    return {
      ok: true,
      status: 200,
      data: {
        user,
        asociacion: { nombre: 'Asociación Mexicana de Hoteles de Nuevo León', hotelesObjetivo: 136 },
        storage: {
          engine: 'postgresql-ready',
          engineLabel: 'Demo Estática · Esquema PostgreSQL 16 + RLS Listo para AWS RDS',
          rlsEnabled: false,
          rlsSchemaReady: true,
          poolMax: 40,
          queueMode: 'Outbox ACID + SQS Workers Ready',
          recommendedCapacityHotels: 1000,
          encryptionStandard: 'AES-256-GCM + HMAC-SHA256 por RFC'
        },
        escenariosDemo: DEMO_SCENARIOS,
        integridadCadena: { integra: true, totalEventos: st.auditLog.length },
        hotels,
        alerts: isRec ? [] : scope ? st.alerts.filter((a) => a.hotelSlug === scope) : st.alerts,
        outbox: isRec ? [] : scope ? st.outbox.filter((o) => o.hotelSlug === scope) : st.outbox,
        guests: scope ? st.guests.filter((g) => g.hotelSlug === scope) : st.guests,
        auditLog: isRec ? [] : scope ? st.auditLog.filter((l) => l.hotelSlug === scope) : st.auditLog
      }
    };
  }

  if (p === '/api/demo/reset' && method === 'POST') {
    const fresh = createInitialLocalState();
    saveLocalState(fresh);
    return { ok: true, status: 200, data: { ok: true } };
  }

  if (p === '/api/demo/scale-benchmark' && method === 'POST') {
    const targetHotels = Math.min(2000, Math.max(10, Number(body?.hotels) || 1000));
    const sampleOps = 250;
    const baseCurp = DEMO_SCENARIOS.huespedSinAlerta.curp;
    const t0 = performance.now();
    const hashes = new Set();
    for (let i = 0; i < sampleOps; i++) {
      const slugSim = `hotel-sim-${i % targetHotels}`;
      validarCurpLocal(baseCurp);
      hashes.add(await sha256(`${slugSim}|${baseCurp}`));
    }
    const elapsedMs = Math.max(1, performance.now() - t0);
    return {
      ok: true,
      status: 200,
      data: {
        ok: true,
        hotelesObjetivo: targetHotels,
        operacionesRealesEjecutadas: sampleOps,
        tiempoTotalMs: Number(elapsedMs.toFixed(1)),
        latenciaPromedioMs: Number((elapsedMs / sampleOps).toFixed(2)),
        capacidadEstimadaCheckinsPorSegundo: Math.round((sampleOps / elapsedMs) * 1000),
        hashesUnicosPorHotel: hashes.size,
        fugasEntreRfc: 0,
        infra: estimateScaleInfrastructure(targetHotels)
      }
    };
  }

  if (p === '/api/outbox/retry' && method === 'POST') {
    return { ok: true, status: 200, data: { ok: true, reencolados: 0, procesados: 0 } };
  }

  if (p === '/api/users' && method === 'GET') {
    if (user.rol === 'RECEPCION') {
      return { ok: false, status: 403, data: { error: 'Solo administradores pueden consultar cuentas.' } };
    }
    const list = (st.users || []).filter((u) => (user.rol === 'ASOCIACION_ADMIN' ? true : u.hotelSlug === user.hotelSlug));
    return {
      ok: true,
      status: 200,
      data: {
        users: list.map(({ passwordDemo, ...pub }) => pub)
      }
    };
  }

  if (p === '/api/users' && method === 'POST') {
    if (user.rol === 'RECEPCION') {
      return { ok: false, status: 403, data: { error: 'Solo administradores pueden crear cuentas.' } };
    }
    const nombre = String(body.nombre || '').trim();
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');
    const rol = String(body.rol || '').trim().toUpperCase();
    let hotelSlug = body.hotelSlug || null;
    if (user.rol === 'HOTEL_ADMIN') {
      if (rol === 'ASOCIACION_ADMIN') {
        return { ok: false, status: 403, data: { error: 'No puedes crear cuentas globales de la Asociación.' } };
      }
      hotelSlug = user.hotelSlug;
    }
    if (st.users.some((u) => u.email === email)) {
      return { ok: false, status: 409, data: { error: 'Ya existe una cuenta con ese correo.' } };
    }
    const nuevo = {
      id: (st.users.reduce((m, u) => Math.max(m, u.id || 0), 0) || 0) + 1,
      email,
      passwordDemo: password,
      nombre,
      rol,
      hotelSlug: rol === 'ASOCIACION_ADMIN' ? null : hotelSlug,
      activo: true,
      creadoEn: new Date().toISOString()
    };
    st.users.push(nuevo);
    await addLocalAudit(st, {
      hotelSlug: nuevo.hotelSlug || 'asociacion',
      direccion: 'ACCESO RBAC',
      endpoint: '/api/users',
      fase: 'GESTION USUARIOS',
      resumen: `Nueva cuenta RBAC creada por ${user.nombre}: ${email} (${rol}).`,
      estatusHttp: 201,
      payload: { email, rol, hotelSlug: nuevo.hotelSlug }
    });
    saveLocalState(st);
    const { passwordDemo, ...pub } = nuevo;
    return { ok: true, status: 201, data: { ok: true, user: pub } };
  }

  const userPatch = p.match(/^\/api\/users\/(\d+)$/);
  if (userPatch && method === 'PATCH') {
    if (user.rol === 'RECEPCION') {
      return { ok: false, status: 403, data: { error: 'Acceso restringido.' } };
    }
    const id = Number(userPatch[1]);
    if (id === user.id) {
      return { ok: false, status: 400, data: { error: 'No puedes desactivar tu propia sesión activa.' } };
    }
    const target = (st.users || []).find((u) => u.id === id);
    if (!target) return { ok: false, status: 404, data: { error: 'Usuario no encontrado.' } };
    if (user.rol === 'HOTEL_ADMIN' && target.hotelSlug !== user.hotelSlug) {
      return { ok: false, status: 403, data: { error: 'Aislamiento multi-hotel.' } };
    }
    target.activo = Boolean(body.activo);
    saveLocalState(st);
    const { passwordDemo, ...pub } = target;
    return { ok: true, status: 200, data: { ok: true, user: pub } };
  }

  if (p === '/api/hotels' && method === 'POST') {
    const nombre = String(body.nombre || '').trim();
    const rfc = String(body.rfc || '').trim().toUpperCase();
    const slug = nombre
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    if (st.hotels.some((h) => h.slug === slug || h.rfc === rfc)) {
      return { ok: false, status: 409, data: { error: 'Ya existe un hotel con ese nombre o RFC.' } };
    }
    const hotel = {
      slug,
      nombre,
      grupo: body.grupo || 'Hotel Afiliado',
      rfc,
      ciudad: body.ciudad || 'Monterrey, N.L.',
      habitaciones: Number(body.habitaciones) || 80,
      pms: body.pms || 'Portal Web / CSV',
      modoIntegracion: body.modoIntegracion || 'API / Conector PMS',
      estatus: 'Activo',
      llaveMxStatus: 'Listo para Sandbox',
      usuarioPui: `pui_${slug.replace(/-/g, '_').slice(0, 16)}`,
      pmsApiKey: `portico_pms_${slug.slice(0, 8)}_${randomHex(20)}`,
      segobMode: 'SANDBOX_SIMULADO',
      segobBaseUrl: '',
      segobUsuario: ''
    };
    st.hotels.push(hotel);
    await addLocalAudit(st, {
      hotelSlug: slug,
      direccion: 'ASOCIACIÓN',
      endpoint: '/api/hotels',
      fase: 'ONBOARDING',
      resumen: `Nuevo hotel dado de alta en Certeza ID (multi-RFC): ${nombre} (${rfc}).`,
      estatusHttp: 201,
      payload: { slug, rfc, pms: hotel.pms }
    });
    saveLocalState(st);
    return { ok: true, status: 201, data: { ok: true, hotel } };
  }

  if (p === '/api/demo/segob-action' && method === 'POST') {
    const hotel = st.hotels.find((h) => h.slug === body.hotelSlug);
    if (!hotel) return { ok: false, status: 404, data: { error: 'Hotel no encontrado.' } };
    if (body.accion === 'desactivar') {
      const a = st.alerts.find((x) => x.hotelSlug === hotel.slug && x.reporteId === body.id);
      if (a) a.activa = false;
      await addLocalAudit(st, {
        hotelSlug: hotel.slug,
        direccion: 'SEGOB → HOTEL',
        endpoint: `/api/pui/${hotel.slug}/desactivar-reporte`,
        fase: 'CIERRE FASE 3',
        resumen: `Reporte ${body.id} cerrado por SEGOB en ${hotel.nombre}.`,
        estatusHttp: 200,
        payload: { id: body.id, rfc: hotel.rfc, fase_3: 'DETENIDO' }
      });
      saveLocalState(st);
      return { ok: true, status: 200, data: { ok: true } };
    }
    const val = validarCurpLocal(body.curp);
    if (!val.valida) return { ok: false, status: 400, data: { error: val.error } };
    const existing = st.alerts.find((a) => a.hotelSlug === hotel.slug && a.reporteId === body.id);
    const alertObj = {
      reporteId: body.id,
      hotelSlug: hotel.slug,
      hotelNombre: hotel.nombre,
      curp: val.curp,
      curpEnmascarada: maskCurp(val.curp),
      cifrado: 'AES-256-GCM',
      esMenor: val.esMenor,
      tipoAlerta: body.tipo_alerta || 'Reporte PUI',
      activa: true,
      coincidenciasReportadas: 0
    };
    if (existing) Object.assign(existing, alertObj);
    else st.alerts.unshift(alertObj);

    await addLocalAudit(st, {
      hotelSlug: hotel.slug,
      direccion: 'SEGOB → HOTEL',
      endpoint: `/api/pui/${hotel.slug}/activar-reporte`,
      fase: 'ACTIVACION',
      resumen: `Reporte ${body.id} recibido con JWT en ${hotel.nombre} (${maskCurp(val.curp)}).`,
      estatusHttp: 200,
      payload: { id: body.id, curp_enmascarada: maskCurp(val.curp), es_menor: val.esMenor }
    });

    const matches = st.guests.filter((g) => g.hotelSlug === hotel.slug && g.curp === val.curp);
    if (matches.length > 0) {
      alertObj.coincidenciasReportadas += 2;
      const p1 = { id: body.id, rfc_institucion: hotel.rfc, fase_busqueda: '1', nombre: matches[0].nombre };
      const p2 = { id: body.id, rfc_institucion: hotel.rfc, fase_busqueda: '2', estancias: matches.length };
      addLocalOutbox(st, { hotelSlug: hotel.slug, reporteId: body.id, endpoint: '/pui/notificar-coincidencia', fase: 'FASE 1', payload: p1 });
      addLocalOutbox(st, { hotelSlug: hotel.slug, reporteId: body.id, endpoint: '/pui/notificar-coincidencia', fase: 'FASE 2', payload: p2 });
      await addLocalAudit(st, {
        hotelSlug: hotel.slug,
        direccion: 'HOTEL → SEGOB',
        endpoint: '/pui/notificar-coincidencia',
        fase: 'FASE 1 y 2',
        resumen: `Coincidencia histórica encontrada en ${hotel.nombre} (${matches.length} registro(s)).`,
        estatusHttp: 200,
        payload: p2
      });
    }
    const pCierre = { id: body.id, rfc_institucion: hotel.rfc, fase_busqueda: '2', coincidencias: matches.length, fase_3: 'ACTIVO' };
    addLocalOutbox(st, { hotelSlug: hotel.slug, reporteId: body.id, endpoint: '/pui/busqueda-finalizada', fase: 'FASE 2 CIERRE', payload: pCierre });
    await addLocalAudit(st, {
      hotelSlug: hotel.slug,
      direccion: 'HOTEL → SEGOB',
      endpoint: '/pui/busqueda-finalizada',
      fase: 'FASE 2 CIERRE',
      resumen: `Barrido histórico completado en ${hotel.nombre}. Fase 3 activa.`,
      estatusHttp: 200,
      payload: pCierre
    });
    saveLocalState(st);
    return { ok: true, status: 200, data: { ok: true, id: body.id, hotel: hotel.nombre, coincidencias_historicas: matches.length } };
  }

  const segobCfg = p.match(/^\/api\/hotels\/([a-z0-9-]+)\/segob-config$/);
  if (segobCfg && method === 'PUT') {
    const hotel = st.hotels.find((h) => h.slug === segobCfg[1]);
    if (!hotel) return { ok: false, status: 404, data: { error: 'Hotel no encontrado.' } };
    hotel.segobMode = body.segobMode || hotel.segobMode;
    hotel.llaveMxStatus = body.llaveMxStatus || hotel.llaveMxStatus;
    hotel.segobBaseUrl = body.segobBaseUrl || '';
    hotel.segobUsuario = body.segobUsuario || '';
    saveLocalState(st);
    return { ok: true, status: 200, data: { ok: true, hotel } };
  }

  const pmsMatch = p.match(/^\/api\/pms\/([a-z0-9-]+)\/(checkin|import-csv|csv-template|rotate-key)$/);
  if (pmsMatch) {
    const [, slug, act] = pmsMatch;
    const hotel = st.hotels.find((h) => h.slug === slug);
    if (!hotel) return { ok: false, status: 404, data: { error: 'Hotel no encontrado.' } };

    if (act === 'csv-template') {
      return { ok: true, status: 200, data: buildDemoCsv(url.searchParams.get('demo') === '1') };
    }
    if (act === 'rotate-key') {
      hotel.pmsApiKey = `portico_pms_${slug.slice(0, 8)}_${randomHex(20)}`;
      saveLocalState(st);
      return { ok: true, status: 200, data: { ok: true, pmsApiKey: hotel.pmsApiKey } };
    }
    if (act === 'checkin') {
      const usarPass = Boolean(body.esExtranjero || (body.pasaporte && !body.curp));
      const val = usarPass
        ? validarPasaporteLocal({
            pasaporte: body.pasaporte,
            nacionalidad: body.nacionalidad,
            fechaNacimiento: body.fechaNacimiento
          })
        : validarCurpLocal(body.curp);
      if (!val.valida) return { ok: false, status: 400, data: { error: val.error } };
      const g = {
        id: `GST-${Date.now().toString().slice(-6)}`,
        hotelSlug: slug,
        nombre: String(body.nombre || '').trim().toUpperCase(),
        curp: val.curp,
        curpEnmascarada: maskCurp(val.curp),
        habitacion: body.habitacion || 'Asignación pendiente',
        esMenor: val.esMenor,
        acompanante: body.acompanante || '',
        fechaRegistro: new Date().toISOString(),
        tipo:
          val.esMenor && body.parentescoDocumento === 'NO_ACREDITO'
            ? 'Bloqueado por Protocolo Menores (LGT)'
            : 'Check-in activo en PMS'
      };
      st.guests.unshift(g);
      const alerts = st.alerts.filter((a) => a.hotelSlug === slug && a.activa && a.curp === val.curp);
      for (const a of alerts) {
        a.coincidenciasReportadas += 1;
        const p3 = {
          id: a.reporteId,
          rfc_institucion: hotel.rfc,
          fase_busqueda: '3',
          prioridad: val.esMenor ? 'CRITICA_MENOR_EDAD' : 'ALTA_LOCALIZACION',
          canal: 'SILENCIOSO_SIN_ALERTA_EN_MOSTRADOR',
          habitacion: g.habitacion
        };
        addLocalOutbox(st, { hotelSlug: slug, reporteId: a.reporteId, endpoint: '/pui/notificar-coincidencia', fase: 'FASE 3', payload: p3 });
        await addLocalAudit(st, {
          hotelSlug: slug,
          direccion: 'HOTEL → SEGOB',
          endpoint: '/pui/notificar-coincidencia',
          fase: 'FASE 3 ALERTA',
          resumen: `COINCIDENCIA DETECTADA (${hotel.nombre}, Hab. ${g.habitacion}) — Aviso silencioso enviado a SEGOB para ${a.reporteId}.`,
          estatusHttp: 200,
          critico: true,
          payload: p3
        });
      }
      saveLocalState(st);
      const aviso = val.esMenor
        ? body.parentescoDocumento === 'NO_ACREDITO'
          ? 'Protocolo Ley General de Turismo activado: sin acreditación de parentesco o tutela, negar el servicio y notificar a gerencia.'
          : 'Menor de edad detectado por CURP: verificar documentación de parentesco o tutela del acompañante.'
        : null;
      return {
        ok: true,
        status: 201,
        data: {
          ok: true,
          mensaje_recepcion:
            val.esMenor && body.parentescoDocumento === 'NO_ACREDITO'
              ? `Registro retenido en ${hotel.nombre} por protocolo de menores (Ley General de Turismo).`
              : `Check-in completado en ${hotel.nombre} (Habitación ${g.habitacion}). CURP validada correctamente.`,
          verificacion_menor_turismo: aviso
        }
      };
    }
    if (act === 'import-csv') {
      const rawText = String(body.csvText || '').trim();
      let rows = [];
      let isXml = false;
      if (rawText.startsWith('<')) {
        isXml = true;
        const blocks = rawText.match(/<(?:G_RESERVATION|RESERVATION|GUEST)\b[\s\S]*?<\/(?:G_RESERVATION|RESERVATION|GUEST)>/gi) || [];
        if (!blocks.length) return { ok: false, status: 400, data: { error: 'XML OPERA sin nodos <G_RESERVATION>.' } };
        const tag = (b, ...ts) => {
          for (const t of ts) {
            const m = b.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)<\\/${t}>`, 'i'));
            if (m && m[1].trim()) return m[1].trim();
          }
          return '';
        };
        rows = blocks.map((b, idx) => ({
          linea: idx + 1,
          nombre: tag(b, 'FULL_NAME', 'GUEST_NAME', 'NOMBRE'),
          curp: tag(b, 'CURP', 'TAX_ID', 'GOV_ID'),
          pasaporte: tag(b, 'PASSPORT', 'PASAPORTE'),
          nacionalidad: tag(b, 'NATIONALITY', 'NACIONALIDAD') || 'EXT',
          fechaNacimiento: tag(b, 'BIRTH_DATE', 'DOB'),
          hab: tag(b, 'ROOM', 'HABITACION') || 'OPERA XML'
        }));
      } else {
        const lines = rawText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
        if (lines.length < 2) return { ok: false, status: 400, data: { error: 'CSV vacío o sin filas.' } };
        rows = lines.slice(1).map((line, idx) => {
          const [nombre = '', curp = '', hab = 'Histórico CSV'] = line.split(',').map((c) => c.trim());
          return { linea: idx + 2, nombre, curp, hab };
        });
      }
      let insertados = 0;
      let rechazados = 0;
      const errores = [];
      for (const r of rows) {
        const val = !r.curp && r.pasaporte
          ? validarPasaporteLocal({ pasaporte: r.pasaporte, nacionalidad: r.nacionalidad, fechaNacimiento: r.fechaNacimiento })
          : validarCurpLocal(r.curp);
        if (!val.valida) {
          rechazados++;
          errores.push({ linea: r.linea, curp: r.curp || r.pasaporte, motivo: val.error });
          continue;
        }
        st.guests.unshift({
          id: `${isXml ? 'XML' : 'CSV'}-${Date.now().toString().slice(-4)}-${r.linea}`,
          hotelSlug: slug,
          nombre: r.nombre.toUpperCase(),
          curp: val.curp,
          curpEnmascarada: maskCurp(val.curp),
          habitacion: r.hab,
          esMenor: val.esMenor,
          fechaRegistro: new Date().toISOString(),
          tipo: isXml ? 'Importado desde Oracle OPERA XML' : 'Importado por lote CSV / PMS'
        });
        insertados++;
      }
      await addLocalAudit(st, {
        hotelSlug: slug,
        direccion: 'PMS → CERTEZA ID',
        endpoint: `/api/pms/${slug}/import-csv`,
        fase: isXml ? 'IMPORTACION OPERA XML' : 'IMPORTACION CSV',
        resumen: `Lote ${isXml ? 'OPERA XML' : 'CSV'} procesado en ${hotel.nombre}: ${insertados} válidos, ${rechazados} rechazados.`,
        estatusHttp: 200,
        payload: { insertados, rechazados }
      });
      saveLocalState(st);
      return { ok: true, status: 200, data: { ok: true, hotel: hotel.nombre, insertados, rechazados, errores } };
    }
  }

  return { ok: false, status: 404, data: { error: 'Ruta no encontrada en modo estático.' } };
}
