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
 * Enmascara una CURP para vistas agregadas o reportes sin privilegio de PII.
 */
export function enmascararCurp(curp) {
  if (!curp || curp.length < 18) return '******************';
  return `${curp.slice(0, 4)}******${curp.slice(10, 13)}***${curp.slice(16)}`;
}
