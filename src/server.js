/**
 * Portico Hospitality — Servidor HTTP Producción Multi-Hotel PUI (Manual Técnico DOF)
 * Persistencia ACID (`node:sqlite`), RBAC con sesiones HttpOnly + scrypt,
 * Rate Limiting y Cola Outbox hacia SEGOB con reintentos exponenciales.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validarCurp, validarPasaporteExtranjero, enmascararCurp } from './curp.js';
import {
  firmarJwt,
  verificarJwt,
  hashCurpPorHotel,
  verifyPassword
} from './security.js';
import { createRateLimiter } from './rateLimit.js';
import {
  getDb,
  resetDb,
  DEMO_SCENARIOS,
  DEMO_ACCOUNTS_PUBLIC,
  listHotels,
  getHotelBySlug,
  createHotel,
  rotateHotelPmsKey,
  updateHotelSegobConfig,
  authenticateUser,
  createSession,
  getSessionUser,
  deleteSession,
  listUsers,
  createUser,
  setUserActive,
  upsertAlert,
  listAlerts,
  findActiveMatchingAlerts,
  incrementAlertMatches,
  deactivateAlert,
  insertGuest,
  listGuests,
  findGuestsByCurpHash,
  enqueueSegobNotification,
  listOutbox,
  resetOutboxForRetry,
  appendAudit,
  listAudit,
  verifyFullAuditChain
} from './db.js';
import { parseGuestBatch, generarPlantillaCsvDemo, generarPlantillaOperaXmlDemo } from './csv.js';
import { construirDatosConstancia, renderConstanciaHtml } from './constancia.js';
import { procesarColaOutbox, startOutboxWorker } from './puiClient.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const SESSION_COOKIE = 'portico_session';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon'
};

const PARENTESCO_LABELS = {
  ACTA_NACIMIENTO: 'Acta de nacimiento verificada',
  INE_PADRE_MADRE: 'Identificación oficial de padre/madre coincidente',
  CARTA_NOTARIADA: 'Carta poder / autorización notariada verificada',
  NO_ACREDITO: 'NO ACREDITÓ PARENTESCO — Protocolo LGT activado'
};

function isDemoModeEnabled() {
  return process.env.PORTICO_DEMO_MODE !== 'false' && process.env.ARGUS_DEMO_MODE !== 'false';
}

function setSecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' data:; font-src 'self';"
  );
}

function sendJson(res, statusCode, body, extraHeaders = {}) {
  setSecurityHeaders(res);
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extraHeaders
  });
  res.end(payload);
}

function parseCookies(req) {
  const raw = req.headers.cookie || '';
  const map = {};
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (key) map[key] = decodeURIComponent(val);
  }
  return map;
}

function buildSessionCookie(req, token, maxAgeSec = 43200) {
  const isHttps =
    req.headers['x-forwarded-proto'] === 'https' || req.socket?.encrypted === true;
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/',
    `Max-Age=${maxAgeSec}`
  ];
  if (isHttps) parts.push('Secure');
  return parts.join('; ');
}

function getClientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.trim()) {
    return fwd.split(',')[0].trim();
  }
  return req.socket?.remoteAddress || '127.0.0.1';
}

function readJsonBody(req, maxBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let raw = '';
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error('PAYLOAD_TOO_LARGE'));
        req.destroy();
        return;
      }
      raw += chunk.toString('utf8');
    });
    req.on('end', () => {
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('INVALID_JSON'));
      }
    });
    req.on('error', reject);
  });
}

function extractBearer(req) {
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ')) return null;
  return auth.slice(7).trim();
}

function sanitizeSlug(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

function canAccessHotel(user, hotelSlug, allowedRoles) {
  if (!user || !allowedRoles.includes(user.rol)) return false;
  if (user.rol === 'ASOCIACION_ADMIN') return true;
  return user.hotelSlug === hotelSlug;
}

/**
 * Evalúa alertas activas Fase 3 para un huésped y encola notificación a SEGOB.
 */
async function evaluarAlertasFase3(hotel, guestRecord, curp, validacion, origen = 'CHECKIN_TIEMPO_REAL_PMS') {
  const alertasCoincidentes = findActiveMatchingAlerts(hotel.slug, guestRecord.curpHash);

  for (const alerta of alertasCoincidentes) {
    incrementAlertMatches(hotel.slug, alerta.reporteId, 1);
    const notifFase3 = {
      id: alerta.reporteId,
      rfc_institucion: hotel.rfc,
      fase_busqueda: '3',
      prioridad: validacion.esMenor ? 'CRITICA_MENOR_EDAD' : 'ALTA_LOCALIZACION',
      tipo_evento: origen,
      canal: 'SILENCIOSO_SIN_ALERTA_EN_MOSTRADOR',
      establecimiento: {
        nombre: hotel.nombre,
        rfc: hotel.rfc,
        ciudad: hotel.ciudad,
        pms_origen: hotel.pms
      },
      registro_huesped: {
        folio_pms: guestRecord.id,
        curp_enmascarada: enmascararCurp(curp),
        nombre_capturado: guestRecord.nombre,
        es_menor_edad: validacion.esMenor,
        edad_calculada_curp: validacion.edad,
        habitacion: guestRecord.habitacion,
        acompanante_registrado: guestRecord.acompanante || 'No especificado',
        acreditacion_parentesco: guestRecord.parentescoDocumento
          ? PARENTESCO_LABELS[guestRecord.parentescoDocumento] || guestRecord.parentescoDocumento
          : null,
        timestamp_checkin: guestRecord.fechaRegistro
      }
    };

    enqueueSegobNotification({
      hotelSlug: hotel.slug,
      reporteId: alerta.reporteId,
      endpoint: '/pui/notificar-coincidencia',
      fase: 'FASE 3',
      payload: notifFase3
    });

    appendAudit({
      hotelSlug: hotel.slug,
      direccion: 'HOTEL → SEGOB',
      endpoint: '/pui/notificar-coincidencia',
      fase: 'FASE 3 ALERTA',
      resumen: `COINCIDENCIA DETECTADA (${hotel.nombre}, Hab. ${guestRecord.habitacion}) — Aviso silencioso encolado hacia SEGOB para ${alerta.reporteId}.`,
      estatusHttp: 200,
      critico: true,
      payload: notifFase3
    });
  }

  if (alertasCoincidentes.length > 0) {
    await procesarColaOutbox();
  }
  return alertasCoincidentes.length;
}

/**
 * Ejecuta Fases 1, 2, encola entregas a SEGOB y activa Fase 3.
 */
async function procesarActivacionReporte(hotel, body, esPrueba = false) {
  const reporteId = String(body.id || '').trim();
  const validacion = validarCurp(body.curp);

  if (!reporteId) {
    return { status: 400, payload: { error: 'El campo obligatorio "id" del reporte es requerido.' } };
  }
  if (!validacion.valida) {
    return { status: 400, payload: { error: validacion.error, campo: 'curp' } };
  }

  const curp = validacion.curp;
  const curpHash = hashCurpPorHotel(hotel.slug, curp);
  const endpointOrigen = esPrueba
    ? `/api/pui/${hotel.slug}/activar-reporte-prueba`
    : `/api/pui/${hotel.slug}/activar-reporte`;

  appendAudit({
    hotelSlug: hotel.slug,
    direccion: 'SEGOB → HOTEL',
    endpoint: endpointOrigen,
    fase: 'ACTIVACION',
    resumen: `Reporte ${reporteId} recibido en ${hotel.nombre} (${enmascararCurp(curp)}).`,
    estatusHttp: 200,
    payload: {
      id: reporteId,
      curp_enmascarada: enmascararCurp(curp),
      entidad_nacimiento: validacion.entidad,
      es_menor_edad: validacion.esMenor,
      modo: esPrueba ? 'SANDBOX_PRUEBA' : 'PRODUCCION_PUI',
      fecha_desaparicion: body.fecha_desaparicion || null,
      tipo_alerta: body.tipo_alerta || (validacion.esMenor ? 'Alerta Menor / AMBER' : 'Reporte PUI')
    }
  });

  upsertAlert({
    hotelSlug: hotel.slug,
    reporteId,
    curp,
    curpHash,
    esMenor: validacion.esMenor,
    edadEstimada: validacion.edad,
    entidad: validacion.entidad,
    tipoAlerta: body.tipo_alerta || (validacion.esMenor ? 'Alerta Menor / PUI' : 'Reporte PUI'),
    fechaDesaparicion: body.fecha_desaparicion || null,
    esPrueba
  });

  const coincidenciasHotel = findGuestsByCurpHash(hotel.slug, curpHash);
  let notificaciones = 0;

  if (coincidenciasHotel.length > 0) {
    const reciente = coincidenciasHotel[0];

    const notifFase1 = {
      id: reporteId,
      rfc_institucion: hotel.rfc,
      fase_busqueda: '1',
      tipo_evento: 'DATOS_BASICOS_HUESPED',
      curp_enmascarada: enmascararCurp(curp),
      datos_complementarios: {
        nombre_registrado: reciente.nombre,
        telefono: reciente.telefono || 'No proporcionado',
        correo: reciente.correo || 'No proporcionado',
        ultimo_registro: reciente.fechaRegistro
      }
    };
    enqueueSegobNotification({
      hotelSlug: hotel.slug,
      reporteId,
      endpoint: '/pui/notificar-coincidencia',
      fase: 'FASE 1',
      payload: notifFase1
    });
    incrementAlertMatches(hotel.slug, reporteId, 1);
    notificaciones++;

    appendAudit({
      hotelSlug: hotel.slug,
      direccion: 'HOTEL → SEGOB',
      endpoint: '/pui/notificar-coincidencia',
      fase: 'FASE 1',
      resumen: `Fase 1 (Datos básicos): coincidencia encontrada en ${hotel.nombre} para ${reporteId}.`,
      estatusHttp: 200,
      payload: notifFase1
    });

    const notifFase2 = {
      id: reporteId,
      rfc_institucion: hotel.rfc,
      fase_busqueda: '2',
      tipo_evento: 'ANTECEDENTE_HOSPEDAJE_HISTORICO',
      curp_enmascarada: enmascararCurp(curp),
      eventos_historicos: coincidenciasHotel.map((g) => ({
        establecimiento: hotel.nombre,
        ciudad: hotel.ciudad,
        habitacion: g.habitacion,
        fecha_registro: g.fechaRegistro,
        estatus_estancia: g.tipo
      }))
    };
    enqueueSegobNotification({
      hotelSlug: hotel.slug,
      reporteId,
      endpoint: '/pui/notificar-coincidencia',
      fase: 'FASE 2',
      payload: notifFase2
    });
    incrementAlertMatches(hotel.slug, reporteId, 1);
    notificaciones++;

    appendAudit({
      hotelSlug: hotel.slug,
      direccion: 'HOTEL → SEGOB',
      endpoint: '/pui/notificar-coincidencia',
      fase: 'FASE 2',
      resumen: `Fase 2 (Histórico): ${coincidenciasHotel.length} estancia(s) previa(s) encoladas a SEGOB para ${reporteId}.`,
      estatusHttp: 200,
      payload: notifFase2
    });
  }

  const cierreFase2 = {
    id: reporteId,
    rfc_institucion: hotel.rfc,
    fase_busqueda: '2',
    coincidencias_encontradas: coincidenciasHotel.length,
    ventana_historica_anios: 12,
    monitoreo_continuo_fase_3: 'ACTIVO'
  };
  enqueueSegobNotification({
    hotelSlug: hotel.slug,
    reporteId,
    endpoint: '/pui/busqueda-finalizada',
    fase: 'FASE 2 CIERRE',
    payload: cierreFase2
  });

  appendAudit({
    hotelSlug: hotel.slug,
    direccion: 'HOTEL → SEGOB',
    endpoint: '/pui/busqueda-finalizada',
    fase: 'FASE 2 CIERRE',
    resumen: `Barrido histórico completado en ${hotel.nombre} (${coincidenciasHotel.length} coincidencia(s)). Fase 3 activa.`,
    estatusHttp: 200,
    payload: cierreFase2
  });

  await procesarColaOutbox();

  return {
    status: 200,
    payload: {
      ok: true,
      id: reporteId,
      hotel: hotel.nombre,
      rfc: hotel.rfc,
      fases_ejecutadas: ['1', '2'],
      coincidencias_historicas: coincidenciasHotel.length,
      fase_3_monitoreo_continuo: 'ACTIVO',
      cifrado_boveda: 'AES-256-GCM',
      notificaciones_enviadas: notificaciones
    }
  };
}

/**
 * Procesa un check-in del PMS, verifica protocolo de menores (LGT) y ejecuta Fase 3 silenciosa.
 */
async function procesarCheckinPms(hotel, body) {
  const nombre = String(body.nombre || '').trim().toUpperCase();
  const habitacion = String(body.habitacion || '').trim();
  const acompanante = String(body.acompanante || '').trim();
  const telefono = String(body.telefono || '').trim();
  const correo = String(body.correo || '').trim();
  const parentescoDocumento = body.parentescoDocumento
    ? String(body.parentescoDocumento).trim()
    : null;
  const usarPasaporte = Boolean(body.esExtranjero || (body.pasaporte && !body.curp));
  const validacion = usarPasaporte
    ? validarPasaporteExtranjero({
        pasaporte: body.pasaporte,
        nacionalidad: body.nacionalidad,
        fechaNacimiento: body.fechaNacimiento
      })
    : validarCurp(body.curp);

  if (nombre.length < 3) {
    return { status: 400, payload: { error: 'Ingresa el nombre completo del huésped.' } };
  }
  if (!validacion.valida) {
    return {
      status: 400,
      payload: { error: validacion.error, campo: usarPasaporte ? 'pasaporte' : 'curp' }
    };
  }

  const curp = validacion.curp;
  const curpHash = hashCurpPorHotel(hotel.slug, curp);
  const now = new Date().toISOString();

  const guestRecord = insertGuest({
    id: `GST-${Date.now().toString().slice(-6)}-${Math.floor(Math.random() * 90 + 10)}`,
    hotelSlug: hotel.slug,
    nombre,
    curp,
    curpHash,
    telefono,
    correo,
    habitacion: habitacion || 'Asignación pendiente',
    esMenor: validacion.esMenor,
    edadEstimada: validacion.edad,
    entidad: validacion.entidad,
    acompanante,
    parentescoDocumento: validacion.esMenor ? parentescoDocumento || 'PENDIENTE_VERIFICAR' : null,
    fechaRegistro: now,
    tipo:
      validacion.esMenor && parentescoDocumento === 'NO_ACREDITO'
        ? 'Bloqueado por Protocolo Menores (LGT)'
        : 'Check-in activo en PMS'
  });

  let avisoMenoresLgt = null;
  if (validacion.esMenor) {
    if (parentescoDocumento === 'NO_ACREDITO') {
      avisoMenoresLgt =
        'Protocolo Ley General de Turismo activado: sin acreditación de parentesco o tutela, negar el servicio de hospedaje y notificar a gerencia de seguridad / autoridad competente.';
      appendAudit({
        hotelSlug: hotel.slug,
        direccion: 'HOTEL (LGT)',
        endpoint: `/api/pms/${hotel.slug}/checkin`,
        fase: 'PROTOCOLO MENORES LGT',
        resumen: `Menor de edad sin acreditación de parentesco en ${hotel.nombre} (acompañante: ${acompanante || 'No especificado'}).`,
        estatusHttp: 201,
        payload: {
          folio_pms: guestRecord.id,
          rfc_institucion: hotel.rfc,
          ley_aplicable: 'Ley General de Turismo — Protección de Niñas, Niños y Adolescentes',
          edad_calculada_curp: validacion.edad,
          parentesco: PARENTESCO_LABELS.NO_ACREDITO,
          accion_recomendada: 'Negación de hospedaje y aviso a autoridad'
        }
      });
    } else if (parentescoDocumento && PARENTESCO_LABELS[parentescoDocumento]) {
      avisoMenoresLgt = `Menor de edad (${validacion.edad} años): ${PARENTESCO_LABELS[parentescoDocumento]}.`;
    } else {
      avisoMenoresLgt =
        'Menor de edad detectado por CURP: conforme a la Ley General de Turismo, verificar documentación oficial de parentesco o tutela del acompañante.';
    }
  }

  await evaluarAlertasFase3(hotel, guestRecord, curp, validacion, 'CHECKIN_TIEMPO_REAL_PMS');

  return {
    status: 201,
    payload: {
      ok: true,
      pms_status:
        validacion.esMenor && parentescoDocumento === 'NO_ACREDITO'
          ? 'HOLD_MINOR_PROTOCOL'
          : 'CHECKED_IN',
      mensaje_recepcion:
        validacion.esMenor && parentescoDocumento === 'NO_ACREDITO'
          ? `Registro retenido en ${hotel.nombre} por protocolo de menores (Ley General de Turismo).`
          : validacion.esExtranjero
            ? `Check-in extranjero completado en ${hotel.nombre} (Hab. ${guestRecord.habitacion} · Pasaporte ${validacion.nacionalidad}).`
            : `Check-in completado en ${hotel.nombre} (Habitación ${guestRecord.habitacion}). CURP validada correctamente.`,
      huesped: {
        id: guestRecord.id,
        nombre: guestRecord.nombre,
        curpEnmascarada: guestRecord.curpEnmascarada,
        habitacion: guestRecord.habitacion,
        esMenor: guestRecord.esMenor,
        entidad: validacion.entidad,
        parentescoDocumento: guestRecord.parentescoDocumento,
        fechaRegistro: guestRecord.fechaRegistro
      },
      verificacion_menor_turismo: avisoMenoresLgt
    }
  };
}

/**
 * Importación masiva de padrón / histórico CSV o XML (Oracle OPERA 5) con validación RENAPO/Pasaporte y Fase 3 silenciosa.
 */
async function procesarImportacionCsv(hotel, body) {
  const rawBatch = body.csvText || body.xmlText || '';
  const parsed = parseGuestBatch(rawBatch);
  if (parsed.error) {
    return { status: 400, payload: { error: parsed.error } };
  }

  let insertados = 0;
  let rechazados = 0;
  const errores = [];

  for (const row of parsed.rows) {
    const nombre = row.nombre.trim().toUpperCase();
    const val =
      !row.curp && row.pasaporte
        ? validarPasaporteExtranjero({
            pasaporte: row.pasaporte,
            nacionalidad: row.nacionalidad || 'EXT',
            fechaNacimiento: row.fechaNacimiento
          })
        : validarCurp(row.curp);
    if (nombre.length < 3) {
      rechazados++;
      errores.push({ linea: row.linea, curp: row.curp || row.pasaporte, motivo: 'Nombre vacío o demasiado corto.' });
      continue;
    }
    if (!val.valida) {
      rechazados++;
      errores.push({ linea: row.linea, curp: row.curp || row.pasaporte, motivo: val.error });
      continue;
    }

    const curpHash = hashCurpPorHotel(hotel.slug, val.curp);
    const guestRecord = insertGuest({
      id: `LOTE-${Date.now().toString().slice(-5)}-${row.linea}-${Math.floor(Math.random() * 90 + 10)}`,
      hotelSlug: hotel.slug,
      nombre,
      curp: val.curp,
      curpHash,
      telefono: row.telefono,
      correo: row.correo,
      habitacion: row.habitacion || (parsed.formato === 'OPERA_XML' ? 'OPERA XML' : 'Histórico CSV'),
      esMenor: val.esMenor,
      edadEstimada: val.edad,
      entidad: val.entidad,
      acompanante: row.acompanante,
      parentescoDocumento: null,
      fechaRegistro: row.fechaRegistro || new Date().toISOString(),
      tipo: parsed.formato === 'OPERA_XML' ? 'Importado desde Oracle OPERA XML' : 'Importado por lote CSV / PMS'
    });

    insertados++;
    await evaluarAlertasFase3(hotel, guestRecord, val.curp, val, 'IMPORTACION_LOTE_PMS');
  }

  appendAudit({
    hotelSlug: hotel.slug,
    direccion: 'PMS → PORTICO',
    endpoint: `/api/pms/${hotel.slug}/import-csv`,
    fase: parsed.formato === 'OPERA_XML' ? 'IMPORTACION OPERA XML' : 'IMPORTACION CSV',
    resumen: `Lote ${parsed.formato === 'OPERA_XML' ? 'OPERA XML' : 'CSV'} procesado en ${hotel.nombre}: ${insertados} registros válidos incorporados, ${rechazados} rechazados.`,
    estatusHttp: 200,
    payload: {
      rfc_institucion: hotel.rfc,
      formato: parsed.formato || 'CSV',
      origen: body.origen || 'Carga manual PMS',
      filas_totales: parsed.rows.length,
      validos_insertados: insertados,
      rechazados
    }
  });

  return {
    status: 200,
    payload: {
      ok: true,
      hotel: hotel.nombre,
      procesados: parsed.rows.length,
      insertados,
      rechazados,
      errores
    }
  };
}

function serveStaticFile(req, res, urlPath) {
  const cleanPath = urlPath === '/' ? '/index.html' : urlPath;
  const resolved = path.resolve(PUBLIC_DIR, `.${cleanPath}`);
  if (!resolved.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  if (!fs.existsSync(resolved) || fs.statSync(resolved).isDirectory()) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }
  const ext = path.extname(resolved).toLowerCase();
  setSecurityHeaders(res);
  res.writeHead(200, {
    'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
    'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300'
  });
  fs.createReadStream(resolved).pipe(res);
}

export function createServer({ enableWorker = true } = {}) {
  getDb();
  const limiter = createRateLimiter();
  const stopWorker = enableWorker ? startOutboxWorker(5000) : () => {};

  const server = http.createServer(async (req, res) => {
    const parsedUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const pathname = parsedUrl.pathname;
    const method = req.method || 'GET';
    const ip = getClientIp(req);

    // Resolver sesión si existe cookie
    const cookies = parseCookies(req);
    const sessionToken = cookies[SESSION_COOKIE] || null;
    const currentUser = sessionToken ? getSessionUser(sessionToken) : null;

    try {
      // 1. Healthcheck 24/7 (público para balanceador AWS)
      if (method === 'GET' && pathname === '/api/health') {
        const cadena = verifyFullAuditChain();
        return sendJson(res, 200, {
          status: 'ok',
          servicio: 'Portico Hospitality — Hospitality Trust & Compliance',
          estandar: 'Manual Técnico DOF (23/01/2026)',
          baseDatos: 'SQLite ACID (WAL)',
          hotelesRegistrados: listHotels().length,
          integridadBitacora: cadena.integra,
          timestamp: new Date().toISOString()
        });
      }

      // 2. Autenticación RBAC (/api/auth/*)
      if (method === 'GET' && pathname === '/api/auth/me') {
        return sendJson(res, 200, {
          authenticated: Boolean(currentUser),
          user: currentUser,
          demoMode: isDemoModeEnabled(),
          demoAccounts: isDemoModeEnabled() ? DEMO_ACCOUNTS_PUBLIC : []
        });
      }

      if (method === 'POST' && pathname === '/api/auth/login') {
        const rl = limiter.check(`login:${ip}`, { limit: 20, windowMs: 300_000 });
        if (!rl.allowed) {
          return sendJson(
            res,
            429,
            { error: 'Demasiados intentos de inicio de sesión. Intenta en unos minutos.' },
            { 'Retry-After': String(rl.retryAfterSec) }
          );
        }
        const body = await readJsonBody(req);
        const user = authenticateUser(body.email, body.password);
        if (!user) {
          return sendJson(res, 401, { error: 'Correo o contraseña incorrectos.' });
        }
        const session = createSession(user.id, 12);
        appendAudit({
          hotelSlug: user.hotelSlug || 'asociacion',
          direccion: 'ACCESO RBAC',
          endpoint: '/api/auth/login',
          fase: 'SESION',
          resumen: `Inicio de sesión autenticado: ${user.nombre} (${user.rol}).`,
          estatusHttp: 200,
          payload: { email: user.email, rol: user.rol, hotelSlug: user.hotelSlug }
        });
        return sendJson(
          res,
          200,
          { ok: true, user },
          { 'Set-Cookie': buildSessionCookie(req, session.token, 43200) }
        );
      }

      if (method === 'POST' && pathname === '/api/auth/logout') {
        if (sessionToken) deleteSession(sessionToken);
        return sendJson(
          res,
          200,
          { ok: true },
          { 'Set-Cookie': buildSessionCookie(req, '', 0) }
        );
      }

      // 3. Validación instantánea de CURP (disponible para cualquier usuario autenticado)
      if (method === 'GET' && pathname === '/api/curp/validar') {
        const raw = parsedUrl.searchParams.get('curp') || '';
        return sendJson(res, 200, validarCurp(raw));
      }

      // 4. Estado consolidado filtrado estrictamente por RBAC
      if (method === 'GET' && pathname === '/api/state') {
        if (!currentUser) {
          return sendJson(res, 401, { error: 'Inicia sesión para consultar la plataforma.' });
        }

        const cadena = verifyFullAuditChain();
        const isAssoc = currentUser.rol === 'ASOCIACION_ADMIN';
        const isHotelAdmin = currentUser.rol === 'HOTEL_ADMIN';
        const isReception = currentUser.rol === 'RECEPCION';

        const scopeHotel = isAssoc ? null : currentUser.hotelSlug;
        const hotelsRaw = listHotels({ hotelSlug: scopeHotel });
        const hotels = isReception
          ? hotelsRaw.map(({ pmsApiKey, usuarioPui, segobUsuario, ...pub }) => pub)
          : hotelsRaw;

        const alerts = isReception ? [] : listAlerts({ hotelSlug: scopeHotel });
        const outbox = isReception ? [] : listOutbox({ hotelSlug: scopeHotel, limit: 40 });
        const auditLog = isReception ? [] : listAudit({ hotelSlug: scopeHotel, limit: 50 });
        const guests = listGuests({ hotelSlug: scopeHotel, limit: 60 });

        return sendJson(res, 200, {
          user: currentUser,
          asociacion: {
            nombre: 'Asociación Mexicana de Hoteles de Nuevo León',
            hotelesObjetivo: 136
          },
          escenariosDemo: DEMO_SCENARIOS,
          integridadCadena: cadena,
          hotels,
          alerts,
          outbox,
          guests,
          auditLog,
          resumenRoles: {
            puedeCrearHoteles: isAssoc,
            puedeSimularSegob: isAssoc || isHotelAdmin,
            puedeVerAuditoria: isAssoc || isHotelAdmin,
            puedeConfigurarSegob: isAssoc || isHotelAdmin,
            puedeImportarCsv: isAssoc || isHotelAdmin
          }
        });
      }

      // 5. Cola Outbox y reintentos manuales
      if (method === 'GET' && pathname === '/api/outbox') {
        if (!currentUser || currentUser.rol === 'RECEPCION') {
          return sendJson(res, 403, { error: 'Acceso restringido a administradores.' });
        }
        const scope = currentUser.rol === 'ASOCIACION_ADMIN' ? null : currentUser.hotelSlug;
        return sendJson(res, 200, { outbox: listOutbox({ hotelSlug: scope, limit: 60 }) });
      }

      if (method === 'POST' && pathname === '/api/outbox/retry') {
        if (!currentUser || currentUser.rol === 'RECEPCION') {
          return sendJson(res, 403, { error: 'Acceso restringido a administradores.' });
        }
        const scope = currentUser.rol === 'ASOCIACION_ADMIN' ? null : currentUser.hotelSlug;
        const resetCount = resetOutboxForRetry(scope);
        const processed = await procesarColaOutbox();
        return sendJson(res, 200, { ok: true, reencolados: resetCount, procesados: processed });
      }

      // 5B. Gestión de Usuarios y Roles RBAC (ASOCIACION_ADMIN global; HOTEL_ADMIN aislado a su RFC)
      if (method === 'GET' && pathname === '/api/users') {
        if (!currentUser || currentUser.rol === 'RECEPCION') {
          return sendJson(res, 403, { error: 'Solo administradores pueden consultar cuentas de acceso.' });
        }
        const scope = currentUser.rol === 'ASOCIACION_ADMIN' ? null : currentUser.hotelSlug;
        return sendJson(res, 200, { users: listUsers({ hotelSlug: scope }) });
      }

      if (method === 'POST' && pathname === '/api/users') {
        if (!currentUser || currentUser.rol === 'RECEPCION') {
          return sendJson(res, 403, { error: 'Solo administradores pueden crear usuarios.' });
        }
        const body = await readJsonBody(req);
        const nombre = String(body.nombre || '').trim();
        const email = String(body.email || '').trim().toLowerCase();
        const password = String(body.password || '');
        const rol = String(body.rol || '').trim().toUpperCase();
        let hotelSlug = body.hotelSlug ? String(body.hotelSlug).trim() : null;

        if (nombre.length < 3) {
          return sendJson(res, 400, { error: 'Ingresa el nombre completo del colaborador.' });
        }
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
          return sendJson(res, 400, { error: 'Ingresa un correo institucional válido.' });
        }
        if (password.length < 8) {
          return sendJson(res, 400, { error: 'La contraseña debe tener al menos 8 caracteres.' });
        }
        if (!['ASOCIACION_ADMIN', 'HOTEL_ADMIN', 'RECEPCION'].includes(rol)) {
          return sendJson(res, 400, { error: 'Rol RBAC no válido.' });
        }

        if (currentUser.rol === 'HOTEL_ADMIN') {
          if (rol === 'ASOCIACION_ADMIN') {
            return sendJson(res, 403, {
              error: 'Un administrador de hotel no puede crear cuentas globales de la Asociación.'
            });
          }
          if (hotelSlug && hotelSlug !== currentUser.hotelSlug) {
            return sendJson(res, 403, {
              error: 'Aislamiento multi-hotel: solo puedes crear cuentas para tu propio hotel.'
            });
          }
          hotelSlug = currentUser.hotelSlug;
        } else if (rol !== 'ASOCIACION_ADMIN') {
          if (!hotelSlug || !getHotelBySlug(hotelSlug)) {
            return sendJson(res, 400, { error: 'Selecciona un hotel afiliado válido para este usuario.' });
          }
        } else {
          hotelSlug = null;
        }

        const result = createUser({ email, password, nombre, rol, hotelSlug });
        if (result.conflict) {
          return sendJson(res, 409, { error: 'Ya existe una cuenta registrada con ese correo.' });
        }

        appendAudit({
          hotelSlug: hotelSlug || 'asociacion',
          direccion: 'ACCESO RBAC',
          endpoint: '/api/users',
          fase: 'GESTION USUARIOS',
          resumen: `Nueva cuenta RBAC creada por ${currentUser.nombre}: ${email} (${rol}).`,
          estatusHttp: 201,
          payload: { creado_por: currentUser.email, email, rol, hotelSlug }
        });
        return sendJson(res, 201, { ok: true, user: result.user });
      }

      const userToggleMatch = pathname.match(/^\/api\/users\/(\d+)$/);
      if (userToggleMatch && method === 'PATCH') {
        if (!currentUser || currentUser.rol === 'RECEPCION') {
          return sendJson(res, 403, { error: 'Acceso restringido a administradores.' });
        }
        const targetId = Number(userToggleMatch[1]);
        if (targetId === currentUser.id) {
          return sendJson(res, 400, { error: 'No puedes desactivar tu propia sesión activa.' });
        }
        const body = await readJsonBody(req);
        const activo = Boolean(body.activo);
        const allowedHotelSlug = currentUser.rol === 'ASOCIACION_ADMIN' ? null : currentUser.hotelSlug;
        const resToggle = setUserActive(targetId, activo, { allowedHotelSlug });
        if (resToggle.notFound) return sendJson(res, 404, { error: 'Usuario no encontrado.' });
        if (resToggle.forbidden) {
          return sendJson(res, 403, { error: 'No tienes permiso para modificar cuentas de otro hotel.' });
        }
        appendAudit({
          hotelSlug: resToggle.user.hotelSlug || 'asociacion',
          direccion: 'ACCESO RBAC',
          endpoint: `/api/users/${targetId}`,
          fase: 'GESTION USUARIOS',
          resumen: `Cuenta ${resToggle.user.email} marcada como ${activo ? 'ACTIVA' : 'SUSPENDIDA'} por ${currentUser.nombre}.`,
          estatusHttp: 200,
          payload: { email: resToggle.user.email, activo }
        });
        return sendJson(res, 200, { ok: true, user: resToggle.user });
      }

      // 5C. Exportación CSV de Bitácora Auditable con Cadena SHA-256
      if (method === 'GET' && pathname === '/api/audit/export') {
        if (!currentUser || currentUser.rol === 'RECEPCION') {
          return sendJson(res, 403, { error: 'Acceso restringido a administradores.' });
        }
        const requestedHotel = parsedUrl.searchParams.get('hotel') || null;
        let scope = null;
        if (currentUser.rol === 'HOTEL_ADMIN') {
          scope = currentUser.hotelSlug;
        } else if (requestedHotel && requestedHotel !== 'all') {
          scope = requestedHotel;
        }
        const rows = listAudit({ hotelSlug: scope, limit: 1000 });
        const csvEsc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
        const lines = [
          'seq,timestamp,hotel_slug,direccion,endpoint,fase,estatus_http,resumen,sha256_hash',
          ...rows.map((r) =>
            [
              r.seq,
              r.timestamp,
              r.hotelSlug,
              r.direccion,
              r.endpoint,
              r.fase,
              r.estatusHttp,
              r.resumen,
              r.hash
            ]
              .map(csvEsc)
              .join(',')
          )
        ];
        setSecurityHeaders(res);
        res.writeHead(200, {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="bitacora_portico_${scope || 'asociacion'}.csv"`
        });
        res.end(`\uFEFF${lines.join('\n')}\n`);
        return;
      }

      // 6. Constancia Oficial de Cumplimiento PUI (JSON y Vista PDF — protegida por RBAC)
      const constanciaJsonMatch = pathname.match(/^\/api\/hotels\/([a-z0-9-]+)\/constancia$/);
      if (constanciaJsonMatch && method === 'GET') {
        const slug = constanciaJsonMatch[1];
        if (!canAccessHotel(currentUser, slug, ['ASOCIACION_ADMIN', 'HOTEL_ADMIN'])) {
          return sendJson(res, 403, { error: 'No tienes permiso para emitir la constancia de este hotel.' });
        }
        const hotel = getHotelBySlug(slug);
        if (!hotel) return sendJson(res, 404, { error: 'Hotel no encontrado.' });
        return sendJson(res, 200, construirDatosConstancia(hotel));
      }

      const constanciaHtmlMatch = pathname.match(/^\/constancia\/([a-z0-9-]+)$/);
      if (constanciaHtmlMatch && method === 'GET') {
        const slug = constanciaHtmlMatch[1];
        if (!canAccessHotel(currentUser, slug, ['ASOCIACION_ADMIN', 'HOTEL_ADMIN'])) {
          res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Acceso denegado: inicia sesión como administrador de la Asociación o del hotel titular.');
          return;
        }
        const hotel = getHotelBySlug(slug);
        if (!hotel) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Hotel no encontrado');
          return;
        }
        const datos = construirDatosConstancia(hotel);
        setSecurityHeaders(res);
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store'
        });
        res.end(renderConstanciaHtml(datos));
        return;
      }

      // 7. Configuración de conexión real a SEGOB por hotel (Sandbox / Producción)
      const segobCfgMatch = pathname.match(/^\/api\/hotels\/([a-z0-9-]+)\/segob-config$/);
      if (segobCfgMatch && method === 'PUT') {
        const slug = segobCfgMatch[1];
        if (!canAccessHotel(currentUser, slug, ['ASOCIACION_ADMIN', 'HOTEL_ADMIN'])) {
          return sendJson(res, 403, { error: 'No tienes permiso para modificar la conexión SEGOB de este hotel.' });
        }
        const body = await readJsonBody(req);
        if (
          body.segobBaseUrl &&
          body.segobBaseUrl.trim() &&
          !/^https?:\/\/.+/.test(body.segobBaseUrl.trim())
        ) {
          return sendJson(res, 400, { error: 'La URL de SEGOB debe iniciar con https:// o http://.' });
        }
        const updated = updateHotelSegobConfig(slug, body);
        if (!updated) return sendJson(res, 404, { error: 'Hotel no encontrado.' });
        appendAudit({
          hotelSlug: slug,
          direccion: 'CONFIG SEGOB',
          endpoint: `/api/hotels/${slug}/segob-config`,
          fase: 'CONFIGURACION',
          resumen: `Configuración de salida PUI actualizada en ${updated.nombre} (modo: ${updated.segobMode}).`,
          estatusHttp: 200,
          payload: {
            rfc: updated.rfc,
            segobMode: updated.segobMode,
            segobBaseUrl: updated.segobBaseUrl || '(Simulador local)',
            llaveMxStatus: updated.llaveMxStatus
          }
        });
        return sendJson(res, 200, { ok: true, hotel: updated });
      }

      // 8. Alta de nuevo hotel (solo ASOCIACION_ADMIN)
      if (method === 'POST' && pathname === '/api/hotels') {
        if (!currentUser || currentUser.rol !== 'ASOCIACION_ADMIN') {
          return sendJson(res, 403, {
            error: 'Solo un administrador de la Asociación puede dar de alta nuevos hoteles.'
          });
        }
        const body = await readJsonBody(req);
        const nombre = String(body.nombre || '').trim();
        const rfc = String(body.rfc || '').trim().toUpperCase();
        const pms = String(body.pms || '').trim();
        const grupo = String(body.grupo || 'Hotel Afiliado').trim();
        const ciudad = String(body.ciudad || 'Monterrey, N.L.').trim();
        const habitaciones = Math.max(1, Number(body.habitaciones) || 50);
        const modoIntegracion = String(body.modoIntegracion || 'API / Conector PMS').trim();

        if (nombre.length < 3) {
          return sendJson(res, 400, { error: 'Ingresa el nombre del hotel.' });
        }
        if (!/^[A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3}$/.test(rfc)) {
          return sendJson(res, 400, {
            error: 'El RFC debe tener el formato oficial del SAT (12 caracteres para persona moral).'
          });
        }

        const slug = sanitizeSlug(nombre);
        const result = createHotel({
          slug,
          nombre,
          grupo,
          rfc,
          ciudad,
          habitaciones,
          pms: pms || 'Portal Web / CSV',
          modoIntegracion
        });
        if (result.conflict) {
          return sendJson(res, 409, {
            error: 'Ya existe un hotel registrado con ese nombre o RFC en la Asociación.'
          });
        }

        appendAudit({
          hotelSlug: slug,
          direccion: 'ASOCIACIÓN',
          endpoint: '/api/hotels',
          fase: 'ONBOARDING',
          resumen: `Nuevo hotel dado de alta en Portico Hospitality (multi-RFC): ${nombre} (${rfc}).`,
          estatusHttp: 201,
          payload: { slug, rfc, pms: result.hotel.pms }
        });
        return sendJson(res, 201, { ok: true, hotel: result.hotel });
      }

      // 9. Reset de entorno demo (solo ASOCIACION_ADMIN cuando demoMode está activo)
      if (method === 'POST' && pathname === '/api/demo/reset') {
        if (!isDemoModeEnabled()) {
          return sendJson(res, 403, { error: 'El reinicio de demo está deshabilitado en producción.' });
        }
        if (!currentUser || currentUser.rol !== 'ASOCIACION_ADMIN') {
          return sendJson(res, 403, { error: 'Solo el administrador de la Asociación puede reiniciar la demo.' });
        }
        resetDb();
        // Recrear sesión del usuario actual para no expulsarlo al restablecer
        const userAfter = authenticateUser(currentUser.email, 'PorticoDemo#2026');
        const extra = userAfter
          ? { 'Set-Cookie': buildSessionCookie(req, createSession(userAfter.id, 12).token, 43200) }
          : {};
        return sendJson(
          res,
          200,
          { ok: true, mensaje: 'Base SQLite restablecida limpiamente.' },
          extra
        );
      }

      // 10. Endpoints oficiales PUI (DOF — Máquina a máquina SEGOB ↔ Portico Hospitality)
      const puiMatch = pathname.match(
        /^\/api\/pui\/([a-z0-9-]+)\/(login|activar-reporte|activar-reporte-prueba|desactivar-reporte)$/
      );
      if (puiMatch && method === 'POST') {
        const rl = limiter.check(`pui:${ip}`, { limit: 120, windowMs: 60_000 });
        if (!rl.allowed) {
          return sendJson(
            res,
            429,
            { error: 'Límite de peticiones PUI excedido.' },
            { 'Retry-After': String(rl.retryAfterSec) }
          );
        }

        const [, hotelSlug, action] = puiMatch;
        const hotel = getHotelBySlug(hotelSlug, true);
        if (!hotel) {
          return sendJson(res, 404, { error: 'Institución / hotel no encontrado en el padrón.' });
        }

        const body = await readJsonBody(req);

        if (action === 'login') {
          const user = String(body.usuario || body.username || '').trim();
          const pass = String(body.password || body.clave || '').trim();
          if (user !== hotel.usuarioPui || !verifyPassword(pass, hotel.clavePuiHash)) {
            return sendJson(res, 401, { error: 'Credenciales PUI inválidas para esta institución.' });
          }
          const token = firmarJwt({
            sub: hotel.usuarioPui,
            hotelSlug: hotel.slug,
            rfc: hotel.rfc,
            scope: 'pui:institucion-diversa'
          });
          appendAudit({
            hotelSlug: hotel.slug,
            direccion: 'SEGOB → HOTEL',
            endpoint: `/api/pui/${hotel.slug}/login`,
            fase: 'AUTH JWT',
            resumen: `Sesión JWT emitida para SEGOB en ${hotel.nombre} (RFC ${hotel.rfc}).`,
            estatusHttp: 200,
            payload: { sub: hotel.usuarioPui, rfc: hotel.rfc, alg: 'HS256', expira_en_seg: 3600 }
          });
          return sendJson(res, 200, {
            token,
            token_type: 'Bearer',
            expires_in: 3600,
            rfc: hotel.rfc
          });
        }

        const bearer = extractBearer(req);
        const verif = verificarJwt(bearer);
        if (!verif.valido || verif.payload.hotelSlug !== hotel.slug) {
          return sendJson(res, 401, {
            error: 'Token JWT inválido, expirado o perteneciente a otro RFC.'
          });
        }

        if (action === 'activar-reporte' || action === 'activar-reporte-prueba') {
          const result = await procesarActivacionReporte(
            hotel,
            body,
            action === 'activar-reporte-prueba'
          );
          return sendJson(res, result.status, result.payload);
        }

        if (action === 'desactivar-reporte') {
          const reporteId = String(body.id || '').trim();
          if (!reporteId) {
            return sendJson(res, 400, { error: 'El campo "id" del reporte es obligatorio.' });
          }
          const changed = deactivateAlert(hotel.slug, reporteId);
          if (!changed) {
            return sendJson(res, 404, { error: 'Reporte no encontrado en esta institución.' });
          }
          appendAudit({
            hotelSlug: hotel.slug,
            direccion: 'SEGOB → HOTEL',
            endpoint: `/api/pui/${hotel.slug}/desactivar-reporte`,
            fase: 'CIERRE FASE 3',
            resumen: `Monitoreo continuo desactivado en ${hotel.nombre} para reporte ${reporteId}.`,
            estatusHttp: 200,
            payload: { id: reporteId, rfc: hotel.rfc, monitoreo_fase_3: 'DETENIDO' }
          });
          return sendJson(res, 200, {
            ok: true,
            id: reporteId,
            fase_3_monitoreo_continuo: 'DETENIDO'
          });
        }
      }

      // 11. Simulador SEGOB desde UI (requiere ASOCIACION_ADMIN o HOTEL_ADMIN de ese hotel)
      if (method === 'POST' && pathname === '/api/demo/segob-action') {
        const body = await readJsonBody(req);
        const slug = String(body.hotelSlug || '').trim();
        if (!canAccessHotel(currentUser, slug, ['ASOCIACION_ADMIN', 'HOTEL_ADMIN'])) {
          return sendJson(res, 403, { error: 'No tienes permiso para ejecutar simulaciones SEGOB en este hotel.' });
        }
        const hotel = getHotelBySlug(slug);
        if (!hotel) return sendJson(res, 404, { error: 'Hotel no encontrado.' });

        const token = firmarJwt({
          sub: hotel.usuarioPui,
          hotelSlug: hotel.slug,
          rfc: hotel.rfc,
          scope: 'pui:institucion-diversa'
        });

        if (body.accion === 'activar') {
          appendAudit({
            hotelSlug: hotel.slug,
            direccion: 'SEGOB → HOTEL',
            endpoint: `/api/pui/${hotel.slug}/login`,
            fase: 'AUTH JWT',
            resumen: `Autenticación JWT verificada para SEGOB en ${hotel.nombre}.`,
            estatusHttp: 200,
            payload: { rfc: hotel.rfc, token_preview: `${token.slice(0, 26)}...`, alg: 'HS256' }
          });
          const resAct = await procesarActivacionReporte(hotel, body, Boolean(body.esPrueba));
          return sendJson(res, resAct.status, resAct.payload);
        }

        if (body.accion === 'desactivar') {
          const changed = deactivateAlert(hotel.slug, body.id);
          if (!changed) return sendJson(res, 404, { error: 'Reporte no encontrado.' });
          appendAudit({
            hotelSlug: hotel.slug,
            direccion: 'SEGOB → HOTEL',
            endpoint: `/api/pui/${hotel.slug}/desactivar-reporte`,
            fase: 'CIERRE FASE 3',
            resumen: `Reporte ${body.id} cerrado por SEGOB. Se detiene monitoreo en ${hotel.nombre}.`,
            estatusHttp: 200,
            payload: { id: body.id, rfc: hotel.rfc, fase_3: 'DETENIDO' }
          });
          return sendJson(res, 200, { ok: true, id: body.id, fase_3: 'DETENIDO' });
        }

        return sendJson(res, 400, { error: 'Acción de simulación no reconocida.' });
      }

      // 12. Endpoints PMS (autenticados por X-Portico-PMS-Key O sesión RBAC válida)
      const pmsMatch = pathname.match(
        /^\/api\/pms\/([a-z0-9-]+)\/(checkin|import-csv|csv-template|rotate-key)$/
      );
      if (pmsMatch) {
        const [, hotelSlug, action] = pmsMatch;
        const hotel = getHotelBySlug(hotelSlug);
        if (!hotel) return sendJson(res, 404, { error: 'Hotel no encontrado.' });

        const rl = limiter.check(`pms:${hotelSlug}:${ip}`, { limit: 300, windowMs: 60_000 });
        if (!rl.allowed) {
          return sendJson(
            res,
            429,
            { error: 'Límite de peticiones PMS excedido.' },
            { 'Retry-After': String(rl.retryAfterSec) }
          );
        }

        if (action === 'csv-template' && method === 'GET') {
          if (!canAccessHotel(currentUser, hotelSlug, ['ASOCIACION_ADMIN', 'HOTEL_ADMIN'])) {
            return sendJson(res, 403, { error: 'Inicia sesión como administrador para descargar plantillas.' });
          }
          const incluirMenor = parsedUrl.searchParams.get('demo') === '1';
          const csv = generarPlantillaCsvDemo({
            incluirMenorDemo: incluirMenor,
            curpMenor: DEMO_SCENARIOS.menorEnTiempoReal.curp
          });
          setSecurityHeaders(res);
          res.writeHead(200, {
            'Content-Type': 'text/csv; charset=utf-8',
            'Content-Disposition': `attachment; filename="plantilla_huespedes_${hotel.slug}.csv"`
          });
          res.end(csv);
          return;
        }

        if (action === 'rotate-key' && method === 'POST') {
          if (!canAccessHotel(currentUser, hotelSlug, ['ASOCIACION_ADMIN', 'HOTEL_ADMIN'])) {
            return sendJson(res, 403, { error: 'No tienes permiso para rotar la llave PMS de este hotel.' });
          }
          const newKey = rotateHotelPmsKey(hotel.slug);
          appendAudit({
            hotelSlug: hotel.slug,
            direccion: 'SEGURIDAD',
            endpoint: `/api/pms/${hotel.slug}/rotate-key`,
            fase: 'ROTACION LLAVE',
            resumen: `API Key de conector PMS rotada en ${hotel.nombre}.`,
            estatusHttp: 200,
            payload: { rfc: hotel.rfc, key_prefix: `${newKey.slice(0, 18)}...` }
          });
          return sendJson(res, 200, { ok: true, pmsApiKey: newKey });
        }

        // Autenticación dual para /checkin e /import-csv:
        // (A) Conector externo / Agente local vía X-Portico-PMS-Key
        // (B) Usuario web con sesión RBAC autorizada
        const providedKey = req.headers['x-portico-pms-key'];
        let authorized = false;

        if (providedKey !== undefined) {
          if (providedKey !== hotel.pmsApiKey) {
            return sendJson(res, 401, {
              error: 'Llave X-Portico-PMS-Key inválida o perteneciente a otro hotel.'
            });
          }
          authorized = true;
        } else if (action === 'checkin') {
          authorized = canAccessHotel(currentUser, hotelSlug, [
            'ASOCIACION_ADMIN',
            'HOTEL_ADMIN',
            'RECEPCION'
          ]);
        } else if (action === 'import-csv') {
          authorized = canAccessHotel(currentUser, hotelSlug, ['ASOCIACION_ADMIN', 'HOTEL_ADMIN']);
        }

        if (!authorized) {
          return sendJson(res, currentUser ? 403 : 401, {
            error: currentUser
              ? 'No tienes permiso para operar el PMS de este hotel.'
              : 'Autenticación requerida (sesión o header X-Portico-PMS-Key).'
          });
        }

        if (action === 'checkin' && method === 'POST') {
          const body = await readJsonBody(req);
          const result = await procesarCheckinPms(hotel, body);
          return sendJson(res, result.status, result.payload);
        }

        if (action === 'import-csv' && method === 'POST') {
          const body = await readJsonBody(req);
          const result = await procesarImportacionCsv(hotel, body);
          return sendJson(res, result.status, result.payload);
        }
      }

      // 13. Archivos estáticos de la aplicación web
      if (method === 'GET') {
        return serveStaticFile(req, res, pathname);
      }

      return sendJson(res, 404, { error: 'Ruta no encontrada.' });
    } catch (err) {
      if (err.message === 'INVALID_JSON') {
        return sendJson(res, 400, { error: 'El cuerpo JSON enviado no es válido.' });
      }
      if (err.message === 'PAYLOAD_TOO_LARGE') {
        return sendJson(res, 413, { error: 'La petición excede el tamaño máximo permitido.' });
      }
      console.error('[Portico Hospitality Server Error]', err);
      return sendJson(res, 500, { error: 'Error interno del servidor.' });
    }
  });

  server.on('close', () => {
    stopWorker();
  });

  return server;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  getDb();
  const PORT = Number(process.env.PORT) || 3080;
  const HOST = process.env.HOST || '0.0.0.0';
  const server = createServer({ enableWorker: true });
  server.listen(PORT, HOST, () => {
    console.log(`Portico Hospitality (Producción SQLite + RBAC + Outbox) listo en http://localhost:${PORT}`);
  });
}
