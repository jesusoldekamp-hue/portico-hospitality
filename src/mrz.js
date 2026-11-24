/**
 * Decodificador y validador oficial ICAO Doc 9303 (Zona de Lectura Mecánica — MRZ)
 * Soporta:
 * - TD3 (2 líneas × 44 caracteres): Pasaportes internacionales (EE.UU., Canadá, Europa, Asia, México)
 * - TD1 (3 líneas × 30 caracteres): Credencial para Votar INE México (reverso) y tarjetas ID oficiales
 * Cero dependencias externas — ejecutable tanto en Node.js como en navegador.
 */

const WEIGHTS = [7, 3, 1];

export function calcularDigitoIcao(str) {
  let sum = 0;
  const upper = String(str || '').toUpperCase();
  for (let i = 0; i < upper.length; i++) {
    const ch = upper[i];
    let val = 0;
    if (ch >= '0' && ch <= '9') {
      val = ch.charCodeAt(0) - 48;
    } else if (ch >= 'A' && ch <= 'Z') {
      val = ch.charCodeAt(0) - 55;
    } else if (ch === '<') {
      val = 0;
    } else {
      return null;
    }
    sum += val * WEIGHTS[i % 3];
  }
  return String(sum % 10);
}

function parseMrzBirthDate(yymmdd) {
  if (!/^\d{6}$/.test(yymmdd)) return null;
  const yy = Number(yymmdd.slice(0, 2));
  const mm = Number(yymmdd.slice(2, 4));
  const dd = Number(yymmdd.slice(4, 6));
  const now = new Date();
  const currentYY = now.getUTCFullYear() % 100;
  const year = yy <= currentYY ? 2000 + yy : 1900 + yy;
  const dt = new Date(Date.UTC(year, mm - 1, dd));
  if (dt.getUTCFullYear() !== year || dt.getUTCMonth() !== mm - 1 || dt.getUTCDate() !== dd) {
    return null;
  }
  let edad = now.getUTCFullYear() - year;
  const mDiff = now.getUTCMonth() + 1 - mm;
  if (mDiff < 0 || (mDiff === 0 && now.getUTCDate() < dd)) edad--;
  return {
    fechaNacimiento: `${year}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`,
    edad,
    esMenor: edad < 18
  };
}

function parseMrzNames(rawNameField) {
  const parts = String(rawNameField || '').split('<<');
  const apellidos = (parts[0] || '').replace(/<+/g, ' ').trim();
  const nombres = (parts.slice(1).join(' ') || '').replace(/<+/g, ' ').trim();
  return `${nombres} ${apellidos}`.replace(/\s+/g, ' ').trim();
}

export function parseMrz(rawText) {
  if (typeof rawText !== 'string' || !rawText.trim()) {
    return { valido: false, error: 'Pega o escanea las líneas MRZ del pasaporte o INE.' };
  }

  const lines = rawText
    .toUpperCase()
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, '').trim())
    .filter(Boolean);

  // Caso 1: TD3 Pasaporte (2 líneas de 44 caracteres)
  if (lines.length === 2 && lines[0].length === 44 && lines[1].length === 44) {
    const [l1, l2] = lines;
    if (!l1.startsWith('P')) {
      return { valido: false, error: 'La primera línea TD3 no corresponde a un pasaporte (P<).' };
    }
    const paisEmisor = l1.slice(2, 5).replace(/</g, '');
    const nombreCompleto = parseMrzNames(l1.slice(5));

    const docRaw = l2.slice(0, 9);
    const docCheck = l2[9];
    const nacionalidad = l2.slice(10, 13).replace(/</g, '') || paisEmisor;
    const birthRaw = l2.slice(13, 19);
    const birthCheck = l2[19];
    const sexo = l2[20] === 'M' ? 'H' : l2[20] === 'F' ? 'M' : 'X';
    const expRaw = l2.slice(21, 27);
    const expCheck = l2[27];

    if (calcularDigitoIcao(docRaw) !== docCheck) {
      return { valido: false, error: 'Dígito verificador ICAO inválido en número de pasaporte.' };
    }
    if (calcularDigitoIcao(birthRaw) !== birthCheck) {
      return { valido: false, error: 'Dígito verificador ICAO inválido en fecha de nacimiento.' };
    }
    if (calcularDigitoIcao(expRaw) !== expCheck) {
      return { valido: false, error: 'Dígito verificador ICAO inválido en vigencia del pasaporte.' };
    }

    const birth = parseMrzBirthDate(birthRaw);
    if (!birth) {
      return { valido: false, error: 'Fecha de nacimiento inválida en MRZ del pasaporte.' };
    }

    return {
      valido: true,
      formato: 'TD3_PASAPORTE',
      tipoIdentificacion: nacionalidad === 'MEX' ? 'NACIONAL_PASAPORTE' : 'EXTRANJERO_PASAPORTE',
      numeroDocumento: docRaw.replace(/</g, ''),
      nacionalidad,
      nombreCompleto,
      sexo,
      ...birth
    };
  }

  // Caso 2: TD1 Credencial INE / ID Oficial (3 líneas de 30 caracteres)
  if (lines.length === 3 && lines[0].length === 30 && lines[1].length === 30 && lines[2].length === 30) {
    const [l1, l2, l3] = lines;
    const docRaw = l1.slice(5, 14);
    const docCheck = l1[14];
    const birthRaw = l2.slice(0, 6);
    const birthCheck = l2[6];
    const sexo = l2[7] === 'M' ? 'H' : l2[7] === 'F' ? 'M' : 'X';
    const expRaw = l2.slice(8, 14);
    const expCheck = l2[14];
    const nacionalidad = l2.slice(15, 18).replace(/</g, '') || l1.slice(2, 5).replace(/</g, '');
    const nombreCompleto = parseMrzNames(l3);

    if (calcularDigitoIcao(docRaw) !== docCheck) {
      return { valido: false, error: 'Dígito verificador ICAO inválido en credencial ID/INE.' };
    }
    if (calcularDigitoIcao(birthRaw) !== birthCheck) {
      return { valido: false, error: 'Dígito verificador ICAO inválido en fecha de nacimiento INE.' };
    }
    if (calcularDigitoIcao(expRaw) !== expCheck) {
      return { valido: false, error: 'Dígito verificador ICAO inválido en vigencia INE.' };
    }

    const birth = parseMrzBirthDate(birthRaw);
    if (!birth) {
      return { valido: false, error: 'Fecha de nacimiento inválida en credencial ID/INE.' };
    }

    return {
      valido: true,
      formato: 'TD1_INE_ID',
      tipoIdentificacion: nacionalidad === 'MEX' ? 'NACIONAL_INE' : 'EXTRANJERO_ID',
      numeroDocumento: docRaw.replace(/</g, ''),
      nacionalidad,
      nombreCompleto,
      sexo,
      ...birth
    };
  }

  return {
    valido: false,
    error: 'Formato MRZ no reconocido. Se esperan 2 líneas de 44 caracteres (Pasaporte) o 3 líneas de 30 caracteres (INE).'
  };
}

export function buildSamplePassportMrz({
  pais = 'USA',
  apellidos = 'ANDERSON',
  nombres = 'MICHAEL JAMES',
  pasaporte = '548920174',
  fechaNacYYMMDD = '840619',
  sexo = 'M',
  expYYMMDD = '310820'
} = {}) {
  const nameField = `${apellidos.replace(/\s+/g, '<')}<<${nombres.replace(/\s+/g, '<')}`.padEnd(39, '<').slice(0, 39);
  const l1 = `P<${pais.padEnd(3, '<').slice(0, 3)}${nameField}`;
  const doc9 = pasaporte.toUpperCase().padEnd(9, '<').slice(0, 9);
  const docChk = calcularDigitoIcao(doc9);
  const bChk = calcularDigitoIcao(fechaNacYYMMDD);
  const eChk = calcularDigitoIcao(expYYMMDD);
  const personal = ''.padEnd(14, '<');
  const pChk = calcularDigitoIcao(personal);
  const composite = `${doc9}${docChk}${fechaNacYYMMDD}${bChk}${expYYMMDD}${eChk}${personal}${pChk}`;
  const finalChk = calcularDigitoIcao(composite);
  const l2 = `${doc9}${docChk}${pais.padEnd(3, '<').slice(0, 3)}${fechaNacYYMMDD}${bChk}${sexo}${expYYMMDD}${eChk}${personal}${pChk}${finalChk}`;
  return `${l1}\n${l2}`;
}
