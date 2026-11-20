-- Argus ID — Esquema de Producción para PostgreSQL 16+ (AWS RDS con cifrado KMS)
-- Equivalente 1:1 del esquema SQLite embebido en src/db.js

CREATE TABLE IF NOT EXISTS hotels (
  id BIGSERIAL PRIMARY KEY,
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
  segob_clave_cifrada_json JSONB,
  creado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS users (
  id BIGSERIAL PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  nombre TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  rol TEXT NOT NULL CHECK (rol IN ('ASOCIACION_ADMIN', 'HOTEL_ADMIN', 'RECEPCION')),
  hotel_slug TEXT REFERENCES hotels(slug) ON DELETE SET NULL,
  activo BOOLEAN NOT NULL DEFAULT TRUE,
  creado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS pui_alerts (
  id BIGSERIAL PRIMARY KEY,
  hotel_slug TEXT NOT NULL REFERENCES hotels(slug) ON DELETE CASCADE,
  reporte_id TEXT NOT NULL,
  curp_hash TEXT NOT NULL,
  curp_enmascarada TEXT NOT NULL,
  curp_cifrada_json JSONB NOT NULL,
  es_menor BOOLEAN NOT NULL DEFAULT FALSE,
  edad_estimada INTEGER,
  entidad TEXT NOT NULL,
  tipo_alerta TEXT NOT NULL,
  fecha_desaparicion TEXT,
  es_prueba BOOLEAN NOT NULL DEFAULT FALSE,
  activa BOOLEAN NOT NULL DEFAULT TRUE,
  coincidencias_reportadas INTEGER NOT NULL DEFAULT 0,
  activada_en TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  desactivada_en TIMESTAMPTZ,
  UNIQUE(hotel_slug, reporte_id)
);
CREATE INDEX IF NOT EXISTS idx_pui_alerts_lookup ON pui_alerts(hotel_slug, activa, curp_hash);

CREATE TABLE IF NOT EXISTS guests (
  id TEXT PRIMARY KEY,
  hotel_slug TEXT NOT NULL REFERENCES hotels(slug) ON DELETE CASCADE,
  nombre TEXT NOT NULL,
  curp_cifrada_json JSONB NOT NULL,
  curp_hash TEXT NOT NULL,
  curp_enmascarada TEXT NOT NULL,
  telefono TEXT DEFAULT '',
  correo TEXT DEFAULT '',
  habitacion TEXT DEFAULT '',
  es_menor BOOLEAN NOT NULL DEFAULT FALSE,
  edad_estimada INTEGER,
  entidad TEXT DEFAULT '',
  acompanante TEXT DEFAULT '',
  parentesco_documento TEXT,
  fecha_registro TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  tipo TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_guests_lookup ON guests(hotel_slug, curp_hash);
CREATE INDEX IF NOT EXISTS idx_guests_recent ON guests(hotel_slug, fecha_registro DESC);

CREATE TABLE IF NOT EXISTS segob_outbox (
  id BIGSERIAL PRIMARY KEY,
  hotel_slug TEXT NOT NULL REFERENCES hotels(slug) ON DELETE CASCADE,
  reporte_id TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  fase TEXT NOT NULL,
  payload_json JSONB NOT NULL,
  estado TEXT NOT NULL CHECK (estado IN ('PENDIENTE', 'ENTREGADO', 'REINTENTANDO', 'ERROR_PERMANENTE')),
  intentos INTEGER NOT NULL DEFAULT 0,
  max_intentos INTEGER NOT NULL DEFAULT 8,
  proximo_intento_en TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ultimo_http INTEGER,
  ultimo_error TEXT,
  acuse_segob TEXT,
  latencia_ms INTEGER,
  creado_en TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  entregado_en TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_outbox_due ON segob_outbox(estado, proximo_intento_en);

CREATE TABLE IF NOT EXISTS audit_log (
  seq BIGSERIAL PRIMARY KEY,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  hotel_slug TEXT NOT NULL,
  direccion TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  fase TEXT,
  resumen TEXT NOT NULL,
  estatus_http INTEGER NOT NULL DEFAULT 200,
  critico BOOLEAN NOT NULL DEFAULT FALSE,
  payload_json JSONB NOT NULL,
  hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_hotel ON audit_log(hotel_slug, seq DESC);
