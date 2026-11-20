/**
 * Capa de persistencia relacional ACID sobre `node:sqlite` (Node 22+/25 nativo, cero dependencias).
 * Esquema 1:1 con `sql/schema.postgres.sql` para migración directa a AWS RDS PostgreSQL.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { completarCurpValida, enmascararCurp } from './curp.js';
import {
  calcularHashAuditoria,
  cifrarAes256Gcm,
  generarTokenSesion,
  hashCurpPorHotel,
  hashPassword,
  sha256Hex,
  verifyPassword
} from './security.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const DEFAULT_DB_PATH = path.join(DATA_DIR, 'argus.sqlite');

export function generarPmsApiKey(slug) {
  const prefix = slug.replace(/[^a-z0-9]/g, '').slice(0, 8) || 'hotel';
  return `argus_pms_${prefix}_${crypto.randomBytes(12).toString('hex')}`;
}

export const DEMO_SCENARIOS = {
  menorEnTiempoReal: {
    titulo: 'Menor con alerta activa (Fase 3 — Check-in en vivo)',
    descripcion:
      'SEGOB activa alerta para un menor. Minutos después intentan registrarlo en Crowne Plaza Monterrey; recepción opera con sigilo y la plataforma notifica a SEGOB al instante.',
    reporteId: 'FUB-NL-2026-04182',
    nombre: 'MATEO VALDEZ GARZA',
    curp: completarCurpValida('VAGM120815HNLZLDA'),
    fechaDesaparicion: '2026-11-18',
    habitacion: '1408',
    acompanante: 'ROBERTO SALAZAR MENDOZA',
    parentescoDocumento: 'NO_ACREDITO',
    tipoAlerta: 'Alerta AMBER / PUI Menor'
  },
  coincidenciaHistorica: {
    titulo: 'Coincidencia histórica previa (Fase 1 + Fase 2)',
    descripcion:
      'SEGOB solicita búsqueda de una persona que se hospedó hace 5 meses en Crowne Plaza Monterrey. El motor responde datos básicos (Fase 1), evento histórico (Fase 2) y cierre formal.',
    reporteId: 'FUB-NL-2026-03910',
    nombre: 'ELENA RODRIGUEZ CAVAZOS',
    curp: completarCurpValida('ROCE910422MNLDRL0'),
    fechaDesaparicion: '2026-05-01',
    tipoAlerta: 'Reporte PUI Adulto'
  },
  huespedSinAlerta: {
    titulo: 'Huésped ordinario sin reporte (Control negativo)',
    descripcion:
      'Check-in cotidiano de un viajero de negocios sin alertas activas. Valida CURP y completa el registro sin emitir notificaciones a SEGOB.',
    nombre: 'CARLOS EDUARDO TREVINO GARZA',
    curp: completarCurpValida('TEGC850910HNLVRN0'),
    habitacion: '0912'
  },
  escaneoIneEjecutivo: {
    nombre: 'VALERIA MONTEMAYOR GARZA',
    curp: completarCurpValida('MOGV900614MNLNRL0'),
    documento: 'INE Credencial para Votar (Lectura QR/MRZ)',
    habitacion: '1014'
  }
};

export const DEMO_ACCOUNTS_PUBLIC = [
  {
    email: 'presidente@asociacionhotelesnl.mx',
    passwordDemo: 'ArgusDemo#2026',
    nombre: 'Consejo — Asociación de Hoteles NL',
    rol: 'ASOCIACION_ADMIN',
    etiqueta: 'Presidente / Consejo Asociación',
    alcance: 'Tablero gremial, ROI, simulador y constancias (sin PII de huéspedes).'
  },
  {
    email: 'ti@crowneplazamty.mx',
    passwordDemo: 'ArgusDemo#2026',
    nombre: 'Dirección TI — Crowne Plaza Monterrey',
    rol: 'HOTEL_ADMIN',
    hotelSlug: 'crowne-plaza-monterrey',
    etiqueta: 'Gerente TI — Crowne Plaza MTY',
    alcance: 'Aislado solo a RFC MGM940512NL1: PMS Key, CSV, config SEGOB y constancia.'
  },
  {
    email: 'recepcion@crowneplazamty.mx',
    passwordDemo: 'ArgusDemo#2026',
    nombre: 'Mostrador — Crowne Plaza Monterrey',
    rol: 'RECEPCION',
    hotelSlug: 'crowne-plaza-monterrey',
    etiqueta: 'Recepción — Crowne Plaza MTY',
    alcance: 'Solo terminal de check-in y protocolo menores (cero acceso a alertas SEGOB).'
  },
  {
    email: 'ti@safihotels.mx',
    passwordDemo: 'ArgusDemo#2026',
    nombre: 'Dirección TI — Safi Royal Luxury Centro',
    rol: 'HOTEL_ADMIN',
    hotelSlug: 'safi-centro',
    etiqueta: 'Gerente TI — Hoteles Safi',
    alcance: 'Aislado solo a RFC SRL890320NL8 (prueba de aislamiento multi-hotel).'
  }
];

let db = null;
let cachedPasswordHash = null;
let cachedPuiClaveHash = null;

function getDefaultUserHash() {
  if (!cachedPasswordHash) cachedPasswordHash = hashPassword('ArgusDemo#2026');
  return cachedPasswordHash;
}

function getDefaultPuiHash() {
  if (!cachedPuiClaveHash) cachedPuiClaveHash = hashPassword('SegobPui#2026');
  return cachedPuiClaveHash;
}

function initSchema(database) {
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS hotels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT NOT NULL UNIQUE,
      nombre TEXT NOT NULL,
      grupo TEXT NOT NULL DEFAULT 'Hotel Afiliado',
      rfc TEXT NOT NULL UNIQUE,
      ciudad TEXT NOT NULL DEFAULT 'Monterrey, N.L.',
      habitaciones INTEGER NOT NULL DEFAULT 50,
      pms TEXT NOT NULL DEFAULT 'Portal Web / CSV',
      modo_integracion TEXT NOT NULL DEFAULT 'API / Conector PMS',
      estatus TEXT NOT NULL DEFAULT 'Activo',
      llave_mx_status TEXT NOT NULL DEFAULT 'Pendiente',
      latencia_ms INTEGER NOT NULL DEFAULT 45,
      usuario_pui TEXT NOT NULL,
      clave_pui_hash TEXT NOT NULL,
      pms_api_key TEXT NOT NULL,
      segob_mode TEXT NOT NULL DEFAULT 'SANDBOX_SIMULADO',
      segob_base_url TEXT NOT NULL DEFAULT '',
      segob_usuario TEXT NOT NULL DEFAULT '',
      segob_clave_cifrada_json TEXT,
      creado_en TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      nombre TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      rol TEXT NOT NULL CHECK (rol IN ('ASOCIACION_ADMIN', 'HOTEL_ADMIN', 'RECEPCION')),
      hotel_slug TEXT REFERENCES hotels(slug) ON DELETE SET NULL,
      activo INTEGER NOT NULL DEFAULT 1,
      creado_en TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

    CREATE TABLE IF NOT EXISTS pui_alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hotel_slug TEXT NOT NULL REFERENCES hotels(slug) ON DELETE CASCADE,
      reporte_id TEXT NOT NULL,
      curp_hash TEXT NOT NULL,
      curp_enmascarada TEXT NOT NULL,
      curp_cifrada_json TEXT NOT NULL,
      es_menor INTEGER NOT NULL DEFAULT 0,
      edad_estimada INTEGER,
      entidad TEXT NOT NULL,
      tipo_alerta TEXT NOT NULL,
      fecha_desaparicion TEXT,
      es_prueba INTEGER NOT NULL DEFAULT 0,
      activa INTEGER NOT NULL DEFAULT 1,
      coincidencias_reportadas INTEGER NOT NULL DEFAULT 0,
      activada_en TEXT NOT NULL,
      desactivada_en TEXT,
      UNIQUE(hotel_slug, reporte_id)
    );
    CREATE INDEX IF NOT EXISTS idx_pui_alerts_lookup ON pui_alerts(hotel_slug, activa, curp_hash);

    CREATE TABLE IF NOT EXISTS guests (
      id TEXT PRIMARY KEY,
      hotel_slug TEXT NOT NULL REFERENCES hotels(slug) ON DELETE CASCADE,
      nombre TEXT NOT NULL,
      curp_cifrada_json TEXT NOT NULL,
      curp_hash TEXT NOT NULL,
      curp_enmascarada TEXT NOT NULL,
      telefono TEXT DEFAULT '',
      correo TEXT DEFAULT '',
      habitacion TEXT DEFAULT '',
      es_menor INTEGER NOT NULL DEFAULT 0,
      edad_estimada INTEGER,
      entidad TEXT DEFAULT '',
      acompanante TEXT DEFAULT '',
      parentesco_documento TEXT,
      fecha_registro TEXT NOT NULL,
      tipo TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_guests_lookup ON guests(hotel_slug, curp_hash);
    CREATE INDEX IF NOT EXISTS idx_guests_recent ON guests(hotel_slug, fecha_registro DESC);

    CREATE TABLE IF NOT EXISTS segob_outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hotel_slug TEXT NOT NULL REFERENCES hotels(slug) ON DELETE CASCADE,
      reporte_id TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      fase TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      estado TEXT NOT NULL CHECK (estado IN ('PENDIENTE', 'ENTREGADO', 'REINTENTANDO', 'ERROR_PERMANENTE')),
      intentos INTEGER NOT NULL DEFAULT 0,
      max_intentos INTEGER NOT NULL DEFAULT 8,
      proximo_intento_en TEXT NOT NULL,
      ultimo_http INTEGER,
      ultimo_error TEXT,
      acuse_segob TEXT,
      latencia_ms INTEGER,
      creado_en TEXT NOT NULL,
      entregado_en TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_outbox_due ON segob_outbox(estado, proximo_intento_en);

    CREATE TABLE IF NOT EXISTS audit_log (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      hotel_slug TEXT NOT NULL,
      direccion TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      fase TEXT,
      resumen TEXT NOT NULL,
      estatus_http INTEGER NOT NULL DEFAULT 200,
      critico INTEGER NOT NULL DEFAULT 0,
      payload_json TEXT NOT NULL,
      hash TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_audit_hotel ON audit_log(hotel_slug, seq DESC);
  `);
}

function seedInitialData(database) {
  const now = new Date().toISOString();
  const puiHash = getDefaultPuiHash();
  const userHash = getDefaultUserHash();

  const insertHotel = database.prepare(`
    INSERT INTO hotels (
      slug, nombre, grupo, rfc, ciudad, habitaciones, pms, modo_integracion,
      estatus, llave_mx_status, latencia_ms, usuario_pui, clave_pui_hash,
      pms_api_key, segob_mode, segob_base_url, segob_usuario, segob_clave_cifrada_json, creado_en
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const seedHotels = [
    [
      'crowne-plaza-monterrey',
      'Crowne Plaza Monterrey',
      'Milenium Grupo Hotelero / IHG',
      'MGM940512NL1',
      'Monterrey, N.L.',
      403,
      'Oracle OPERA (OHIP / Puente Local)',
      'API / Conector OPERA',
      'Piloto Activo',
      'Certificado Sandbox',
      42,
      'pui_crowne_mty',
      puiHash,
      'argus_pms_crowne_7f92a4c18e3b6d051a24e890',
      'SANDBOX_SIMULADO',
      '',
      '',
      null,
      now
    ],
    [
      'safi-centro',
      'Safi Royal Luxury Centro',
      'Hoteles Safi',
      'SRL890320NL8',
      'Monterrey, N.L.',
      250,
      'Oracle OPERA 5',
      'Agente Local Sincronizado',
      'Siguiente Fase',
      'En Trámite',
      55,
      'pui_safi_centro',
      puiHash,
      'argus_pms_saficent_4c18b2f90e7a3d615290c4e1',
      'SANDBOX_SIMULADO',
      '',
      '',
      null,
      now
    ],
    [
      'safi-metropolitan',
      'Safi Royal Luxury Metropolitan',
      'Hoteles Safi',
      'SRL190814NL3',
      'San Pedro Garza García, N.L.',
      220,
      'Oracle OPERA Cloud',
      'API / Conector OPERA',
      'Siguiente Fase',
      'En Trámite',
      39,
      'pui_safi_metro',
      puiHash,
      'argus_pms_safimetr_9b04d3e71c5a8f206412a7b3',
      'SANDBOX_SIMULADO',
      '',
      '',
      null,
      now
    ],
    [
      'safi-valle',
      'Safi Royal Luxury Valle',
      'Hoteles Safi',
      'SRL051109NL5',
      'San Pedro Garza García, N.L.',
      240,
      'Oracle OPERA 5',
      'Agente Local Sincronizado',
      'Programado',
      'Pendiente',
      51,
      'pui_safi_valle',
      puiHash,
      'argus_pms_safivall_2e81c0a64f9d3b751084e2c9',
      'SANDBOX_SIMULADO',
      '',
      '',
      null,
      now
    ],
    [
      'posada-regia',
      'Hotel Posada Regia Independiente',
      'Hotel Afiliado Independiente',
      'HPR120401NL9',
      'Monterrey, N.L.',
      48,
      'Sin API (Portal Web / CSV)',
      'Portal Web / CSV',
      'Activo',
      'Certificado Sandbox',
      68,
      'pui_posada_regia',
      puiHash,
      'argus_pms_posadare_6a53f1d82c4e9b073165d8a2',
      'SANDBOX_SIMULADO',
      '',
      '',
      null,
      now
    ]
  ];

  for (const row of seedHotels) {
    insertHotel.run(...row);
  }

  const insertUser = database.prepare(`
    INSERT INTO users (email, nombre, password_hash, rol, hotel_slug, activo, creado_en)
    VALUES (?, ?, ?, ?, ?, 1, ?)
  `);
  for (const acc of DEMO_ACCOUNTS_PUBLIC) {
    insertUser.run(acc.email, acc.nombre, userHash, acc.rol, acc.hotelSlug || null, now);
  }

  const insertGuestStmt = database.prepare(`
    INSERT INTO guests (
      id, hotel_slug, nombre, curp_cifrada_json, curp_hash, curp_enmascarada,
      telefono, correo, habitacion, es_menor, edad_estimada, entidad,
      acompanante, parentesco_documento, fecha_registro, tipo
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const historicoCurp = DEMO_SCENARIOS.coincidenciaHistorica.curp;
  const g2Curp = completarCurpValida('CAVA880311MNLNRL0');
  const g3Curp = completarCurpValida('GAML791103HNLNRN0');

  const seedGuests = [
    [
      'GST-1001',
      'crowne-plaza-monterrey',
      DEMO_SCENARIOS.coincidenciaHistorica.nombre,
      JSON.stringify(cifrarAes256Gcm(historicoCurp)),
      hashCurpPorHotel('crowne-plaza-monterrey', historicoCurp),
      enmascararCurp(historicoCurp),
      '81-8340-2910',
      'e.rodriguez.demo@correo.mx',
      '1104',
      0,
      35,
      'Nuevo León',
      '',
      null,
      '2026-06-14T19:42:00.000Z',
      'Histórico (Check-out completado)'
    ],
    [
      'GST-1002',
      'crowne-plaza-monterrey',
      'ALEJANDRA CANTU VILLARREAL',
      JSON.stringify(cifrarAes256Gcm(g2Curp)),
      hashCurpPorHotel('crowne-plaza-monterrey', g2Curp),
      enmascararCurp(g2Curp),
      '81-1904-5521',
      'acantu.demo@empresa.mx',
      '0705',
      0,
      38,
      'Nuevo León',
      '',
      null,
      '2026-11-18T16:20:00.000Z',
      'Huésped en casa'
    ],
    [
      'GST-1003',
      'safi-centro',
      'LUIS FERNANDO GARZA MONTEMAYOR',
      JSON.stringify(cifrarAes256Gcm(g3Curp)),
      hashCurpPorHotel('safi-centro', g3Curp),
      enmascararCurp(g3Curp),
      '81-2201-8834',
      'lfgarza.demo@industrial.mx',
      '0418',
      0,
      47,
      'Nuevo León',
      '',
      null,
      '2026-11-19T14:05:00.000Z',
      'Huésped en casa'
    ]
  ];

  for (const g of seedGuests) {
    insertGuestStmt.run(...g);
  }

  // Evento génesis de auditoría encadenada SHA-256
  const payload = {
    plataforma: 'Argus ID — Hospitality Identity & Gov Alerts',
    motor_bd: 'SQLite ACID (WAL) · Compatible AWS RDS PostgreSQL',
    estandar: 'Manual Técnico PUI — Instituciones Diversas (DOF 23/01/2026)',
    cifrado: 'AES-256-GCM + scrypt + JWT HS256',
    aislamiento: 'Multi-RFC con RBAC estricto'
  };
  const baseAudit = {
    seq: 1,
    timestamp: now,
    hotelSlug: 'crowne-plaza-monterrey',
    direccion: 'SISTEMA',
    endpoint: '/api/health',
    fase: 'INICIO',
    resumen: 'Núcleo Argus ID inicializado sobre base relacional ACID con cifrado AES-256-GCM y RBAC.',
    estatusHttp: 200,
    critico: false,
    payload
  };
  const hash = calcularHashAuditoria('GENESIS', baseAudit);
  database
    .prepare(
      `INSERT INTO audit_log (seq, timestamp, hotel_slug, direccion, endpoint, fase, resumen, estatus_http, critico, payload_json, hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      1,
      baseAudit.timestamp,
      baseAudit.hotelSlug,
      baseAudit.direccion,
      baseAudit.endpoint,
      baseAudit.fase,
      baseAudit.resumen,
      baseAudit.estatusHttp,
      0,
      JSON.stringify(payload),
      hash
    );
}

export function getDb() {
  if (db) return db;
  const dbPath = process.env.ARGUS_DB_PATH || DEFAULT_DB_PATH;
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  db = new DatabaseSync(dbPath);
  initSchema(db);
  const count = db.prepare('SELECT COUNT(*) AS n FROM hotels').get().n;
  if (count === 0) {
    seedInitialData(db);
  }
  return db;
}

export function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}

export function resetDb() {
  const database = getDb();
  database.exec(`
    DELETE FROM sessions;
    DELETE FROM segob_outbox;
    DELETE FROM pui_alerts;
    DELETE FROM guests;
    DELETE FROM audit_log;
    DELETE FROM users;
    DELETE FROM hotels;
    DELETE FROM sqlite_sequence;
  `);
  seedInitialData(database);
}

// --- Mappers limpios ---
function mapHotel(row, includeSecrets = false) {
  if (!row) return null;
  const base = {
    id: row.id,
    slug: row.slug,
    nombre: row.nombre,
    grupo: row.grupo,
    rfc: row.rfc,
    ciudad: row.ciudad,
    habitaciones: row.habitaciones,
    pms: row.pms,
    modoIntegracion: row.modo_integracion,
    estatus: row.estatus,
    llaveMxStatus: row.llave_mx_status,
    latenciaMs: row.latencia_ms,
    usuarioPui: row.usuario_pui,
    pmsApiKey: row.pms_api_key,
    segobMode: row.segob_mode,
    segobBaseUrl: row.segob_base_url,
    segobUsuario: row.segob_usuario,
    segobClaveConfigurada: Boolean(row.segob_clave_cifrada_json),
    creadoEn: row.creado_en
  };
  if (includeSecrets) {
    base.clavePuiHash = row.clave_pui_hash;
    base.segobClaveCifrada = row.segob_clave_cifrada_json
      ? JSON.parse(row.segob_clave_cifrada_json)
      : null;
  }
  return base;
}

function mapAlert(row) {
  return {
    id: row.id,
    reporteId: row.reporte_id,
    hotelSlug: row.hotel_slug,
    hotelNombre: row.hotel_nombre || row.hotel_slug,
    curpEnmascarada: row.curp_enmascarada,
    cifrado: 'AES-256-GCM',
    esMenor: Boolean(row.es_menor),
    edadEstimada: row.edad_estimada,
    entidad: row.entidad,
    tipoAlerta: row.tipo_alerta,
    fechaDesaparicion: row.fecha_desaparicion,
    esPrueba: Boolean(row.es_prueba),
    activa: Boolean(row.activa),
    coincidenciasReportadas: row.coincidencias_reportadas,
    activadaEn: row.activada_en,
    desactivadaEn: row.desactivada_en
  };
}

function mapGuest(row) {
  return {
    id: row.id,
    hotelSlug: row.hotel_slug,
    nombre: row.nombre,
    curpEnmascarada: row.curp_enmascarada,
    telefono: row.telefono,
    correo: row.correo,
    habitacion: row.habitacion,
    esMenor: Boolean(row.es_menor),
    edadEstimada: row.edad_estimada,
    entidad: row.entidad,
    acompanante: row.acompanante,
    parentescoDocumento: row.parentesco_documento,
    fechaRegistro: row.fecha_registro,
    tipo: row.tipo
  };
}

function mapAudit(row) {
  return {
    seq: row.seq,
    timestamp: row.timestamp,
    hotelSlug: row.hotel_slug,
    direccion: row.direccion,
    endpoint: row.endpoint,
    fase: row.fase,
    resumen: row.resumen,
    estatusHttp: row.estatus_http,
    critico: Boolean(row.critico),
    payload: JSON.parse(row.payload_json),
    hash: row.hash
  };
}

function mapOutbox(row) {
  return {
    id: row.id,
    hotelSlug: row.hotel_slug,
    reporteId: row.reporte_id,
    endpoint: row.endpoint,
    fase: row.fase,
    payload: JSON.parse(row.payload_json),
    estado: row.estado,
    intentos: row.intentos,
    maxIntentos: row.max_intentos,
    proximoIntentoEn: row.proximo_intento_en,
    ultimoHttp: row.ultimo_http,
    ultimoError: row.ultimo_error,
    acuseSegob: row.acuse_segob,
    latenciaMs: row.latencia_ms,
    creadoEn: row.creado_en,
    entregadoEn: row.entregado_en
  };
}

// --- Repositorio de Hoteles ---
export function listHotels({ hotelSlug = null } = {}) {
  const database = getDb();
  if (hotelSlug) {
    const row = database.prepare('SELECT * FROM hotels WHERE slug = ?').get(hotelSlug);
    return row ? [mapHotel(row)] : [];
  }
  return database
    .prepare('SELECT * FROM hotels ORDER BY id ASC')
    .all()
    .map((r) => mapHotel(r));
}

export function getHotelBySlug(slug, includeSecrets = false) {
  const row = getDb().prepare('SELECT * FROM hotels WHERE slug = ?').get(slug);
  return mapHotel(row, includeSecrets);
}

export function createHotel({
  slug,
  nombre,
  grupo,
  rfc,
  ciudad,
  habitaciones,
  pms,
  modoIntegracion
}) {
  const database = getDb();
  const exists = database
    .prepare('SELECT 1 FROM hotels WHERE slug = ? OR rfc = ?')
    .get(slug, rfc);
  if (exists) return { conflict: true };

  const now = new Date().toISOString();
  const usuarioPui = `pui_${slug.replace(/-/g, '_').slice(0, 18)}`;
  const pmsApiKey = generarPmsApiKey(slug);

  database
    .prepare(
      `INSERT INTO hotels (
        slug, nombre, grupo, rfc, ciudad, habitaciones, pms, modo_integracion,
        estatus, llave_mx_status, latencia_ms, usuario_pui, clave_pui_hash,
        pms_api_key, segob_mode, segob_base_url, segob_usuario, segob_clave_cifrada_json, creado_en
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Activo', 'Listo para Sandbox', 45, ?, ?, ?, 'SANDBOX_SIMULADO', '', '', NULL, ?)`
    )
    .run(
      slug,
      nombre,
      grupo,
      rfc,
      ciudad,
      habitaciones,
      pms,
      modoIntegracion,
      usuarioPui,
      getDefaultPuiHash(),
      pmsApiKey,
      now
    );

  return { conflict: false, hotel: getHotelBySlug(slug) };
}

export function rotateHotelPmsKey(slug) {
  const newKey = generarPmsApiKey(slug);
  getDb().prepare('UPDATE hotels SET pms_api_key = ? WHERE slug = ?').run(newKey, slug);
  return newKey;
}

export function updateHotelSegobConfig(
  slug,
  { segobMode, segobBaseUrl, segobUsuario, segobClave, llaveMxStatus }
) {
  const database = getDb();
  const current = database.prepare('SELECT * FROM hotels WHERE slug = ?').get(slug);
  if (!current) return null;

  const mode = ['SANDBOX_SIMULADO', 'SEGOB_SANDBOX', 'SEGOB_PRODUCCION'].includes(segobMode)
    ? segobMode
    : current.segob_mode;
  const url = typeof segobBaseUrl === 'string' ? segobBaseUrl.trim().replace(/\/$/, '') : current.segob_base_url;
  const user = typeof segobUsuario === 'string' ? segobUsuario.trim() : current.segob_usuario;
  const claveJson =
    typeof segobClave === 'string' && segobClave.trim().length > 0
      ? JSON.stringify(cifrarAes256Gcm(segobClave.trim()))
      : current.segob_clave_cifrada_json;
  const llaveMx =
    typeof llaveMxStatus === 'string' && llaveMxStatus.trim().length > 0
      ? llaveMxStatus.trim()
      : current.llave_mx_status;

  database
    .prepare(
      `UPDATE hotels
       SET segob_mode = ?, segob_base_url = ?, segob_usuario = ?, segob_clave_cifrada_json = ?, llave_mx_status = ?
       WHERE slug = ?`
    )
    .run(mode, url, user, claveJson, llaveMx, slug);

  return getHotelBySlug(slug);
}

// --- Usuarios y Sesiones RBAC ---
export function authenticateUser(email, password) {
  const normalized = String(email || '').trim().toLowerCase();
  const user = getDb()
    .prepare('SELECT * FROM users WHERE email = ? AND activo = 1')
    .get(normalized);
  if (!user || !verifyPassword(password, user.password_hash)) {
    return null;
  }
  return {
    id: user.id,
    email: user.email,
    nombre: user.nombre,
    rol: user.rol,
    hotelSlug: user.hotel_slug
  };
}

export function createSession(userId, ttlHours = 12) {
  const token = generarTokenSesion();
  const tokenHash = sha256Hex(token);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlHours * 3600 * 1000).toISOString();
  getDb()
    .prepare('INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
    .run(tokenHash, userId, expiresAt, now.toISOString());
  return { token, expiresAt };
}

export function getSessionUser(token) {
  if (!token) return null;
  const tokenHash = sha256Hex(token);
  const nowIso = new Date().toISOString();
  const row = getDb()
    .prepare(
      `SELECT u.id, u.email, u.nombre, u.rol, u.hotel_slug, s.expires_at
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND u.activo = 1 AND s.expires_at > ?`
    )
    .get(tokenHash, nowIso);
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    nombre: row.nombre,
    rol: row.rol,
    hotelSlug: row.hotel_slug
  };
}

export function deleteSession(token) {
  if (!token) return;
  getDb().prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256Hex(token));
}

// --- Alertas PUI ---
export function upsertAlert({
  hotelSlug,
  reporteId,
  curp,
  curpHash,
  esMenor,
  edadEstimada,
  entidad,
  tipoAlerta,
  fechaDesaparicion,
  esPrueba
}) {
  const database = getDb();
  const now = new Date().toISOString();
  const curpCifradaJson = JSON.stringify(cifrarAes256Gcm(curp));
  const curpEnmascarada = enmascararCurp(curp);

  database
    .prepare(
      `INSERT INTO pui_alerts (
        hotel_slug, reporte_id, curp_hash, curp_enmascarada, curp_cifrada_json,
        es_menor, edad_estimada, entidad, tipo_alerta, fecha_desaparicion,
        es_prueba, activa, coincidencias_reportadas, activada_en, desactivada_en
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, NULL)
      ON CONFLICT(hotel_slug, reporte_id) DO UPDATE SET
        curp_hash = excluded.curp_hash,
        curp_enmascarada = excluded.curp_enmascarada,
        curp_cifrada_json = excluded.curp_cifrada_json,
        es_menor = excluded.es_menor,
        edad_estimada = excluded.edad_estimada,
        entidad = excluded.entidad,
        tipo_alerta = excluded.tipo_alerta,
        fecha_desaparicion = excluded.fecha_desaparicion,
        es_prueba = excluded.es_prueba,
        activa = 1,
        activada_en = excluded.activada_en,
        desactivada_en = NULL`
    )
    .run(
      hotelSlug,
      reporteId,
      curpHash,
      curpEnmascarada,
      curpCifradaJson,
      esMenor ? 1 : 0,
      edadEstimada,
      entidad,
      tipoAlerta,
      fechaDesaparicion || null,
      esPrueba ? 1 : 0,
      now
    );
}

export function listAlerts({ hotelSlug = null, onlyActive = false } = {}) {
  const database = getDb();
  const clauses = [];
  const params = [];
  if (hotelSlug) {
    clauses.push('a.hotel_slug = ?');
    params.push(hotelSlug);
  }
  if (onlyActive) {
    clauses.push('a.activa = 1');
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return database
    .prepare(
      `SELECT a.*, h.nombre AS hotel_nombre
       FROM pui_alerts a
       JOIN hotels h ON h.slug = a.hotel_slug
       ${where}
       ORDER BY a.id DESC`
    )
    .all(...params)
    .map(mapAlert);
}

export function findActiveMatchingAlerts(hotelSlug, curpHash) {
  return getDb()
    .prepare(
      `SELECT a.*, h.nombre AS hotel_nombre
       FROM pui_alerts a
       JOIN hotels h ON h.slug = a.hotel_slug
       WHERE a.hotel_slug = ? AND a.activa = 1 AND a.curp_hash = ?`
    )
    .all(hotelSlug, curpHash)
    .map(mapAlert);
}

export function incrementAlertMatches(hotelSlug, reporteId, delta = 1) {
  getDb()
    .prepare(
      `UPDATE pui_alerts
       SET coincidencias_reportadas = coincidencias_reportadas + ?
       WHERE hotel_slug = ? AND reporte_id = ?`
    )
    .run(delta, hotelSlug, reporteId);
}

export function deactivateAlert(hotelSlug, reporteId) {
  const now = new Date().toISOString();
  const res = getDb()
    .prepare(
      `UPDATE pui_alerts
       SET activa = 0, desactivada_en = ?
       WHERE hotel_slug = ? AND reporte_id = ?`
    )
    .run(now, hotelSlug, reporteId);
  return res.changes > 0;
}

// --- Huéspedes (CURP cifrada AES-256-GCM en reposo) ---
export function insertGuest({
  id,
  hotelSlug,
  nombre,
  curp,
  curpHash,
  telefono,
  correo,
  habitacion,
  esMenor,
  edadEstimada,
  entidad,
  acompanante,
  parentescoDocumento,
  fechaRegistro,
  tipo
}) {
  const curpCifradaJson = JSON.stringify(cifrarAes256Gcm(curp));
  const curpEnmascarada = enmascararCurp(curp);
  getDb()
    .prepare(
      `INSERT INTO guests (
        id, hotel_slug, nombre, curp_cifrada_json, curp_hash, curp_enmascarada,
        telefono, correo, habitacion, es_menor, edad_estimada, entidad,
        acompanante, parentesco_documento, fecha_registro, tipo
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      hotelSlug,
      nombre,
      curpCifradaJson,
      curpHash,
      curpEnmascarada,
      telefono || '',
      correo || '',
      habitacion || '',
      esMenor ? 1 : 0,
      edadEstimada ?? null,
      entidad || '',
      acompanante || '',
      parentescoDocumento || null,
      fechaRegistro,
      tipo
    );
  return {
    id,
    hotelSlug,
    nombre,
    curpHash,
    curpEnmascarada,
    telefono: telefono || '',
    correo: correo || '',
    habitacion: habitacion || '',
    esMenor: Boolean(esMenor),
    edadEstimada,
    entidad: entidad || '',
    acompanante: acompanante || '',
    parentescoDocumento: parentescoDocumento || null,
    fechaRegistro,
    tipo
  };
}

export function listGuests({ hotelSlug = null, limit = 50 } = {}) {
  const database = getDb();
  if (hotelSlug) {
    return database
      .prepare('SELECT * FROM guests WHERE hotel_slug = ? ORDER BY fecha_registro DESC LIMIT ?')
      .all(hotelSlug, limit)
      .map(mapGuest);
  }
  return database
    .prepare('SELECT * FROM guests ORDER BY fecha_registro DESC LIMIT ?')
    .all(limit)
    .map(mapGuest);
}

export function findGuestsByCurpHash(hotelSlug, curpHash) {
  return getDb()
    .prepare(
      'SELECT * FROM guests WHERE hotel_slug = ? AND curp_hash = ? ORDER BY fecha_registro DESC'
    )
    .all(hotelSlug, curpHash)
    .map(mapGuest);
}

export function countGuests(hotelSlug = null) {
  if (hotelSlug) {
    return getDb().prepare('SELECT COUNT(*) AS n FROM guests WHERE hotel_slug = ?').get(hotelSlug).n;
  }
  return getDb().prepare('SELECT COUNT(*) AS n FROM guests').get().n;
}

// --- Cola Outbox SEGOB ---
export function enqueueSegobNotification({ hotelSlug, reporteId, endpoint, fase, payload }) {
  const now = new Date().toISOString();
  const res = getDb()
    .prepare(
      `INSERT INTO segob_outbox (
        hotel_slug, reporte_id, endpoint, fase, payload_json,
        estado, intentos, max_intentos, proximo_intento_en, creado_en
      ) VALUES (?, ?, ?, ?, ?, 'PENDIENTE', 0, 8, ?, ?)`
    )
    .run(hotelSlug, reporteId, endpoint, fase, JSON.stringify(payload), now, now);
  return Number(res.lastInsertRowid);
}

export function listDueOutboxJobs(nowIso = new Date().toISOString(), limit = 25) {
  return getDb()
    .prepare(
      `SELECT * FROM segob_outbox
       WHERE estado IN ('PENDIENTE', 'REINTENTANDO') AND proximo_intento_en <= ?
       ORDER BY id ASC LIMIT ?`
    )
    .all(nowIso, limit)
    .map(mapOutbox);
}

export function markOutboxDelivered(id, { httpStatus, acuseSegob, latenciaMs }) {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `UPDATE segob_outbox
       SET estado = 'ENTREGADO', intentos = intentos + 1, ultimo_http = ?,
           ultimo_error = NULL, acuse_segob = ?, latencia_ms = ?, entregado_en = ?
       WHERE id = ?`
    )
    .run(httpStatus, acuseSegob, latenciaMs, now, id);
}

export function markOutboxRetry(id, { intentosActuales, maxIntentos, httpStatus, errorMsg, latenciaMs }) {
  const nextAttempt = intentosActuales + 1;
  const permanent = nextAttempt >= maxIntentos;
  const backoffMs = Math.min(600_000, 5_000 * 2 ** Math.max(0, nextAttempt - 1));
  const nextIso = new Date(Date.now() + backoffMs).toISOString();

  getDb()
    .prepare(
      `UPDATE segob_outbox
       SET estado = ?, intentos = ?, proximo_intento_en = ?, ultimo_http = ?,
           ultimo_error = ?, latencia_ms = ?
       WHERE id = ?`
    )
    .run(
      permanent ? 'ERROR_PERMANENTE' : 'REINTENTANDO',
      nextAttempt,
      nextIso,
      httpStatus || null,
      String(errorMsg || 'Error de entrega').slice(0, 400),
      latenciaMs || null,
      id
    );
}

export function listOutbox({ hotelSlug = null, limit = 40 } = {}) {
  const database = getDb();
  if (hotelSlug) {
    return database
      .prepare('SELECT * FROM segob_outbox WHERE hotel_slug = ? ORDER BY id DESC LIMIT ?')
      .all(hotelSlug, limit)
      .map(mapOutbox);
  }
  return database
    .prepare('SELECT * FROM segob_outbox ORDER BY id DESC LIMIT ?')
    .all(limit)
    .map(mapOutbox);
}

export function resetOutboxForRetry(hotelSlug = null) {
  const now = new Date().toISOString();
  if (hotelSlug) {
    const r = getDb()
      .prepare(
        `UPDATE segob_outbox
         SET estado = 'PENDIENTE', proximo_intento_en = ?
         WHERE hotel_slug = ? AND estado IN ('REINTENTANDO', 'ERROR_PERMANENTE')`
      )
      .run(now, hotelSlug);
    return r.changes;
  }
  const r = getDb()
    .prepare(
      `UPDATE segob_outbox
       SET estado = 'PENDIENTE', proximo_intento_en = ?
       WHERE estado IN ('REINTENTANDO', 'ERROR_PERMANENTE')`
    )
    .run(now);
  return r.changes;
}

// --- Bitácora Auditable encadenada SHA-256 ---
export function appendAudit({
  hotelSlug,
  direccion,
  endpoint,
  fase = null,
  resumen,
  estatusHttp = 200,
  critico = false,
  payload = {}
}) {
  const database = getDb();
  const prev = database
    .prepare('SELECT seq, hash FROM audit_log ORDER BY seq DESC LIMIT 1')
    .get();
  const seq = (prev?.seq || 0) + 1;
  const timestamp = new Date().toISOString();

  const record = {
    seq,
    timestamp,
    hotelSlug,
    direccion,
    endpoint,
    fase,
    resumen,
    estatusHttp,
    critico: Boolean(critico),
    payload
  };
  const hash = calcularHashAuditoria(prev?.hash || 'GENESIS', record);

  database
    .prepare(
      `INSERT INTO audit_log (seq, timestamp, hotel_slug, direccion, endpoint, fase, resumen, estatus_http, critico, payload_json, hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      seq,
      timestamp,
      hotelSlug,
      direccion,
      endpoint,
      fase,
      resumen,
      estatusHttp,
      critico ? 1 : 0,
      JSON.stringify(payload),
      hash
    );

  return { ...record, hash };
}

export function listAudit({ hotelSlug = null, limit = 60 } = {}) {
  const database = getDb();
  if (hotelSlug) {
    return database
      .prepare('SELECT * FROM audit_log WHERE hotel_slug = ? ORDER BY seq DESC LIMIT ?')
      .all(hotelSlug, limit)
      .map(mapAudit);
  }
  return database
    .prepare('SELECT * FROM audit_log ORDER BY seq DESC LIMIT ?')
    .all(limit)
    .map(mapAudit);
}

export function verifyFullAuditChain() {
  const rows = getDb().prepare('SELECT * FROM audit_log ORDER BY seq ASC').all();
  if (rows.length === 0) {
    return { integra: true, totalEventos: 0, ultimoHash: 'GENESIS' };
  }
  let prevHash = 'GENESIS';
  for (const row of rows) {
    const base = {
      seq: row.seq,
      timestamp: row.timestamp,
      hotelSlug: row.hotel_slug,
      direccion: row.direccion,
      endpoint: row.endpoint,
      fase: row.fase,
      resumen: row.resumen,
      estatusHttp: row.estatus_http,
      critico: Boolean(row.critico),
      payload: JSON.parse(row.payload_json)
    };
    const esperado = calcularHashAuditoria(prevHash, base);
    if (row.hash !== esperado) {
      return {
        integra: false,
        totalEventos: rows.length,
        ultimoHash: rows[rows.length - 1].hash
      };
    }
    prevHash = row.hash;
  }
  return {
    integra: true,
    totalEventos: rows.length,
    ultimoHash: rows[rows.length - 1].hash
  };
}
