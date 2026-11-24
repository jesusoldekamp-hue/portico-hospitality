/**
 * Portico Hospitality — Adaptador Dual de Persistencia (SQLite WAL ↔ PostgreSQL 16 + RLS)
 *
 * - Sin `DATABASE_URL`: opera en modo embebido cero-dependencias sobre `node:sqlite` (WAL ACID)
 *   para desarrollo local, piloto rápido y pruebas unitarias.
 * - Con `DATABASE_URL=postgres://...`: prepara pool de conexiones PostgreSQL 16 (AWS RDS Multi-AZ),
 *   fijando `SET LOCAL app.current_hotel_slug` en cada transacción para aislamiento RLS a escala
 *   de 1,000+ hoteles.
 */

export function resolveStorageConfig(env = process.env) {
  const databaseUrl = (env.DATABASE_URL || '').trim();
  const isPostgres = /^postgres(ql)?:\/\//i.test(databaseUrl);
  const redisUrl = (env.REDIS_URL || '').trim();
  const awsRegion = env.AWS_REGION || 'us-east-1';

  return {
    engine: isPostgres ? 'postgresql' : 'sqlite',
    engineLabel: isPostgres
      ? 'PostgreSQL 16+ (AWS RDS Multi-AZ · RLS Activo)'
      : 'SQLite WAL ACID (Embebido · Esquema 1:1 PostgreSQL RLS listo)',
    rlsEnabled: isPostgres,
    rlsSchemaReady: true,
    poolMax: Number(env.PG_POOL_MAX || (isPostgres ? 40 : 1)),
    redisConfigured: Boolean(redisUrl),
    queueMode: redisUrl ? 'Distribuida (Redis / SQS Workers)' : 'Outbox ACID Embebido (Reintento exponencial)',
    awsRegion,
    recommendedCapacityHotels: isPostgres ? 1000 : 50,
    encryptionStandard: 'AES-256-GCM + HMAC-SHA256 por RFC'
  };
}

/**
 * Ejecuta una transacción aislada por hotel en PostgreSQL usando Row-Level Security (RLS).
 * Requiere un pool compatible con `pg.Pool` (paquete `pg` instalado en despliegue AWS RDS).
 */
export async function withHotelRlsTransaction(pgPool, hotelSlug, fn) {
  if (!pgPool || typeof pgPool.connect !== 'function') {
    throw new Error('Se requiere un pg.Pool válido para ejecutar transacciones RLS.');
  }
  const client = await pgPool.connect();
  try {
    await client.query('BEGIN');
    if (hotelSlug === '*') {
      await client.query(`SELECT set_config('app.bypass_rls', 'on', true)`);
    } else {
      await client.query(`SELECT set_config('app.bypass_rls', 'off', true)`);
      await client.query(`SELECT set_config('app.current_hotel_slug', $1, true)`, [String(hotelSlug)]);
    }
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Calcula la arquitectura de nube AWS recomendada y el costo mensual prorrateado
 * desde 10 hasta 1,000+ hoteles.
 */
export function estimateScaleInfrastructure(hotelsCount) {
  const n = Math.max(1, Number(hotelsCount) || 136);
  const dailyCheckins = Math.round(n * 80); // ~80 huéspedes/día promedio por hotel
  const annualRecords = dailyCheckins * 365;

  if (n <= 50) {
    return {
      tier: 'Etapa 1 · Piloto Estatal',
      dbSpec: 'AWS RDS PostgreSQL db.t4g.medium (Multi-AZ + RLS)',
      computeSpec: '2× ECS Fargate (1 vCPU / 2 GB) + ALB HTTPS',
      queueSpec: 'Outbox PostgreSQL + Redis ElastiCache micro',
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
      tier: 'Etapa 2 · Asociación Estatal Completa (NL)',
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
      tier: 'Etapa 3 · Red Regional (2–4 Asociaciones)',
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
