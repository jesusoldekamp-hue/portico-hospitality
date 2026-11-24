/**
 * Parser RFC-4180 ligero (cero dependencias) y generador de plantilla CSV
 * compatible con exportaciones de PMS (Oracle OPERA, Cloudbeds, Zeus, Excel).
 */

import { completarCurpValida } from './curp.js';

/**
 * Parsea una línea CSV respetando campos entrecomillados y comillas escapadas ("").
 */
function parseCsvLine(line) {
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
    } else if (ch === ',') {
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
 * Convierte texto CSV con encabezados en un arreglo de filas normalizadas.
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

  const rawHeaders = parseCsvLine(lines[0]).map((h) =>
    h
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/\s+/g, '_')
  );

  const findCol = (...names) => rawHeaders.findIndex((h) => names.includes(h));
  const idxNombre = findCol('nombre', 'nombre_completo', 'huesped', 'guest_name', 'full_name');
  const idxCurp = findCol('curp', 'clave_curp', 'identificacion_curp');
  const idxPasaporte = findCol('pasaporte', 'passport', 'documento_extranjero', 'passport_number');
  const idxNac = findCol('nacionalidad', 'pais', 'nationality', 'country');
  const idxNacFecha = findCol('fecha_nacimiento', 'birth_date', 'dob');
  const idxHab = findCol('habitacion', 'room', 'cuarto', 'no_habitacion');
  const idxFecha = findCol('fecha_registro', 'fecha_checkin', 'checkin', 'fecha', 'arrival_date');
  const idxTel = findCol('telefono', 'phone', 'celular');
  const idxCorreo = findCol('correo', 'email', 'correo_electronico');
  const idxAcomp = findCol('acompanante', 'tutor', 'companion');

  if (idxNombre === -1 || (idxCurp === -1 && idxPasaporte === -1)) {
    return {
      error: 'El CSV debe contener al menos "nombre" y "curp" (o "pasaporte").',
      rows: []
    };
  }

  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCsvLine(lines[i]);
    rows.push({
      linea: i + 1,
      nombre: cols[idxNombre] || '',
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

  return { error: null, rows };
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
 * Detecta automáticamente si el lote recibido desde el PMS/Agente es XML (OPERA 5) o CSV.
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
<OPERA_INHOUSE_EXPORT hotel="Crowne Plaza Monterrey">
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
 * Incluye registros válidos, un registro con CURP inválida para mostrar el filtro RENAPO
 * y opcionalmente la CURP de demostración del menor para comprobar detección Fase 3 en lote.
 */
export function generarPlantillaCsvDemo({ incluirMenorDemo = false, curpMenor = '' } = {}) {
  const header = 'nombre,curp,habitacion,fecha_registro,telefono,correo,acompanante';
  const rows = [
    `SOFIA MARTINEZ GARZA,${completarCurpValida('MAGS930718MNLRTN0')},0804,2026-11-19T14:10:00Z,81-8120-3301,sofia.mg@empresa.mx,`,
    `DIEGO ALBERTO LOZANO RIOS,${completarCurpValida('LORD871204HNLZRS0')},1215,2026-11-19T15:25:00Z,81-1554-8902,dlozano@industrias.mx,`,
    `FERNANDA VILLARREAL CAVAZOS,${completarCurpValida('VICF960228MNLLRN0')},0510,2026-11-19T16:02:00Z,81-1890-4412,fvillarreal@consultora.mx,`,
    `JORGE HUMBERTO SADA ELIZONDO,${completarCurpValida('SAEJ800515HNLDLN0')},1602,2026-11-19T16:40:00Z,81-8332-7741,jsada@corporativo.mx,`,
    `REGISTRO CON ERROR DE CAPTURA,XXXX999999HNLZZZ00,0301,2026-11-19T17:00:00Z,81-0000-0000,error@demo.mx,`
  ];

  if (incluirMenorDemo && curpMenor) {
    rows.splice(
      2,
      0,
      `MATEO VALDEZ GARZA,${curpMenor},1408,2026-11-19T17:15:00Z,,sin-correo@demo.mx,ROBERTO SALAZAR MENDOZA`
    );
  }

  return `${header}\n${rows.join('\n')}\n`;
}
