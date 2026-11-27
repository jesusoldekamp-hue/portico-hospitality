# Certeza ID — Arquitectura Técnica, Seguridad Criptográfica y Plan de Producción

Documento de ingeniería en español basado exactamente en el código implementado en `src/`, `agent/` y `sql/` (Node.js >=20 ESM nativo, **cero dependencias npm externas**, `9/9` pruebas pasando en `test/pui.test.js`).

---

## 1. Mapa de Arquitectura y Fronteras de Seguridad

```mermaid
flowchart TB
    subgraph CAPA1["Capa 1. Entrada desde hoteles (sin tocar su base de datos)"]
        PMS_NUBE["PMS en la nube: OPERA Cloud, Cloudbeds, Mews"]
        PMS_LOCAL["PMS local o arcaico: OPERA 5 XML, Zeus, Fidelio, FoxPro, impresión .prn"]
        AGENTE["Agente local: agent/pms-sync-agent.js (revisa cada 15 s, detecta UTF-8 / Latin-1)"]
        MOSTRADOR["Terminal de recepción (Rol RECEPCION - cero alertas PUI)"]
        CONSOLA["Consola Admin / TI (aislada por RFC)"]
        PMS_LOCAL --> AGENTE
    end

    subgraph CAPA2["Capa 2. Servidor central Certeza ID (src/server.js - Node.js nativo)"]
        ENTRADA["Control de entrada: rateLimit.js, tope 1 MB, CSP estricta, X-Frame DENY"]
        AUTH_WEB["Sesiones web: cookie HttpOnly -> sessions(token_hash) -> RBAC por hotel"]
        AUTH_PMS["Acceso PMS: cabecera X-Portico-PMS-Key única por hotel"]
        AUTH_PUI["Acceso SEGOB: POST /login (scrypt) -> JWT HS256 limitado a ese hotel y RFC"]

        LECTURA["Lectura e identidad: csv.js (XML/CSV/barras/.prn) + curp.js + mrz.js ($0)"]
        MENORES["Filtro Art. 58 Ley de Turismo: detecta menor de 18 años y exige parentesco/tutela"]
        CRIPTO["Cifrado (src/security.js): índice ciego HMAC-SHA256 + AES-256-GCM + cadena SHA-256"]
        CRUCE["Motor PUI (Fases 1 a 3): cruce por índice ciego con sigilo total en mostrador"]
        OUTBOX["Cola de envío (src/puiClient.js): revisión cada 5 s, caché JWT y hasta 8 reintentos"]

        ENTRADA --> AUTH_WEB
        ENTRADA --> AUTH_PMS
        ENTRADA --> AUTH_PUI
        AUTH_WEB --> LECTURA
        AUTH_PMS --> LECTURA
        LECTURA --> MENORES
        LECTURA --> CRIPTO
        CRIPTO --> CRUCE
        AUTH_PUI --> CRIPTO
        CRUCE --> OUTBOX
    end

    subgraph CAPA3["Capa 3. Base de datos aislada por hotel (db.js y schema.postgres.sql)"]
        SQLITE["Piloto actual: SQLite nativo (modo WAL, sin servidor extra)"]
        PG["Producción objetivo: AWS RDS PostgreSQL 16 + RLS por RFC + partición mensual"]
        TABLAS["Tablas: associations, hotels, users, sessions, pui_alerts, guests, segob_outbox, audit_log"]
        SQLITE -. "Mismo esquema 1:1" .-> PG
        SQLITE --- TABLAS
        PG --- TABLAS
    end

    subgraph CAPA4["Capa 4. Conexión oficial SEGOB / ATDT (Anexo 2 DOF 23/01/2026)"]
        SEGOB_IN["Llamadas entrantes: /api/pui/:slug/(login|activar-reporte|activar-reporte-prueba|desactivar-reporte)"]
        SEGOB_OUT["Avisos salientes: POST /notificar-coincidencia (Bearer JWT, TLS 1.2+)"]
    end

    PMS_NUBE -- "HTTPS POST /api/pms/:slug/checkin" --> ENTRADA
    AGENTE -- "HTTPS POST /api/pms/:slug/import-csv" --> ENTRADA
    MOSTRADOR -- "Cookie HttpOnly" --> ENTRADA
    CONSOLA -- "Cookie HttpOnly" --> ENTRADA

    SEGOB_IN -- "Bearer JWT por RFC" --> ENTRADA
    OUTBOX -- "HTTPS POST con reintentos" --> SEGOB_OUT

    MENORES --> SQLITE
    CRUCE --> SQLITE
    OUTBOX --> SQLITE
```

---

## 2. Flujo A — Cuando SEGOB envía un reporte (Fases 1, 2 histórica y 3 en vivo)

```mermaid
sequenceDiagram
    autonumber
    participant S as SEGOB / ATDT
    participant API as src/server.js (Rutas Anexo 2)
    participant SEC as src/security.js
    participant DB as Bóveda del hotel (RFC)
    participant OB as src/puiClient.js (Cola Outbox)

    S->>API: POST /api/pui/:slug/login {usuario, password}
    API->>SEC: Valida clave con scrypt + comparación en tiempo constante
    API->>SEC: Emite JWT HS256 (1 hora) acotado a hotelSlug y RFC
    API->>DB: Registra evento en audit_log (cadena SHA-256)
    API-->>S: 200 OK {token, Bearer, expires_in: 3600}

    S->>API: POST /api/pui/:slug/activar-reporte (Bearer JWT) {id, curp}
    API->>SEC: Verifica firma JWT y comprueba que pertenece exactamente a ese hotel
    API->>SEC: Valida CURP RENAPO, calcula índice ciego HMAC-SHA256 y cifra en AES-256-GCM
    API->>DB: Activa vigilancia Fase 3 en pui_alerts y busca histórico (hasta 12 años) en guests

    alt Existe coincidencia histórica (Fases 1 y 2)
        API->>DB: Encola reporte positivo de Fases 1 y 2 en segob_outbox
    else Sin coincidencias previas
        API->>DB: Encola cierre negativo de Fase 2 en segob_outbox
    end

    API-->>S: 200 OK {fase_1, fase_2, fase_3: MONITOREANDO}

    loop Proceso asíncrono cada 5 segundos
        OB->>DB: Toma trabajos pendientes o en reintento
        OB->>S: Autentica (caché JWT) y envía POST /notificar-coincidencia
        alt HTTP 2xx
            OB->>DB: Marca entregado y guarda acuse y latencia
        else Error 401 / 5xx / timeout
            OB->>DB: Programa reintento con espera progresiva (máximo 8 intentos)
        end
    end
```

---

## 3. Flujo B — Cuando llega un huésped (Check-in, menores y sigilo en mostrador)

```mermaid
sequenceDiagram
    autonumber
    participant REC as Recepción o Agente PMS
    participant API as src/server.js (/api/pms/:slug/checkin)
    participant VAL as curp.js / mrz.js / security.js
    participant DB as Bóveda del hotel (RFC)
    participant OB as segob_outbox -> SEGOB

    REC->>API: Envía check-in (CURP o Pasaporte MRZ, habitación, parentesco)
    API->>VAL: Valida CURP RENAPO o Pasaporte ($0) y calcula edad exacta

    alt Menor de 18 años sin documento de parentesco o tutela
        API->>DB: Registra bloqueo conforme al Art. 58 de la Ley General de Turismo
        API-->>REC: Detiene asignación de habitación y pide acreditar parentesco
    end

    API->>VAL: Calcula índice ciego HMAC-SHA256 y cifra documento en AES-256-GCM
    API->>DB: Guarda huésped en guests (solo texto enmascarado en vistas)

    Note over API,OB: Frontera estricta de sigilo: recepción nunca conoce el resultado PUI
    API->>DB: Busca coincidencias activas en pui_alerts usando índice ciego

    opt Coincidencia con reporte activo (Fase 3)
        API->>DB: Encola aviso silencioso (prioridad crítica si es menor) y sella audit_log
        API->>OB: Dispara entrega inmediata cifrada hacia SEGOB
    end

    API-->>REC: 201 Created (respuesta normal de check-in, cero datos de alertas SEGOB)
```

---

## 4. Lista de Endurecimiento Obligatorio Antes de Producción Real

### Prioridad 1 (bloqueantes antes del primer huésped real)
1. **Quitar llaves de prueba y usar AWS KMS (`src/security.js:11-14`):** hacer que el servidor falle al arrancar si faltan secretos en producción, usar **AWS KMS con una clave de datos por hotel** (con `key_version` para rotar sin romper búsquedas `HMAC-SHA256`) y apagar `PORTICO_DEMO_MODE` y las rutas `/api/demo/*`.
2. **Conectar PostgreSQL 16 real + RLS + `SKIP LOCKED`:** migrar los queries de `src/db.js` (SQLite) al driver real `pg` en AWS RDS usando un rol `NOBYPASSRLS` + `FORCE ROW LEVEL SECURITY`, aplicar `SELECT ... FOR UPDATE SKIP LOCKED` en `segob_outbox` para múltiples réplicas y activar particionamiento mensual (`pg_partman`) en `guests`.
3. **Blindaje de red exclusivo para SEGOB:** TLS 1.2+/1.3 obligatorio con cabecera `Strict-Transport-Security`, **AWS WAF + lista blanca de IPs de SEGOB/ATDT** (y mTLS si la autoridad lo soporta) en `/api/pui/*`.
4. **Acceso seguro, 2FA, CSRF y límite en Redis:** mover `src/rateLimit.js` a **Redis**, exigir **doble factor (2FA / TOTP) y bloqueo por intentos fallidos** en cuentas `ASOCIACION_ADMIN` y `HOTEL_ADMIN`, agregar validación de origen + token CSRF en acciones con cookie y servir las fuentes localmente.
5. **Endurecer el agente local (`agent/pms-sync-agent.js`):** exigir `https://` con verificación estricta de certificado (eliminar `http://` por defecto), borrar de forma segura los CSV/XML procesados tras recibir HTTP `200` (cero CURPs en texto plano en la PC de recepción) y rotar llaves PMS periódicamente.
6. **Validar contrato real en Sandbox ATDT (`SG_230126_VES_02.pdf`):** confirmar nombres exactos de campos, códigos HTTP, algoritmo JWT (`HS256` vs `RS256`) y URLs reales de callback al activar el primer hotel piloto con Llave MX y e.firma.

### Siguientes mejoras recomendadas
7. **Autenticidad de RFC (SAT):** validar certificado público `.cer` del SAT o QR de Constancia de Situación Fiscal al dar de alta cada hotel real.
8. **Consulta opcional RENAPO / INE (Nivel 3):** adaptador desacoplado para hoteles que soliciten verificar vigencia y titularidad oficial de la CURP en vivo.
9. **Auditoría Sección 8 y LFPDPPP:** correr escaneo formal SAST, DAST y SCA en CI/CD (cero hallazgos críticos/altos) y formalizar contrato de Encargado de Tratamiento de Datos con cada hotel.
