# Certeza ID — Checklist de Salida a Producción (Hotel #1 · 100% PUI SEGOB)

> Este checklist refleja exactamente lo que falta gestionar entre **tú, el hotel piloto, SEGOB/ATDT y tu técnico** para conectar el primer hotel al PUI oficial y empezar a operar y cobrar. También está integrado de forma interactiva dentro de la consola en la pestaña **Pendientes PUI**.

## 1. Trámites ante SEGOB / ATDT y datos del hotel (4 pasos)
- [ ] **Dar de alta al hotel en Llave MX con `e.firma` vigente** (`Tú + Hotel` · 15 min · \$0) — Registro oficial del RFC del hotel en https://www.plataformadebusqueda.gob.mx/inscripcion y designación de responsable técnico.
- [ ] **Recibir credenciales oficiales del entorno Sandbox ATDT** (`SEGOB / ATDT` · 1 a 3 días) — URL base oficial, usuario/contraseña PUI e IPs permitidas de Gobernación.
- [ ] **Definir método de conexión del PMS del hotel #1** (`Tú + Hotel` · 30 min) — Confirmar si se usará el agente local (Oracle OPERA / CSV / XML), webhook HTTPS directo o Mostrador Web.
- [ ] **Importar histórico de huéspedes disponible (hasta 12 años)** (`Hotel + Técnico` · 1 día) — Cargar la base histórica que tenga el hotel para responder Fases 1 y 2 del Manual Técnico PUI.

## 2. Infraestructura y seguridad en servidor real (5 pasos — Tu técnico)
- [ ] **Desplegar backend real en AWS con dominio HTTPS e IP fija** (`Técnico` · 1 a 2 días) — Subir `src/server.js` fuera de la demo estática con `TLS 1.2+`, `HSTS` e IP fija saliente (NAT Gateway) para lista blanca de SEGOB.
- [ ] **Conectar PostgreSQL 16 + aislamiento RLS por RFC** (`Técnico` · 1 a 2 días) — Sustituir SQLite de pruebas (`src/db.js`) por `pg.Pool` con `sql/schema.postgres.sql`, `FORCE ROW LEVEL SECURITY` y worker Outbox `FOR UPDATE SKIP LOCKED`.
- [ ] **Migrar secretos y cifrado AES-256-GCM a AWS KMS** (`Técnico` · 1 día) — Eliminar fallbacks de desarrollo en `src/security.js`, activar arranque `fail-fast` y cifrar llaves por hotel en AWS Secrets Manager / KMS.
- [ ] **Activar Redis rate limit, 2FA/TOTP y lista blanca WAF** (`Técnico` · 1 día) — Migrar `src/rateLimit.js` a Redis, activar 2FA en administradores y restringir `/api/pui/*` solo a IPs oficiales de SEGOB con AWS WAF.
- [ ] **Endurecer agente PMS y generar reporte SAST / DAST / SCA** (`Técnico` · 1 día) — Forzar HTTPS estricto + borrado seguro en `agent/pms-sync-agent.js` y emitir el reporte de vulnerabilidades exigido por el Anexo 2 DOF.

## 3. Certificación oficial y arranque comercial (2 pasos)
- [ ] **Aprobar pruebas oficiales en Sandbox (`/activar-reporte-prueba`)** (`Técnico + SEGOB` · 1 día) — Validar JWT, barrido histórico Fases 1–2, monitoreo silencioso Fase 3 y acuse real `200 OK` en la cola Outbox.
- [ ] **Activar `SEGOB_PRODUCCION` y entregar Constancia Oficial PDF** (`Tú + Hotel` · 30 min) — Cargar credenciales productivas en la pestaña *Conexión SEGOB*, entregar la Constancia PDF con sello `SHA-256` e iniciar operación comercial.
