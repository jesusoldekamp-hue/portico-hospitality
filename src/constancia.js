/**
 * Generador de Constancia Oficial de Cumplimiento PUI (JSON + HTML imprimible a PDF)
 * con verificación criptográfica SHA-256 y métricas reales de entregas a SEGOB.
 */

import {
  countGuests,
  listAlerts,
  listAudit,
  listOutbox,
  verifyFullAuditChain
} from './db.js';

function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function construirDatosConstancia(hotel) {
  const alertasHotel = listAlerts({ hotelSlug: hotel.slug });
  const alertasActivas = alertasHotel.filter((a) => a.activa);
  const totalHuespedes = countGuests(hotel.slug);
  const eventosHotel = listAudit({ hotelSlug: hotel.slug, limit: 200 });
  const outboxHotel = listOutbox({ hotelSlug: hotel.slug, limit: 200 });
  const verificacionCadena = verifyFullAuditChain();

  const entregadosSegob = outboxHotel.filter((o) => o.estado === 'ENTREGADO').length;
  const pendientesSegob = outboxHotel.filter((o) => o.estado !== 'ENTREGADO').length;

  const fases = {
    fase1: eventosHotel.filter((e) => e.fase === 'FASE 1').length,
    fase2: eventosHotel.filter((e) => e.fase === 'FASE 2' || e.fase === 'FASE 2 CIERRE').length,
    fase3: eventosHotel.filter((e) => e.fase === 'FASE 3 ALERTA').length,
    protocoloMenores: eventosHotel.filter((e) => e.fase === 'PROTOCOLO MENORES LGT').length
  };

  const emitidaEn = new Date().toISOString();
  const folio = `PORTICO-PUI-${hotel.rfc.slice(0, 6)}-${emitidaEn.slice(0, 10).replace(/-/g, '')}`;

  return {
    folio,
    emitidaEn,
    plataforma: 'Hospitality PUI ID — Hospitality Trust & Compliance',
    asociacion: 'Asociación Mexicana de Hoteles de Nuevo León',
    marcoNormativo: [
      'Artículo 12 Bis y 43 Bis de la Ley General en Materia de Desaparición Forzada de Personas',
      'Manual Técnico de la Solución Tecnológica para Instituciones Diversas (DOF, 23/01/2026)',
      'Ley General de Turismo — Protocolo de verificación de parentesco de menores de edad'
    ],
    hotel: {
      nombre: hotel.nombre,
      grupo: hotel.grupo,
      rfc: hotel.rfc,
      ciudad: hotel.ciudad,
      habitaciones: hotel.habitaciones,
      pms: hotel.pms,
      modoIntegracion: hotel.modoIntegracion,
      llaveMxStatus: hotel.llaveMxStatus,
      segobMode: hotel.segobMode,
      estatus: hotel.estatus
    },
    endpointsDof: [
      { metodo: 'POST', ruta: `/api/pui/${hotel.slug}/login`, estado: 'ACTIVO (JWT HS256)' },
      { metodo: 'POST', ruta: `/api/pui/${hotel.slug}/activar-reporte`, estado: 'ACTIVO (Fases 1–3)' },
      { metodo: 'POST', ruta: `/api/pui/${hotel.slug}/activar-reporte-prueba`, estado: 'ACTIVO (Sandbox)' },
      { metodo: 'POST', ruta: `/api/pui/${hotel.slug}/desactivar-reporte`, estado: 'ACTIVO (Cierre Fase 3)' }
    ],
    metricas: {
      registrosHuespedesBoveda: totalHuespedes,
      alertasRecibidasTotal: alertasHotel.length,
      alertasFase3Activas: alertasActivas.length,
      notificacionesFase1: fases.fase1,
      barridosFase2: fases.fase2,
      alertasSilenciosasFase3: fases.fase3,
      entregasConfirmadasSegob: entregadosSegob,
      entregasEnColaReintento: pendientesSegob,
      revisionesProtocoloMenores: fases.protocoloMenores,
      eventosAuditadosHotel: eventosHotel.length
    },
    seguridad: {
      baseDatos: 'Relacional ACID (SQLite WAL / PostgreSQL RDS)',
      cifradoEnReposo: 'AES-256-GCM (CURPs, alertas y secretos)',
      autenticacionPui: 'JWT HS256 + scrypt + RBAC aislado por RFC',
      integridadCadenaBitacora: verificacionCadena.integra
        ? 'VERIFICADA (SIN ALTERACIONES)'
        : 'REVISAR',
      hashSelloActual: verificacionCadena.ultimoHash
    },
    ultimosEventos: eventosHotel.slice(0, 8).map((e) => ({
      seq: e.seq,
      timestamp: e.timestamp,
      direccion: e.direccion,
      endpoint: e.endpoint,
      fase: e.fase,
      resumen: e.resumen,
      hash: e.hash
    }))
  };
}

export function renderConstanciaHtml(datos) {
  const fechaLegible = new Intl.DateTimeFormat('es-MX', {
    dateStyle: 'long',
    timeStyle: 'medium'
  }).format(new Date(datos.emitidaEn));

  return `<!doctype html>
<html lang="es-MX">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Constancia PUI — ${escapeHtml(datos.hotel.nombre)} (${escapeHtml(datos.folio)})</title>
    <style>
      :root {
        --ink: #111d2e;
        --muted: #4b5868;
        --accent: #0d6858;
        --border: #d5dce3;
        --bg: #f4f6f8;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        background: var(--bg);
        color: var(--ink);
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
        line-height: 1.5;
      }
      .toolbar {
        max-width: 860px;
        margin: 1.25rem auto 0;
        padding: 0 1rem;
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 1rem;
      }
      .btn {
        background: var(--accent);
        color: #fff;
        border: none;
        border-radius: 6px;
        padding: 0.6rem 1.1rem;
        font-weight: 600;
        font-size: 0.9rem;
        cursor: pointer;
      }
      .btn-sec {
        background: #fff;
        color: var(--ink);
        border: 1px solid #bfc9d4;
        text-decoration: none;
        border-radius: 6px;
        padding: 0.56rem 0.95rem;
        font-weight: 600;
        font-size: 0.88rem;
      }
      .sheet {
        max-width: 860px;
        margin: 1rem auto 2.5rem;
        background: #fff;
        border: 1px solid var(--border);
        border-radius: 10px;
        padding: 2.25rem 2.5rem;
        box-shadow: 0 4px 20px rgb(17 29 46 / 0.06);
      }
      .doc-header {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        gap: 1.5rem;
        border-bottom: 2px solid var(--ink);
        padding-bottom: 1.1rem;
        margin-bottom: 1.4rem;
      }
      .doc-brand {
        font-size: 1.35rem;
        font-weight: 800;
        letter-spacing: -0.02em;
      }
      .doc-sub {
        font-size: 0.85rem;
        color: var(--muted);
      }
      .folio-box {
        text-align: right;
        font-size: 0.82rem;
        color: var(--muted);
      }
      .folio-box strong {
        display: block;
        color: var(--ink);
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 0.92rem;
      }
      h1 {
        font-size: 1.25rem;
        margin: 0 0 0.35rem;
        letter-spacing: -0.015em;
      }
      h2 {
        font-size: 0.96rem;
        margin: 1.45rem 0 0.6rem;
        padding-bottom: 0.3rem;
        border-bottom: 1px solid var(--border);
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--accent);
      }
      .lead {
        margin: 0;
        font-size: 0.9rem;
        color: var(--muted);
      }
      .meta-grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 0.65rem 1.5rem;
        font-size: 0.88rem;
      }
      .meta-row span {
        color: var(--muted);
        display: block;
        font-size: 0.76rem;
      }
      .meta-row strong {
        font-size: 0.92rem;
      }
      .kpi-row {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: 0.75rem;
        margin-top: 0.5rem;
      }
      .kpi {
        border: 1px solid var(--border);
        border-radius: 6px;
        padding: 0.7rem 0.8rem;
      }
      .kpi span {
        display: block;
        font-size: 0.75rem;
        color: var(--muted);
      }
      .kpi strong {
        font-size: 1.25rem;
        font-variant-numeric: tabular-nums;
      }
      table {
        width: 100%;
        border-collapse: collapse;
        font-size: 0.83rem;
      }
      th, td {
        text-align: left;
        padding: 0.5rem 0.6rem;
        border-bottom: 1px solid var(--border);
        vertical-align: top;
      }
      th {
        background: #f7f9fb;
        color: var(--muted);
        font-weight: 700;
      }
      code {
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 0.78rem;
      }
      .seal-box {
        margin-top: 1.2rem;
        padding: 0.9rem 1rem;
        border: 1px solid #b5ddd4;
        background: #eef8f5;
        border-radius: 6px;
        font-size: 0.82rem;
      }
      .seal-box code {
        display: block;
        margin-top: 0.35rem;
        word-break: break-all;
        color: #0b4a3f;
      }
      .doc-footer {
        margin-top: 1.5rem;
        padding-top: 0.9rem;
        border-top: 1px solid var(--border);
        font-size: 0.78rem;
        color: var(--muted);
        display: flex;
        justify-content: space-between;
        gap: 1rem;
      }
      @media print {
        body { background: #fff; }
        .toolbar { display: none; }
        .sheet {
          margin: 0;
          border: none;
          box-shadow: none;
          padding: 0;
          max-width: none;
        }
      }
    </style>
  </head>
  <body>
    <div class="toolbar">
      <a class="btn-sec" href="/">Volver a Hospitality PUI ID</a>
      <button type="button" class="btn" id="btn-print-doc">Imprimir / Guardar como PDF</button>
    </div>

    <main class="sheet">
      <div class="doc-header">
        <div>
          <div class="doc-brand">Hospitality PUI ID</div>
          <div class="doc-sub">Hospitality Trust &amp; Compliance · ${escapeHtml(datos.asociacion)}</div>
        </div>
        <div class="folio-box">
          Folio de Evidencia
          <strong>${escapeHtml(datos.folio)}</strong>
          <span>Emitida: ${escapeHtml(fechaLegible)}</span>
        </div>
      </div>

      <h1>Constancia Técnica de Interconexión y Cumplimiento PUI</h1>
      <p class="lead">
        Evidencia auditable generada por Hospitality PUI ID para acreditar operación continua, aislamiento por RFC, cola de entrega a SEGOB y cumplimiento técnico del Manual de Instituciones Diversas (DOF, 23 de enero de 2026).
      </p>

      <h2>1. Datos de la Institución Obligada</h2>
      <div class="meta-grid">
        <div class="meta-row"><span>Establecimiento</span><strong>${escapeHtml(datos.hotel.nombre)}</strong></div>
        <div class="meta-row"><span>RFC (Persona Moral)</span><strong><code>${escapeHtml(datos.hotel.rfc)}</code></strong></div>
        <div class="meta-row"><span>Grupo / Operador</span><strong>${escapeHtml(datos.hotel.grupo)}</strong></div>
        <div class="meta-row"><span>Ubicación / Inventario</span><strong>${escapeHtml(datos.hotel.ciudad)} · ${escapeHtml(datos.hotel.habitaciones)} habitaciones</strong></div>
        <div class="meta-row"><span>Sistema PMS / Integración</span><strong>${escapeHtml(datos.hotel.pms)} (${escapeHtml(datos.hotel.modoIntegracion)})</strong></div>
        <div class="meta-row"><span>Llave MX / Modo SEGOB</span><strong>${escapeHtml(datos.hotel.llaveMxStatus)} · ${escapeHtml(datos.hotel.segobMode)}</strong></div>
      </div>

      <h2>2. Resumen de Operación PUI y Entregas a SEGOB</h2>
      <div class="kpi-row">
        <div class="kpi"><span>Registros cifrados</span><strong>${datos.metricas.registrosHuespedesBoveda}</strong></div>
        <div class="kpi"><span>Alertas SEGOB</span><strong>${datos.metricas.alertasRecibidasTotal}</strong></div>
        <div class="kpi"><span>Entregas confirmadas</span><strong>${datos.metricas.entregasConfirmadasSegob}</strong></div>
        <div class="kpi"><span>Notificaciones Fase 3</span><strong>${datos.metricas.alertasSilenciosasFase3}</strong></div>
      </div>

      <h2>3. Endpoints Oficiales Habilitados (DOF)</h2>
      <table>
        <thead>
          <tr><th>Método</th><th>Ruta aislada por institución</th><th>Estatus</th></tr>
        </thead>
        <tbody>
          ${datos.endpointsDof
            .map(
              (ep) =>
                `<tr><td><code>${escapeHtml(ep.metodo)}</code></td><td><code>${escapeHtml(ep.ruta)}</code></td><td>${escapeHtml(ep.estado)}</td></tr>`
            )
            .join('')}
        </tbody>
      </table>

      <h2>4. Últimos Eventos de Bitácora Auditable</h2>
      <table>
        <thead>
          <tr><th>Seq</th><th>Fase</th><th>Endpoint</th><th>Resumen</th></tr>
        </thead>
        <tbody>
          ${
            datos.ultimosEventos.length
              ? datos.ultimosEventos
                  .map(
                    (ev) =>
                      `<tr><td>#${ev.seq}</td><td>${escapeHtml(ev.fase || ev.direccion)}</td><td><code>${escapeHtml(ev.endpoint)}</code></td><td>${escapeHtml(ev.resumen)}</td></tr>`
                  )
                  .join('')
              : '<tr><td colspan="4">Sin eventos recientes registrados para esta institución.</td></tr>'
          }
        </tbody>
      </table>

      <div class="seal-box">
        <strong>Integridad Criptográfica de Bitácora:</strong> ${escapeHtml(datos.seguridad.integridadCadenaBitacora)}
        · Cifrado en bóveda: ${escapeHtml(datos.seguridad.cifradoEnReposo)} · Control de acceso: ${escapeHtml(datos.seguridad.autenticacionPui)}
        <code>Sello SHA-256 vigente: ${escapeHtml(datos.seguridad.hashSelloActual)}</code>
      </div>

      <div class="doc-footer">
        <span>Documento generado automáticamente por Hospitality PUI ID (sin exponer datos personales sensibles).</span>
        <span>Art. 12 Bis y 43 Bis LGMDFP · Ley General de Turismo</span>
      </div>
    </main>

    <script src="/constancia-print.js" defer></script>
  </body>
</html>`;
}
