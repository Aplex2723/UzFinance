/**
 * Calculadora segura para el agente: los modelos fallan en aritmética larga (intereses, plazos, porcentajes), así que cada cuenta
 * pasa por aquí. Analizador recursivo propio; nunca `eval` ni `Function`.
 *
 * Gramática: + − * / ^ (potencia), paréntesis, `%` posfijo (15% = 0.15), "$" opcional y las funciones round(x[, n]), ceil, floor, abs,
 * sqrt, min(...), max(...). La coma solo separa argumentos: los números van sin separador de miles (1500, no 1,500).
 */
export class CalcError extends Error {}

const MAX_LEN = 200;
type Tok = { t: "num"; v: number } | { t: "id"; v: string } | { t: "op"; v: string };

function lex(src: string): Tok[] {
  // "10 20" o "1 500" no son un solo número: sin esto, quitar espacios los fundiría en 1020 / 1500.
  if (/[\d.]\s+[\d.]/.test(src)) throw new CalcError("Hay dos números seguidos sin operador (¿escribiste 1 500? usa 1500)");
  const s = src.replace(/[$\s]/g, "").replace(/×/g, "*").replace(/÷/g, "/").replace(/−/g, "-");
  const out: Tok[] = [];
  for (let i = 0; i < s.length; ) {
    const rest = s.slice(i);
    const num = /^(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/i.exec(rest);
    if (num) { out.push({ t: "num", v: Number(num[0]) }); i += num[0].length; continue; }
    const id = /^[a-z]+/i.exec(rest);
    if (id) { out.push({ t: "id", v: id[0].toLowerCase() }); i += id[0].length; continue; }
    if ("+-*/^()%,".includes(rest[0])) { out.push({ t: "op", v: rest[0] }); i++; continue; }
    throw new CalcError(`Carácter no permitido: "${rest[0]}"`);
  }
  return out;
}

const FUNCS: Record<string, (a: number[]) => number> = {
  // Redondeo decimal (1.005 → 1.01): se corre la coma en texto para no heredar el error de la coma flotante.
  round: ([x, n = 0]) => {
    const d = Math.min(Math.max(Math.trunc(n), 0), 10);
    if (/e/i.test(String(x))) return Math.round(x * 10 ** d) / 10 ** d;
    return Number(`${Math.round(Number(`${x}e${d}`))}e-${d}`);
  },
  ceil: ([x]) => Math.ceil(x),
  floor: ([x]) => Math.floor(x),
  abs: ([x]) => Math.abs(x),
  sqrt: ([x]) => Math.sqrt(x),
  min: (a) => Math.min(...a),
  max: (a) => Math.max(...a),
};

export function calculate(expression: string): number {
  if (expression.length > MAX_LEN) throw new CalcError("Expresión demasiado larga");
  const toks = lex(expression);
  if (!toks.length) throw new CalcError("Expresión vacía");
  let p = 0;
  const peek = () => toks[p];
  const isOp = (v: string) => peek()?.t === "op" && (peek() as { v: string }).v === v;

  // expr = term (("+"|"-") term)*
  const expr = (): number => {
    let x = term();
    while (isOp("+") || isOp("-")) x = (toks[p++] as { v: string }).v === "+" ? x + term() : x - term();
    return x;
  };
  const term = (): number => {
    let x = unary();
    while (isOp("*") || isOp("/")) {
      const op = (toks[p++] as { v: string }).v;
      const y = unary();
      if (op === "/" && y === 0) throw new CalcError("División entre cero");
      x = op === "*" ? x * y : x / y;
    }
    return x;
  };
  // El signo liga más flojo que la potencia: -2^2 = -4.
  const unary = (): number => {
    if (isOp("-")) { p++; return -unary(); }
    if (isOp("+")) { p++; return unary(); }
    return power();
  };
  const power = (): number => {
    const base = postfix();
    if (isOp("^")) { p++; return base ** unary(); }
    return base;
  };
  const postfix = (): number => {
    let x = atom();
    while (isOp("%")) { p++; x /= 100; }
    return x;
  };
  const atom = (): number => {
    const tk = toks[p++];
    if (!tk) throw new CalcError("Expresión incompleta");
    if (tk.t === "num") return tk.v;
    if (tk.t === "id") {
      const fn = FUNCS[tk.v];
      if (!fn) throw new CalcError(`Función desconocida: ${tk.v}`);
      if (!isOp("(")) throw new CalcError(`Falta "(" después de ${tk.v}`);
      p++;
      const args: number[] = [];
      if (!isOp(")")) { do { args.push(expr()); } while (isOp(",") && ++p); }
      if (!isOp(")")) throw new CalcError('Falta ")"');
      p++;
      if (!args.length) throw new CalcError(`${tk.v} necesita argumentos`);
      return fn(args);
    }
    if (tk.v === "(") {
      const x = expr();
      if (!isOp(")")) throw new CalcError('Falta ")"');
      p++;
      return x;
    }
    throw new CalcError(`No se esperaba "${tk.v}"`);
  };

  const result = expr();
  if (p < toks.length) throw new CalcError("Sobra texto al final de la expresión (¿escribiste 1,500 con coma? usa 1500)");
  if (!Number.isFinite(result)) throw new CalcError("El resultado no es un número finito");
  // Evita ruido de coma flotante (0.1 + 0.2).
  return Math.round(result * 1e8) / 1e8;
}
