/**
 * Limitador de tasa (Rate Limiter) por ventana deslizante en memoria para protección
 * contra fuerza bruta en /login y abuso en endpoints PUI / PMS (requisito DAST).
 */

export function createRateLimiter() {
  const buckets = new Map();

  function check(key, { limit = 60, windowMs = 60_000 } = {}) {
    const now = Date.now();
    const cutoff = now - windowMs;
    const timestamps = (buckets.get(key) || []).filter((ts) => ts > cutoff);

    if (timestamps.length >= limit) {
      const oldest = timestamps[0];
      const retryAfterSec = Math.max(1, Math.ceil((oldest + windowMs - now) / 1000));
      buckets.set(key, timestamps);
      return {
        allowed: false,
        limit,
        remaining: 0,
        retryAfterSec
      };
    }

    timestamps.push(now);
    buckets.set(key, timestamps);

    // Limpieza ocasional para evitar crecimiento ilimitado de memoria
    if (buckets.size > 5000) {
      for (const [k, list] of buckets.entries()) {
        if (!list.length || list[list.length - 1] <= cutoff) {
          buckets.delete(k);
        }
      }
    }

    return {
      allowed: true,
      limit,
      remaining: Math.max(0, limit - timestamps.length),
      retryAfterSec: 0
    };
  }

  function reset() {
    buckets.clear();
  }

  return { check, reset };
}
