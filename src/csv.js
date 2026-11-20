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
  const idxHab = findCol('habitacion', 'room', 'cuarto', 'no_habitacion');
  const idxFecha = findCol('fecha_registro', 'fecha_checkin', 'checkin', 'fecha', 'arrival_date');
  const idxTel = findCol('telefono', 'phone', 'celular');
  const idxCorreo = findCol('correo', 'email', 'correo_electronico');
  const idxAcomp = findCol('acompanante', 'tutor', 'companion');

  if (idxNombre === -1 || idxCurp === -1) {
    return {
      error: 'El CSV debe contener al menos las columnas "nombre" y "curp".',
      rows: []
    };
  }

  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCsvLine(lines[i]);
    rows.push({
      linea: i + 1,
      nombre: cols[idxNombre] || '',
      curp: cols[idxCurp] || '',
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
