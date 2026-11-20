#!/usr/bin/env node
/**
 * Argus ID — Agente Local de Sincronización PMS (cero dependencias externas)
 *
 * Diseñado para hoteles con PMS On-Premise (Oracle OPERA 5, Zeus, Frontdesk, etc.)
 * que exportan reportes CSV a una carpeta local sin exponer su base de datos.
 *
 * Uso:
 *   node agent/pms-sync-agent.js \
 *     --dir ./carpeta-exports \
 *     --hotel crowne-plaza-monterrey \
 *     --key argus_pms_... \
 *     --url http://localhost:3080 \
 *     [--once] [--interval 15000]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--once') {
      args.once = true;
    } else if (token.startsWith('--')) {
      const key = token.slice(2);
      const val = argv[i + 1];
      if (val && !val.startsWith('--')) {
        args[key] = val;
        i++;
      } else {
        args[key] = 'true';
      }
    }
  }
  return args;
}

export async function syncDirectoryOnce({ dir, hotelSlug, apiKey, baseUrl, logger = console }) {
  const watchDir = path.resolve(dir);
  const processedDir = path.join(watchDir, 'processed');
  const failedDir = path.join(watchDir, 'failed');

  fs.mkdirSync(watchDir, { recursive: true });
  fs.mkdirSync(processedDir, { recursive: true });
  fs.mkdirSync(failedDir, { recursive: true });

  const entries = fs
    .readdirSync(watchDir, { withFileTypes: true })
    .filter((d) => d.isFile() && d.name.toLowerCase().endsWith('.csv'))
    .map((d) => d.name)
    .sort();

  const summary = {
    archivosDetectados: entries.length,
    exitosos: 0,
    fallidos: 0,
    resultados: []
  };

  for (const filename of entries) {
    const filePath = path.join(watchDir, filename);
    const csvText = fs.readFileSync(filePath, 'utf8');
    const endpoint = `${baseUrl.replace(/\/$/, '')}/api/pms/${hotelSlug}/import-csv`;

    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Argus-PMS-Key': apiKey
        },
        body: JSON.stringify({
          csvText,
          origen: `Agente Local PMS (${filename})`
        }),
        signal: AbortSignal.timeout(15_000)
      });

      const data = await res.json().catch(() => ({}));
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');

      if (!res.ok) {
        const dest = path.join(failedDir, `${stamp}_${filename}`);
        fs.renameSync(filePath, dest);
        fs.writeFileSync(
          `${dest}.error.json`,
          JSON.stringify({ status: res.status, error: data.error || 'Error HTTP' }, null, 2)
        );
        summary.fallidos++;
        summary.resultados.push({ filename, ok: false, status: res.status, error: data.error });
        logger.error(`[Argus Agent] Error en ${filename}: HTTP ${res.status} (${data.error || ''})`);
      } else {
        const dest = path.join(processedDir, `${stamp}_${filename}`);
        fs.renameSync(filePath, dest);
        fs.writeFileSync(`${dest}.result.json`, JSON.stringify(data, null, 2));
        summary.exitosos++;
        summary.resultados.push({
          filename,
          ok: true,
          insertados: data.insertados,
          rechazados: data.rechazados
        });
        logger.log(
          `[Argus Agent] Sincronizado ${filename} → ${data.insertados} válidos, ${data.rechazados} rechazados.`
        );
      }
    } catch (err) {
      summary.fallidos++;
      summary.resultados.push({ filename, ok: false, error: err.message });
      logger.error(`[Argus Agent] Fallo de red en ${filename}: ${err.message} (se reintentará)`);
    }
  }

  return summary;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const cli = parseArgs(process.argv.slice(2));
  const dir = cli.dir || process.env.ARGUS_WATCH_DIR;
  const hotelSlug = cli.hotel || process.env.ARGUS_HOTEL_SLUG;
  const apiKey = cli.key || process.env.ARGUS_PMS_KEY;
  const baseUrl = cli.url || process.env.ARGUS_URL || 'http://localhost:3080';
  const intervalMs = Math.max(3000, Number(cli.interval || process.env.ARGUS_INTERVAL_MS || 15000));

  if (!dir || !hotelSlug || !apiKey) {
    console.error(
      'Uso: node agent/pms-sync-agent.js --dir <carpeta_csv> --hotel <slug> --key <X-Argus-PMS-Key> [--url http://localhost:3080] [--once]'
    );
    process.exit(1);
  }

  console.log(`[Argus Agent] Vigilando ${path.resolve(dir)} para ${hotelSlug} → ${baseUrl}`);

  if (cli.once) {
    const res = await syncDirectoryOnce({ dir, hotelSlug, apiKey, baseUrl });
    console.log('[Argus Agent] Resumen:', JSON.stringify(res));
    process.exit(res.fallidos > 0 ? 2 : 0);
  } else {
    const tick = async () => {
      await syncDirectoryOnce({ dir, hotelSlug, apiKey, baseUrl });
    };
    await tick();
    setInterval(tick, intervalMs);
  }
}
