/**
 * Parser Universal de Lotes PMS (cero dependencias) compatible con:
 * - CSV estándar (,) y CSV Excel México / Zeus / Front2000 (;)
 * - TSV (\t) y archivos delimitados por pipe (|) de Micros-Fidelio / FoxPro / AS400
 * - XML de Oracle OPERA 5 (OXI / Opera Export XML)
 * - Reportes impresos a archivo de texto plano (.txt / .prn) de sistemas heredados sin exportación
 */

import { completarCurpValida } from './curp.js';

const CURP_INLINE_REGEX =
  /\b([A-Z][AEIOUX][A-Z]{2}\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])[HMX](?:AS|BC|BS|CC|CL|CM|CS|CH|DF|DG|GT|GR|HG|JC|MC|MN|MS|NT|NL|OC|PL|QT|QR|SP|SL|SR|TC|TS|TL|VZ|YN|ZS|NE)[B-DF-HJ-NP-TV-Z]{3}[0-9A-Z]\d)\b/i;

/**
 * Detecta el delimitador predominante en la fila de encabezados (`,`, `;`, `|` o `\t`).
 */
function detectDelimiter(headerLine) {
  const candidates = [',', ';', '|', '\t'];
  let best = ',';
  let bestCount = 0;
  for (const delim of candidates) {
    let count = 0;
    let inQuotes = false;
    for (let i = 0; i < headerLine.length; i++) {
      const ch = headerLine[i];
      if (ch === '"') inQuotes = !inQuotes;
      else if (!inQuotes && ch === delim) count++;
    }
    if (count > bestCount) {
      bestCount = count;
      best = delim;
    }
  }
  return best;
}

/**
 * Parsea una línea delimitada respetando campos entrecomillados y comillas escapadas ("").
 */
function parseDelimitedLine(line, delimiter = ',') {
  const result = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        current += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      result.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current.trim());
  return result;
}

/**
 * Parsea reportes impresos en texto plano (.txt / .prn) de sistemas heredados (DOS / FoxPro / AS400 / Windows viejo)
 * que no tienen exportación CSV/XML pero permiten "Imprimir reporte de llegadas a archivo".
 */
export function parseLegacyTextReport(rawText) {
  const lines = String(rawText || '')
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/);

  const rows = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || /^[-=_*#]{4,}$/.test(line)) continue;

    const curpMatch = line.match(CURP_INLINE_REGEX);
    if (!curpMatch) continue;

    const curp = curpMatch[1].toUpperCase();
    const before = line.slice(0, curpMatch.index).trim();
    const after = line.slice(curpMatch.index + curp.length).trim();

    // Extraer habitación (ej. "HAB 204", "CUARTO: 312", o primer bloque numérico 2-4 dígitos)
    const roomMatch =
      after.match(/(?:HAB(?:ITACION)?|ROOM|CUARTO|CTO)[.:\s#]*([A-Z0-9-]{2,8})/i) ||
      before.match(/^(?:HAB[.:\s#]*)?(\d{2,4}[A-Z]?)\s+/i) ||
      after.match(/\b(\d{2,4}[A-Z]?)\b/);
    const habitacion = roomMatch ? roomMatch[1].toUpperCase() : 'Reporte Impreso';

    // Limpiar nombre del huésped desde el texto previo a la CURP
    let nombre = before
      .replace(/^(?:HAB[.:\s#]*)?\d{2,4}[A-Z]?\s*[-|:]?\s*/i, '')
      .replace(/^(?:FOLIO|REG|NO\.?)\s*\d+\s*[-|:]?\s*/i, '')
      .replace(/\b(?:HUESPED|NOMBRE|CLIENTE|PAX)\s*[:=-]\s*/gi, '')
      .replace(/[|;]+/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim();

    if (nombre.length < 3) {
      const afterName = after
        .replace(/(?:HAB(?:ITACION)?|ROOM|CUARTO|CTO)[.:\s#]*[A-Z0-9-]{2,8}/gi, '')
        .replace(/\d{4}-\d{2}-\d{2}(?:[T\s]\d{2}:\d{2}(?::\d{2})?Z?)?/g, '')
        .replace(/[|;]+/g, ' ')
        .replace(/\s{2,}/g, ' ')
        .trim();
      if (afterName.length >= 3) nombre = afterName;
    }

    const dateMatch = line.match(/\b(\d{4}-\d{2}-\d{2}(?:[T\s]\d{2}:\d{2}(?::\d{2})?Z?)?)\b/);

    rows.push({
      linea: i + 1,
      nombre: nombre || `HUESPED ${curp.slice(0, 4)}`,
      curp,
      pasaporte: '',
      nacionalidad: 'MEX',
      fechaNacimiento: '',
      habitacion,
      fechaRegistro: dateMatch ? dateMatch[1] : '',
      telefono: '',
      correo: '',
      acompanante: ''
    });
  }

  if (!rows.length) {
    return {
      error: 'No se detectaron registros con CURP válida dentro del reporte de texto heredado.',
      rows: []
    };
  }

  return { error: null, formato: 'LEGACY_TXT_REPORT', rows };
}

/**
 * Convierte texto delimitado (CSV/TSV/semicolon/pipe) con encabezados en un arreglo de filas normalizadas.
 */
export function parseGuestsCsv(csvText) {
  if (typeof csvText !== 'string' || !csvText.trim()) {
    return { error: 'El archivo CSV está vacío.', rows: [] };
  }

  const lines = csvText
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  if (lines.length < 2) {
    return {
      error: 'El CSV debe incluir fila de encabezados y al menos un huésped.',
      rows: []
    };
  }

  const delimiter = detectDelimiter(lines[0]);
  const rawHeaders = parseDelimitedLine(lines[0], delimiter).map((h) =>
    h
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
  );

  const findCol = (...names) => rawHeaders.findIndex((h) => names.includes(h));
  const idxNombre = findCol(
    'nombre',
    'nombre_completo',
    'huesped',
    'guest_name',
    'full_name',
    'cliente',
    'titular',
    'pax',
    'nombres',
    'first_name',
    'given_name'
  );
  const idxApellido = findCol('apellido', 'apellidos', 'last_name', 'surname', 'apellido_paterno', 'paterno');
  const idxMaterno = findCol('apellido_materno', 'materno');
  const idxCurp = findCol('curp', 'clave_curp', 'identificacion_curp', 'id_curp', 'gov_id', 'tax_id');
  const idxPasaporte = findCol('pasaporte', 'passport', 'documento_extranjero', 'passport_number', 'num_pasaporte');
  const idxNac = findCol('nacionalidad', 'pais', 'nationality', 'country');
  const idxNacFecha = findCol('fecha_nacimiento', 'birth_date', 'dob', 'f_nac', 'nacimiento');
  const idxHab = findCol('habitacion', 'room', 'cuarto', 'no_habitacion', 'hab', 'num_hab', 'room_no', 'room_number', 'cto');
  const idxFecha = findCol('fecha_registro', 'fecha_checkin', 'checkin', 'check_in', 'fecha', 'arrival_date', 'f_llegada', 'llegada', 'entrada');
  const idxTel = findCol('telefono', 'phone', 'celular', 'tel');
  const idxCorreo = findCol('correo', 'email', 'correo_electronico', 'e_mail');
  const idxAcomp = findCol('acompanante', 'tutor', 'companion');

  if (idxNombre === -1 || (idxCurp === -1 && idxPasaporte === -1)) {
    // Fallback automático: si no tiene encabezados estándar pero contiene CURPs en texto plano (ej. reporte impreso DOS/FoxPro)
    const legacyFallback = parseLegacyTextReport(csvText);
    if (!legacyFallback.error && legacyFallback.rows.length > 0) {
      return legacyFallback;
    }
    return {
      error: 'El CSV debe contener al menos "nombre" y "curp" (o "pasaporte").',
      rows: []
    };
  }

  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = parseDelimitedLine(lines[i], delimiter);
    const nombreBase = cols[idxNombre] || '';
    const apellidoPart = idxApellido >= 0 ? cols[idxApellido] || '' : '';
    const maternoPart = idxMaterno >= 0 ? cols[idxMaterno] || '' : '';
    const nombreCompleto = [nombreBase, apellidoPart, maternoPart].filter(Boolean).join(' ').trim();

    rows.push({
      linea: i + 1,
      nombre: nombreCompleto,
      curp: idxCurp >= 0 ? cols[idxCurp] || '' : '',
      pasaporte: idxPasaporte >= 0 ? cols[idxPasaporte] || '' : '',
      nacionalidad: idxNac >= 0 ? cols[idxNac] || '' : '',
      fechaNacimiento: idxNacFecha >= 0 ? cols[idxNacFecha] || '' : '',
      habitacion: idxHab >= 0 ? cols[idxHab] || '' : '',
      fechaRegistro: idxFecha >= 0 ? cols[idxFecha] || '' : '',
      telefono: idxTel >= 0 ? cols[idxTel] || '' : '',
      correo: idxCorreo >= 0 ? cols[idxCorreo] || '' : '',
      acompanante: idxAcomp >= 0 ? cols[idxAcomp] || '' : ''
    });
  }

  const formato =
    delimiter === ';'
      ? 'LEGACY_CSV_SEMICOLON'
      : delimiter === '|'
        ? 'LEGACY_PIPE'
        : delimiter === '\t'
          ? 'LEGACY_TSV'
          : 'CSV';

  return { error: null, formato, rows };
}

/**
 * Parsea exportaciones XML de Oracle OPERA 5 (OXI / Opera Export XML: <G_RESERVATION>, <RESERVATION> o <GUEST>).
 */
export function parseOperaXml(xmlText) {
  if (typeof xmlText !== 'string' || !xmlText.trim()) {
    return { error: 'El archivo XML de OPERA está vacío.', rows: [] };
  }
  const blocks =
    xmlText.match(/<(?:G_RESERVATION|RESERVATION|GUEST)\b[\s\S]*?<\/(?:G_RESERVATION|RESERVATION|GUEST)>/gi) || [];
  if (!blocks.length) {
    return {
      error: 'No se encontraron nodos <RESERVATION>, <G_RESERVATION> o <GUEST> en el XML.',
      rows: []
    };
  }

  const getTag = (block, ...tags) => {
    for (const t of tags) {
      const m = block.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)<\\/${t}>`, 'i'));
      if (m && m[1].trim()) return m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim();
    }
    return '';
  };

  const rows = blocks.map((block, i) => {
    const fullName =
      getTag(block, 'FULL_NAME', 'GUEST_NAME', 'NOMBRE') ||
      `${getTag(block, 'FIRST_NAME', 'GIVEN_NAME')} ${getTag(block, 'LAST_NAME', 'SURNAME')}`.trim();
    return {
      linea: i + 1,
      nombre: fullName,
      curp: getTag(block, 'CURP', 'TAX_ID', 'GOV_ID', 'NATIONAL_ID'),
      pasaporte: getTag(block, 'PASSPORT', 'PASAPORTE', 'DOCUMENT_NUMBER'),
      nacionalidad: getTag(block, 'NATIONALITY', 'NACIONALIDAD', 'COUNTRY'),
      fechaNacimiento: getTag(block, 'BIRTH_DATE', 'DOB', 'FECHA_NACIMIENTO'),
      habitacion: getTag(block, 'ROOM', 'ROOM_NUMBER', 'HABITACION'),
      fechaRegistro: getTag(block, 'ARRIVAL', 'CHECKIN_DATE', 'FECHA_REGISTRO'),
      telefono: getTag(block, 'PHONE', 'TELEFONO'),
      correo: getTag(block, 'EMAIL', 'CORREO'),
      acompanante: getTag(block, 'COMPANION', 'ACOMPANANTE')
    };
  });

  return { error: null, formato: 'OPERA_XML', rows };
}

/**
 * Detecta automáticamente si el lote recibido desde el PMS/Agente es XML (OPERA 5),
 * CSV/TSV/Pipe/Semicolon (Excel, Zeus, Front2000, Fidelio, FoxPro) o un reporte impreso de texto (.txt/.prn).
 */
export function parseGuestBatch(text) {
  const trimmed = String(text || '').replace(/^\uFEFF/, '').trim();
  if (trimmed.startsWith('<')) {
    return parseOperaXml(trimmed);
  }
  return parseGuestsCsv(trimmed);
}

export function generarPlantillaOperaXmlDemo() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<OPERA_INHOUSE_EXPORT hotel="Hotel Piloto Monterrey">
  <G_RESERVATION>
    <FULL_NAME>ALEJANDRO GARZA SADA</FULL_NAME>
    <CURP>${completarCurpValida('GASA820314HNLRLL0')}</CURP>
    <ROOM>1502</ROOM>
    <ARRIVAL>2026-11-24T14:20:00Z</ARRIVAL>
    <EMAIL>agarza@corporativo.mx</EMAIL>
  </G_RESERVATION>
  <G_RESERVATION>
    <FULL_NAME>MICHAEL JAMES ANDERSON</FULL_NAME>
    <PASSPORT>548920174</PASSPORT>
    <NATIONALITY>USA</NATIONALITY>
    <BIRTH_DATE>1984-06-19</BIRTH_DATE>
    <ROOM>1810</ROOM>
    <ARRIVAL>2026-11-24T15:05:00Z</ARRIVAL>
    <EMAIL>manderson@globalmfg.com</EMAIL>
  </G_RESERVATION>
</OPERA_INHOUSE_EXPORT>
`;
}

/**
 * Genera una plantilla CSV lista para descargar o probar la importación masiva.
 */
export function generarPlantillaCsvDemo({ incluirMenorDemo = false, curpMenor = '' } = {}) {
  const header = 'nombre,curp,habitacion,fecha_registro,telefono,correo,acompanante';
  const rows = [
    `SOFIA MARTINEZ GARZA,${completarCurpValida('MAGS930718MNLRTN0')},0804,2026-11-19T14:10:00Z,81-8120-3301,sofia.mg@empresa.mx,`,
    `DIEGO ALBERTO LOZANO RIOS,${completarCurpValida('LORD871204HNLZRS0')},1215,2026-11-19T15:25:00Z,81-1554-8902,dlozano@industrias.mx,`,
    `FERNANDA VILLARREAL CAVAZOS,${completarCurpValida('VICF960228MNLLRN0')},0510,2026-11-19T16:02:00Z,81-1890-4412,fvillarreal@consultora.mx,`,
    `JORGE HUMBERTO SADA ELIZONDO,${completarCurpValida('SAEJ800515HNLDLN0')},1602,2026-11-19T16:40:00Z,81-8332-7741,jsada@corporativo.mx,`,
    `REGISTRO CON ERROR DEMO,CURP_INVALIDA_0000,0301,2026-11-19T17:00:00Z,,error@demo.mx,`
  ];
  if (incluirMenorDemo && curpMenor) {
    rows.unshift(
      `MATEO VALDEZ GARZA,${curpMenor},1408,2026-11-19T17:15:00Z,,sin-correo@demo.mx,ROBERTO SALAZAR MENDOZA`
    );
  }
  return `${header}\n${rows.join('\n')}\n`;
}
