"""Normaliza el CSV propio de movimientos actuales de Amex y Nu.

Columnas: Tarjeta,Fecha,Hora,Quien cobro (comercio),Titular/usuario (Amex),Monto MXN,Notas
Al final trae renglones 'TOTAL ...' que se usan como verificacion (no son movimientos).

Reglas:
  * Amex, Notas = 'MSI'  -> mensualidad de un plan existente (n/total desconocidos en el CSV).
  * Amex del dia siguiente al corte cuyo comercio+monto coincide con la mensualidad de un plan
    del estado de cuenta (tolerancia 5 centavos) -> installment + plan_ref.
  * Nu, Notas = 'N MSI'  -> compra NUEVA a N meses; el CSV trae el monto TOTAL (supuesto).
  * Notas = 'Por procesar' -> pending.
"""
from __future__ import annotations

import csv
import json
import re
import sys
from typing import Optional

from common import (
    cents_to_str, iso, make_check, make_doc, make_txn, parse_date, parse_money, split_csv_city,
    write_json,
)
from extract_amex import link_plan

CARD_KEYS = {"american express": "amex", "nu": "nu"}


def _card_key(label: str) -> Optional[str]:
    low = label.strip().lower()
    for k, v in CARD_KEYS.items():
        if low.startswith(k):
            return v
    return None


def match_holder(csv_name: str, full_names: list[str]) -> Optional[str]:
    """'Ana B Perez C' -> 'ANA BETINA PEREZ CASTRO' si cada palabra es prefijo de la correspondiente."""
    toks = csv_name.upper().split()
    for full in full_names:
        ft = full.upper().split()
        if len(ft) == len(toks) and all(f.startswith(t) for t, f in zip(toks, ft)):
            return full
    return None


def normalize(csv_path: str, amex_doc: Optional[dict] = None) -> dict[str, dict]:
    with open(csv_path, newline="", encoding="utf-8-sig") as f:
        rows = list(csv.reader(f))
    header = rows[0]
    assert header[0] == "Tarjeta" and "Monto MXN" in header, header
    plans = (amex_doc or {}).get("plans", [])
    amex_end = (amex_doc or {}).get("as_of")
    holders = []
    titular = None
    if amex_doc:
        for t in amex_doc["transactions"]:
            if t["holder"] and t["holder"] not in holders:
                holders.append(t["holder"])
        titular = holders[0] if holders else None

    docs = {k: make_doc(f"csv_{k}", k, None, None, source="gastos_amex_nu.csv") for k in ("amex", "nu")}
    printed: dict[str, int] = {}
    for r in rows[1:]:
        if not any(r):
            continue
        r = (r + [""] * 7)[:7]
        tarjeta, fecha, hora, comercio, titular_csv, monto, notas = [c.strip() for c in r]
        if tarjeta.upper().startswith("TOTAL"):
            key = _card_key(tarjeta[len("TOTAL"):])
            printed[key] = parse_money(monto)
            continue
        key = _card_key(tarjeta)
        if key is None:
            docs["amex"]["warnings"].append(f"tarjeta desconocida: {tarjeta!r}")
            continue
        doc = docs[key]
        cents = parse_money(monto)
        merchant, city = split_csv_city(comercio)
        note_parts = []
        if city:
            note_parts.append(f"ciudad: {city}")
        pending = notas.lower() == "por procesar"
        installment = None
        ttype = "purchase"
        extra: dict = {}
        holder = None
        if key == "amex":
            holder_csv = titular_csv or None
            holder = (match_holder(titular_csv, holders) if titular_csv else titular) or titular_csv or titular
            if titular_csv:
                extra["holder_csv"] = titular_csv
            is_msi = notas.upper() == "MSI"
            ref = None
            if is_msi or (amex_end and fecha > amex_end):
                ref = link_plan(plans, merchant, cents) if plans else None
            if is_msi or (ref and fecha == _next_day(amex_end)):
                ttype = "installment"
                installment = {"n": None, "total": None}
                extra["plan_ref"] = ref
                if ref:
                    plan = next(p for p in plans if p["merchant"] == ref["merchant"] and p["original_cents"] == ref["original_cents"]
                                and abs(p["monthly_cents"] - cents) <= 5)
                    extra["inferred_installment"] = {"n": plan["n_current"] + 1, "total": plan["n_total"]}
                    note_parts.append("mensualidad inferida = n actual del plan + 1")
                else:
                    doc["warnings"].append(f"MSI sin plan coincidente: {merchant} {cents_to_str(cents)}")
        else:
            m = re.fullmatch(r"(\d+) MSI", notas.upper())
            if m:
                installment = {"n": 1, "total": int(m.group(1))}
                note_parts.append("msi_new_purchase_installment_assumed")
        doc["transactions"].append(make_txn(
            date=fecha, time=hora or None, merchant=merchant, raw=comercio, amount_cents=cents,
            type=ttype, holder=holder, section="regular", installment=installment, pending=pending,
            note="; ".join(note_parts) or None, **extra,
        ))

    for key, doc in docs.items():
        ds = [t["date"] for t in doc["transactions"]]
        doc["period"] = {"start": min(ds), "end": max(ds)} if ds else None
        doc["as_of"] = max(ds) if ds else None
        total = sum(t["amount_cents"] for t in doc["transactions"])
        if key in printed:
            doc["checks"].append(make_check(f"TOTAL {key} del CSV = suma de renglones", printed[key], total))
        else:
            doc["warnings"].append("sin renglon TOTAL en el CSV")
    return docs


def _next_day(iso_date: Optional[str]) -> Optional[str]:
    if not iso_date:
        return None
    from datetime import date, timedelta
    return (date.fromisoformat(iso_date) + timedelta(days=1)).isoformat()


if __name__ == "__main__":
    amex = json.load(open(sys.argv[3])) if len(sys.argv) > 3 else None
    out = normalize(sys.argv[1], amex)
    for k, d in out.items():
        write_json(f"{sys.argv[2]}/csv_{k}.json", d)
