/**
 * Correos FICTICIOS con la estructura real de Banamex (tabla "Etiqueta | valor").
 * Nombres, dígitos y autorizaciones son inventados: este repo puede ser público.
 */
const rows = (r: [string, string][]) => r.map(([k, v]) => `${k}\n${v}`).join("\n");

const FOOT = rows([["Fecha de corte", "18 septiembre 2026"], ["Fecha límite de pago", "8 octubre 2026"], ["Mínimo a pagar", "$800.00"]]);

export const A = {
  subject: "Retiro/Compra con tarjeta Banamex",
  receivedAt: new Date("2026-10-01T18:45:00Z"),
  body: `1 oct 2026, 12:44 h.
Se realizó la siguiente operación: Retiro / Compra
JUAN EJEMPLO PEREZ
EXPLORA BANAMEX**000
${rows([["Monto", "$1,423.58"], ["Establecimiento", "FERRETERIA EJEMPLO SA"], ["Fecha y hora", "2026/10/1 12:44:22 PM"], ["Estatus", "Exitoso"], ["No. Autorización", "000000"]])}
Información importante de tu tarjeta
${FOOT}`,
};

export const B = {
  subject: "Retiro/Compra con tarjeta adicional",
  receivedAt: new Date("2026-10-01T23:17:30Z"),
  body: `Oct 01, 2026 05:16:59 PM
Se realizó la siguiente operación: Retiro / Compra
MARIA EJEMPLO LOPEZ
EXPLORA BANAMEX Adicional 000
${rows([["Monto", "$ 1,119.11"], ["Establecimiento", "SERVICIO EJEMPLO CR MU CIU"], ["Fecha y hora", "01 Octubre 2026 / 17:16:59"], ["Estatus", "Exitoso"], ["No. Autorización", "000001"]])}`,
};

export const C = {
  subject: "Retiro/Compra con cuenta Banamex",
  receivedAt: new Date("2026-09-22T23:32:00Z"),
  body: `Se realizó la siguiente operación: Retiro / Compra
Tarjeta M.N. ***000
${rows([["Monto", "$ 159.00 M.N."], ["Establecimiento", "GOOGLE YOUTUBE CR CIUDAD DE MEX001MX"], ["Fecha y hora", "22 Septiembre 2026 / 17:31:00"], ["Estatus", "Exitoso"], ["No. Autorización", "000002"]])}`,
};

export const D = (merchant = "AMERICAN EXPRESS CO", amount = "$37,999.72") => ({
  subject: "Cargo a cuenta para pago a Establecimiento",
  receivedAt: new Date("2026-10-02T02:18:00Z"),
  body: `Se realizó la domiciliación de tu pago
${rows([
    ["Operación", "Cargo a cuenta para pago a Establecimiento"],
    ["Establecimiento", merchant],
    ["Cuenta de cargo", "000"],
    ["Referencia establecimiento", "***0000"],
    ["Referencia 4", "M00000000000000000 PYBO"],
    ["Monto", amount],
    ["Fecha y hora", "01/10/26 20:17:22 PM"],
    ["No. Autorización", "S000 0000000000"],
  ])}`,
});

export const E = {
  subject: "Depósito a Cuenta o Tarjeta Banamex",
  receivedAt: new Date("2026-07-22T16:29:00Z"),
  body: `Se recibió un depósito
CLASICA BANAMEX**000
${rows([["Monto", "$ 326.24"], ["Medio", "MOBILE"], ["Fecha y hora", "22 Julio 2026 / 10:28:32"], ["No. Autorización", "000003"]])}
Información importante de tu tarjeta
${FOOT}`,
};

export const IGNORED_SUBJECTS = [
  "Alta de cuenta",
  "Modificación de cuenta(s)",
  "Cambio de preferencias de Notificaciones",
  "Notificación de cambio de NIP",
  "Aviso de modificación de Monto Transaccional",
  "Confirmación de modificación de Monto Transaccional",
  "Superaste tu límite de transacción",
  "Rechazo de cargo a cuenta para Domiciliación",
  "Contratación de ahorro fácil",
  "Creación de ahorro fácil",
  "Modificación de ahorro fácil",
  "Cuenta MICUENTA te da la Bienvenida",
];

/** Mismo correo con otras formas de plano: todo en una línea, tabuladores y "|". */
export const asOneLine = (body: string) => body.replace(/\n+/g, " ");
const FIELDS = "(Monto|Establecimiento|Fecha y hora|Estatus|No\\. Autorización)";
export const asPipes = (body: string) => body.replace(new RegExp(`\\n${FIELDS}\\n`, "g"), "\n$1 | ");
export const asTabs = (body: string) => body.replace(new RegExp(`\\n${FIELDS}\\n`, "g"), "\n$1\t");
