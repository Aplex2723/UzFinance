"""Extractor del estado de cuenta de la tarjeta de credito Nu.

Entrada: PDF con capa de texto. Signo: '+$X' cargo, '-$X' abono.
Las lineas 'Tarjeta virtual **** NNNN' y 'Cambio (USD 1 = $16.96) USD 100.00' que siguen a
un movimiento se anexan a ese movimiento.
"""
from __future__ import annotations

import re
import sys
from typing import Optional

import pdfplumber

from common import (
    iso, make_check, make_doc, make_plan, make_txn, parse_date, parse_installment, parse_money,
    write_json,
)

DATE = r"\d{2} [A-Z]{3} \d{4}"
M = r"\$[\d,]+\.\d{2}"
RE_PERIOD = re.compile(r"Periodo: (" + DATE + r") al (" + DATE + ")")
RE_CUT = re.compile(r"Fecha de corte: (" + DATE + ")")
RE_MOV = re.compile(r"^(" + DATE + r") (" + DATE + r") (.+?) \| RFC: (\S+) ([+-])(" + M + r")$")
RE_PLAN_SIN = re.compile(
    r"^(" + DATE + r") (.+?) (" + M + r") (" + M + r") (" + M + r") (\d+)/(\d+) ([\d.]+)%$")
RE_PLAN_CON = re.compile(
    r"^(" + DATE + r") (" + M + r") (" + M + r") (" + M + r") (" + M + r") (" + M + r") (\d+)/(\d+) ([\d.]+)%$")
RE_VIRTUAL = re.compile(r"^Tarjeta virtual \*+ ?(\d{4})$")
RE_FX = re.compile(r"^Cambio \(([A-Z]{3}) 1 = \$([\d.]+)\) [A-Z]{3} ([\d,]+\.\d{2})$")
RE_TOTAL = re.compile(r"^Total de (cargos|abonos) ([+-])(" + M + ")$")
RE_SUMMARY = {
    "cargos_regulares": re.compile(r"^Cargos regulares \(no a meses\) \+ (" + M + ")"),
    "cargos_meses_capital": re.compile(r"^Cargos y compras a meses \(capital\)\d* \+ (" + M + ")"),
    "intereses": re.compile(r"^Monto de intereses\d* \+ (" + M + ")"),
    "iva": re.compile(r"^IVA de intereses y comisiones\d* \+ (" + M + ")"),
    "pagos_abonos": re.compile(r"^Pagos y abonos - (" + M + ")"),
}


def classify(desc: str, amount: int) -> tuple[str, Optional[dict], str, Optional[str]]:
    """(type, installment, descripcion_limpia, nota)."""
    low = desc.lower()
    if "grácias por tu pago" in low or "gracias por tu pago" in low:
        return "payment", None, desc, None
    if low.startswith("disposición de saldo en cuenta nu"):
        if low.endswith("- intereses"):
            return "interest", None, "Disposición de saldo en Cuenta Nu (intereses)", "intereses del plan de disposicion"
        inst, rest = parse_installment(desc)
        return "installment", inst, rest, "capital de plan de disposicion de saldo (cash_advance)"
    if low.startswith("iva sobre intereses"):
        return "interest", None, desc, "IVA sobre intereses de plan de pagos fijos"
    inst, rest = parse_installment(desc)
    if inst:
        return "installment", inst, rest, None
    if amount < 0:
        return "refund", None, desc, None
    return "purchase", None, desc, None


def _plan_with_interest(m, desc: str, holder: str) -> dict:
    d, orig, pend, interest, iva, req, n, tot, rate = m.groups()
    inst, merchant = parse_installment(desc)
    kind = "cash_advance" if desc.lower().startswith("disposición de saldo") else "purchase"
    return make_plan(
        merchant=merchant, original_cents=parse_money(orig), pending_cents=parse_money(pend),
        monthly_cents=parse_money(req), n_current=int(n), n_total=int(tot), rate_pct=rate,
        with_interest=True, op_date=iso(parse_date(d)), kind=kind, holder=holder,
        note=f"intereses del periodo {interest}, IVA {iva}", interest_cents=parse_money(interest),
        iva_cents=parse_money(iva),
    )


def extract(path: str, document: str = "nu_stmt", card_key: str = "nu") -> dict:
    with pdfplumber.open(path) as pdf:
        lines: list[str] = []
        for page in pdf.pages:
            lines.extend(l.strip() for l in (page.extract_text() or "").split("\n"))
    lines = [l for l in lines if l]

    doc = make_doc(document, card_key, None, None)
    summary: dict[str, int] = {}
    printed: dict[str, int] = {}
    mode: Optional[str] = None
    holder: Optional[str] = None
    holder_name: Optional[str] = None
    current: Optional[dict] = None

    i = 0
    while i < len(lines):
        ln = lines[i]
        i += 1
        m = RE_PERIOD.search(ln)
        if m and doc["period"] is None:
            doc["period"] = {"start": iso(parse_date(m.group(1))), "end": iso(parse_date(m.group(2)))}
        m = RE_CUT.search(ln)
        if m:
            doc["as_of"] = iso(parse_date(m.group(1)))
        m = re.search(r"N[uú]mero de tarjeta: X+-X+-X+-(\d{4})", ln)
        if m and "card_last4" not in doc:
            doc["card_last4"] = m.group(1)
        for key, rx in RE_SUMMARY.items():
            m = rx.match(ln)
            if m and key not in summary:
                summary[key] = parse_money(m.group(1))

        if ln.startswith("COMPRAS Y CARGOS DIFERIDOS A MESES SIN INTERESES"):
            mode = "plans_sin"
            continue
        if ln.startswith("COMPRAS Y CARGOS DIFERIDOS A MESES CON INTERESES"):
            mode = "plans_con"
            continue
        if ln.startswith("CARGOS, ABONOS Y COMPRAS REGULARES"):
            mode = "regular"
            current = None
            continue
        m = re.match(r"^Tarjeta titular: (.+)$", ln)
        if m:
            holder_name = m.group(1).strip()
            continue
        if ln.startswith("NOTAS ACLARATORIAS"):
            mode = None
            continue

        if mode == "plans_sin":
            m = RE_PLAN_SIN.match(ln)
            if m:
                d, desc, orig, pend, req, n, tot, rate = m.groups()
                _, merchant = parse_installment(desc)
                doc["plans"].append(make_plan(
                    merchant=merchant, original_cents=parse_money(orig), pending_cents=parse_money(pend),
                    monthly_cents=parse_money(req), n_current=int(n), n_total=int(tot), rate_pct=rate,
                    with_interest=False, op_date=iso(parse_date(d)), kind="purchase", holder=holder_name))
        elif mode == "plans_con":
            m = RE_PLAN_CON.match(ln)
            if m:
                prev = lines[i - 2]
                nxt = lines[i] if i < len(lines) else ""
                desc = f"{prev} {nxt}".strip()
                doc["plans"].append(_plan_with_interest(m, desc, holder_name))
        elif mode == "regular":
            m = RE_TOTAL.match(ln)
            if m:
                printed[m.group(1)] = abs(parse_money(m.group(3)))
                current = None
                continue
            m = RE_MOV.match(ln)
            if m:
                d_op, d_post, desc, rfc, sign, amt = m.groups()
                cents = parse_money(amt)
                cents = -cents if sign == "-" else cents
                ttype, inst, clean, note = classify(desc, cents)
                current = make_txn(
                    date=iso(parse_date(d_op)), post_date=iso(parse_date(d_post)), merchant=clean,
                    raw=desc, amount_cents=cents, type=ttype, holder=holder_name, section="regular",
                    installment=inst, note=note, rfc=None if rfc == "S.I." else rfc,
                )
                doc["transactions"].append(current)
                continue
            if current is not None:
                mv = RE_VIRTUAL.match(ln)
                mf = RE_FX.match(ln)
                if mv:
                    current["holder"] = "virtual"
                    current["section"] = "virtual"
                    extra = f"tarjeta virtual **** {mv.group(1)} (titular: {holder_name})"
                    current["note"] = f"{current['note']}; {extra}" if current["note"] else extra
                    current["raw"] += " " + ln
                elif mf:
                    cur, fx, amount = mf.groups()
                    current["raw"] += " " + ln
                    if cur != "MXN":
                        current["foreign"] = {"currency": cur, "amount": amount.replace(",", ""), "fx": fx}
                elif ln.startswith("Abono ("):
                    current["raw"] += " " + ln
                    current["note"] = (current["note"] + "; " if current["note"] else "") + ln

    doc["summary"] = summary
    txns = doc["transactions"]
    charges = sum(t["amount_cents"] for t in txns if t["amount_cents"] > 0)
    credits = -sum(t["amount_cents"] for t in txns if t["amount_cents"] < 0)
    if "cargos" in printed:
        # el 'Total de cargos' impreso NO incluye las lineas 'IVA sobre intereses' (46.50 en
        # este estado) aunque se listen entre los movimientos; el resumen las muestra aparte.
        iva_lines = sum(
            t["amount_cents"] for t in txns
            if t["amount_cents"] > 0 and t["raw"].lower().startswith("iva sobre intereses"))
        doc["checks"].append(make_check(
            "total cargos (impreso) + IVA sobre intereses listado aparte", printed["cargos"] + iva_lines, charges))
    if "abonos" in printed:
        doc["checks"].append(make_check("total abonos", printed["abonos"], credits))
    if "pagos_abonos" in summary:
        doc["checks"].append(make_check("pagos y abonos (resumen)", summary["pagos_abonos"], credits))
    # el resumen separa regulares / meses (capital) / intereses / IVA
    inst_cap = sum(t["amount_cents"] for t in txns if t["type"] == "installment")
    ints = sum(t["amount_cents"] for t in txns if t["type"] == "interest")
    if "cargos_meses_capital" in summary:
        doc["checks"].append(make_check("cargos a meses (capital, resumen) = lineas installment",
                                        summary["cargos_meses_capital"], inst_cap))
    if "intereses" in summary and "iva" in summary:
        doc["checks"].append(make_check("intereses + IVA (resumen) = lineas interest",
                                        summary["intereses"] + summary["iva"], ints))
    if "cargos_regulares" in summary:
        reg = sum(t["amount_cents"] for t in txns if t["amount_cents"] > 0 and t["type"] in ("purchase",))
        doc["checks"].append(make_check("cargos regulares (resumen) = compras", summary["cargos_regulares"], reg))
    plan_req = sum(p["monthly_cents"] for p in doc["plans"])
    doc["checks"].append(make_check(
        "plans: pago requerido (sin+con intereses) = lineas installment (capital)", plan_req, inst_cap))
    return doc


if __name__ == "__main__":
    write_json(sys.argv[2], extract(sys.argv[1]))
