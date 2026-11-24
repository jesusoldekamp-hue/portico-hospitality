/**
 * Validador oficial de estructura, entidad federativa y dígito verificador de CURP (RENAPO / DOF).
 */

export const ENTIDADES_CURP = {
  AS: 'Aguascalientes',
  BC: 'Baja California',
  BS: 'Baja California Sur',
  CC: 'Campeche',
  CL: 'Coahuila',
  CM: 'Colima',
  CS: 'Chiapas',
  CH: 'Chihuahua',
  DF: 'Ciudad de México',
  DG: 'Durango',
  GT: 'Guanajuato',
  GR: 'Guerrero',
  HG: 'Hidalgo',
  JC: 'Jalisco',
  MC: 'Estado de México',
  MN: 'Michoacán',
  MS: 'Morelos',
  NT: 'Nayarit',
  NL: 'Nuevo León',
  OC: 'Oaxaca',
  PL: 'Puebla',
  QT: 'Querétaro',
  QR: 'Quintana Roo',
  SP: 'San Luis Potosí',
  SL: 'Sinaloa',
  SR: 'Sonora',
  TC: 'Tabasco',
  TS: 'Tamaulipas',
  TL: 'Tlaxcala',
  VZ: 'Veracruz',
  YN: 'Yucatán',
  ZS: 'Zacatecas',
  NE: 'Nacido en el Extranjero'
};

const CURP_REGEX =
  /^[A-Z][AEIOUX][A-Z]{2}\d{2}(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])[HMX](AS|BC|BS|CC|CL|CM|CS|CH|DF|DG|GT|GR|HG|JC|MC|MN|MS|NT|NL|OC|PL|QT|QR|SP|SL|SR|TC|TS|TL|VZ|YN|ZS|NE)[B-DF-HJ-NP-TV-Z]{3}[0-9A-Z]\d$/;

const DICCIONARIO = '0123456789ABCDEFGHIJKLMNÑOPQRSTUVWXYZ';

/**
 * Calcula el dígito verificador oficial RENAPO para los primeros 17 caracteres de una CURP.
 */
export function calcularDigitoVerificador(curp17) {
  let suma = 0;
  for (let i = 0; i < 17; i++) {
    const idx = DICCIONARIO.indexOf(curp17[i]);
    if (idx === -1) return null;
    suma += idx * (18 - i);
  }
  const digito = (10 - (suma % 10)) % 10;
  return String(digito);
}

/**
 * Valida una CURP mexicana (formato, fecha calendario, entidad y dígito verificador).
 */
export function validarCurp(rawCurp) {
  if (typeof rawCurp !== 'string') {
    return { valida: false, error: 'La CURP es obligatoria.' };
  }
  const curp = rawCurp.trim().toUpperCase();
  if (curp.length !== 18) {
    return { valida: false, curp, error: 'La CURP debe tener exactamente 18 caracteres.' };
  }
  if (!CURP_REGEX.test(curp)) {
    return {
      valida: false,
      curp,
      error: 'El formato de CURP no coincide con la estructura oficial de RENAPO.'
    };
  }

  // Validar fecha calendario
  const yy = Number(curp.slice(4, 6));
  const mm = Number(curp.slice(6, 8));
  const dd = Number(curp.slice(8, 10));
  const homoclave = curp[16];
  const siglo = /\d/.test(homoclave) ? 1900 : 2000;
  const anio = siglo + yy;
  const fecha = new Date(Date.UTC(anio, mm - 1, dd));
  if (
    fecha.getUTCFullYear() !== anio ||
    fecha.getUTCMonth() !== mm - 1 ||
    fecha.getUTCDate() !== dd
  ) {
    return { valida: false, curp, error: 'La fecha de nacimiento codificada en la CURP no es válida.' };
  }

  // Validar dígito verificador
  const esperado = calcularDigitoVerificador(curp.slice(0, 17));
  if (esperado !== curp[17]) {
    return {
      valida: false,
      curp,
      error: `El dígito verificador de la CURP es incorrecto (se esperaba ${esperado}).`
    };
  }

  const codigoEntidad = curp.slice(11, 13);
  const hoy = new Date();
  let edad = hoy.getUTCFullYear() - anio;
  const mDiff = hoy.getUTCMonth() + 1 - mm;
  if (mDiff < 0 || (mDiff === 0 && hoy.getUTCDate() < dd)) {
    edad--;
  }

  return {
    valida: true,
    curp,
    fechaNacimiento: `${anio}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`,
    edad,
    esMenor: edad < 18,
    sexo: curp[10],
    codigoEntidad,
    entidad: ENTIDADES_CURP[codigoEntidad] || codigoEntidad
  };
}

/**
 * Construye una CURP válida (con dígito verificador real) a partir de los primeros 17 caracteres.
 */
export function completarCurpValida(curp17) {
  const base = curp17.trim().toUpperCase().slice(0, 17);
  const dv = calcularDigitoVerificador(base);
  return `${base}${dv}`;
}

/**
 * Enmascara una CURP o identificador de pasaporte para vistas agregadas o reportes sin privilegio de PII.
 */
export function enmascararCurp(curp) {
  if (!curp) return '******************';
  if (curp.startsWith('PASS:')) {
    const parts = curp.split(':');
    const nac = parts[1] || 'EXT';
    const num = parts[2] || '';
    return `PASS:${nac}:****${num.slice(-3)}`;
  }
  if (curp.length < 18) return '******************';
  return `${curp.slice(0, 4)}******${curp.slice(10, 13)}***${curp.slice(16)}`;
}

/**
 * Valida un pasaporte o documento migratorio extranjero (huéspedes internacionales sin CURP)
 * y calcula minoría de edad (<18) para cumplir con la Ley General de Turismo.
 */
export function validarPasaporteExtranjero({ pasaporte, nacionalidad = 'EXT', fechaNacimiento = '' } = {}) {
  const num = String(pasaporte || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
  if (num.length < 6 || num.length > 15) {
    return {
      valida: false,
      error: 'El número de pasaporte extranjero debe tener entre 6 y 15 caracteres alfanuméricos.'
    };
  }
  const nac = String(nacionalidad || 'EXT')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z]/g, '')
    .slice(0, 3);
  if (nac.length < 2) {
    return { valida: false, error: 'Indica el código de país / nacionalidad del pasaporte (ej. USA, CAN, KOR).' };
  }

  let edad = null;
  let esMenor = false;
  let fechaIso = null;

  if (fechaNacimiento && /^\d{4}-\d{2}-\d{2}$/.test(String(fechaNacimiento).trim())) {
    const [y, m, d] = String(fechaNacimiento).trim().split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    if (dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d) {
      const hoy = new Date();
      edad = hoy.getUTCFullYear() - y;
      const mDiff = hoy.getUTCMonth() + 1 - m;
      if (mDiff < 0 || (mDiff === 0 && hoy.getUTCDate() < d)) edad--;
      esMenor = edad < 18;
      fechaIso = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }
  }

  const claveCanonica = `PASS:${nac}:${num}`;
  return {
    valida: true,
    esExtranjero: true,
    curp: claveCanonica,
    pasaporte: num,
    nacionalidad: nac,
    fechaNacimiento: fechaIso,
    edad,
    esMenor,
    sexo: 'X',
    codigoEntidad: 'NE',
    entidad: `Extranjero (${nac})`
  };
}
