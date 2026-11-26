/**
 * Generador cliente de Instalador 1-Clic del Agente PMS + Estimador de Escala AWS (10–1,000 hoteles).
 * Funciona igual en modo estático CDN que conectado al servidor Node/AWS.
 */

function escapePs(val) {
  return String(val || '').replace(/'/g, "''");
}

function escapeSh(val) {
  return String(val || '').replace(/'/g, "'\\''");
}

export function buildWindowsInstallerScript({
  hotelNombre,
  hotelSlug,
  rfc,
  apiKey,
  baseUrl,
  watchDir = 'C:\\PorticoPMS\\Exports',
  intervalMs = 15000
}) {
  const safeName = escapePs(hotelNombre);
  const safeSlug = escapePs(hotelSlug);
  const safeRfc = escapePs(rfc);
  const safeKey = escapePs(apiKey);
  const safeUrl = escapePs(baseUrl);
  const safeDir = escapePs(watchDir);

  return `# ==============================================================================
# Certeza ID — Instalador 1-Clic de Servicio Windows (OPERA 5 / Zeus)
# Hotel: ${safeName} (RFC: ${safeRfc})
# ==============================================================================
# Ejecutar en PowerShell como Administrador:
#   powershell -ExecutionPolicy Bypass -File .\\Instalar-Portico-${safeSlug}.ps1

$ErrorActionPreference = 'Stop'

$HotelSlug  = '${safeSlug}'
$HotelName  = '${safeName}'
$PmsApiKey  = '${safeKey}'
$PorticoUrl = '${safeUrl}'
$WatchDir   = '${safeDir}'
$InstallDir = 'C:\\ProgramData\\PorticoHospitality\\Agent'
$TaskName   = "PorticoHospitality-PMS-$HotelSlug"

Write-Host ""
Write-Host "=== Certeza ID · Instalador de Agente PMS ===" -ForegroundColor Cyan
Write-Host "Hotel: $HotelName ($HotelSlug)"
Write-Host "Carpeta vigilada (CSV/XML OPERA): $WatchDir"

$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
  Write-Error "Node.js 20+ no encontrado. Descárgalo en https://nodejs.org y vuelve a ejecutar este script."
}

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
New-Item -ItemType Directory -Force -Path $WatchDir | Out-Null
New-Item -ItemType Directory -Force -Path "$WatchDir\\processed" | Out-Null
New-Item -ItemType Directory -Force -Path "$WatchDir\\failed" | Out-Null

$envContent = @"
PORTICO_HOTEL_SLUG=$HotelSlug
PORTICO_PMS_KEY=$PmsApiKey
PORTICO_URL=$PorticoUrl
PORTICO_WATCH_DIR=$WatchDir
PORTICO_INTERVAL_MS=${Number(intervalMs) || 15000}
"@
Set-Content -Path "$InstallDir\\agent.env" -Value $envContent -Encoding UTF8

$agentPath = "$InstallDir\\pms-sync-agent.mjs"
$embeddedAgent = @'
import fs from 'node:fs';
import path from 'node:path';

const dir = process.env.PORTICO_WATCH_DIR;
const slug = process.env.PORTICO_HOTEL_SLUG;
const key = process.env.PORTICO_PMS_KEY;
const url = (process.env.PORTICO_URL || '').replace(/\\/$/, '');
const intervalMs = Math.max(3000, Number(process.env.PORTICO_INTERVAL_MS || 15000));

async function syncOnce() {
  const files = fs.readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isFile() && /\\.(csv|xml)$/i.test(d.name))
    .map((d) => d.name).sort();
  for (const name of files) {
    const src = path.join(dir, name);
    const body = fs.readFileSync(src, 'utf8');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    try {
      const res = await fetch(\`\${url}/api/pms/\${slug}/import-csv\`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Portico-PMS-Key': key },
        body: JSON.stringify({ csvText: body, origen: \`Windows Agent (\${name})\` }),
        signal: AbortSignal.timeout(15000)
      });
      const out = await res.json().catch(() => ({}));
      const targetDir = res.ok ? path.join(dir, 'processed') : path.join(dir, 'failed');
      fs.renameSync(src, path.join(targetDir, \`\${stamp}_\${name}\`));
      fs.writeFileSync(path.join(targetDir, \`\${stamp}_\${name}.json\`), JSON.stringify(out, null, 2));
    } catch (e) {
      console.error('[Certeza ID Agent] Error de red, se reintentará:', e.message);
    }
  }
}

setInterval(syncOnce, intervalMs);
syncOnce();
'@
Set-Content -Path $agentPath -Value $embeddedAgent -Encoding UTF8

$runnerCmd = @"
@echo off
for /f "usebackq tokens=1,* delims==" %%A in ("$InstallDir\\agent.env") do set "%%A=%%B"
"$($nodeCmd.Source)" "$agentPath" >> "$InstallDir\\agent.log" 2>&1
"@
Set-Content -Path "$InstallDir\\run-agent.cmd" -Value $runnerCmd -Encoding ASCII

$action = New-ScheduledTaskAction -Execute "$InstallDir\\run-agent.cmd"
$trigger = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName

Write-Host "[OK] Servicio '$TaskName' instalado y corriendo en segundo plano." -ForegroundColor Green
Write-Host "     Suelta cualquier archivo .xml (OPERA 5) o .csv en: $WatchDir"
`;
}

export function buildLinuxInstallerScript({
  hotelNombre,
  hotelSlug,
  rfc,
  apiKey,
  baseUrl,
  watchDir = '/var/spool/portico-pms/exports',
  intervalMs = 15000
}) {
  const safeName = escapeSh(hotelNombre);
  const safeSlug = escapeSh(hotelSlug);
  const safeRfc = escapeSh(rfc);
  const safeKey = escapeSh(apiKey);
  const safeUrl = escapeSh(baseUrl);
  const safeDir = escapeSh(watchDir);

  return `#!/usr/bin/env bash
# ==============================================================================
# Certeza ID — Instalador 1-Clic systemd (Linux / Mac Server)
# Hotel: ${safeName} (RFC: ${safeRfc})
# ==============================================================================
set -euo pipefail

HOTEL_SLUG='${safeSlug}'
PMS_API_KEY='${safeKey}'
PORTICO_URL='${safeUrl}'
WATCH_DIR='${safeDir}'
INSTALL_DIR='/opt/portico-hospitality-agent'
SERVICE_NAME="portico-pms-\${HOTEL_SLUG}"

echo "=== Certeza ID · Instalador Agente PMS (\${HOTEL_SLUG}) ==="
command -v node >/dev/null 2>&1 || { echo "Error: instala Node.js 20+ primero."; exit 1; }

sudo mkdir -p "\${INSTALL_DIR}" "\${WATCH_DIR}/processed" "\${WATCH_DIR}/failed"

cat <<EOF | sudo tee "\${INSTALL_DIR}/agent.env" >/dev/null
PORTICO_HOTEL_SLUG=\${HOTEL_SLUG}
PORTICO_PMS_KEY=\${PMS_API_KEY}
PORTICO_URL=\${PORTICO_URL}
PORTICO_WATCH_DIR=\${WATCH_DIR}
PORTICO_INTERVAL_MS=${Number(intervalMs) || 15000}
EOF
sudo chmod 600 "\${INSTALL_DIR}/agent.env"

cat <<'EOF' | sudo tee "\${INSTALL_DIR}/pms-sync-agent.mjs" >/dev/null
import fs from 'node:fs';
import path from 'node:path';

const dir = process.env.PORTICO_WATCH_DIR;
const slug = process.env.PORTICO_HOTEL_SLUG;
const key = process.env.PORTICO_PMS_KEY;
const url = (process.env.PORTICO_URL || '').replace(/\\/$/, '');
const intervalMs = Math.max(3000, Number(process.env.PORTICO_INTERVAL_MS || 15000));

async function syncOnce() {
  const files = fs.readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isFile() && /\\.(csv|xml)$/i.test(d.name))
    .map((d) => d.name).sort();
  for (const name of files) {
    const src = path.join(dir, name);
    const body = fs.readFileSync(src, 'utf8');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    try {
      const res = await fetch(\`\${url}/api/pms/\${slug}/import-csv\`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Portico-PMS-Key': key },
        body: JSON.stringify({ csvText: body, origen: \`Linux Agent (\${name})\` }),
        signal: AbortSignal.timeout(15000)
      });
      const out = await res.json().catch(() => ({}));
      const targetDir = res.ok ? path.join(dir, 'processed') : path.join(dir, 'failed');
      fs.renameSync(src, path.join(targetDir, \`\${stamp}_\${name}\`));
      fs.writeFileSync(path.join(targetDir, \`\${stamp}_\${name}.json\`), JSON.stringify(out, null, 2));
    } catch (e) {
      console.error('[Certeza ID Agent] Error de red, se reintentará:', e.message);
    }
  }
}

setInterval(syncOnce, intervalMs);
syncOnce();
EOF

if command -v systemctl >/dev/null 2>&1; then
  cat <<EOF | sudo tee "/etc/systemd/system/\${SERVICE_NAME}.service" >/dev/null
[Unit]
Description=Certeza ID PMS Sync Agent (\${HOTEL_SLUG})
After=network-online.target

[Service]
Type=simple
EnvironmentFile=\${INSTALL_DIR}/agent.env
ExecStart=$(command -v node) \${INSTALL_DIR}/pms-sync-agent.mjs
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF
  sudo systemctl daemon-reload
  sudo systemctl enable --now "\${SERVICE_NAME}"
  echo "[OK] Servicio systemd \${SERVICE_NAME} activo. Carpeta vigilada: \${WATCH_DIR}"
else
  echo "[OK] Agente instalado en \${INSTALL_DIR}."
fi
`;
}

export function estimateScaleInfrastructure(hotelsCount) {
  const n = Math.max(1, Number(hotelsCount) || 136);
  const dailyCheckins = Math.round(n * 80);
  const annualRecords = dailyCheckins * 365;

  if (n <= 50) {
    return {
      tier: 'Etapa 1 · Piloto Fundador',
      dbSpec: 'AWS RDS PostgreSQL db.t4g.medium (Multi-AZ + RLS)',
      computeSpec: '2× ECS Fargate (1 vCPU / 2 GB) + ALB HTTPS',
      queueSpec: 'Outbox PostgreSQL + Redis ElastiCache',
      monthlyAwsMxn: 4500,
      supportRetainerMxn: 12000,
      p95LatencyMs: 18,
      sla: '99.90%',
      dailyCheckins,
      annualRecords
    };
  }
  if (n <= 180) {
    return {
      tier: 'Etapa 2 · Asociación Estatal (NL)',
      dbSpec: 'AWS RDS PostgreSQL db.m6g.large (Multi-AZ + RLS + KMS)',
      computeSpec: '2–4× ECS Fargate Auto-Scaling + WAF + IP fija SEGOB',
      queueSpec: 'Redis ElastiCache + SQS FIFO Outbox Workers',
      monthlyAwsMxn: 6000,
      supportRetainerMxn: 12000,
      p95LatencyMs: 21,
      sla: '99.95%',
      dailyCheckins,
      annualRecords
    };
  }
  if (n <= 500) {
    return {
      tier: 'Etapa 3 · Red Regional (2–4 Estados)',
      dbSpec: 'AWS RDS PostgreSQL db.m6g.xlarge Multi-AZ + Particiones mensuales',
      computeSpec: '4–6× ECS Fargate Auto-Scaling + NAT Gateway dedicado',
      queueSpec: 'Redis Cluster + SQS Outbox + Workers dedicados',
      monthlyAwsMxn: 16500,
      supportRetainerMxn: 18000,
      p95LatencyMs: 24,
      sla: '99.95%',
      dailyCheckins,
      annualRecords
    };
  }
  return {
    tier: 'Etapa 4 · Escala Nacional (1,000+ Hoteles)',
    dbSpec: 'AWS RDS PostgreSQL db.r6g.xlarge Multi-AZ + Read Replica + pg_partman',
    computeSpec: '6–12× ECS Fargate Auto-Scaling + AWS WAF + KMS Multi-Región',
    queueSpec: 'Redis Cluster + AWS SQS + Workers paralelos SKIP LOCKED',
    monthlyAwsMxn: 34000,
    supportRetainerMxn: 24000,
    p95LatencyMs: 27,
    sla: '99.99%',
    dailyCheckins,
    annualRecords
  };
}
