"""Extractor de estados de cuenta de tarjeta de credito Banamex (Explora, Costco...).

Entrada: PDF con capa de texto. Salida: dict normalizado (ver README).
Signo: en estos estados '+ $X' es un cargo y '- $X' es un abono (pago o reembolso).
"""
from __future__ import annotations

import re
import sys
from typing import Optional

import pdfplumber

from common import (
    clean_banamex_merchant, infer_year, iso, make_check, make_doc, make_plan, make_txn,
    parse_date, parse_installment, parse_money, split_banamex_rfc, write_json,
)

MONEY = r"\$\s?[\d,]+\.\d{2}"
RE_PERIOD = re.compile(r"Periodo:\s*(\d{1,2}-\w{3}-\d{4}) al (\d{1,2}-\w{3}-\d{4})")
RE_CUT = re.compile(r"Fecha de corte:\s*(\d{1,2}-\w{3}-\d{4})")
RE_CARD = re.compile(r"N[uú]mero de tarjeta\s+(\d{4}) (\d{4}) (\d{4}) (\d{4})")
RE_REGULAR = re.compile(r"^(\d{2}-\w{3}-\d{4}) (\d{2}-\w{3}-\d{4}) (.+?) ([+-]) (\$ ?[\d ,.]+)$")
RE_PLAN = re.compile(
    r"^(\d{2}-\w{3}-\d{4}) (.+?) (" + MONEY + r") (" + MONEY + r") (" + MONEY + r") (\d+) de (\d+) (\S+)$"
)
RE_TOTAL = re.compile(r"^Total (cargos|abonos) ([+-]) (\$ ?[\d ,.]+)$")
RE_SUMMARY = {
    "adeudo_anterior": re.compile(r"^Adeudo del periodo anterior = (" + MONEY + ")"),
    "cargos_regulares": re.compile(r"^Cargos regulares \(no a meses\) \+ (" + MONEY + ")"),
    "cargos_meses_capital": re.compile(r"^Cargos compras a meses \(capital\)\d* \+ (" + MONEY + ")"),
    "intereses": re.compile(r"^Monto de Intereses\d* \+ (" + MONEY + ")"),
    "comisiones": re.compile(r"^Monto de comisiones \+ (" + MONEY + ")"),
    "iva": re.compile(r"^IVA de Intereses y comisiones \+ (" + MONEY + ")"),
    "pagos_abonos": re.compile(r"^Pagos y abonos - (" + MONEY + ")"),
    "pago_no_intereses": re.compile(r"^Pago para no generar intereses:?\d* (" + MONEY + ")"),
}


def classify(desc: str, amount: int) -> tuple[str, Optional[dict], str]:
    """Reglas deterministas de tipo para una linea de tarjeta de credito Banamex.

    Devuelve (type, installment, descripcion_sin_marcador).
    """
    up = desc.upper()
    inst, rest = parse_installment(desc)
    if up.startswith("SU ABONO"):
        return "payment", None, desc
    if up.startswith("COMISION") or up.startswith("IVA COMISION"):
        return "fee", None, desc
    if up.startswith("INTERES") or up.startswith("IVA POR INTERES"):
        return "interest", None, desc
    if inst:
        return "installment", inst, rest
    if "DISP. EFECTIV" in up or "DISPOSICION DE EFECTIVO" in up or "DISP EFECTIVO" in up:
        return "cash_withdrawal", None, desc
    if amount < 0:
        return "refund", None, desc
    return "purchase", None, desc


def extract(path: str, document: str, card_key: str) -> dict:
    with pdfplumber.open(path) as pdf:
        lines: list[str] = []
        for page in pdf.pages:
            lines.extend((page.extract_text() or "").split("\n"))

    doc = make_doc(document, card_key, None, None)
    summary: dict[str, int] = {}
    printed: dict[str, int] = {}
    mode: Optional[str] = None  # 'plans' | 'regular'
    holder = "titular"
    start = end = None
    last_plan: Optional[dict] = None
    last_page_marker = None

    for ln in lines:
        ln = ln.strip()
        if not ln:
            continue
        m = RE_PERIOD.search(ln)
        if m and start is None:
            start, end = parse_date(m.group(1)), parse_date(m.group(2))
            doc["period"] = {"start": iso(start), "end": iso(end)}
        m = RE_CUT.search(ln)
        if m:
            doc["as_of"] = iso(parse_date(m.group(1)))
        m = RE_CARD.search(ln)
        if m and "card_last4" not in doc:
            doc["card_last4"] = m.group(4)
            # los 8 primeros digitos identifican la tarjeta en los pagos 'A TB NNNN NNNN' de la cuenta de debito
            doc["card_bin8"] = m.group(1) + m.group(2)
        for key, rx in RE_SUMMARY.items():
            m = rx.match(ln)
            if m and key not in summary:
                summary[key] = parse_money(m.group(1))

        if ln.startswith("COMPRAS Y CARGOS DIFERIDOS A MESES"):
            mode = "plans"
            last_plan = None
            continue
        if ln.startswith("CARGOS, ABONOS Y COMPRAS REGULARES"):
            mode = "regular"
            continue
        m = re.match(r"^Tarjeta (titular|digital):", ln)
        if m and mode:
            holder = m.group(1)
            continue

        if mode == "plans":
            m = RE_PLAN.match(ln)
            if m:
                d, desc, orig, pend, req, n, tot, rate = m.groups()
                with_int = rate.upper() != "NA" and rate.replace("%", "").replace(".", "").isdigit()
                kind = "cash_advance" if "DISP" in desc.upper() else "purchase"
                last_plan = make_plan(
                    merchant=clean_banamex_merchant(desc), original_cents=parse_money(orig),
                    pending_cents=parse_money(pend), monthly_cents=parse_money(req),
                    n_current=int(n), n_total=int(tot),
                    rate_pct=rate.replace("%", "") if with_int else "0.00", with_interest=with_int,
                    op_date=iso(parse_date(d)), kind=kind, holder=holder,
                    op_date_is_latest_installment=True, raw=desc,
                )
                doc["plans"].append(last_plan)
                continue
            if last_plan and re.match(r"^A PAGAR EN ", ln):
                last_plan["note"] = ln
                continue

        if mode == "regular":
            m = RE_TOTAL.match(ln)
            if m:
                printed[m.group(1)] = abs(parse_money(m.group(3)))
                continue
            m = RE_REGULAR.match(ln)
            if m:
                d_op, d_post, desc, sign, amt = m.groups()
                cents = parse_money(amt)
                cents = -cents if sign == "-" else cents
                ttype, inst, rest = classify(desc, cents)
                merchant = clean_banamex_merchant(rest)
                note = None
                if ttype == "cash_withdrawal":
                    note = "disposicion de efectivo"
                    base = re.sub(r"\s*DISP\. EFECTIV(MX)?\s*$", "", rest).strip()
                    merchant = re.sub(r"^\d{3,4} ", "", base).strip() or merchant
                txn = make_txn(
                    date=iso(parse_date(d_op)), post_date=iso(parse_date(d_post)),
                    merchant=merchant, raw=desc, amount_cents=cents, type=ttype,
                    holder=holder, section="digital" if holder == "digital" else "regular",
                    installment=inst, note=note,
                )
                doc["transactions"].append(txn)
                continue

    doc["summary"] = {k: v for k, v in summary.items()}
    txns = doc["transactions"]
    charges = sum(t["amount_cents"] for t in txns if t["amount_cents"] > 0)
    credits = -sum(t["amount_cents"] for t in txns if t["amount_cents"] < 0)
    if "cargos" in printed:
        doc["checks"].append(make_check("total cargos", printed["cargos"], charges))
    else:
        doc["warnings"].append("no se encontro 'Total cargos'")
    if "abonos" in printed:
        doc["checks"].append(make_check("total abonos", printed["abonos"], credits))
    else:
        doc["warnings"].append("no se encontro 'Total abonos'")
    if "pagos_abonos" in summary:
        doc["checks"].append(make_check("pagos y abonos (resumen)", summary["pagos_abonos"], credits))
    plan_monthly = sum(p["monthly_cents"] for p in doc["plans"])
    if "cargos_meses_capital" in summary:
        doc["checks"].append(
            make_check("plans: suma pago requerido = cargos compras a meses (capital)",
                       summary["cargos_meses_capital"], plan_monthly))
    inst_total = sum(t["amount_cents"] for t in txns if t["type"] == "installment")
    doc["checks"].append(make_check("lineas de mensualidad = suma pago requerido de plans", plan_monthly, inst_total))
    if "cargos_regulares" in summary:
        # el resumen no netea los reembolsos aqui: se suman en 'pagos y abonos'
        regular_kinds = sum(
            t["amount_cents"] for t in txns
            if t["amount_cents"] > 0 and t["type"] not in ("installment", "fee", "interest")
        )
        doc["checks"].append(make_check("cargos regulares (resumen) = compras + disposiciones",
                                        summary["cargos_regulares"], regular_kinds))
    fees = sum(t["amount_cents"] for t in txns if t["type"] == "fee")
    ints = sum(t["amount_cents"] for t in txns if t["type"] == "interest")
    if "comisiones" in summary and "intereses" in summary and "iva" in summary:
        doc["checks"].append(make_check(
            "comisiones + intereses + IVA (resumen) = lineas fee+interest",
            summary["comisiones"] + summary["intereses"] + summary["iva"], fees + ints))
    return doc


if __name__ == "__main__":
    pdf_path, out_path, document, card_key = sys.argv[1:5]
    write_json(out_path, extract(pdf_path, document, card_key))
