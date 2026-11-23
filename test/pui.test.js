import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Base SQLite en memoria aislada para pruebas rápidas y limpias
process.env.PORTICO_DB_PATH = ':memory:';

const { validarCurp, completarCurpValida } = await import('../src/curp.js');
const { generarPlantillaCsvDemo } = await import('../src/csv.js');
const { createServer } = await import('../src/server.js');
const { resetDb, closeDb, getHotelBySlug, DEMO_SCENARIOS } = await import('../src/db.js');
const { syncDirectoryOnce } = await import('../agent/pms-sync-agent.js');

async function loginAs(baseUrl, email, password = 'PorticoDemo#2026') {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password })
  });
  assert.equal(res.status, 200, `Login falló para ${email}`);
  const setCookie = res.headers.get('set-cookie') || '';
  const cookie = setCookie.split(';')[0];
  assert.ok(cookie.startsWith('portico_session='));
  return cookie;
}

describe('Validador oficial CURP RENAPO', () => {
  it('acepta CURPs válidas con dígito verificador correcto y detecta menor de edad', () => {
    const curpMenor = DEMO_SCENARIOS.menorEnTiempoReal.curp;
    const res = validarCurp(curpMenor);
    assert.equal(res.valida, true);
    assert.equal(res.esMenor, true);
    assert.equal(res.codigoEntidad, 'NL');
    assert.equal(res.entidad, 'Nuevo León');
  });

  it('rechaza CURPs con dígito verificador alterado', () => {
    const curp = completarCurpValida('TEGC850910HNLVRN0');
    const lastDigit = curp[17] === '9' ? '0' : String(Number(curp[17]) + 1);
    const res = validarCurp(curp.slice(0, 17) + lastDigit);
    assert.equal(res.valida, false);
  });
});

describe('Portico Hospitality Producción — SQLite ACID, RBAC, PUI DOF, Outbox HTTP real y Agente PMS', () => {
  let server;
  let baseUrl;

  before(async () => {
    resetDb();
    server = createServer({ enableWorker: false });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    baseUrl = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    closeDb();
  });

  it('protege /api/state y aplica aislamiento RBAC estricto para RECEPCION y HOTEL_ADMIN', async () => {
    // Sin sesión → 401
    const unauth = await fetch(`${baseUrl}/api/state`);
    assert.equal(unauth.status, 401);

    // Login como RECEPCION de Crowne Plaza
    const recCookie = await loginAs(baseUrl, 'recepcion@crowneplazamty.mx');
    const recState = await (
      await fetch(`${baseUrl}/api/state`, { headers: { Cookie: recCookie } })
    ).json();
    assert.equal(recState.hotels.length, 1);
    assert.equal(recState.hotels[0].slug, 'crowne-plaza-monterrey');
    assert.equal(recState.hotels[0].pmsApiKey, undefined); // Sin llave expuesta a mostrador
    assert.equal(recState.alerts.length, 0);
    assert.equal(recState.auditLog.length, 0);

    // Recepción NO puede leer outbox ni emitir constancia ni crear hoteles (HTTP 403)
    assert.equal(
      (await fetch(`${baseUrl}/api/outbox`, { headers: { Cookie: recCookie } })).status,
      403
    );
    assert.equal(
      (
        await fetch(`${baseUrl}/api/hotels/crowne-plaza-monterrey/constancia`, {
          headers: { Cookie: recCookie }
        })
      ).status,
      403
    );
    assert.equal(
      (
        await fetch(`${baseUrl}/api/hotels`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Cookie: recCookie },
          body: JSON.stringify({ nombre: 'Hotel Intruso', rfc: 'HIN010101NL1' })
        })
      ).status,
      403
    );

    // Login como HOTEL_ADMIN de Hoteles Safi → NO puede ver constancia ni config de Crowne Plaza
    const safiCookie = await loginAs(baseUrl, 'ti@safihotels.mx');
    assert.equal(
      (
        await fetch(`${baseUrl}/api/hotels/crowne-plaza-monterrey/constancia`, {
          headers: { Cookie: safiCookie }
        })
      ).status,
      403
    );
    assert.equal(
      (
        await fetch(`${baseUrl}/api/hotels/safi-centro/constancia`, {
          headers: { Cookie: safiCookie }
        })
      ).status,
      200
    );
  });

  it('ejecuta flujo DOF completo (JWT + scrypt + Fases 1-3 + LGT + entrega Outbox a servidor SEGOB mock)', async () => {
    // 1. Levantamos un servidor HTTP mock que simula el Sandbox oficial de SEGOB
    const receivedBySegob = [];
    const mockSegob = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const parsed = body ? JSON.parse(body) : {};
        if (req.url === '/login') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ token: 'segob-mock-jwt-token', expires_in: 3600 }));
          return;
        }
        receivedBySegob.push({
          url: req.url,
          auth: req.headers.authorization,
          payload: parsed
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ acuse: `SEGOB-REAL-${receivedBySegob.length}` }));
      });
    });
    await new Promise((resolve) => mockSegob.listen(0, '127.0.0.1', resolve));
    const segobUrl = `http://127.0.0.1:${mockSegob.address().port}`;

    try {
      // 2. Configurar Crowne Plaza para enviar realmente al servidor mock SEGOB
      const adminCookie = await loginAs(baseUrl, 'ti@crowneplazamty.mx');
      const cfgRes = await fetch(`${baseUrl}/api/hotels/crowne-plaza-monterrey/segob-config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
        body: JSON.stringify({
          segobMode: 'SEGOB_SANDBOX',
          segobBaseUrl: segobUrl,
          segobUsuario: 'crowne_sandbox',
          segobClave: 'SecretoOficial#2026',
          llaveMxStatus: 'Certificado Sandbox'
        })
      });
      assert.equal(cfgRes.status, 200);

      // 3. Login JWT SEGOB hacia Crowne Plaza (contraseña verificada con scrypt)
      const loginRes = await fetch(`${baseUrl}/api/pui/crowne-plaza-monterrey/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ usuario: 'pui_crowne_mty', password: 'SegobPui#2026' })
      });
      assert.equal(loginRes.status, 200);
      const { token } = await loginRes.json();

      // Aislamiento JWT entre hoteles
      const cross = await fetch(`${baseUrl}/api/pui/safi-centro/activar-reporte`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ id: 'FUB-CROSS', curp: DEMO_SCENARIOS.menorEnTiempoReal.curp })
      });
      assert.equal(cross.status, 401);

      // 4. Activar alerta de menor en Crowne Plaza → dispara /busqueda-finalizada hacia SEGOB mock
      const menor = DEMO_SCENARIOS.menorEnTiempoReal;
      const actRes = await fetch(`${baseUrl}/api/pui/crowne-plaza-monterrey/activar-reporte`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ id: menor.reporteId, curp: menor.curp })
      });
      assert.equal(actRes.status, 200);

      // 5. Check-in de menor desde recepción (sin parentesco) → dispara alerta silenciosa Fase 3 real al mock SEGOB
      const recCookie = await loginAs(baseUrl, 'recepcion@crowneplazamty.mx');
      const chkRes = await fetch(`${baseUrl}/api/pms/crowne-plaza-monterrey/checkin`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: recCookie },
        body: JSON.stringify({
          nombre: menor.nombre,
          curp: menor.curp,
          habitacion: menor.habitacion,
          acompanante: menor.acompanante,
          parentescoDocumento: 'NO_ACREDITO'
        })
      });
      assert.equal(chkRes.status, 201);
      const chkData = await chkRes.json();
      assert.equal(chkData.pms_status, 'HOLD_MINOR_PROTOCOL');
      assert.equal(chkData.alerta_pui, undefined); // Sigilo estricto en recepción

      // Confirmar que el servidor SEGOB mock recibió el POST real autenticado con Bearer JWT
      const fase3Delivery = receivedBySegob.find(
        (r) => r.url === '/notificar-coincidencia' && r.payload.fase_busqueda === '3'
      );
      assert.ok(fase3Delivery, 'El servidor SEGOB mock debió recibir /notificar-coincidencia Fase 3');
      assert.equal(fase3Delivery.auth, 'Bearer segob-mock-jwt-token');
      assert.equal(fase3Delivery.payload.prioridad, 'CRITICA_MENOR_EDAD');

      // 6. Verificar Constancia oficial con entregas confirmadas y cadena SHA-256 íntegra
      const certRes = await fetch(`${baseUrl}/api/hotels/crowne-plaza-monterrey/constancia`, {
        headers: { Cookie: adminCookie }
      });
      const cert = await certRes.json();
      assert.equal(cert.seguridad.integridadCadenaBitacora, 'VERIFICADA (SIN ALTERACIONES)');
      assert.ok(cert.metricas.entregasConfirmadasSegob >= 2);
    } finally {
      await new Promise((resolve) => mockSegob.close(resolve));
    }
  });

  it('sincroniza una carpeta CSV real mediante agent/pms-sync-agent.js con X-Portico-PMS-Key', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portico-opera-export-'));
    try {
      const csvFile = path.join(tmpDir, 'opera_inhouse_20261120.csv');
      fs.writeFileSync(
        csvFile,
        generarPlantillaCsvDemo({
          incluirMenorDemo: false
        }),
        'utf8'
      );

      const crowne = getHotelBySlug('crowne-plaza-monterrey');
      const res = await syncDirectoryOnce({
        dir: tmpDir,
        hotelSlug: 'crowne-plaza-monterrey',
        apiKey: crowne.pmsApiKey,
        baseUrl,
        logger: { log() {}, error() {} }
      });

      assert.equal(res.archivosDetectados, 1);
      assert.equal(res.exitosos, 1);
      assert.equal(res.resultados[0].insertados, 4);
      assert.equal(res.resultados[0].rechazados, 1);
      assert.equal(fs.existsSync(csvFile), false, 'El archivo procesado debe moverse a processed/');
      assert.equal(fs.readdirSync(path.join(tmpDir, 'processed')).length, 2); // csv + result.json
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
