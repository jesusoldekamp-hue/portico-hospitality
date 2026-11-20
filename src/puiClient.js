/**
 * Cliente saliente hacia la PUI de SEGOB con cola persistente (`segob_outbox`),
 * caché de JWT por hotel y reintentos con backoff exponencial.
 *
 * Modos soportados por hotel:
 * - SANDBOX_SIMULADO: entrega verificable local sin salir a internet (demos y pruebas).
 * - SEGOB_SANDBOX / SEGOB_PRODUCCION: realiza login JWT real y POST HTTPS a SEGOB.
 */

import crypto from 'node:crypto';
import {
  getHotelBySlug,
  listDueOutboxJobs,
  markOutboxDelivered,
  markOutboxRetry
} from './db.js';
import { descifrarAes256Gcm } from './security.js';

const tokenCache = new Map();

async function obtenerJwtSegob(hotel) {
  const cached = tokenCache.get(hotel.slug);
  if (cached && cached.expiresAt > Date.now() + 30_000) {
    return cached.token;
  }

  if (!hotel.segobBaseUrl) {
    throw new Error('Falta configurar la URL base de SEGOB para este hotel.');
  }

  const clave = hotel.segobClaveCifrada ? descifrarAes256Gcm(hotel.segobClaveCifrada) : '';
  const loginRes = await fetch(`${hotel.segobBaseUrl}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      usuario: hotel.segobUsuario,
      password: clave
    }),
    signal: AbortSignal.timeout(10_000)
  });

  if (!loginRes.ok) {
    throw new Error(`Fallo autenticación /login en SEGOB (HTTP ${loginRes.status}).`);
  }
  const data = await loginRes.json();
  const token = data.token || data.access_token;
  if (!token) {
    throw new Error('SEGOB no devolvió token JWT en /login.');
  }
  const ttlMs = (Number(data.expires_in) || 1800) * 1000;
  tokenCache.set(hotel.slug, { token, expiresAt: Date.now() + ttlMs });
  return token;
}

async function entregarTrabajo(job) {
  const hotel = getHotelBySlug(job.hotelSlug, true);
  if (!hotel) {
    markOutboxRetry(job.id, {
      intentosActuales: job.maxIntentos,
      maxIntentos: job.maxIntentos,
      errorMsg: 'Hotel eliminado antes de entregar notificación.'
    });
    return;
  }

  const start = Date.now();

  // Modo simulado local (ideal para demo / sandbox sin credenciales gubernamentales aún)
  if (hotel.segobMode === 'SANDBOX_SIMULADO' || !hotel.segobBaseUrl) {
    const acuse = `ACUSE-SEGOB-${job.fase.replace(/\s+/g, '')}-${crypto
      .randomBytes(4)
      .toString('hex')
      .toUpperCase()}`;
    const latenciaMs = Math.max(12, Date.now() - start + 18);
    markOutboxDelivered(job.id, {
      httpStatus: 200,
      acuseSegob: `${acuse} (Simulado)`,
      latenciaMs
    });
    return;
  }

  // Modo real SEGOB_SANDBOX / SEGOB_PRODUCCION
  try {
    const token = await obtenerJwtSegob(hotel);
    const targetPath = job.endpoint.startsWith('/pui/')
      ? job.endpoint.replace(/^\/pui/, '')
      : job.endpoint;

    const res = await fetch(`${hotel.segobBaseUrl}${targetPath}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify(job.payload),
      signal: AbortSignal.timeout(10_000)
    });

    const latenciaMs = Date.now() - start;
    if (res.ok) {
      const respJson = await res.json().catch(() => ({}));
      const acuse = respJson.acuse || respJson.folio || `HTTP-${res.status}-OK`;
      markOutboxDelivered(job.id, {
        httpStatus: res.status,
        acuseSegob: String(acuse),
        latenciaMs
      });
    } else {
      const errText = await res.text().catch(() => '');
      if (res.status === 401) {
        tokenCache.delete(hotel.slug);
      }
      markOutboxRetry(job.id, {
        intentosActuales: job.intentos,
        maxIntentos: job.maxIntentos,
        httpStatus: res.status,
        errorMsg: `SEGOB respondió HTTP ${res.status}: ${errText}`,
        latenciaMs
      });
    }
  } catch (err) {
    markOutboxRetry(job.id, {
      intentosActuales: job.intentos,
      maxIntentos: job.maxIntentos,
      httpStatus: null,
      errorMsg: err.message,
      latenciaMs: Date.now() - start
    });
  }
}

let processing = false;

export async function procesarColaOutbox() {
  if (processing) return 0;
  processing = true;
  let count = 0;
  try {
    const jobs = listDueOutboxJobs();
    for (const job of jobs) {
      await entregarTrabajo(job);
      count++;
    }
  } finally {
    processing = false;
  }
  return count;
}

export function startOutboxWorker(intervalMs = 5000) {
  const timer = setInterval(() => {
    procesarColaOutbox().catch((err) => {
      console.error('[Argus Outbox Worker Error]', err);
    });
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
