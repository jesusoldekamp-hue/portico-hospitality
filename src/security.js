/**
 * Primitivas criptográficas con `node:crypto` (cero dependencias externas):
 * - scrypt + timingSafeEqual para contraseñas de usuarios y credenciales PUI
 * - JWT HS256 (autenticación /login del Manual Técnico PUI - DOF)
 * - AES-256-GCM (cifrado en reposo de CURPs, alertas y secretos SEGOB)
 * - SHA-256 HMAC y cadena de hashes inmutable para bitácora auditable
 */

import crypto from 'node:crypto';

const JWT_SECRET = process.env.PUI_JWT_SECRET || 'argus-id-jwt-dev-secret-change-in-prod-2026';
const VAULT_KEY_SOURCE =
  process.env.PUI_VAULT_KEY || 'argus-id-vault-aes256-dev-key-change-in-prod-2026';
const VAULT_KEY = crypto.createHash('sha256').update(VAULT_KEY_SOURCE).digest();

function base64UrlEncode(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input, 'utf8');
  return buf.toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function base64UrlDecode(str) {
  const pad = 4 - (str.length % 4 || 4);
  const normalized = str.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat(pad === 4 ? 0 : pad);
  return Buffer.from(normalized, 'base64').toString('utf8');
}

/**
 * Hashea una contraseña con scrypt y sal aleatoria de 16 bytes.
 */
export function hashPassword(plain) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(String(plain), salt, 64).toString('hex');
  return `scrypt:${salt}:${derived}`;
}

/**
 * Verifica una contraseña en tiempo constante contra un hash scrypt almacenado.
 */
export function verifyPassword(plain, stored) {
  if (!plain || !stored || !stored.startsWith('scrypt:')) return false;
  const parts = stored.split(':');
  if (parts.length !== 3) return false;
  const [, salt, hexHash] = parts;
  try {
    const derived = crypto.scryptSync(String(plain), salt, 64);
    const expected = Buffer.from(hexHash, 'hex');
    if (derived.length !== expected.length) return false;
    return crypto.timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

export function generarTokenSesion() {
  return crypto.randomBytes(32).toString('hex');
}

export function sha256Hex(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

export function firmarJwt(payload, expiresInSeconds = 3600) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'HS256', typ: 'JWT' };
  const body = { ...payload, iat: now, exp: now + expiresInSeconds };
  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedBody = base64UrlEncode(JSON.stringify(body));
  const signingInput = `${encodedHeader}.${encodedBody}`;
  const signature = crypto.createHmac('sha256', JWT_SECRET).update(signingInput).digest();
  return `${signingInput}.${base64UrlEncode(signature)}`;
}

export function verificarJwt(token) {
  if (!token || typeof token !== 'string') {
    return { valido: false, error: 'Token faltante.' };
  }
  const parts = token.split('.');
  if (parts.length !== 3) {
    return { valido: false, error: 'Estructura JWT inválida.' };
  }
  const [encodedHeader, encodedBody, encodedSig] = parts;
  const expectedSig = base64UrlEncode(
    crypto.createHmac('sha256', JWT_SECRET).update(`${encodedHeader}.${encodedBody}`).digest()
  );

  const a = Buffer.from(encodedSig);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { valido: false, error: 'Firma JWT inválida.' };
  }

  try {
    const payload = JSON.parse(base64UrlDecode(encodedBody));
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp && payload.exp < now) {
      return { valido: false, error: 'Token JWT expirado.' };
    }
    return { valido: true, payload };
  } catch {
    return { valido: false, error: 'Payload JWT ilegible.' };
  }
}

export function cifrarAes256Gcm(textoPlano) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', VAULT_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(String(textoPlano), 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    alg: 'AES-256-GCM',
    iv: iv.toString('hex'),
    tag: authTag.toString('hex'),
    data: encrypted.toString('hex')
  };
}

export function descifrarAes256Gcm(paquete) {
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    VAULT_KEY,
    Buffer.from(paquete.iv, 'hex')
  );
  decipher.setAuthTag(Buffer.from(paquete.tag, 'hex'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(paquete.data, 'hex')),
    decipher.final()
  ]);
  return decrypted.toString('utf8');
}

export function hashCurpPorHotel(hotelSlug, curp) {
  return crypto
    .createHmac('sha256', VAULT_KEY)
    .update(`${hotelSlug}::${curp.trim().toUpperCase()}`)
    .digest('hex');
}

export function calcularHashAuditoria(prevHash, registro) {
  return crypto
    .createHash('sha256')
    .update(`${prevHash || 'GENESIS'}|${JSON.stringify(registro)}`)
    .digest('hex');
}
