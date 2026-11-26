/**
 * Certeza ID — Padrón Sintético de Pruebas (Sandbox DOF / PUI)
 * 50 registros ficticios con CURP matemáticamente válida ante RENAPO (dígito verificador real),
 * casos de menores de edad (Art. 58 Ley General de Turismo) y pasaportes internacionales (MRZ).
 *
 * AVISO LEGAL: Por disposición de los Lineamientos PUI (DOF 27/11/2025) y la LFPDPPP,
 * este padrón contiene EXCLUSIVAMENTE datos sintéticos de demostración; no almacena
 * información personal de víctimas reales del RNPDNO.
 */

(function (globalScope) {
  const ENTIDADES = {
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
    NE: 'Extranjero'
  };

  const DICCIONARIO = '0123456789ABCDEFGHIJKLMNÑOPQRSTUVWXYZ';
  const CURP_REGEX =
    /^[A-Z][AEIOUX][A-Z]{2}\d{2}(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])[HMX](AS|BC|BS|CC|CL|CM|CS|CH|DF|DG|GT|GR|HG|JC|MC|MN|MS|NT|NL|OC|PL|QT|QR|SP|SL|SR|TC|TS|TL|VZ|YN|ZS|NE)[B-DF-HJ-NP-TV-Z]{3}[0-9A-Z]\d$/;

  function calcularDigitoVerificador(curp17) {
    let suma = 0;
    for (let i = 0; i < 17; i++) {
      const idx = DICCIONARIO.indexOf(curp17[i]);
      if (idx === -1) return '0';
      suma += idx * (18 - i);
    }
    return String((10 - (suma % 10)) % 10);
  }

  function completarCurp(curp17) {
    const base = String(curp17).trim().toUpperCase().slice(0, 17);
    return base + calcularDigitoVerificador(base);
  }

  function validarCurpRenapo(raw) {
    if (typeof raw !== 'string') return { valida: false, error: 'Ingresa una CURP de 18 caracteres.' };
    const curp = raw.trim().toUpperCase();
    if (curp.length !== 18) {
      return { valida: false, curp, error: 'La CURP debe tener exactamente 18 caracteres.' };
    }
    if (!CURP_REGEX.test(curp)) {
      return { valida: false, curp, error: 'La estructura no coincide con el formato oficial de RENAPO.' };
    }
    const yy = Number(curp.slice(4, 6));
    const mm = Number(curp.slice(6, 8));
    const dd = Number(curp.slice(8, 10));
    const siglo = /\d/.test(curp[16]) ? 1900 : 2000;
    const anio = siglo + yy;
    const d = new Date(Date.UTC(anio, mm - 1, dd));
    if (d.getUTCFullYear() !== anio || d.getUTCMonth() !== mm - 1 || d.getUTCDate() !== dd) {
      return { valida: false, curp, error: 'La fecha de nacimiento dentro de la CURP no es válida.' };
    }
    const esperado = calcularDigitoVerificador(curp.slice(0, 17));
    if (esperado !== curp[17]) {
      return { valida: false, curp, error: `Dígito verificador RENAPO inválido (se esperaba ${esperado}).` };
    }
    const hoy = new Date();
    let edad = hoy.getUTCFullYear() - anio;
    const mDiff = hoy.getUTCMonth() + 1 - mm;
    if (mDiff < 0 || (mDiff === 0 && hoy.getUTCDate() < dd)) edad--;
    const codigoEntidad = curp.slice(11, 13);
    return {
      valida: true,
      curp,
      fechaNacimiento: `${anio}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`,
      edad,
      esMenor: edad < 18,
      sexo: curp[10],
      codigoEntidad,
      entidad: ENTIDADES[codigoEntidad] || 'México'
    };
  }

  // Semillas 100% sintéticas (50 registros: 22 PUI adulto, 12 PUI menor / AMBER, 8 pasaporte extranjero, 8 control sin alerta)
  const RAW_SEEDS = [
    // --- 12 MENORES CON ALERTA PUI / AMBER (Activan Sigilo SEGOB + Protocolo Art. 58 LGT) ---
    { id: 'SBX-001', fub: 'FUB-SANDBOX-NL-04182', nombre: 'MATEO VALDEZ GARZA', curp17: 'VAGM120815HNLZLDA', categoria: 'MENOR_PUI', estado: 'Nuevo León', fechaReporte: '2026-11-18', tipo: 'Alerta AMBER / PUI Menor', acompanante: 'ROBERTO SALAZAR MENDOZA', parentesco: 'NO_ACREDITO', nota: 'Menor de edad con reporte activo; acompañante no acredita tutela.' },
    { id: 'SBX-002', fub: 'FUB-SANDBOX-DF-04209', nombre: 'SOFIA CAMILA RIOS MENDEZ', curp17: 'RIMS140322MDFMDNA', categoria: 'MENOR_PUI', estado: 'Ciudad de México', fechaReporte: '2026-11-14', tipo: 'Alerta AMBER / PUI Menor', acompanante: 'JORGE ALBERTO LUNA', parentesco: 'NO_ACREDITO', nota: 'Menor reportada en CDMX; requiere bloqueo Art. 58 LGT y aviso silencioso.' },
    { id: 'SBX-003', fub: 'FUB-SANDBOX-JC-04115', nombre: 'DIEGO EMILIANO TORRES SOTO', curp17: 'TOSD110904HJCRSTA', categoria: 'MENOR_PUI', estado: 'Jalisco', fechaReporte: '2026-10-29', tipo: 'Alerta AMBER / PUI Menor', acompanante: 'PATRICIA VEGA', parentesco: 'NO_ACREDITO', nota: 'Cruce en tiempo real Fase 3 + validación obligatoria de parentesco.' },
    { id: 'SBX-004', fub: 'FUB-SANDBOX-NL-04088', nombre: 'VALENTINA CRUZ HERRERA', curp17: 'CUHV150611MNLZRLA', categoria: 'MENOR_PUI', estado: 'Nuevo León', fechaReporte: '2026-11-02', tipo: 'Alerta AMBER / PUI Menor', acompanante: 'SIN_ACOMPANANTE', parentesco: 'NO_ACREDITO', nota: 'Menor viajando sin tutela acreditada.' },
    { id: 'SBX-005', fub: 'FUB-SANDBOX-MC-03994', nombre: 'SANTIAGO MORALES DIAZ', curp17: 'MODS101127HMCRLDA', categoria: 'MENOR_PUI', estado: 'Estado de México', fechaReporte: '2026-10-15', tipo: 'Alerta AMBER / PUI Menor', acompanante: 'HECTOR GOMEZ', parentesco: 'NO_ACREDITO', nota: 'Coincidencia de menor en monitoreo continuo Fase 3.' },
    { id: 'SBX-006', fub: 'FUB-SANDBOX-CL-04041', nombre: 'REGINA NAVARRO FLORES', curp17: 'NAFR130219MCLVRFA', categoria: 'MENOR_PUI', estado: 'Coahuila', fechaReporte: '2026-10-22', tipo: 'Alerta AMBER / PUI Menor', acompanante: 'LUIS FERNANDO REYES', parentesco: 'NO_ACREDITO', nota: 'Reporte interestatal Coahuila-Nuevo León.' },
    { id: 'SBX-007', fub: 'FUB-SANDBOX-TS-04133', nombre: 'SEBASTIAN ORTIZ LUNA', curp17: 'OILS120503HTSRZLA', categoria: 'MENOR_PUI', estado: 'Tamaulipas', fechaReporte: '2026-11-05', tipo: 'Alerta AMBER / PUI Menor', acompanante: 'MARIO CASTILLO', parentesco: 'NO_ACREDITO', nota: 'Alerta prioritaria corredor noreste.' },
    { id: 'SBX-008', fub: 'FUB-SANDBOX-GT-03877', nombre: 'CAMILA VARGAS MEDINA', curp17: 'VAMC140729MGTRGDA', categoria: 'MENOR_PUI', estado: 'Guanajuato', fechaReporte: '2026-09-30', tipo: 'Alerta AMBER / PUI Menor', acompanante: 'RAUL MENDOZA', parentesco: 'NO_ACREDITO', nota: 'Activación simultánea de sigilo en mostrador y verificación LGT.' },
    { id: 'SBX-009', fub: 'FUB-SANDBOX-PL-04012', nombre: 'LEONARDO SILVA CAMPOS', curp17: 'SICL110114HPLLVMA', categoria: 'MENOR_PUI', estado: 'Puebla', fechaReporte: '2026-10-18', tipo: 'Alerta AMBER / PUI Menor', acompanante: 'SERGIO PAREDES', parentesco: 'NO_ACREDITO', nota: 'Reporte activo con búsqueda nacional PUI.' },
    { id: 'SBX-010', fub: 'FUB-SANDBOX-VZ-03951', nombre: 'RENATA DELGADO PAREDES', curp17: 'DEPR160408MVZLGRA', categoria: 'MENOR_PUI', estado: 'Veracruz', fechaReporte: '2026-10-08', tipo: 'Alerta AMBER / PUI Menor', acompanante: 'CLAUDIA SOSA', parentesco: 'NO_ACREDITO', nota: 'Menor de 10 años sin documento oficial de tutela.' },
    { id: 'SBX-011', fub: 'FUB-SANDBOX-QR-04190', nombre: 'EMILIANO PEÑA SOLIS', curp17: 'PESM131021HQRNSLA', categoria: 'MENOR_PUI', estado: 'Quintana Roo', fechaReporte: '2026-11-12', tipo: 'Alerta AMBER / PUI Menor', acompanante: 'ANDRES DOMINGUEZ', parentesco: 'NO_ACREDITO', nota: 'Destino turístico; dispara protocolo Art. 58 LGT y webhook SEGOB.' },
    { id: 'SBX-012', fub: 'FUB-SANDBOX-CH-04066', nombre: 'MARIANA GUERRERO LEAL', curp17: 'GULM121209MCHRRRA', categoria: 'MENOR_PUI', estado: 'Chihuahua', fechaReporte: '2026-10-25', tipo: 'Alerta AMBER / PUI Menor', acompanante: 'ARTURO SALAS', parentesco: 'NO_ACREDITO', nota: 'Búsqueda nacional activa Fase 3.' },

    // --- 22 ADULTOS CON ALERTA PUI ACTIVA (Sigilo total en recepción + Webhook Fase 2/3) ---
    { id: 'SBX-013', fub: 'FUB-SANDBOX-NL-03910', nombre: 'ELENA RODRIGUEZ CAVAZOS', curp17: 'ROCE910422MNLDRL0', categoria: 'ADULTO_PUI', estado: 'Nuevo León', fechaReporte: '2026-05-01', tipo: 'Reporte PUI Adulto (Histórico + Vivo)', nota: 'Coincidencia histórica Fase 2 y monitoreo continuo Fase 3.' },
    { id: 'SBX-014', fub: 'FUB-SANDBOX-NL-04104', nombre: 'ALEJANDRO CANTU VILLARREAL', curp17: 'CAVA880714HNLNTR0', categoria: 'ADULTO_PUI', estado: 'Nuevo León', fechaReporte: '2026-10-28', tipo: 'Reporte PUI Adulto', nota: 'Check-in normal en mostrador; aviso cifrado silencioso a SEGOB.' },
    { id: 'SBX-015', fub: 'FUB-SANDBOX-DF-04019', nombre: 'MARIA FERNANDA LOPEZ RUIZ', curp17: 'LORF941103MDFPZR0', categoria: 'ADULTO_PUI', estado: 'Ciudad de México', fechaReporte: '2026-10-12', tipo: 'Reporte PUI Adulto', nota: 'Búsqueda federal activa en todo el país.' },
    { id: 'SBX-016', fub: 'FUB-SANDBOX-JC-03882', nombre: 'RICARDO MENDOZA AGUILAR', curp17: 'MEAR840218HJCNDG0', categoria: 'ADULTO_PUI', estado: 'Jalisco', fechaReporte: '2026-09-24', tipo: 'Reporte PUI Adulto', nota: 'Reporte PUI activo con notificación inmediata Fase 3.' },
    { id: 'SBX-017', fub: 'FUB-SANDBOX-MC-04152', nombre: 'GABRIELA SANCHEZ ORTEGA', curp17: 'SAOG970625MMCNCR0', categoria: 'ADULTO_PUI', estado: 'Estado de México', fechaReporte: '2026-11-06', tipo: 'Reporte PUI Adulto', nota: 'Envío silencioso con acuse criptográfico SHA-256.' },
    { id: 'SBX-018', fub: 'FUB-SANDBOX-SL-03965', nombre: 'JAVIER HERNANDEZ CASTRO', curp17: 'HECJ890912HSLRNS0', categoria: 'ADULTO_PUI', estado: 'Sinaloa', fechaReporte: '2026-10-04', tipo: 'Reporte PUI Adulto', nota: 'Sin alertas visibles para el personal de recepción.' },
    { id: 'SBX-019', fub: 'FUB-SANDBOX-SR-04077', nombre: 'PAOLA MARTINEZ FLORES', curp17: 'MAFP950330MSRRTF0', categoria: 'ADULTO_PUI', estado: 'Sonora', fechaReporte: '2026-10-21', tipo: 'Reporte PUI Adulto', nota: 'Cruce en milisegundos contra padrón activo.' },
    { id: 'SBX-020', fub: 'FUB-SANDBOX-BC-04121', nombre: 'FERNANDO RAMIREZ GOMEZ', curp17: 'RAGF860508HBCMZG0', categoria: 'ADULTO_PUI', estado: 'Baja California', fechaReporte: '2026-11-01', tipo: 'Reporte PUI Adulto', nota: 'Reporte interestatal frontera norte.' },
    { id: 'SBX-021', fub: 'FUB-SANDBOX-TS-03930', nombre: 'ANDREA JIMENEZ VAZQUEZ', curp17: 'JIVA990819MTSMNZ0', categoria: 'ADULTO_PUI', estado: 'Tamaulipas', fechaReporte: '2026-09-29', tipo: 'Reporte PUI Adulto', nota: 'Notificación automática al endpoint oficial PUI.' },
    { id: 'SBX-022', fub: 'FUB-SANDBOX-CL-04055', nombre: 'DANIEL PEREZ SALINAS', curp17: 'PESD920111HCLRLN0', categoria: 'ADULTO_PUI', estado: 'Coahuila', fechaReporte: '2026-10-19', tipo: 'Reporte PUI Adulto', nota: 'Coincidencia positiva en check-in de prueba.' },
    { id: 'SBX-023', fub: 'FUB-SANDBOX-QT-04166', nombre: 'LUCIA MORENO HERRERA', curp17: 'MOHL961204MQTRNR0', categoria: 'ADULTO_PUI', estado: 'Querétaro', fechaReporte: '2026-11-09', tipo: 'Reporte PUI Adulto', nota: 'Bitácora inmutable sellada por RFC.' },
    { id: 'SBX-024', fub: 'FUB-SANDBOX-SP-03988', nombre: 'OSCAR GARCIA MEDINA', curp17: 'GAMO830427HSPRCD0', categoria: 'ADULTO_PUI', estado: 'San Luis Potosí', fechaReporte: '2026-10-09', tipo: 'Reporte PUI Adulto', nota: 'Validación RENAPO + envío outbox seguro.' },
    { id: 'SBX-025', fub: 'FUB-SANDBOX-GT-04091', nombre: 'MONICA REYES JUAREZ', curp17: 'REJM930702MGTYSR0', categoria: 'ADULTO_PUI', estado: 'Guanajuato', fechaReporte: '2026-10-26', tipo: 'Reporte PUI Adulto', nota: 'Búsqueda nacional PUI activa.' },
    { id: 'SBX-026', fub: 'FUB-SANDBOX-MN-04140', nombre: 'IVAN DOMINGUEZ ROJAS', curp17: 'DORI871016HMNMNJ0', categoria: 'ADULTO_PUI', estado: 'Michoacán', fechaReporte: '2026-11-04', tipo: 'Reporte PUI Adulto', nota: 'Cruce local sin exponer datos a terceros.' },
    { id: 'SBX-027', fub: 'FUB-SANDBOX-VZ-03902', nombre: 'CLAUDIA CASTRO ROMERO', curp17: 'CARC900209MVZSTM0', categoria: 'ADULTO_PUI', estado: 'Veracruz', fechaReporte: '2026-09-21', tipo: 'Reporte PUI Adulto', nota: 'Notificación Fase 3 con folio UUID4.' },
    { id: 'SBX-028', fub: 'FUB-SANDBOX-PL-04028', nombre: 'HUGO VAZQUEZ NUNEZ', curp17: 'VANH850621HPLZQN0', categoria: 'ADULTO_PUI', estado: 'Puebla', fechaReporte: '2026-10-14', tipo: 'Reporte PUI Adulto', nota: 'Sigilo RBAC garantizado en recepción.' },
    { id: 'SBX-029', fub: 'FUB-SANDBOX-YN-04175', nombre: 'DIANA ALVAREZ PECH', curp17: 'AAPD980317MYNLVR0', categoria: 'ADULTO_PUI', estado: 'Yucatán', fechaReporte: '2026-11-11', tipo: 'Reporte PUI Adulto', nota: 'Cruce inmediato con bitácora auditable.' },
    { id: 'SBX-030', fub: 'FUB-SANDBOX-QR-04005', nombre: 'JORGE LUIS MEJIA CRUZ', curp17: 'MECJ910905HQRJZR0', categoria: 'ADULTO_PUI', estado: 'Quintana Roo', fechaReporte: '2026-10-11', tipo: 'Reporte PUI Adulto', nota: 'Reporte PUI activo en corredor turístico.' },
    { id: 'SBX-031', fub: 'FUB-SANDBOX-CH-03944', nombre: 'PATRICIA LUNA CHAVEZ', curp17: 'LUCP881129MCHNCH0', categoria: 'ADULTO_PUI', estado: 'Chihuahua', fechaReporte: '2026-10-02', tipo: 'Reporte PUI Adulto', nota: 'Verificación silenciosa sin frenar check-in.' },
    { id: 'SBX-032', fub: 'FUB-SANDBOX-NL-04199', nombre: 'RAUL EDUARDO GARZA TREVINO', curp17: 'GATR940513HNLRZV0', categoria: 'ADULTO_PUI', estado: 'Nuevo León', fechaReporte: '2026-11-16', tipo: 'Reporte PUI Adulto', nota: 'Reporte metropolitano de prueba Monterrey.' },
    { id: 'SBX-033', fub: 'FUB-SANDBOX-DF-04061', nombre: 'VERONICA SOTO CAMPOS', curp17: 'SOCV890807MDFTMP0', categoria: 'ADULTO_PUI', estado: 'Ciudad de México', fechaReporte: '2026-10-20', tipo: 'Reporte PUI Adulto', nota: 'Reporte nacional activo Fase 3.' },
    { id: 'SBX-034', fub: 'FUB-SANDBOX-JC-04158', nombre: 'RODRIGO IBARRA ESPINOZA', curp17: 'IAER920403HJCBRP0', categoria: 'ADULTO_PUI', estado: 'Jalisco', fechaReporte: '2026-11-07', tipo: 'Reporte PUI Adulto', nota: 'Validación instantánea con acuse PDF.' },

    // --- 8 PASAPORTES EXTRANJEROS (MRZ ICAO 9303 a $0 — 4 con alerta, 4 sin alerta, 2 menores LGT) ---
    { id: 'SBX-035', fub: 'FUB-SANDBOX-INT-0901', nombre: 'EMILY GRACE CARTER', documento: 'PASAPORTE', pasaporte: 'US548920114', nacionalidad: 'USA', fechaNacimiento: '2013-06-14', esMenor: true, categoria: 'EXTRANJERO_PUI', estado: 'Extranjero (USA)', fechaReporte: '2026-11-10', tipo: 'Pasaporte Extranjero · Menor LGT + PUI', acompanante: 'MARK DAVIS', parentesco: 'NO_ACREDITO', nota: 'Menor extranjera con pasaporte MRZ; activa protocolo Art. 58 LGT y aviso silencioso.' },
    { id: 'SBX-036', fub: 'FUB-SANDBOX-INT-0902', nombre: 'LIAM ALEXANDER MILLER', documento: 'PASAPORTE', pasaporte: 'CA773219408', nacionalidad: 'CAN', fechaNacimiento: '1991-02-22', esMenor: false, categoria: 'EXTRANJERO_PUI', estado: 'Extranjero (CAN)', fechaReporte: '2026-10-30', tipo: 'Pasaporte Extranjero · Alerta PUI', nota: 'Lectura óptica MRZ a $0 por escaneo + cruce silencioso.' },
    { id: 'SBX-037', fub: 'FUB-SANDBOX-INT-0903', nombre: 'SOFIA ISABEL ALVAREZ', documento: 'PASAPORTE', pasaporte: 'CO992841520', nacionalidad: 'COL', fechaNacimiento: '1996-09-11', esMenor: false, categoria: 'EXTRANJERO_PUI', estado: 'Extranjero (COL)', fechaReporte: '2026-11-03', tipo: 'Pasaporte Extranjero · Alerta PUI', nota: 'Huésped sin CURP validada vía pasaporte internacional.' },
    { id: 'SBX-038', fub: 'FUB-SANDBOX-INT-0904', nombre: 'LUCAS MARTIN GOMEZ', documento: 'PASAPORTE', pasaporte: 'AR441209873', nacionalidad: 'ARG', fechaNacimiento: '2011-04-05', esMenor: true, categoria: 'EXTRANJERO_PUI', estado: 'Extranjero (ARG)', fechaReporte: '2026-11-15', tipo: 'Pasaporte Extranjero · Menor LGT + PUI', acompanante: 'CARLOS RUIZ', parentesco: 'NO_ACREDITO', nota: 'Menor extranjero sin tutela acreditada.' },
    { id: 'SBX-039', fub: null, nombre: 'HANNAH CLAIRE THOMPSON', documento: 'PASAPORTE', pasaporte: 'GB610482931', nacionalidad: 'GBR', fechaNacimiento: '1989-08-19', esMenor: false, categoria: 'EXTRANJERO_OK', estado: 'Extranjero (GBR)', fechaReporte: null, tipo: 'Pasaporte Extranjero · Sin alerta', nota: 'Viajera de negocios británica; check-in limpio en milisegundos.' },
    { id: 'SBX-040', fub: null, nombre: 'KENJI TAKAHASHI', documento: 'PASAPORTE', pasaporte: 'JP832019447', nacionalidad: 'JPN', fechaNacimiento: '1984-11-02', esMenor: false, categoria: 'EXTRANJERO_OK', estado: 'Extranjero (JPN)', fechaReporte: null, tipo: 'Pasaporte Extranjero · Sin alerta', nota: 'Ejecutivo extranjero; lectura MRZ sin costo adicional.' },
    { id: 'SBX-041', fub: null, nombre: 'MARIE CLAIRE DUBOIS', documento: 'PASAPORTE', pasaporte: 'FR209841765', nacionalidad: 'FRA', fechaNacimiento: '1993-05-27', esMenor: false, categoria: 'EXTRANJERO_OK', estado: 'Extranjero (FRA)', fechaReporte: null, tipo: 'Pasaporte Extranjero · Sin alerta', nota: 'Sin reportes activos; cero notificaciones a SEGOB.' },
    { id: 'SBX-042', fub: null, nombre: 'NOAH BENJAMIN CLARK', documento: 'PASAPORTE', pasaporte: 'US390148229', nacionalidad: 'USA', fechaNacimiento: '2015-01-12', esMenor: true, categoria: 'EXTRANJERO_OK', estado: 'Extranjero (USA)', fechaReporte: null, tipo: 'Menor Extranjero · Con padres (LGT OK)', acompanante: 'SARAH CLARK (MADRE)', parentesco: 'ACTA_Y_PASAPORTE', nota: 'Menor sin alerta PUI; parentesco verificado conforme a Art. 58 LGT.' },

    // --- 8 CONTROLES NEGATIVOS NACIONALES (Sin alerta PUI — para demostrar operación limpia) ---
    { id: 'SBX-043', fub: null, nombre: 'CARLOS EDUARDO TREVINO GARZA', curp17: 'TEGC850910HNLVRN0', categoria: 'CONTROL_OK', estado: 'Nuevo León', fechaReporte: null, tipo: 'Huésped sin alerta (Control)', nota: 'Check-in cotidiano; valida CURP RENAPO y cierra sin enviar avisos.' },
    { id: 'SBX-044', fub: null, nombre: 'VALERIA MONTEMAYOR GARZA', curp17: 'MOGV900614MNLNRL0', categoria: 'CONTROL_OK', estado: 'Nuevo León', fechaReporte: null, tipo: 'Huésped sin alerta (Control)', nota: 'Viajera ejecutiva; registro instantáneo y bitácora limpia.' },
    { id: 'SBX-045', fub: null, nombre: 'ROBERTO CARLOS ELIZONDO SADA', curp17: 'EISR791203HNLZND0', categoria: 'CONTROL_OK', estado: 'Nuevo León', fechaReporte: null, tipo: 'Huésped sin alerta (Control)', nota: 'Sin coincidencias en PUI; privacidad 100% preservada.' },
    { id: 'SBX-046', fub: null, nombre: 'ANA SOFIA ZAMBRANO LOZANO', curp17: 'ZALA950318MNLMRZ0', categoria: 'CONTROL_OK', estado: 'Nuevo León', fechaReporte: null, tipo: 'Huésped sin alerta (Control)', nota: 'Check-in validado sin fricción en mostrador.' },
    { id: 'SBX-047', fub: null, nombre: 'MIGUEL ANGEL QUINTANILLA', curp17: 'QUAM820725HCLNTN0', categoria: 'CONTROL_OK', estado: 'Coahuila', fechaReporte: null, tipo: 'Huésped sin alerta (Control)', nota: 'Validación oficial RENAPO exitosa.' },
    { id: 'SBX-048', fub: null, nombre: 'MARTHA PATRICIA SALINAS', curp17: 'SAMP761009MDFLLN0', categoria: 'CONTROL_OK', estado: 'Ciudad de México', fechaReporte: null, tipo: 'Huésped sin alerta (Control)', nota: 'Sin reporte activo; cero datos enviados a Gobernación.' },
    { id: 'SBX-049', fub: null, nombre: 'EMILIO GARZA VILLARREAL', curp17: 'GAVE150520HNLRZL0', categoria: 'CONTROL_MENOR_OK', estado: 'Nuevo León', fechaReporte: null, tipo: 'Menor sin alerta · Con padres (LGT OK)', acompanante: 'LAURA VILLARREAL (MADRE)', parentesco: 'ACTA_NACIMIENTO', nota: 'Menor sin alerta PUI; parentesco acreditado en recepción.' },
    { id: 'SBX-050', fub: null, nombre: 'SOFIA TREVINO CANTU', curp17: 'TECS130811MNLVRN0', categoria: 'CONTROL_MENOR_BLOQUEO', estado: 'Nuevo León', fechaReporte: null, tipo: 'Menor sin alerta · Sin acreditar tutela (Bloqueo LGT)', acompanante: 'TERCERO SIN DOCUMENTO', parentesco: 'NO_ACREDITO', nota: 'No tiene alerta PUI, pero la Ley General de Turismo obliga a negar hospedaje sin acreditar parentesco.' }
  ];

  // Normalizar y calcular CURPs válidas RENAPO para los 50 registros
  const RECORDS = RAW_SEEDS.map((item) => {
    if (item.documento === 'PASAPORTE') {
      const birthYear = Number(item.fechaNacimiento.slice(0, 4));
      return {
        ...item,
        curp: null,
        identificador: item.pasaporte,
        edad: 2026 - birthYear,
        tieneAlertaPui: Boolean(item.fub)
      };
    }
    const curp = completarCurp(item.curp17);
    const val = validarCurpRenapo(curp);
    return {
      ...item,
      documento: 'CURP / INE',
      curp,
      identificador: curp,
      pasaporte: null,
      nacionalidad: 'MEX',
      fechaNacimiento: val.fechaNacimiento,
      edad: val.edad,
      esMenor: val.esMenor,
      tieneAlertaPui: Boolean(item.fub)
    };
  });

  const api = {
    version: '2026.1-SANDBOX',
    total: RECORDS.length,
    records: RECORDS,
    validarCurpRenapo,
    completarCurp,
    buscarPorIdentificador(query) {
      const clean = String(query || '').trim().toUpperCase();
      if (!clean) return null;
      return (
        RECORDS.find(
          (r) =>
            (r.curp && r.curp === clean) ||
            (r.pasaporte && r.pasaporte === clean) ||
            (r.fub && r.fub.toUpperCase() === clean) ||
            r.id === clean
        ) || null
      );
    }
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (globalScope) {
    globalScope.HOSPITALITY_SANDBOX_REGISTRY = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);
