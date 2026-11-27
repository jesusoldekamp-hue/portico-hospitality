# Certeza ID — Arquitectura Técnica, Flujo Criptográfico y Threat Model (Engineering Spec)

Documento de referencia técnica basado estrictamente en el código implementado en el repositorio (`src/`, `agent/`, `sql/`, `test/pui.test.js` — `9/9` pruebas unitarias/integración pasando sobre Node.js ESM nativo con **cero dependencias npm externas**).

---

## 1. Topología del Sistema y Fronteras de Confianza (Trust Boundaries)

```mermaid
flowchart TB
    subgraph EDGE["1. Hotel Premises / Untrusted Edge"]
        PMS_CLOUD["Cloud PMS: OPERA Cloud OHIP, Cloudbeds, Mews"]
        PMS_LOCAL["On-Prem / Legacy PMS: OPERA 5 XML, Zeus, Fidelio, FoxPro, DOS .PRN"]
        AGENT["Local Sync Agent: agent/pms-sync-agent.js (15s poll, UTF-8/Latin-1 auto-detect)"]
        DESK["Front-Desk UI: Browser / Tablet (Role: RECEPCION)"]
        ADMIN_UI["Admin Console: HOTEL_ADMIN / ASOCIACION_ADMIN"]
        PMS_LOCAL --> AGENT
    end

    subgraph CORE["2. Certeza ID Core Runtime (src/server.js - Zero-Dep Node.js >=20 ESM)"]
        GUARD["Ingress Guard: rateLimit.js (120/300 rpm), 1 MiB cap, CSP script-src self, X-Frame DENY"]
        AUTH_WEB["Web AuthN/AuthZ: HttpOnly Cookie -> sessions(token_hash) -> RBAC canAccessHotel()"]
        AUTH_PMS["PMS AuthN: X-Portico-PMS-Key (per-hotel secret)"]
        AUTH_PUI["SEGOB M2M AuthN: POST /login (scrypt + timingSafeEqual) -> JWT HS256 scoped by hotelSlug+rfc"]

        PARSER["Ingestion & Identity: src/csv.js (XML/CSV/Pipe/PRN) + src/curp.js (RENAPO mod-10) + src/mrz.js (ICAO 9303)"]
        LGT["Minor Compliance Engine: Art. 58 LGT age < 18 check + mandatory kinship/tutelage state"]
        CRYPTO["Crypto Primitives (src/security.js - node:crypto): Blind-Index HMAC-SHA256 + AES-256-GCM + Audit SHA-256 Chain"]
        MATCH["Phase 1-3 Matcher: O(log n) lookup on (hotel_slug, curp_hash) - Non-Interference Isolation"]
        OUTBOX_W["Async Delivery Worker: src/puiClient.js (5s tick, JWT cache 30s skew, exp backoff, max 8 retries)"]

        GUARD --> AUTH_WEB
        GUARD --> AUTH_PMS
        GUARD --> AUTH_PUI
        AUTH_WEB --> PARSER
        AUTH_PMS --> PARSER
        PARSER --> LGT
        PARSER --> CRYPTO
        CRYPTO --> MATCH
        AUTH_PUI --> CRYPTO
        MATCH --> OUTBOX_W
    end

    subgraph DATA["3. Multi-Tenant Persistence Layer (src/db.js <-> src/db-adapter.js + sql/schema.postgres.sql)"]
        SQLITE["Current Pilot Engine: node:sqlite (DatabaseSync, WAL mode, FK ON)"]
        PG["Target Prod Engine: AWS RDS PostgreSQL 16 Multi-AZ + RLS (app.current_hotel_slug) + pg_partman"]
        TABLES["Tables: associations, hotels, users, sessions, pui_alerts, guests, segob_outbox, audit_log"]
        SQLITE -. "1:1 Schema Parity" .-> PG
        SQLITE --- TABLES
        PG --- TABLES
    end

    subgraph GOV["4. SEGOB / RENAPO / ATDT Boundary (Anexo 2 DOF 23/01/2026)"]
        SEGOB_IN["SEGOB Inbound Calls: /api/pui/:slug/(login|activar-reporte|activar-reporte-prueba|desactivar-reporte)"]
        SEGOB_OUT["SEGOB Outbound Callback: POST /notificar-coincidencia (Bearer JWT, TLS 1.2+)"]
    end

    PMS_CLOUD -- "HTTPS POST /api/pms/:slug/checkin" --> GUARD
    AGENT -- "HTTPS POST /api/pms/:slug/import-csv" --> GUARD
    DESK -- "Cookie Auth (No Read on pui_alerts)" --> GUARD
    ADMIN_UI -- "Cookie Auth (RBAC Scoped)" --> GUARD

    SEGOB_IN -- "Bearer JWT (Scoped to RFC)" --> GUARD
    OUTBOX_W -- "HTTPS POST + Exponential Backoff" --> SEGOB_OUT

    LGT --> SQLITE
    MATCH --> SQLITE
    OUTBOX_W --> SQLITE
```

---

## 2. Flujo de Secuencia A — Activación Entrante de SEGOB (Fases 1, 2 Histórica 12 Años y Armado Fase 3)

```mermaid
sequenceDiagram
    autonumber
    participant S as SEGOB / PUI (ATDT)
    participant API as src/server.js (Anexo 2 Router)
    participant SEC as src/security.js (node:crypto)
    participant DB as DB Vault (hotel_slug / RFC)
    participant OB as src/puiClient.js (Outbox Worker)

    S->>API: POST /api/pui/:slug/login {usuario, password}
    API->>SEC: verifyPassword(pass, hotel.clavePuiHash) [scrypt 64B + timingSafeEqual]
    SEC-->>API: valid = true
    API->>SEC: firmarJwt({sub, hotelSlug, rfc, scope}, 3600s) [HS256]
    API->>DB: appendAudit(AUTH JWT, SHA-256 chain)
    API-->>S: 200 OK {token, token_type: Bearer, expires_in: 3600}

    S->>API: POST /api/pui/:slug/activar-reporte (Bearer JWT) {id, curp, fecha_desaparicion}
    API->>SEC: verificarJwt(token) + assert(payload.hotelSlug === :slug)
    API->>SEC: validarCurp(curp) [RENAPO regex + check digit]
    API->>SEC: curpHash = HMAC-SHA256(VAULT_KEY, "slug::CURP")
    API->>SEC: curpCipher = AES-256-GCM(VAULT_KEY, 12B IV, CURP)

    Note over API,DB: Arm Fase 3 continuous monitoring + execute Fase 1/2 historical scan
    API->>DB: upsertAlert(hotel_slug, reporte_id, curpHash, curpCipher, activa=1)
    API->>DB: findGuestsByCurpHash(hotel_slug, curpHash) [Index: idx_guests_lookup]

    alt Historical Match Found (Fase 1 & Fase 2 <= 12 years)
        API->>DB: enqueueSegobNotification(FASE 1 + FASE 2 payloads -> segob_outbox)
        API->>DB: incrementAlertMatches(hotel_slug, reporte_id)
    else No Historical Match
        API->>DB: enqueueSegobNotification(FASE 2 negative closure -> segob_outbox)
    end

    API->>DB: appendAudit(FASE 1-3 ACTIVADA, SHA-256 chain)
    API-->>S: 200 OK {fase_1, fase_2, fase_3: MONITOREANDO}

    loop Async Worker (5s tick / immediate trigger)
        OB->>DB: listDueOutboxJobs() [estado IN (PENDIENTE, REINTENTANDO)]
        OB->>S: POST /login (cached JWT, 30s skew) -> POST /notificar-coincidencia
        alt HTTP 2xx
            OB->>DB: markOutboxDelivered(httpStatus, acuseSegob, latenciaMs)
        else HTTP 401 / 5xx / Timeout (10s)
            OB->>DB: markOutboxRetry(backoff, reset tokenCache on 401, max 8 attempts)
        end
    end
```

---

## 3. Flujo de Secuencia B — Check-in en Tiempo Real, Propiedad de No-Interferencia (Sigilo) y Art. 58 LGT

```mermaid
sequenceDiagram
    autonumber
    participant FD as Reception UI / PMS Agent
    participant API as src/server.js (/api/pms/:slug/checkin)
    participant ID as curp.js / mrz.js / security.js
    participant DB as DB Vault (hotel_slug)
    participant OB as segob_outbox -> SEGOB

    FD->>API: POST checkin {nombre, curp | mrz, habitacion, parentescoDocumento}
    API->>ID: Validate RENAPO CURP or ICAO 9303 MRZ ($0) + compute exact age

    alt Guest Age < 18 AND parentescoDocumento missing or NO_ACREDITO
        Note over API,FD: Art. 58 Ley General de Turismo Enforcement
        API->>DB: Record minor verification / denial event (audit_log)
        API-->>FD: Block room assignment + trigger LGT protocol notice
    end

    API->>ID: curpHash = HMAC-SHA256(VAULT_KEY, "slug::ID")
    API->>ID: curpCipher = AES-256-GCM(VAULT_KEY, 12B IV, ID)
    API->>DB: insertGuest(hotel_slug, curpHash, curpCipher, maskedId, lgtStatus)

    Note over API,OB: STRICT NON-INTERFERENCE BOUNDARY (Front Desk never sees alert result)
    API->>DB: findActiveMatchingAlerts(hotel_slug, curpHash) [idx_pui_alerts_lookup]

    opt Active PUI Alert Match (Fase 3)
        API->>DB: enqueueSegobNotification(FASE 3, prioridad=CRITICA_MENOR|ALTA)
        API->>DB: appendAudit(HOTEL -> SEGOB, critico=true, SHA-256 chain)
        API->>OB: procesarColaOutbox() -> Silent HTTPS delivery to SEGOB
    end

    API-->>FD: 201 Created {guestId, maskedId, lgtStatus} -- ZERO PUI alert fields leaked
```

---

## 4. Diseño Criptográfico y Modelo de Datos (Qué está cifrado vs. indexado)

| Entidad / Campo | Primitiva Real (`src/security.js`) | Propósito / Propiedad de Seguridad |
| :--- | :--- | :--- |
| `users.password_hash` / `hotels.clave_pui_hash` | `scrypt` (`64 B` output, `16 B` random salt) + `timingSafeEqual` | Resistente a fuerza bruta en GPU/ASIC y ataques de canal lateral por tiempo. |
| `sessions.token_hash` | `SHA-256` sobre token CSPRNG de `256 bits` (`randomBytes(32)`) | Un dump de la tabla `sessions` no permite secuestrar sesiones activas. |
| `guests.curp_hash` / `pui_alerts.curp_hash` | **Blind Index:** `HMAC-SHA256(VAULT_KEY, "${hotelSlug}::${curp}")` | Permite lookups exactos `O(log n)` sin almacenar CURP en texto plano y **rompe correlación entre distintos hoteles (RFCs)**. |
| `guests.curp_cifrada_json` / `pui_alerts.curp_cifrada_json` / `hotels.segob_clave_cifrada_json` | `AES-256-GCM` (`12 B` random IV + `16 B` auth tag) | Confidencialidad + integridad autenticada (AEAD) en reposo. |
| `audit_log.hash` | Cadena `SHA-256(prevHash \| JSON(record))` | Evidencia forense tamper-evident verificable con `verifyFullAuditChain()`. |
| Aislamiento Multi-Tenant (`sql/schema.postgres.sql`) | PostgreSQL 16 `ENABLE ROW LEVEL SECURITY` sobre `pui_alerts`, `guests`, `segob_outbox`, `audit_log` | Política `hotel_slug = current_setting('app.current_hotel_slug', true)` fijada con `SET LOCAL` por transacción en `withHotelRlsTransaction()`. |

---

## 5. Threat Model y Backlog Priorizado de Hardening (Lo que falta antes de PII real)

Diagnóstico directo de ingeniería sobre el código actual — **0 humo, brechas exactas con archivo y línea**:

### P0 — Bloqueantes antes del primer huésped real
1. **Envelope Encryption y eliminación de fallbacks dev (`src/security.js:11-14`):**
   - *Hallazgo actual:* `PUI_JWT_SECRET` y `PUI_VAULT_KEY` caen a strings hardcodeados si faltan env vars, y `VAULT_KEY` es única para todos los tenants.
   - *Fix requerido:* Fail-fast al arranque si `NODE_ENV=production` carece de secretos; integrar **AWS KMS** con **DEK por hotel** (cifrado de sobre) + columna `key_version` para rotación sin invalidar blind indexes `HMAC-SHA256`, y deshabilitar `isDemoModeEnabled()` + endpoints `/api/demo/*` en producción.
2. **Migración efectiva de `src/db.js` (SQLite) a `pg.Pool` + `FORCE ROW LEVEL SECURITY` + `SKIP LOCKED`:**
   - *Hallazgo actual:* `src/db.js` opera sobre `node:sqlite` (single-node); `src/db-adapter.js` define el wrapper transaccional RLS pero los queries aún no están cableados al driver `pg`.
   - *Fix requerido:* Cablear repositorio async sobre `pg.Pool` con rol no-superuser (`NOBYPASSRLS`) + `ALTER TABLE ... FORCE ROW LEVEL SECURITY`, usar `SELECT ... FOR UPDATE SKIP LOCKED` en `segob_outbox` para múltiples réplicas ECS/Fargate, y habilitar `pg_partman` mensual sobre `guests(fecha_registro)`.
3. **Aislamiento de red M2M y TLS estricto:**
   - *Fix requerido:* Terminación TLS 1.2+/1.3 con `Strict-Transport-Security`, **AWS WAF + IP Allowlist** (y mTLS si ATDT lo soporta) exclusivo para `/api/pui/*`.
4. **Hardening Web / AuthN:**
   - *Hallazgo actual:* `src/rateLimit.js` usa un `Map` en memoria de proceso; no hay MFA/2FA ni validación CSRF explícita para mutaciones autenticadas por cookie; la CSP en `src/server.js:92` bloquea fuentes externas si se sirve desde Node.
   - *Fix requerido:* Mover rate-limiting a **Redis** (sliding window atómico), exigir **TOTP MFA + account lockout** en `ASOCIACION_ADMIN` / `HOTEL_ADMIN`, agregar verificación `Origin` + CSRF token, y alojar tipografías localmente en `public/assets/fonts/`.
5. **Hardening del Agente Local en PC de Recepción (`agent/pms-sync-agent.js`):**
   - *Hallazgo actual:* Permite `http://` por defecto (`line 139`) y mueve los CSV/XML originales con CURPs en texto plano a `processed/` y `failed/` (`lines 99–111`).
   - *Fix requerido:* Exigir `https://` obligatorio con verificación TLS estricta en producción, borrado seguro (`unlink` / shred) tras confirmación HTTP `200` (o retención cifrada breve) para no dejar PII en claro en discos de mostrador, y rotación automática de `X-Portico-PMS-Key`.

### P1 — Certificación ATDT (Sección 8) y Validación de Fuentes
6. **Validación exacta de contrato contra Sandbox real ATDT (`SG_230126_VES_02.pdf`):** Confirmar payload exacto, HTTP codes, JWT signing algorithm (`HS256` vs `RS256` / JWKS si lo requiere ATDT) y URLs reales de callback en `/activar-reporte-prueba`.
7. **Verificación de autenticidad RFC / CURP:** Validar cadena X.509 de certificado público `.cer` del SAT (o QR de Constancia de Situación Fiscal) al registrar cada hotel, más adaptador opcional de consulta en vivo a **RENAPO / Lista Nominal INE** para clientes que soliciten validación Nivel 3.
8. **Pipeline Sección 8 + LFPDPPP:** Integrar **SAST** (Semgrep/CodeQL), **DAST** (OWASP ZAP) y **SCA** (Trivy sobre imagen Docker) en CI/CD con gate cero críticos/altos, y formalizar contrato de Encargado de Tratamiento de Datos (LFPDPPP) con cada hotel.
