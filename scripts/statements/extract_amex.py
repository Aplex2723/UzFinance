"""Extractor del estado de cuenta American Express (Platinum) con posiciones de palabras.

Peculiaridades que resuelve:
  * la fecha se parte en dos renglones ('28 de' / 'Agosto', o pegada 'deAgosto') y puede
    quedar en la pagina siguiente a la del importe;
  * los movimientos pertenecen al bloque del tarjetahabiente que CIERRA con el renglon
    'Total de las transacciones en $ de <NOMBRE> <monto>' (el total va DESPUES de sus lineas);
  * seccion en moneda extranjera cerrada con 'Total de Transacciones en Moneda Extranjera de';
  * 'CR' al final = credito (pago, reembolso o 'MONTO A DIFERIR ...').
Las mensualidades que Amex carga cada mes ('MESES EN AUTOMATICO ...', 'Total de Meses sin
Intereses') se devuelven en `installment_postings` (NO en transactions) y el consolidado
('Resumen de Meses sin Intereses') en `plans`.
"""
from __future__ import annotations

import re
import sys
from datetime import date
from typing import Optional

import pdfplumber

from common import (
    group_lines, iso, make_check, make_doc, make_plan, make_txn, month_number, parse_date,
    parse_money, split_amex_city, write_json,
)

AMT = re.compile(r"^\d{1,3}(?:,\d{3})*\.\d{2}$")
MONTH_NAMES = {"enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre",
               "octubre", "noviembre", "diciembre"}


def _words_text(ws) -> str:
    return " ".join(w["text"] for w in ws)


def _merchant_key(s: str) -> set[str]:
    return {t for t in re.findall(r"[A-Z0-9]{4,}", s.upper().replace("*", " ")) if t not in {"MEXICO", "CITY", "MERCADOPAGO"}}


def link_plan(plans: list[dict], merchant: str, amount: int, n: Optional[int] = None) -> Optional[dict]:
    """Plan cuya mensualidad coincide (<=5 centavos) y comparte alguna palabra con el comercio."""
    best = None
    for p in plans:
        if abs(p["monthly_cents"] - amount) > 5:
            continue
        if n is not None and p["n_current"] != n:
            continue
        overlap = len(_merchant_key(merchant) & _merchant_key(p["merchant"]))
        if overlap or ("AUTOM" in merchant.upper() and "AUTOM" in p["merchant"].upper()):
            score = (overlap, -abs(p["monthly_cents"] - amount))
            if best is None or score > best[0]:
                best = (score, p)
    return {"merchant": best[1]["merchant"], "original_cents": best[1]["original_cents"]} if best else None


def extract(path: str, document: str = "amex_stmt", card_key: str = "amex") -> dict:
    pdf = pdfplumber.open(path)
    doc = make_doc(document, card_key, None, None)
    text1 = pdf.pages[0].extract_text() or ""
    m = re.search(r"Per[ií]odo de Facturaci[oó]n Del (\d{1,2}) de ?(\w+) al ?(\d{1,2}) de ?(\w+) de ?(\d{4})", text1)
    start = end = None
    if m:
        end = date(int(m.group(5)), month_number(m.group(4)), int(m.group(3)))
        sm = month_number(m.group(2))
        start = date(end.year if sm <= end.month else end.year - 1, sm, int(m.group(1)))
        doc["period"] = {"start": iso(start), "end": iso(end)}
        doc["as_of"] = iso(end)
    year = end.year if end else 2026
    mc = re.search(r"(\d{4})-(\d{6})-(\d{5})", text1)
    if mc:
        doc["card_last5"] = mc.group(3)
    summ = re.search(r"([\d,]+\.\d{2}) - ([\d,]+\.\d{2}) \+ ([\d,]+\.\d{2}) = ([\d,]+\.\d{2}) ([\d,]+\.\d{2})", text1)
    summary = {}
    if summ:
        keys = ["saldo_anterior", "creditos", "nuevos_cargos", "pago_no_intereses", "pago_minimo"]
        summary = {k: parse_money(v) for k, v in zip(keys, summ.groups())}
    nt = re.search(r"Nuevas transacciones: ([\d,]+\.\d{2})", text1)
    if nt:
        summary["nuevas_transacciones"] = parse_money(nt.group(1))
    doc["summary"] = summary

    mode: Optional[str] = None
    block: list[dict] = []  # transacciones pendientes de asignar a un titular
    cur: Optional[dict] = None
    cur_has_month = True
    totals: list[tuple[str, str, int]] = []  # (kind, name, cents)
    printed: dict = {}
    postings: list[dict] = []
    plans_rows: list[dict] = []
    cur_plan: Optional[dict] = None

    def finish_date(t: dict):
        if t is None:
            return
        if t.get("_day") and t.get("_month"):
            d = parse_date(f"{t['_day']} de {t['_month']}", year=year, not_after=end)
            t["date"] = iso(d)

    for page in pdf.pages:
        words = page.extract_words()
        lines = group_lines(words, tol=3.0)
        for ln in lines:
            top = ln[0]["top"]
            txt = _words_text(ln)
            if txt.startswith("Fecha y Detalle de las operaciones"):
                if mode not in ("msi_monthly",):
                    mode = "txn"
                continue
            if txt.startswith("Transacciones de Meses sin Intereses"):
                mode = "msi_monthly"
                cur = None
                continue
            if txt.startswith("Consolidado de compras en Meses sin"):
                mode = "plans"
                cur_plan = None
                continue
            if txt.startswith("Paga desde los canales"):
                mode = None
                continue
            if top < 135 or top > 742:
                continue
            if mode in ("txn", "msi_monthly"):
                amt_words = [w for w in ln if w["x0"] >= 480 and AMT.match(w["text"])]
                date_words = [w for w in ln if w["x0"] < 80]
                desc_words = [w for w in ln if 80 <= w["x0"] < 480]
                # --- totales
                if txt.startswith("Total de las transacciones en $ de"):
                    name = _words_text([w for w in ln if w not in amt_words]).replace("Total de las transacciones en $ de", "").strip()
                    totals.append(("holder", name, parse_money(amt_words[-1]["text"])))
                    for t in block:
                        t["holder"] = name
                    doc["transactions"].extend(block)
                    block = []
                    cur = None
                    continue
                if txt.startswith("Total de Transacciones en Moneda Extranjera"):
                    name = re.sub(r"^Total de Transacciones en Moneda Extranjera de ?", "", _words_text([w for w in ln if w not in amt_words])).strip()
                    totals.append(("foreign", name, parse_money(amt_words[-1]["text"])))
                    for t in block:
                        t["holder"] = name
                        t["section"] = "foreign"
                    doc["transactions"].extend(block)
                    block = []
                    cur = None
                    continue
                if txt.startswith("Total de Meses sin Intereses"):
                    printed["msi_monthly"] = parse_money(amt_words[-1]["text"])
                    mode = None
                    cur = None
                    continue
                # --- nuevo movimiento (tiene importe a la derecha)
                if amt_words and desc_words:
                    day = month = None
                    dtxt = [w["text"] for w in date_words]
                    if dtxt and dtxt[0].isdigit():
                        day = int(dtxt[0])
                        if len(dtxt) > 1:
                            mm = re.fullmatch(r"de(\w+)", dtxt[1])
                            if mm and month_number(mm.group(1)):
                                month = mm.group(1)
                    desc = _words_text(desc_words)
                    cur = {"_day": day, "_month": month, "_desc": [desc], "_amt": parse_money(amt_words[-1]["text"]),
                           "_cr": False, "_extra": []}
                    (block if mode == "txn" else postings).append(cur)
                    continue
                if cur is None:
                    continue
                # --- continuaciones del movimiento anterior
                first = ln[0]
                if first["x0"] < 20 and first["text"].lower() in MONTH_NAMES and cur["_month"] is None:
                    cur["_month"] = first["text"]
                    rest = [w for w in ln[1:] if w["x0"] >= 80]
                    for w in rest:
                        cur["_extra"].append(w["text"])
                    cr = [w for w in ln if w["text"] == "CR" and w["x0"] > 530]
                    if cr:
                        cur["_cr"] = True
                    continue
                if first["x0"] < 20 and first["text"].isdigit() and cur["_day"] is None:
                    # fecha en la pagina siguiente al importe (renglon '2 de RFC.. /REF..' o '20 de Dolar ...')
                    cur["_day"] = int(first["text"])
                    rest = [w["text"] for w in ln if w["x0"] >= 80]
                    cur["_extra"].extend(rest)
                    continue
                if first["x0"] >= 80 or first["text"] == "CR":
                    cr = [w for w in ln if w["text"] == "CR" and w["x0"] > 530]
                    if cr:
                        cur["_cr"] = True
                    others = [w["text"] for w in ln if not (w["text"] == "CR" and w["x0"] > 530)]
                    cur["_extra"].extend(others)
                    continue
                if first["x0"] < 20 and first["text"].lower() in MONTH_NAMES:
                    cur["_extra"].extend([w["text"] for w in ln[1:] if w["x0"] >= 80])
                    cr = [w for w in ln if w["text"] == "CR" and w["x0"] > 530]
                    if cr:
                        cur["_cr"] = True
            elif mode == "plans":
                pct = [w for w in ln if w["text"].endswith("%")]
                if pct:
                    desc = _words_text([w for w in ln if w["x0"] < 215])
                    dws = [w["text"] for w in ln if 215 <= w["x0"] < 280]
                    nums = [w for w in ln if w["x0"] >= 295 and AMT.match(w["text"])]
                    orig = [w for w in nums if w["x0"] < 355][0]
                    saldo = [w for w in nums if 355 < w["x0"] < 450][0]
                    monthly = [w for w in nums if w["x0"] >= 500][0]
                    nm = re.search(r"(\d+)\s+de ?(\d+)", " ".join(w["text"] for w in ln if w["x0"] >= 460 and w["x0"] < 510))
                    mm = re.fullmatch(r"de(\w+)", dws[1]) if len(dws) > 1 else None
                    opd = parse_date(f"{dws[0]} de {mm.group(1)}", year=year, not_after=end) if mm else None
                    cur_plan = {"desc": desc, "op": opd, "orig": parse_money(orig["text"]),
                                "rate": pct[0]["text"].rstrip("%"), "saldo": parse_money(saldo["text"]),
                                "n": int(nm.group(1)), "tot": int(nm.group(2)),
                                "monthly": parse_money(monthly["text"])}
                    plans_rows.append(cur_plan)
                    continue
                if txt.startswith("Total de Plan de Meses sin Intereses"):
                    nums = [w for w in ln if AMT.match(w["text"])]
                    printed["plan_saldo"] = parse_money(nums[0]["text"])
                    printed["plan_monthly"] = parse_money(nums[1]["text"])
                    mode = None
                    cur_plan = None
                    continue
                if cur_plan is not None and not txt.startswith("Mensualidad") and "=" not in txt:
                    if all(w["x0"] < 215 for w in ln):
                        cur_plan["desc"] += " " + txt
                    else:
                        cur_plan = None
                elif "=" in txt:
                    cur_plan = None

    # ---- finalizar transacciones
    assert not block, "movimientos sin cerrar por un 'Total ... de <titular>'"
    # planes
    for r in plans_rows:
        city_split = split_amex_city(r["desc"]) if not r["desc"].startswith("MESES EN") else (r["desc"], None)
        doc["plans"].append(make_plan(
            merchant=city_split[0], original_cents=r["orig"], pending_cents=r["saldo"],
            monthly_cents=r["monthly"], n_current=r["n"], n_total=r["tot"], rate_pct=r["rate"],
            with_interest=False, op_date=iso(r["op"]),
            kind="auto_msi" if r["desc"].startswith("MESES EN AUTOM") else "purchase", holder=None,
            note=("ciudad: " + city_split[1]) if city_split[1] else None, raw=r["desc"],
        ))

    def build(t: dict, section: str = "regular") -> dict:
        finish_date(t)
        desc = re.sub(r"\s+", " ", " ".join(t["_desc"])).strip()
        extra = " ".join(t["_extra"])
        fm = re.search(r"D[oó]lar U\.S\.A\. ([\d.]+) TC:([\d.]+)", extra)
        foreign = {"currency": "USD", "amount": fm.group(1), "fx": fm.group(2)} if fm else None
        rfc = re.search(r"RFC([A-Z0-9&]+)", extra)
        im = re.search(r"CARGO (\d+) DE ?(\d+)", extra)
        inst = {"n": int(im.group(1)), "total": int(im.group(2))} if im else None
        up = desc.upper()
        cents = t["_amt"]
        note = None
        if t["_cr"]:
            cents = -cents
            if up.startswith("GRACIAS POR SU PAGO"):
                ttype = "payment"
            elif up.startswith("MONTO A DIFERIR"):
                ttype = "installment_credit"
                note = "neutraliza una compra convertida automaticamente a meses sin intereses"
            else:
                ttype = "refund"
            if ttype == "refund":
                merchant, city = split_amex_city(desc)
            else:
                merchant, city = desc, None
        else:
            ttype = "installment" if inst else "purchase"
            merchant, city = split_amex_city(desc)
        if city:
            note = f"ciudad: {city}"
        raw = " ".join([desc] + t["_extra"] + (["CR"] if t["_cr"] else []))
        d = make_txn(
            date=t.get("date"), merchant=merchant, raw=raw, amount_cents=cents, type=ttype,
            holder=t.get("holder"), section=t.get("section", section), installment=inst, foreign=foreign,
            note=note, rfc=rfc.group(1) if rfc else None,
        )
        if inst:
            d["plan_ref"] = link_plan(doc["plans"], merchant, abs(cents), inst["n"])
        return d

    txns = []
    for t in doc["transactions"]:
        txns.append(build(t))
    doc["transactions"] = txns
    for p in postings:
        finish_date(p)
        desc = " ".join(p["_desc"])
        im = re.search(r"CARGO (\d+) DE ?(\d+)", " ".join(p["_extra"]))
        inst = {"n": int(im.group(1)), "total": int(im.group(2))} if im else None
        kind = "auto_msi_extranjero" if "EXTRANJERO" in desc else "auto_msi_nacional"
        doc.setdefault("installment_postings", []).append({
            "date": p.get("date"), "merchant": desc, "raw": " ".join([desc] + p["_extra"]),
            "amount_cents": p["_amt"], "type": "installment", "installment": inst, "kind": kind,
            "plan_ref": link_plan(doc["plans"], desc, p["_amt"], inst["n"] if inst else None),
            "note": "mensualidad cargada este periodo (Total de Meses sin Intereses); NO es compra nueva",
        })

    # ---- checks
    all_t = doc["transactions"]
    exp = {n: c for k, n, c in totals}
    holders = [n for k, n, c in totals if k == "holder"]
    for idx, (k, n, c) in enumerate(totals, start=1):
        mine = [t for t in all_t if t["holder"] == n and (t["section"] == "foreign") == (k == "foreign")]
        # el total del bloque = cargos - creditos del propio bloque (reembolsos y 'MONTO A DIFERIR'),
        # sin contar los pagos a la tarjeta
        net = sum(t["amount_cents"] for t in mine if t["type"] != "payment")
        label = "extranjero" if k == "foreign" else "titular/adicional"
        doc["checks"].append(make_check(f"total bloque #{idx} ({label}; cargos - creditos, sin pagos)", c, net))
    cred = -sum(t["amount_cents"] for t in all_t if t["amount_cents"] < 0)
    if "creditos" in summary:
        doc["checks"].append(make_check("total creditos (resumen) = pagos + MONTO A DIFERIR + reembolsos", summary["creditos"], cred))
    posted = sum(p["amount_cents"] for p in doc.get("installment_postings", []))
    if "msi_monthly" in printed:
        doc["checks"].append(make_check("Total de Meses sin Intereses (tabla mensual)", printed["msi_monthly"], posted))
    if "nuevas_transacciones" in summary:
        pos = sum(t["amount_cents"] for t in all_t if t["amount_cents"] > 0)
        doc["checks"].append(make_check("Nuevas transacciones = cargos positivos (todos los bloques + extranjero)",
                                        summary["nuevas_transacciones"], pos))
    if "nuevos_cargos" in summary:
        pos = sum(t["amount_cents"] for t in all_t if t["amount_cents"] > 0)
        doc["checks"].append(make_check("Total Nuevos Cargos = cargos positivos + mensualidades MSI", summary["nuevos_cargos"], pos + posted))
    if "plan_saldo" in printed:
        doc["checks"].append(make_check("Total Plan MSI: saldo pendiente (union de paginas)", printed["plan_saldo"], sum(p["pending_cents"] for p in doc["plans"])))
        doc["checks"].append(make_check("Total Plan MSI: monto total a pagar (union de paginas)", printed["plan_monthly"], sum(p["monthly_cents"] for p in doc["plans"])))
    # las mensualidades del mes cuadran con las mensualidades de los planes de la tabla mensual
    return doc


if __name__ == "__main__":
    write_json(sys.argv[2], extract(sys.argv[1]))
