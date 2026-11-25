# Hospitality PUI ID — Hospitality Trust & Compliance

Plataforma multi-hotel propiedad de la Asociación para el cumplimiento federal de la **Plataforma Única de Identidad (PUI — SEGOB / RENAPO)** conforme al **Manual Técnico de Instituciones Diversas (DOF, 23 de enero de 2026)** y el protocolo de protección de menores de la **Ley General de Turismo**.

- **Demo ejecutiva en vivo 24/7 (GitHub Pages):** https://jesusoldekamp-hue.github.io/portico-hospitality/
- **Presentación ejecutiva interactiva:** https://jesusoldekamp-hue.github.io/portico-hospitality/presentacion.html
- **Cero dependencias externas de npm** en el núcleo del servidor (`node:http`, `node:crypto`, `node:sqlite`).

## Capacidades principales

1. **Núcleo DOF Multi-RFC:** Endpoints aislados por hotel (`/login` JWT HS256, `/activar-reporte`, `/activar-reporte-prueba`, `/desactivar-reporte`) con ejecución automática de **Fases 1, 2 y 3** y **sigilo estricto** en recepción.
2. **Base de datos relacional ACID + Cifrado en reposo:** `node:sqlite` (modo WAL) embebido + esquema equivalente para **AWS RDS PostgreSQL 16** ([sql/schema.postgres.sql](sql/schema.postgres.sql)). CURPs, alertas y secretos SEGOB cifrados con **AES-256-GCM**.
3. **Autenticación y RBAC real:** Roles `ASOCIACION_ADMIN`, `HOTEL_ADMIN` (aislado a su propio RFC) y `RECEPCION` (solo mostrador, sin visibilidad de alertas SEGOB) con contraseñas `scrypt` y cookies `HttpOnly`.
4. **Cola Outbox hacia SEGOB con reintentos exponenciales:** Garantiza entrega de `/notificar-coincidencia` y `/busqueda-finalizada` en modo `SANDBOX_SIMULADO`, `SEGOB_SANDBOX` o `SEGOB_PRODUCCION`.
5. **Integración Multi-PMS:** API/Webhook (`X-Portico-PMS-Key`), importador masivo CSV con validador oficial de dígito verificador RENAPO y agente local independiente para OPERA On-Premise / Zeus ([agent/pms-sync-agent.js](agent/pms-sync-agent.js)).
6. **Constancias Oficiales PDF:** Generación por hotel con verificación íntegra de cadena criptográfica **SHA-256**.

## Arranque local (Node.js >= 22.5 / 24+)

```bash
npm test   # Ejecuta suite de pruebas (CURP, RBAC, PUI DOF, Outbox mock SEGOB y Agente PMS)
npm start  # Inicia servidor en http://localhost:3080
```

## Agente Local para PMS On-Premise (OPERA 5 / Zeus)

```bash
node agent/pms-sync-agent.js \
  --dir ./exports-opera \
  --hotel crowne-plaza-monterrey \
  --key <X-Portico-PMS-Key> \
  --url https://tu-servidor-portico
```

## Despliegue en Producción (AWS)

Consulta [DEPLOY_AWS.md](DEPLOY_AWS.md) para desplegar con Docker / AWS RDS PostgreSQL + HTTPS TLS 1.3 + WAF en la cuenta oficial de la Asociación.
