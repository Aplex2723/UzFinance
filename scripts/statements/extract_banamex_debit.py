"""Extractor del estado de cuenta de la cuenta de debito Banamex (MiCuenta).

Lee el 'Detalle de Operaciones' con posiciones de palabras: la fecha va en la columna
izquierda, el CONCEPTO ocupa varias lineas y los importes (RETIROS / DEPOSITOS / SALDO)
estan al final de la ULTIMA linea del renglon. La cadena de saldos decide si un importe
es retiro o deposito y es la verificacion principal.

Convencion de signo del JSON: retiro (dinero que sale) = positivo; deposito (dinero que
entra) = negativo (igual que 'abono/credito' en las tarjetas). El tipo dice la naturaleza.
"""
from __future__ import annotations

import re
import sys
from typing import Optional

import pdfplumber

from common import (
    group_lines, infer_year, iso, make_check, make_doc, make_txn, month_number, parse_date,
    parse_money, write_json,
)

AMT = re.compile(r"^\d{1,3}(?:,\d{3})*\.\d{2}$")
# palabras que delatan una razon social (si no aparece ninguna, se asume persona fisica)
COMPANY = re.compile(
    r"\b(S\.?A\.?|SA|SAPI|CV|S DE RL|SC|AC|SOFOM|INC|LLC|LTD|BANCO|SERVICIOS|DESARROLLOS|GRUPO|"
    r"COMPANY|CORP|SRL|SPA|GMBH)\b")
CARD_RE = re.compile(r"\b\d{16}\b")  # numero de la tarjeta de debito (16 digitos) dentro del concepto


def initials(name: str) -> str:
    parts = [p for p in re.split(r"[\s,/]+", name.strip()) if p]
    return ".".join(p[0].upper() for p in parts) + "." if parts else ""


def is_company(name: str) -> bool:
    return bool(COMPANY.search(name.upper()))


def scrub_raw(text: str, own_name: str = "") -> str:
    """Quita cuentas/CLABE/rastreos/ids largos y reemplaza nombres de terceros por iniciales."""
    t = re.sub(r"\s+", " ", text).strip()

    def person_to_initials(m: re.Match) -> str:
        name = m.group(2).strip()
        if is_company(name) or (own_name and name.upper().startswith(own_name.upper()[:15])):
            return m.group(0)
        return f"{m.group(1)}{initials(name)}{m.group(3)}"

    t = re.sub(r"(AL BENEF\. )(.+?)( \(DATO NO)", person_to_initials, t)
    t = re.sub(r"(POR ORDEN DE )(.+?)( CTA\.ORDENANTE| REF\.|$)", person_to_initials, t)
    toks = []
    for tok in t.split(" "):
        if re.search(r"\d{10,}", tok):
            continue
        if len(tok) >= 9 and re.fullmatch(r"[A-Za-z0-9]+", tok) and sum(c.isdigit() for c in tok) >= 6:
            continue
        toks.append(tok)
    t = " ".join(toks)
    t = re.sub(r"RASTREO:?( \S+)?(?= REF| CTA| MISMO|$)", "RASTREO:", t)
    return re.sub(r"\s+", " ", t).strip()


def classify_row(concept_lines: list[str], own_name: str, withdrawal: bool, amount_cents: int) -> dict:
    """Devuelve dict con type, merchant, note, post_date?, foreign?."""
    text = re.sub(r"\s+", " ", " ".join(concept_lines)).strip()
    up = text.upper()
    out: dict = {"type": None, "merchant": text, "note": None, "foreign": None, "post_date": None}

    if up.startswith("EXENCION COBRO COMISION"):
        ex = re.search(r"IMPORTE A EX ?ENTAR \$([\d,.]+)", up)
        out.update(type="fee", merchant="Exencion cobro comision",
                   note=(f"exencion informativa de comision (importe a exentar ${ex.group(1)} en el concepto); "
                         "no mueve el saldo") if amount_cents == 0 else "exencion de comision")
    elif up.startswith("IVA COMISION") or up.startswith("COMISION"):
        low = text.lower()
        out.update(type="fee", merchant=("IVA" + low[3:]) if up.startswith("IVA") else low.capitalize())
    elif up.startswith("PAGO DE IMPUESTOS") or "PAGO DE IMPUESTOS" in up:
        out.update(type="tax", merchant="Pago de impuestos")
    elif up.startswith("DOMI "):
        name = re.split(r"\sAUT\.? DOMI", up[5:])[0].strip()
        name = re.sub(r"\s+", " ", name)
        if name.startswith("AMERICAN EXPRESS"):
            out.update(type="domiciliation_card_payment", merchant="American Express")
        else:
            out.update(type="domiciliation_other", merchant=name)
    elif up.startswith("PAGO INTERBANCARIO A"):
        m = re.match(r"PAGO INTERBANCARIO A (.+?) AL BENEF\. (.+?) \(DATO NO VERIFICADO", text, re.I)
        bank = m.group(1).strip() if m else "banco"
        benef = m.group(2).strip() if m else ""
        cm = re.search(r"REF\. ?\S+ (.*?)(?: MISMO DIA)?$", text)
        concept = cm.group(1).strip() if cm else ""
        if concept.lower() == "transferencia interbancaria":
            concept = ""
        notes = []
        if concept:
            notes.append(concept)
        if benef and is_company(benef):
            notes.append(f"benef. {benef}")
        out.update(type="transfer_out", merchant=f"Transferencia SPEI a {bank}",
                   note=" | ".join(notes) or None)
    elif up.startswith("PAGO RECIBIDO DE"):
        m = re.match(r"PAGO RECIBIDO DE (.+?)(?: POR ORDEN DE (.+?))?(?: CTA\.ORDENANTE| REF[.:]|$)", text)
        sender = (m.group(1) if m else "").strip()
        orden = (m.group(2) or "").strip() if m else ""
        fm = re.search(r"DIVISA:([A-Z]{3}) IMPORTE: \$([\d,.]+)/TC \$([\d.]+)", text)
        if fm:
            out["foreign"] = {"currency": fm.group(1), "amount": fm.group(2).replace(",", ""), "fx": fm.group(3)}
        if orden and own_name and orden.upper().startswith(own_name.upper()):
            out.update(type="transfer_own", merchant=f"Transferencia SPEI recibida de {sender.title()} (cuenta propia)")
        elif orden:
            if is_company(orden):
                out.update(type="income", merchant=orden)
            else:
                out.update(type="income", merchant=f"Transferencia SPEI recibida de {sender}",
                           note=f"ordenante {initials(orden)}")
        else:
            nm = re.sub(r"^\d+/", "", sender)
            nm = re.sub(r"\s+\.\s+", " ", nm)
            out.update(type="income", merchant=nm)
    elif up.startswith("DEPOSITO INVERSION"):
        out.update(type="transfer_own", merchant="Inversion " + text.split(" ", 2)[2].title(),
                   note="deposito a inversion propia" if withdrawal else "retiro de inversion propia")
    elif up.startswith("DEPOSITO POR RETIRO DE AHORRO"):
        out.update(type="transfer_own", merchant="Retiro de ahorro a la vista",
                   note="de Ahorro Facil (cuenta propia)")
    elif up.startswith("TRASPASO"):
        out.update(type="transfer_own", merchant="Traspaso",
                   note="traspaso banca electronica " + ("(sale)" if withdrawal else "(entra)"))
    elif CARD_RE.search(text):
        # compra con tarjeta de debito: comercio, ciudad y fechas/ids
        merch_lines = []
        for ln in concept_lines:
            if re.match(r"^\d{8} ", ln):
                break
            merch_lines.append(ln)
        pm = re.search(r"\b(20\d{2})(\d{2})(\d{2}) ", text)
        if pm:
            out["post_date"] = f"{pm.group(1)}-{pm.group(2)}-{pm.group(3)}"
        out.update(type="purchase" if withdrawal else "refund",
                   merchant=merch_lines[0].strip() if merch_lines else text,
                   note=("ciudad: " + " ".join(merch_lines[1:])) if len(merch_lines) > 1 else None)
    return out


def extract(path: str, document: str = "debito_stmt", card_key: str = "debito") -> dict:
    with pdfplumber.open(path) as pdf:
        texts = [(p.extract_text() or "") for p in pdf.pages]
        own_name = ""
        m = re.search(r"MiCuenta\n([A-Z ]{8,60})\n", texts[0])
        if m:
            own_name = m.group(1).strip()
        full = "\n".join(texts[:3])
        pm = re.search(r"Per[ií]odo del (\d{1,2}) de (\w+) al (\d{1,2}) de (\w+) del (\d{4})", texts[0])
        start = end = None
        if pm:
            y = int(pm.group(5))
            from datetime import date
            end = date(y, month_number(pm.group(4)), int(pm.group(3)))
            sm = month_number(pm.group(2))
            start = date(y if sm <= end.month else y - 1, sm, int(pm.group(1)))
        doc = make_doc(document, card_key, {"start": iso(start), "end": iso(end)} if start else None, iso(end))
        mc = re.search(r"N[uú]mero de Tarjeta de D[eé]bito (\d{12})(\d{4})", texts[0])
        if mc:
            doc["card_last4"] = mc.group(2)
        sumd = {}
        for key, rx in {
            "saldo_anterior": r"Saldo anterior En pesos M\.N\. ([\d,]+\.\d{2})",
            "depositos": r"\(\+\) (\d+) Dep[oó]sitos ([\d,]+\.\d{2})",
            "retiros": r"\(-\) (\d+) Retiros/Otros cargos ([\d,]+\.\d{2})",
            "saldo_corte": r"Saldo al Corte ([\d,]+\.\d{2})",
            "comisiones": r"COMISIONES COBRADAS EN EL PERIODO: ([\d,]+\.\d{2})",
        }.items():
            mm = re.search(rx, full + "\n" + "\n".join(texts[3:5]))
            if mm:
                sumd[key] = mm.groups()

        # ---- detalle de operaciones (paginas con la tabla)
        rows: list[dict] = []
        cur: Optional[dict] = None
        prev_balance: Optional[int] = None
        started = False
        stop = False
        for page in pdf.pages:
            if stop:
                break
            words = page.extract_words()
            lines = group_lines(words, tol=3.0)
            in_table = False
            for ln in lines:
                txt = " ".join(w["text"] for w in ln)
                top = ln[0]["top"]
                if "FECHA" in txt and "CONCEPTO" in txt and "SALDO" in txt:
                    in_table = True
                    started = True
                    continue
                if not in_table or top > 740:
                    continue
                if txt.startswith("Domiciliaci") or txt.startswith("AHORRO") or "Cargo Autom" in txt:
                    stop = True
                    break
                if txt.startswith("SALDO ANTERIOR"):
                    prev_balance = parse_money(ln[-1]["text"])
                    continue
                date_words = [w for w in ln if w["x1"] <= 72]
                concept_words = [w for w in ln if 75 <= w["x0"] < 345]
                amt_words = [w for w in ln if w["x0"] >= 345 and AMT.match(w["text"])]
                # inicio de renglon
                if len(date_words) >= 2 and date_words[0]["text"].isdigit() and month_number(date_words[1]["text"]):
                    cur = {"day": int(date_words[0]["text"]), "mon": month_number(date_words[1]["text"]),
                           "lines": [], "w": None, "d": None, "bal": None}
                    rows.append(cur)
                if cur is None:
                    continue
                ctext = " ".join(w["text"] for w in concept_words)
                if ctext:
                    cur["lines"].append(ctext)
                for w in amt_words:
                    cents = parse_money(w["text"])
                    if w["x1"] < 430:
                        cur["w"] = cents
                    elif w["x1"] < 500:
                        cur["d"] = cents
                    else:
                        cur["bal"] = cents

    # ---- cadena de saldos y construccion de transacciones
    doc["warnings"] = []
    assert start and end
    bal = prev_balance_initial = None
    # saldo anterior: se tomo del renglon SALDO ANTERIOR (ultimo valor leido al inicio)
    bal = int(sumd["saldo_anterior"][0].replace(",", "").replace(".", "")) if "saldo_anterior" in sumd else None
    chain_ok = True
    dep_count = wd_count = 0
    dep_total = wd_total = 0
    for r in rows:
        if r["bal"] is None:
            doc["warnings"].append(f"renglon sin saldo: {' '.join(r['lines'])[:40]}")
            chain_ok = False
            continue
        delta = r["bal"] - bal
        col_amt = r["w"] if r["w"] is not None else r["d"]
        withdrawal = delta < 0
        amount = abs(delta)
        if (col_amt or 0) != amount:
            chain_ok = False
            doc["warnings"].append(
                f"cadena de saldo: importe de columna {col_amt} != delta {amount} en {' '.join(r['lines'])[:40]}")
        if r["w"] is not None and not withdrawal and amount:
            chain_ok = False
            doc["warnings"].append("retiro en columna pero el saldo sube")
        if r["d"] is not None and withdrawal:
            chain_ok = False
            doc["warnings"].append("deposito en columna pero el saldo baja")
        bal = r["bal"]
        year = infer_year(r["day"], r["mon"], start, end)
        from datetime import date as _d
        op_date = _d(year, r["mon"], r["day"])
        if amount:
            if withdrawal:
                wd_count += 1
                wd_total += amount
            else:
                dep_count += 1
                dep_total += amount
        info = classify_row(r["lines"], own_name, withdrawal, amount)
        if info["type"] is None:
            doc["warnings"].append(f"concepto sin clasificar ({' '.join(r['lines'])[:50]})")
            info["type"] = "purchase" if withdrawal else "income"
        signed = amount if withdrawal else -amount
        if info["type"] == "fee" and amount == 0:
            signed = 0
        doc["transactions"].append(make_txn(
            date=op_date.isoformat(), post_date=info["post_date"], merchant=info["merchant"],
            raw=scrub_raw(" ".join(r["lines"]), own_name), amount_cents=signed, type=info["type"],
            holder=None, section="regular", foreign=info["foreign"], note=info["note"],
            balance_cents=r["bal"],
        ))

    doc["checks"].append(make_check("cadena de saldos (renglones inconsistentes = 0)", 0, 0 if chain_ok else 1, unit="count"))
    if "saldo_corte" in sumd:
        doc["checks"].append(make_check("saldo final = saldo al corte", parse_money(sumd["saldo_corte"][0]), bal))
    if "depositos" in sumd:
        doc["checks"].append(make_check("total depositos", parse_money(sumd["depositos"][1]), dep_total))
        doc["checks"].append(make_check("numero de depositos", int(sumd["depositos"][0]), dep_count, unit="count"))
    if "retiros" in sumd:
        doc["checks"].append(make_check("total retiros/otros cargos", parse_money(sumd["retiros"][1]), wd_total))
        doc["checks"].append(make_check("numero de retiros/otros cargos", int(sumd["retiros"][0]), wd_count, unit="count"))
    if "comisiones" in sumd:
        com = sum(t["amount_cents"] for t in doc["transactions"]
                  if t["type"] == "fee" and t["raw"].upper().startswith("COMISION"))
        doc["checks"].append(make_check("comisiones cobradas (sin IVA)", parse_money(sumd["comisiones"][0]), com))
    doc["summary"] = {k: v for k, v in sumd.items()}
    return doc


if __name__ == "__main__":
    write_json(sys.argv[2], extract(sys.argv[1]))
