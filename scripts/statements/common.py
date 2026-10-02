"""Utilidades compartidas por los extractores de estados de cuenta.

Funciones puras (sin I/O) para parsear dinero, fechas, marcadores de mensualidades
y limpiar nombres de comercio, mas helpers para armar el JSON normalizado.
Todo el dinero se maneja como enteros en centavos.
"""
from __future__ import annotations

import json
import re
import unicodedata
from datetime import date, timedelta
from typing import Any, Optional

# --------------------------------------------------------------------------- meses

MONTHS: dict[str, int] = {}
for _i, _names in enumerate(
    [
        ("ene", "enero", "jan", "january"),
        ("feb", "febrero", "february"),
        ("mar", "marzo", "march"),
        ("abr", "abril", "apr", "april"),
        ("may", "mayo"),
        ("jun", "junio", "june"),
        ("jul", "julio", "july"),
        ("ago", "agosto", "aug", "august"),
        ("sep", "sept", "septiembre", "setiembre", "september"),
        ("oct", "octubre", "october"),
        ("nov", "noviembre", "november"),
        ("dic", "diciembre", "dec", "december"),
    ],
    start=1,
):
    for _n in _names:
        MONTHS[_n] = _i


def _norm(s: str) -> str:
    """minusculas sin acentos."""
    s = unicodedata.normalize("NFD", s)
    return "".join(c for c in s if unicodedata.category(c) != "Mn").lower()


def month_number(name: str) -> Optional[int]:
    return MONTHS.get(_norm(name).strip("."))


# --------------------------------------------------------------------------- dinero

_MONEY_RE = re.compile(r"^([+-])?\$?(\d[\d,]*)(?:\.(\d{1,2}))?$")


def parse_money(s: str) -> int:
    """Convierte texto de dinero a centavos (con signo si trae + o -).

    Soporta '$1,487.42', '+$1,487.42', '- $18,890.87', '-$16,050.00' y digitos
    separados por espacios como '$ 1 2 5 . 0 0'. Sin punto decimal se interpretan pesos.
    """
    t = re.sub(r"\s+", "", s)
    t = t.replace("−", "-")  # signo menos unicode
    m = _MONEY_RE.match(t)
    if not m:
        raise ValueError(f"monto no reconocido: {s!r}")
    sign, whole, frac = m.groups()
    cents = int(whole.replace(",", "")) * 100 + int((frac or "0").ljust(2, "0"))
    return -cents if sign == "-" else cents


def cents_to_str(c: int) -> str:
    sign = "-" if c < 0 else ""
    c = abs(c)
    return f"{sign}{c // 100:,}.{c % 100:02d}"


# --------------------------------------------------------------------------- fechas

_RE_DMY_DASH = re.compile(r"(\d{1,2})-([A-Za-z]{3,4})-(\d{4})")
_RE_DMY_SPACE = re.compile(r"(\d{1,2}) ([A-Za-z]{3,10}) (\d{4})")
_RE_D_DE_M = re.compile(r"(\d{1,2}) ?de ?([A-Za-záéíóú]+)(?: ?de ?(\d{4}))?", re.I)
_RE_DM = re.compile(r"(\d{1,2}) ([A-Za-z]{3,10})")
_RE_ISO = re.compile(r"(\d{4})-(\d{2})-(\d{2})")


def _mk(y: int, m: int, d: int) -> date:
    return date(y, m, d)


def parse_date(s: str, year: Optional[int] = None, not_after: Optional[date] = None) -> Optional[date]:
    """Parsea fechas de los estados de cuenta.

    Formatos: 'dd-mon-yyyy', 'dd MON yyyy', 'dd de Mes [de yyyy]' (tambien pegado:
    'dd deMes'), 'dd Mon' (requiere year) e ISO. Si falta el ano se usa `year`; si
    ademas se da `not_after` y la fecha resultante lo excede, se resta un ano.
    """
    s = s.strip()
    m = _RE_ISO.fullmatch(s)
    if m:
        return _mk(*map(int, m.groups()))
    m = _RE_DMY_DASH.fullmatch(s) or _RE_DMY_SPACE.fullmatch(s)
    if m:
        mo = month_number(m.group(2))
        if mo is None:
            return None
        return _mk(int(m.group(3)), mo, int(m.group(1)))
    m = _RE_D_DE_M.fullmatch(s)
    if m:
        mo = month_number(m.group(2))
        if mo is None:
            return None
        y = int(m.group(3)) if m.group(3) else year
        if y is None:
            return None
        d = _mk(y, mo, int(m.group(1)))
        if not m.group(3) and not_after and d > not_after:
            d = _mk(y - 1, mo, int(m.group(1)))
        return d
    m = _RE_DM.fullmatch(s)
    if m and year is not None:
        mo = month_number(m.group(2))
        if mo is None:
            return None
        d = _mk(year, mo, int(m.group(1)))
        if not_after and d > not_after:
            d = _mk(year - 1, mo, int(m.group(1)))
        return d
    return None


def infer_year(day: int, month: int, start: date, end: date) -> int:
    """Ano de una fecha 'dd MON' dentro de un periodo [start, end]."""
    for y in (start.year, end.year):
        try:
            d = date(y, month, day)
        except ValueError:
            continue
        if start - timedelta(days=3) <= d <= end + timedelta(days=3):
            return y
    return end.year


def iso(d: Optional[date]) -> Optional[str]:
    return d.isoformat() if d else None


# --------------------------------------------------------------------------- mensualidades

_INST_PATTERNS = [
    re.compile(r"\((\d{1,3}):(\d{1,3})\)"),  # (013:024)
    re.compile(r"\bCARGO\s+(\d{1,2})\s+DE\s*(\d{1,2})\b", re.I),  # CARGO 05 DE 06 / DE03
    re.compile(r"\b(\d{3}) de (\d{3})\b", re.I),  # 012 de 024
    re.compile(r"\s+-\s*(\d{1,2})/(\d{1,2})\b"),  # - 1/3
    re.compile(r"(?<![\d/])(\d{1,2})/(\d{1,2})$"),  # 1/3 al final
]


def parse_installment(text: str) -> tuple[Optional[dict], str]:
    """Busca un marcador de mensualidad. Devuelve ({'n','total'} | None, texto sin marcador)."""
    for pat in _INST_PATTERNS:
        m = pat.search(text)
        if m:
            n, total = int(m.group(1)), int(m.group(2))
            if total < 1 or n > total:
                continue
            cleaned = (text[: m.start()] + " " + text[m.end():]).strip()
            return {"n": n, "total": total}, re.sub(r"\s+", " ", cleaned)
    return None, text


# --------------------------------------------------------------------------- comercios

# RFC (o parte de el) al final de la descripcion Banamex:
#   [letras 0-4][AAMMDD][2-3 homoclave][MX|EX opcional]
_RFC_RE = re.compile(r"^[A-Z&Ñ]{0,4}\d{6}[A-Z0-9]{2,3}(?:MX|EX)?$")
_COUNTRY_CODES = {"MX", "NL", "US", "ES", "GB", "DE", "FR", "IE", "CA", "SG", "LU", "AR", "BR", "CL", "CO", "PE"}
_STATE_CODES = {"VER", "YUC", "CDMX", "DF", "MEX", "NL", "QR", "JAL"}


def _collapse_spaced_letters(tokens: list[str]) -> list[str]:
    """'K E T E N' -> 'KETEN' (corridas de >=3 letras sueltas)."""
    out: list[str] = []
    i = 0
    while i < len(tokens):
        j = i
        while j < len(tokens) and len(tokens[j]) == 1 and tokens[j].isalpha():
            j += 1
        if j - i >= 3:
            out.append("".join(tokens[i:j]))
            i = j
        else:
            out.append(tokens[i])
            i += 1
    return out


def split_banamex_rfc(desc: str) -> tuple[str, Optional[str], Optional[str]]:
    """Separa la descripcion en (comercio, codigo_adquirente, rfc).

    Quita el RFC final y el codigo de 2-3 letras mayusculas que lo precede. Si no hay
    RFC, no se toca nada salvo pais/estado final. El texto original debe conservarse
    en 'raw' por quien llama.
    """
    toks = desc.split()
    rfc = acq = None
    if toks and toks[-1] in ("MX", "EX") and len(toks) > 1 and _RFC_RE.match(toks[-2]):
        toks = toks[:-1]
    if toks and _RFC_RE.match(toks[-1]) and any(ch.isdigit() for ch in toks[-1]):
        rfc = toks.pop()
        if len(toks) > 1 and re.fullmatch(r"[A-Z]{2,3}", toks[-1]):
            acq = toks.pop()
    elif len(toks) > 2 and toks[-1] in _COUNTRY_CODES:
        # sin RFC: 'UBER *EATS AMSTERDAM NL', 'SERV COSTA VERDE VERACRUZ VER MX'
        cc = toks.pop()
        if cc == "MX":
            if toks and toks[-1] in _STATE_CODES:
                toks.pop()
        elif len(toks) > 1:
            toks.pop()  # ciudad
    toks = _collapse_spaced_letters(toks)
    return " ".join(toks), acq, rfc


def clean_banamex_merchant(desc: str, known: Optional[dict[str, str]] = None) -> str:
    """Nombre de comercio limpio a partir de una descripcion de tarjeta Banamex.

    `known` es un diccionario opcional {clave_sin_espacios: nombre_limpio} con marcas
    ya conocidas (sirve para las descripciones pegadas de las exportaciones en imagen).
    """
    _, cleaned = parse_installment(desc)
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    if known:
        key = re.sub(r"[^A-Z0-9*]", "", cleaned.upper())
        best = None
        for k, v in known.items():
            if key.startswith(k) and (best is None or len(k) > len(best[0])):
                best = (k, v)
        if best:
            return best[1]
    merchant, _, _ = split_banamex_rfc(cleaned)
    return merchant or cleaned


# Ciudades / estados que Amex pega al final del comercio (frases, de mas larga a mas corta)
AMEX_CITY_PHRASES = [
    "CIUDAD DE MEX", "SOUTH SAN FRANC", "HTTPS://HELP.UB", "BOCA DEL RIO", "BENITO JUAREZ",
    "MEXICO CITY", "MERIDA YUC", "VERACRUZ VER", "MERIDA", "M?RIDA", "VERACRUZ", "YUCATAN",
    "APODACA", "CONKAL", "CDMX", "MEXICO", "YUC", "VER", "DF", "MX", "KANASIN",
]


def split_amex_city(text: str) -> tuple[str, Optional[str]]:
    """Separa 'COMERCIO CIUDAD' -> (comercio, ciudad). Conserva al menos una palabra."""
    work = re.sub(r"\s+", " ", text).strip()
    city_parts: list[str] = []
    changed = True
    while changed:
        changed = False
        up = work.upper()
        for ph in sorted(AMEX_CITY_PHRASES, key=len, reverse=True):
            if up.endswith(" " + ph):
                city_parts.insert(0, work[-len(ph):])
                work = work[: -len(ph)].rstrip()
                changed = True
                break
    return work, (" ".join(city_parts) if city_parts else None)


_CSV_CITIES = {"merida", "mexico city", "boca del rio", "cdmx", "veracruz", "cancun", "progreso"}


def split_csv_city(text: str) -> tuple[str, Optional[str]]:
    """'TDA LEONA DIAMANTE (Merida)' -> (comercio, 'Merida'). Solo si el parentesis es una ciudad."""
    m = re.fullmatch(r"(.*?)\s*\(([^()]*)\)\s*", text)
    if m and _norm(m.group(2)) in _CSV_CITIES:
        return m.group(1).strip(), m.group(2).strip()
    return text.strip(), None


# --------------------------------------------------------------------------- JSON normalizado

TXN_TYPES = {
    "purchase", "fee", "interest", "payment", "installment", "installment_credit",
    "transfer_own", "transfer_out", "income", "domiciliation_card_payment",
    "domiciliation_other", "cash_withdrawal", "tax", "refund",
}


def make_txn(
    *, date: Optional[str], merchant: str, raw: str, amount_cents: int, type: str,
    post_date: Optional[str] = None, time: Optional[str] = None, holder: Optional[str] = None,
    section: str = "regular", installment: Optional[dict] = None, pending: bool = False,
    foreign: Optional[dict] = None, note: Optional[str] = None, **extra: Any,
) -> dict:
    assert type in TXN_TYPES, type
    assert isinstance(amount_cents, int)
    t = {
        "date": date, "post_date": post_date, "time": time, "merchant": merchant,
        "raw": re.sub(r"\s+", " ", raw).strip(), "amount_cents": amount_cents, "type": type,
        "holder": holder, "section": section, "installment": installment, "pending": pending,
        "foreign": foreign, "note": note,
    }
    t.update(extra)
    return t


def make_plan(
    *, merchant: str, original_cents: int, pending_cents: int, monthly_cents: int,
    n_current: int, n_total: int, rate_pct: str = "0.00", with_interest: bool = False,
    op_date: Optional[str] = None, kind: str = "purchase", holder: Optional[str] = None,
    note: Optional[str] = None, **extra: Any,
) -> dict:
    p = {
        "merchant": merchant, "original_cents": original_cents, "pending_cents": pending_cents,
        "monthly_cents": monthly_cents, "n_current": n_current, "n_total": n_total,
        "rate_pct": rate_pct, "with_interest": with_interest, "op_date": op_date,
        "kind": kind, "holder": holder, "note": note,
    }
    p.update(extra)
    return p


def make_check(name: str, expected_cents: int, actual_cents: int, tolerance: int = 0, unit: str = "cents") -> dict:
    """unit='cents' (importes) o 'count' (conteos; en ese caso los campos *_cents guardan el conteo)."""
    c = {
        "name": name, "expected_cents": expected_cents, "actual_cents": actual_cents,
        "ok": abs(expected_cents - actual_cents) <= tolerance,
    }
    if unit != "cents":
        c["unit"] = unit
    return c


def make_doc(document: str, card_key: str, period: Optional[dict], as_of: Optional[str], **extra: Any) -> dict:
    d = {
        "document": document, "card_key": card_key, "period": period, "as_of": as_of,
        "transactions": [], "plans": [], "checks": [], "warnings": [],
    }
    d.update(extra)
    return d


def write_json(path: str, obj: Any) -> None:
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=2)
        f.write("\n")


def sum_cents(txns: list[dict], pred=lambda t: True) -> int:
    return sum(t["amount_cents"] for t in txns if pred(t))


def group_lines(words: list[dict], tol: float = 2.5) -> list[list[dict]]:
    """Agrupa palabras de pdfplumber en renglones por cercania vertical (top)."""
    lines: list[list[dict]] = []
    for w in sorted(words, key=lambda w: (w["top"], w["x0"])):
        if lines and abs(lines[-1][0]["top"] - w["top"]) <= tol:
            lines[-1].append(w)
        else:
            lines.append([w])
    for ln in lines:
        ln.sort(key=lambda w: w["x0"])
    return lines
