export class MoneyParseError extends Error {}

/**
 * Convierte "$1,234.50", "1234.5", "MXN 99", -45.2 o 12 (pesos) a centavos enteros.
 * Sin aritmética de punto flotante para strings. Rechaza ambigüedades.
 */
export function parseAmountToCents(input: string | number): number {
  if (typeof input === "number") {
    if (!Number.isFinite(input)) throw new MoneyParseError("monto no finito");
    const c = Math.round(input * 100);
    return check(c);
  }
  let s = input.trim().toUpperCase().replace(/MXN|MX\$|\$|\s/g, "");
  let neg = false;
  if (s.startsWith("-")) {
    neg = true;
    s = s.slice(1);
  } else if (s.startsWith("(") && s.endsWith(")")) {
    neg = true;
    s = s.slice(1, -1);
  }
  if (!/^(\d{1,3}(,\d{3})+|\d+)(\.\d{1,2})?$/.test(s)) throw new MoneyParseError("formato de monto inválido");
  const [intPart, frac = ""] = s.replace(/,/g, "").split(".");
  const cents = Number(intPart) * 100 + Number(frac.padEnd(2, "0"));
  return check(neg ? -cents : cents);
}

function check(cents: number): number {
  if (!Number.isSafeInteger(cents) || cents === 0) throw new MoneyParseError("monto fuera de rango o cero");
  if (Math.abs(cents) > 100_000_000_00) throw new MoneyParseError("monto demasiado grande");
  return cents;
}

const mxn = new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" });
const mxnCompact = new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN", maximumFractionDigits: 0 });

export function formatMXN(cents: number, opts: { compact?: boolean } = {}): string {
  return (opts.compact ? mxnCompact : mxn).format(cents / 100);
}
