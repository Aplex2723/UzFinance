"""Construye el JSON normalizado de los 'Envio de movimientos' de Banamex (apps) a partir de
una TRANSCRIPCION manual (los PDF son solo imagen, sin capa de texto).

La transcripcion es un JSON {"explora"|"costco"|"debito": [[pagina, "DD Mon", descripcion, signo, monto], ...]}
donde signo es '+' (verde, con signo) o '' (sin signo). NO se guarda en el repo (datos reales).

Signo en TARJETAS DE CREDITO (explora/costco): '+$X' = cargo; sin signo = abono/credito recibido.
Signo en DEBITO: '+$X' = deposito (entra dinero); sin signo = retiro/cargo (sale dinero).
En el JSON: cargo/retiro = positivo, abono/deposito = negativo.

Uso: python build_movements.py --pass1 p1.json [--pass2 p2.json] --extract-dir DIR --out DIR
"""
from __future__ import annotations

import argparse
import json
import os
import re
from typing import Optional

from common import (
    cents_to_str, clean_banamex_merchant, iso, make_check, make_doc, make_txn, parse_date,
    parse_installment, parse_money, split_banamex_rfc, write_json,
)
from extract_banamex_debit import initials, scrub_raw

REQUEST_DATE = "2026-10-02"
SPEC = {
    "explora": ("movements_explora", "Explora", "credit"),
    "costco": ("movements_costco", "Costco", "credit"),
    "debito": ("movements_debito", "MiCuenta", "debit"),
}
_RFC_END = re.compile(
    r"^(.*?)(?:(?<=\s)(\d{6}[A-Z0-9]{2,3}(?:MX|EX)?)|([A-Z&]{3,4}\d{6}[A-Z0-9]{3}(?:MX|EX)?))$")
PREFIX_ACQ = {"MERPAGO*": "MAG"}


def _key(s: str) -> str:
    return re.sub(r"[^A-Z0-9]", "", s.upper())


def _rfc_core(rfc: str) -> str:
    return re.sub(r"(MX|EX)$", "", rfc)


def build_known(stmt_docs: list[dict]) -> tuple[dict, dict]:
    """Diccionarios aprendidos de los estados de cuenta: marcas conocidas y codigo por RFC."""
    known: dict[str, str] = {}
    rfc_acq: dict[str, str] = {}
    for doc in stmt_docs:
        for t in doc["transactions"] + doc.get("plans", []):
            raw = t.get("raw") or ""
            _, base = parse_installment(raw)
            merchant, acq, rfc = split_banamex_rfc(base)
            if not merchant:
                continue
            known[_key(merchant + (acq or ""))] = merchant
            known[_key(raw)] = t["merchant"]
            if rfc and acq:
                rfc_acq[_rfc_core(rfc)] = acq
    return known, rfc_acq


def clean_image_merchant(text: str, known: dict, rfc_acq: dict, had_installment: bool = False) -> tuple[str, bool]:
    """(comercio, sin_verificar). Las exportaciones pegan las palabras ('DIESELERAOCP')."""
    inst, text = parse_installment(text)
    text = re.sub(r"\s+", " ", text).strip()
    if inst or had_installment:
        text = re.sub(r"\s\d{2}$", "", text)  # fragmento truncado del RFC ('... SED 88(013:024)')
    if _key(text) in known:
        return known[_key(text)], False
    m = _RFC_END.match(text)
    pre, rfc = (m.group(1).strip(), m.group(2) or m.group(3)) if m else (text, None)
    if _key(pre) in known:
        return known[_key(pre)], False
    code = rfc_acq.get(_rfc_core(rfc)) if rfc else None
    if code and pre.upper().endswith(code):
        base = pre[: -len(code)].rstrip()
        return known.get(_key(base + code), base), False
    for pfx, c in PREFIX_ACQ.items():
        if pre.upper().startswith(pfx) and pre.upper().endswith(c):
            return pre[: -len(c)].rstrip(), False
    if rfc:
        last = pre.split(" ")[-1]
        if len(last) - 3 >= 4 and last.isalpha():
            return pre[: -3].rstrip(), True
        return pre, True
    pre = re.sub(r"\s?\S*\d{3}-\d{3}-\d{4}\w*$", "", pre)
    pre = re.sub(r"\s\d{8,}\S*$", "", pre)
    return pre, False


def classify_credit(desc: str, sign: str) -> tuple[str, Optional[dict], str]:
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
    if "DISP. EFECTIV" in up:
        return "cash_withdrawal", None, desc
    if sign != "+":
        return "refund", None, desc
    return "purchase", None, desc


def classify_debit(text: str, deposit: bool, cards: dict, fee_dates: set, date: str) -> dict:
    up = text.upper()
    r: dict = {"type": None, "merchant": text, "note": None, "ambiguous": None}
    if up.startswith("DEPOSITO INVERSION"):
        m = re.match(r"DEPOSITO INVERSION (\S+)\s*(.*?)(?: AUT\. \d+)?$", text, re.I)
        r.update(type="transfer_own", merchant=f"Inversion {m.group(1)}" if m else "Inversion",
                 note=((m.group(2).strip() + "; ") if m and m.group(2) else "") +
                 ("retiro de inversion propia" if deposit else "deposito a inversion propia"))
    elif up.startswith("TRASPASO"):
        r.update(type="transfer_own", merchant="Traspaso",
                 note="traspaso banca electronica " + ("(entra)" if deposit else "(sale)"))
    elif up.startswith("DOMI "):
        name = re.sub(r"^DOMI \d+ ", "", text[0:], flags=re.I) if re.match(r"DOMI \d+ ", text) else text[5:]
        name = re.sub(r"\s+", " ", name).strip()
        if name.startswith("AMERICAN EXPRESS"):
            r.update(type="domiciliation_card_payment", merchant="American Express")
        else:
            r.update(type="domiciliation_other", merchant=name)
    elif up.startswith("PAGO DE SERVICIO"):
        tb = re.search(r"A TB (\d{8})", text)
        if tb:
            label = cards.get(tb.group(1))
            r.update(type="domiciliation_card_payment",
                     merchant=f"Pago a tarjeta {label}" if label else "Pago a tarjeta",
                     note=f"pago a tarjeta {label}" if label else "pago a tarjeta (sin identificar)")
        elif "IMPU" in up:
            r.update(type="tax", merchant="Pago de impuestos", note="PAGO DE SERVICIO (concepto truncado: PAGO DE IMPU...)")
    elif up.startswith("IVA COMISION") or up.startswith("COMISION"):
        low = text.lower()
        r.update(type="fee", merchant=("IVA " + low[4:]) if up.startswith("IVA") else low.capitalize())
    elif up == "TRANSFERENCIA INTERBANCARIA":
        r.update(type="transfer_out", merchant="Transferencia SPEI")
    elif up.startswith("HONORARIOS"):
        r.update(type="transfer_out", merchant="Transferencia SPEI", note=text)
    elif up.startswith("DONATIVO"):
        r.update(type="purchase", merchant="Donativo")
    elif up.startswith("PENNY VALIDATION"):
        r.update(type="income", merchant="Penny validation", note="validacion de cuenta por 1 centavo")
    elif up.startswith("PAGO RECIBIDO DE"):
        n = " con comision de recepcion internacional el mismo dia" if date in fee_dates else ""
        r.update(type="income", merchant="Transferencia recibida",
                 note="PAGO RECIBIDO DE <referencia> TRANSF." + (f" ({n.strip()})" if n else ""))
    elif re.fullmatch(r"[A-Z]+,[A-Z]+/[A-Z]+", up):
        r.update(type="income", merchant="Transferencia SPEI recibida", note=f"ordenante {initials(text)}")
    elif re.fullmatch(r"[A-F0-9]{12}", up):
        r.update(type="income", merchant="Deposito sin descripcion", note=f"concepto: {text}",
                 ambiguous="descripcion solo con codigo (sin comercio ni ordenante); revisar: podria ser un deposito de terceros previo a un DEPOSITO INVERSION")
    elif re.search(r"\d{6}[A-Z0-9]{2,3}$", up) or " EME " in up:
        merch = clean_banamex_merchant(text)
        r.update(type="refund" if deposit else "purchase", merchant=merch)
    return r


def build(rows: list, key: str, known: dict, rfc_acq: dict, cards: dict) -> dict:
    name, label, kind = SPEC[key]
    doc = make_doc(name, key, None, REQUEST_DATE, source="envio_movimientos (transcripcion manual de imagen)")
    end = parse_date(REQUEST_DATE)
    out = []
    unverified = []
    fee_dates = set()
    parsed = []
    for page, d, desc, sign, amt in rows:
        dt = parse_date(d, year=end.year, not_after=end)
        parsed.append((page, iso(dt), desc, sign, parse_money(amt)))
        if key == "debito" and "RECEPCION INTERNACIONAL" in desc.upper():
            fee_dates.add(iso(dt))
    per_page: dict[int, int] = {}
    for idx, (page, dt, desc, sign, cents) in enumerate(parsed, start=1):
        per_page[page] = per_page.get(page, 0) + 1
        if kind == "credit":
            pending = bool(re.search(r"EN PROCESO$", desc))
            text = re.sub(r"EN PROCESO$", "", desc).strip() if pending else desc
            ttype, inst, rest = classify_credit(text, sign)
            amount = cents if sign == "+" else -cents
            merchant, unv = clean_image_merchant(rest, known, rfc_acq, had_installment=inst is not None)
            note = None
            if pending:
                note = "pendiente (EN PROCESO); descripcion truncada a 20 caracteres, sin RFC"
            if ttype in ("payment", "fee", "interest"):
                merchant, unv = text, False
            extra = {}
            tx = make_txn(date=dt, merchant=merchant, raw=desc, amount_cents=amount, type=ttype,
                          holder=None, section="regular", installment=inst, pending=pending, note=note,
                          page=page, row=per_page[page])
            if unv and not pending:
                tx["merchant_unverified"] = True
                unverified.append(desc)
            out.append(tx)
        else:
            deposit = sign == "+"
            status = None
            text = desc
            if text.endswith("AUTHORIZED"):
                status, text = "AUTHORIZED", text[: -len("AUTHORIZED")]
            text = text.strip()
            info = classify_debit(text, deposit, cards, fee_dates, dt)
            if info["type"] is None:
                doc["warnings"].append(f"concepto sin clasificar: {text[:40]}")
                info["type"] = "income" if deposit else "purchase"
            raw = scrub_raw(text)
            if re.fullmatch(r"[A-Z]+,[A-Z]+/[A-Z]+", text.upper()):
                raw = initials(text)
            amount = -cents if deposit else cents
            tx = make_txn(date=dt, merchant=info["merchant"], raw=raw, amount_cents=amount,
                          type=info["type"], holder=None, section="regular", note=info["note"],
                          status=status, page=page, row=per_page[page])
            if info["ambiguous"]:
                tx["ambiguous"] = info["ambiguous"]
                doc["warnings"].append(f"ambiguo: {info['ambiguous']}")
            out.append(tx)
    # credito por conversion a MSI: abono sin signo que iguala N x mensualidad de la misma marca/dia
    if kind == "credit":
        for t in out:
            if t["type"] == "refund":
                for u in out:
                    if u["type"] == "installment" and u["date"] == t["date"] and u["installment"]["n"] == 1:
                        total = u["installment"]["total"]
                        if abs(-t["amount_cents"] - u["amount_cents"] * total) <= total and \
                                _key(t["merchant"])[:8] == _key(u["merchant"])[:8]:
                            t["type"] = "installment_credit"
                            t["note"] = (f"abono = {total} x mensualidad ({cents_to_str(u['amount_cents'])}): "
                                         "compra convertida a meses; neutraliza el cargo original")
    doc["transactions"] = out
    ds = [t["date"] for t in out]
    doc["period"] = {"start": min(ds), "end": max(ds)}
    doc["checks"].append(make_check("renglones transcritos (total)", len(rows), len(out), unit="count"))
    doc["row_counts_per_page"] = per_page
    if kind == "debit":
        by = {}
        for t in out:
            if t["type"] == "fee":
                by.setdefault(t["date"], []).append(t)
        for dt, fs in sorted(by.items()):
            com = [t for t in fs if not t["merchant"].startswith("IVA")]
            iva = [t for t in fs if t["merchant"].startswith("IVA")]
            if com and iva:
                doc["checks"].append(make_check(f"IVA {dt} = 16% de la comision", round(com[0]["amount_cents"] * 0.16), iva[0]["amount_cents"], 1))
    else:
        com = [t for t in out if t["type"] == "fee" and not t["merchant"].startswith("IVA")]
        iva = [t for t in out if t["type"] == "fee" and t["merchant"].startswith("IVA")]
        if com and iva:
            doc["checks"].append(make_check("IVA comision = 16% de la comision", round(com[0]["amount_cents"] * 0.16), iva[0]["amount_cents"], 1))
    if unverified:
        doc["warnings"].append(f"{len(unverified)} comercios con limpieza heuristica (merchant_unverified=true)")
    return doc


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--pass1", required=True)
    ap.add_argument("--pass2")
    ap.add_argument("--extract-dir", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    p1 = json.load(open(a.pass1))
    stmts, cards = [], {}
    for k in ("explora", "costco"):
        fp = os.path.join(a.extract_dir, f"{k}_stmt.json")
        if os.path.exists(fp):
            d = json.load(open(fp))
            stmts.append(d)
            if d.get("card_bin8"):
                cards[d["card_bin8"]] = SPEC[k][1]
    known, rfc_acq = build_known(stmts)
    p2 = json.load(open(a.pass2)) if a.pass2 else None
    for key in SPEC:
        doc = build(p1[key], key, known, rfc_acq, cards)
        if p2 is not None:
            diffs = [(i, x, y) for i, (x, y) in enumerate(zip(p1[key], p2[key])) if x != y]
            nd = len(diffs) + abs(len(p1[key]) - len(p2[key]))
            doc["checks"].append(make_check("transcripcion: pasada 1 vs pasada 2 (diferencias = 0)", 0, nd, unit="count"))
            doc["pass_diffs"] = [{"row": i, "pass1": x, "pass2": y} for i, x, y in diffs]
        write_json(os.path.join(a.out, SPEC[key][0] + ".json"), doc)


if __name__ == "__main__":
    main()
