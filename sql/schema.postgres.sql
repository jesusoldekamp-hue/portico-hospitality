-- Portico Hospitality — Esquema de Producción Escala Nacional (1,000+ Hoteles)
-- PostgreSQL 16+ (AWS RDS Multi-AZ con cifrado KMS, Row-Level Security y particionamiento)
-- Equivalente 1:1 del esquema SQLite embebido en src/db.js + capa Multi-Asociación

-- ============================================================================
-- 1. MULTI-ASOCIACIÓN (Escala Nacional: NL, Jalisco, CDMX, Cancún, Los Cabos)
-- ============================================================================
CREATE TABLE IF NOT EXISTS associations (
  id BIGSERIAL PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  nombre TEXT NOT NULL,
  estado TEXT NOT NULL,
  plan TEXT NOT NULL DEFAULT 'PATRIMONIAL_GREMIAL',
  cuota_mensual_hotel_mxn INTEGER NOT NULL DEFAULT 250,
  activo BOOLEAN NOT NULL DEFAULT TRUE,
  creado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO associations (slug, nombre, estado)
VALUES ('amh-nl', 'Asociación Mexicana de Hoteles de Nuevo León, A.C.', 'Nuevo León')
ON CONFLICT (slug) DO NOTHING;

-- ============================================================================
-- 2. HOTELES AFILIADOS (Aislamiento estricto por RFC)
-- ============================================================================
CREATE TABLE IF NOT EXISTS hotels (
  id BIGSERIAL PRIMARY KEY,
  association_slug TEXT NOT NULL DEFAULT 'amh-nl' REFERENCES associations(slug) ON DELETE RESTRICT,
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
CREATE INDEX IF NOT EXISTS idx_hotels_association ON hotels(association_slug, estatus);

-- ============================================================================
-- 3. USUARIOS Y SESIONES (RBAC + scrypt)
-- ============================================================================
CREATE TABLE IF NOT EXISTS users (
  id BIGSERIAL PRIMARY KEY,
  association_slug TEXT NOT NULL DEFAULT 'amh-nl' REFERENCES associations(slug) ON DELETE RESTRICT,
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

-- ============================================================================
-- 4. BÓVEDA CIFRADA DE ALERTAS PUI (Fases 1, 2 y 3)
-- ============================================================================
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

-- ============================================================================
-- 5. PADRÓN CIFRADO DE HUÉSPEDES (Nacionales CURP + Extranjeros Pasaporte/MRZ)
-- Nota de escala 1,000 hoteles (~30M filas/año): convertir a PARTITION BY RANGE (fecha_registro)
-- creando particiones mensuales automatizadas con pg_partman.
-- ============================================================================
CREATE TABLE IF NOT EXISTS guests (
  id TEXT PRIMARY KEY,
  hotel_slug TEXT NOT NULL REFERENCES hotels(slug) ON DELETE CASCADE,
  nombre TEXT NOT NULL,
  tipo_documento TEXT NOT NULL DEFAULT 'CURP' CHECK (tipo_documento IN ('CURP', 'PASAPORTE')),
  nacionalidad TEXT NOT NULL DEFAULT 'MEX',
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

-- ============================================================================
-- 6. COLA PERSISTENTE SEGOB OUTBOX (Reintentos exponenciales + SKIP LOCKED)
-- ============================================================================
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

-- ============================================================================
-- 7. BITÁCORA INMUTABLE ENCADENADA SHA-256 (Evidencia Forense)
-- ============================================================================
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

-- ============================================================================
-- 8. ROW-LEVEL SECURITY (RLS) — AISLAMIENTO FÍSICO MULTI-HOTEL POR RFC
-- Cada transacción fija: SET LOCAL app.current_hotel_slug = '<slug>';
-- Los procesos de sistema / Consejo fijan: SET LOCAL app.bypass_rls = 'on';
-- ============================================================================
ALTER TABLE pui_alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE guests ENABLE ROW LEVEL SECURITY;
ALTER TABLE segob_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_pui_alerts_hotel ON pui_alerts;
CREATE POLICY rls_pui_alerts_hotel ON pui_alerts
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR hotel_slug = current_setting('app.current_hotel_slug', true)
  );

DROP POLICY IF EXISTS rls_guests_hotel ON guests;
CREATE POLICY rls_guests_hotel ON guests
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR hotel_slug = current_setting('app.current_hotel_slug', true)
  );

DROP POLICY IF EXISTS rls_outbox_hotel ON segob_outbox;
CREATE POLICY rls_outbox_hotel ON segob_outbox
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR hotel_slug = current_setting('app.current_hotel_slug', true)
  );

DROP POLICY IF EXISTS rls_audit_hotel ON audit_log;
CREATE POLICY rls_audit_hotel ON audit_log
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR hotel_slug = current_setting('app.current_hotel_slug', true)
  );

-- ============================================================================
-- 9. PURGA AUTOMÁTICA LFPDPPP (Cumplimiento de Privacidad y Retención Legal)
-- ============================================================================
CREATE OR REPLACE FUNCTION purge_expired_guest_pii(retention_days INTEGER DEFAULT 365)
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
  deleted_count INTEGER;
BEGIN
  DELETE FROM guests
  WHERE fecha_registro < NOW() - make_interval(days => retention_days);
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$;
