"""Corre todos los extractores y escribe los JSON normalizados + index.json + REPORT.md.

    python run_all.py --downloads ~/Downloads --out <dir> [--transcription pass1.json [pass2.json]]

Busca en --downloads (por patron de nombre):
  'Estado de cuenta_explora*.pdf', 'Estado de cuenta_costco*.pdf', 'Estado de cuenta_debito*.pdf',
  '*_edc_nu.pdf', '*_edc_amex.pdf', 'gastos_amex_nu*.csv'
Las exportaciones 'Envio_movimientos_*' son imagen: se procesan desde una transcripcion manual
(--transcription, ver build_movements.py). Nada de esto toca la base de datos.
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import sys
from collections import Counter

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import build_movements  # noqa: E402
import extract_amex  # noqa: E402
import extract_banamex_credit  # noqa: E402
import extract_banamex_debit  # noqa: E402
import extract_nu  # noqa: E402
import normalize_csv  # noqa: E402
from common import make_check, write_json  # noqa: E402


def find(downloads: str, pattern: str) -> str | None:
    hits = sorted(glob.glob(os.path.join(downloads, pattern)))
    return hits[0] if hits else None


def cross_checks(docs: dict) -> list[dict]:
    out = []

    def add(name, a, b, note=None):
        c = make_check(name, a, b)
        if note:
            c["note"] = note
        out.append(c)

    amex, deb = docs.get("amex_stmt"), docs.get("debito_stmt")
    if amex and deb:
        dom = sum(t["amount_cents"] for t in deb["transactions"] if t["type"] == "domiciliation_card_payment")
        pays = -sum(t["amount_cents"] for t in amex["transactions"] if t["type"] == "payment")
        add("domiciliaciones Amex (estado debito) = pagos en linea (estado Amex)", pays, dom)
    for key, label in (("explora", "Explora"), ("costco", "Costco")):
        mv, st, dm = docs.get(f"movements_{key}"), docs.get(f"{key}_stmt"), docs.get("movements_debito")
        if mv and dm:
            pay_card = sum(t["amount_cents"] for t in dm["transactions"] if t["merchant"] == f"Pago a tarjeta {label}")
            pay_credit = -sum(t["amount_cents"] for t in mv["transactions"] if t["type"] == "payment")
            add(f"pago a {label}: export debito = abono en export de la tarjeta", pay_card, pay_credit)
        if st and dm and st.get("summary", {}).get("pago_no_intereses"):
            pay_card = sum(t["amount_cents"] for t in dm["transactions"] if t["merchant"] == f"Pago a tarjeta {label}")
            add(f"pago a {label} = 'pago para no generar intereses' del estado", st["summary"]["pago_no_intereses"], pay_card)
    dm = docs.get("movements_debito")
    if amex and dm:
        dom = sum(t["amount_cents"] for t in dm["transactions"] if t["type"] == "domiciliation_card_payment" and t["merchant"] == "American Express")
        add("domiciliacion Amex (export debito) = 'pago para no generar intereses' Amex", amex["summary"]["pago_no_intereses"], dom)
    # empalme de periodos
    for a, b in (("explora_stmt", "movements_explora"), ("costco_stmt", "movements_costco"),
                 ("debito_stmt", "movements_debito"), ("amex_stmt", "csv_amex"), ("nu_stmt", "csv_nu")):
        if a in docs and b in docs and docs[a]["period"] and docs[b]["period"]:
            ov = docs[b]["period"]["start"] <= docs[a]["period"]["end"]
            out.append({"name": f"empalme {a} (fin {docs[a]['period']['end']}) vs {b} (inicio {docs[b]['period']['start']})",
                        "expected_cents": 0, "actual_cents": 0, "ok": True,
                        "note": "los periodos se TRASLAPAN: deduplicar por (fecha, monto, comercio)" if ov else "sin traslape"})
    return out


DECISIONS = [
    "- Signo en JSON: positivo = cargo/retiro (dinero que sale); negativo = abono/reembolso/deposito. En DEBITO los depositos son negativos.",
    "- Trampa de signo en las exportaciones de app: en TARJETA de credito '+$X' = cargo y sin signo = abono; en DEBITO '+$X' = deposito y sin signo = retiro.",
    "- Amex: las mensualidades que Amex vuelve a cargar cada mes (tabla 'Total de Meses sin Intereses') van en `installment_postings`, NO en `transactions`; el consolidado va en `plans`. 'Total Nuevos Cargos' = transacciones nuevas + esas mensualidades.",
    "- Amex: el total de cada bloque de titular es cargos menos creditos del propio bloque (reembolsos y 'MONTO A DIFERIR'), sin contar pagos a la tarjeta.",
    "- Amex: 'MONTO A DIFERIR MESES EN AUTOMATICO ... CR' neutraliza una compra de otro bloque convertida a 3 MSI en automatico; el importador decide si ignora ambos.",
    "- Amex: el nombre de ciudad se separa del comercio con una lista de ciudades conocidas; el PDF trae 'M?rida' (error de codificacion de origen) y se conserva tal cual.",
    "- Nu: el 'Total de cargos' impreso NO incluye las lineas 'IVA sobre intereses de plan de pagos fijos' aunque aparezcan entre los movimientos; el check suma ese IVA aparte.",
    "- Banamex credito: el parametro op_date de los plans es la fecha del ULTIMO cargo mensual, no de la compra original (op_date_is_latest_installment=true). Un plan con '0 de 1' y nota 'A PAGAR EN ...' es un cargo diferido a futuro (pago requerido 0).",
    "- Banamex credito: en la compra de 'DISP. EFECTIV' (cash_withdrawal) se omite el numero de sucursal inicial del comercio.",
    "- Debito (estado): 'EXENCION COBRO COMISION' no mueve el saldo (importe 0, el monto exentado solo aparece en el texto del concepto). Los depositos de terceros ('PAGO RECIBIDO DE ...') son income aunque probablemente sean dinero propio (p.ej. via una casa de inversion): el importador puede reclasificar.",
    "- Debito: nombres de personas ajenas se reemplazan por iniciales en `merchant`, `note` y `raw`; cuentas/CLABE/rastreos (cualquier token con 10+ digitos) se eliminan de `raw`.",
    "- Exportaciones de app (imagen): las descripciones vienen con las palabras pegadas; el comercio se limpia con un diccionario aprendido de los estados de cuenta y el codigo por RFC; si no hay forma de verificarlo se marca `merchant_unverified=true` (revisar a mano). Las filas 'EN PROCESO' son pending=true con descripcion truncada a 20 caracteres.",
    "- Exportaciones de app: un abono sin signo cuyo importe iguala N x la primera mensualidad del mismo comercio y dia se marca installment_credit (conversion a meses); no hay marca de titular/digital en la exportacion (holder=null).",
    "- CSV Amex: las filas del dia siguiente al corte que coinciden con una mensualidad de un plan son installment con plan_ref; `inferred_installment` = n actual del plan + 1 (inferencia). CSV Nu: '3 MSI' se interpreta como compra NUEVA a 3 meses y el monto del renglon como la MENSUALIDAD del mes en curso (el usuario lo confirmo: con MSI son MSI y las cantidades chicas son la mensualidad); el total es monto x meses (msi_new_purchase_installment_assumed).",
    "- Empalme de periodos: los exports/CSV pueden traslaparse en el dia del corte con el estado de cuenta; deduplicar por (fecha, monto, comercio).",
]


def write_report(docs: dict, cross: list[dict], path: str) -> None:
    L = ["# REPORTE de extraccion de estados de cuenta", ""]
    allok = all(c["ok"] for d in docs.values() for c in d["checks"]) and all(c["ok"] for c in cross)
    L.append(f"Resultado global: **{'TODOS LOS CHECKS PASAN' if allok else 'HAY CHECKS FALLIDOS'}**")
    L.append("")
    L.append("## Checks por documento")
    L.append("")
    L.append("| documento | check | esperado | obtenido | ok |")
    L.append("|---|---|---:|---:|:--:|")

    def fmt(c, v):
        return str(v) if c.get("unit") == "count" else f"{v / 100:,.2f}"

    for k, d in docs.items():
        for c in d["checks"]:
            L.append(f"| {k} | {c['name']} | {fmt(c, c['expected_cents'])} | {fmt(c, c['actual_cents'])} | {'OK' if c['ok'] else 'FALLA'} |")
    L.append("")
    L.append("## Checks cruzados entre documentos")
    L.append("")
    L.append("| check | esperado | obtenido | ok | nota |")
    L.append("|---|---:|---:|:--:|---|")
    for c in cross:
        L.append(f"| {c['name']} | {c['expected_cents'] / 100:,.2f} | {c['actual_cents'] / 100:,.2f} | {'OK' if c['ok'] else 'FALLA'} | {c.get('note', '')} |")
    L.append("")
    L.append("## Conteos por tipo")
    L.append("")
    for k, d in docs.items():
        cnt = Counter(t["type"] for t in d["transactions"])
        extra = ""
        if d.get("plans"):
            extra += f"; plans={len(d['plans'])}"
        if d.get("installment_postings"):
            extra += f"; installment_postings={len(d['installment_postings'])}"
        L.append(f"- **{k}** ({len(d['transactions'])} movimientos{extra}): " + ", ".join(f"{t}={n}" for t, n in sorted(cnt.items())))
    L.append("")
    L.append("## Warnings")
    L.append("")
    any_w = False
    for k, d in docs.items():
        for w in d["warnings"]:
            L.append(f"- {k}: {w}")
            any_w = True
    if not any_w:
        L.append("- ninguno")
    L.append("")
    L.append("## Decisiones y ambiguedades (reglas generales del extractor)")
    L.append("")
    L.extend(DECISIONS)
    L.append("")
    L.append("## Transcripcion de imagenes")
    L.append("")
    for k in ("movements_explora", "movements_costco", "movements_debito"):
        if k in docs:
            d = docs[k]
            L.append(f"- {k}: renglones por pagina {d['row_counts_per_page']}; diferencias pasada1/pasada2: {len(d.get('pass_diffs', []))}")
    L.append("")
    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(L) + "\n")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--downloads", default=os.path.expanduser("~/Downloads"))
    ap.add_argument("--out", required=True)
    ap.add_argument("--transcription", nargs="+", help="JSON(s) de transcripcion de las imagenes (1 o 2 pasadas)")
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    docs: dict[str, dict] = {}

    def save(name: str, doc: dict) -> None:
        docs[name] = doc
        write_json(os.path.join(a.out, f"{name}.json"), doc)

    for key in ("explora", "costco"):
        p = find(a.downloads, f"Estado de cuenta_{key}*.pdf")
        if p:
            save(f"{key}_stmt", extract_banamex_credit.extract(p, f"{key}_stmt", key))
    p = find(a.downloads, "Estado de cuenta_debito*.pdf")
    if p:
        save("debito_stmt", extract_banamex_debit.extract(p))
    p = find(a.downloads, "*_edc_nu.pdf")
    if p:
        save("nu_stmt", extract_nu.extract(p))
    p = find(a.downloads, "*_edc_amex.pdf")
    if p:
        save("amex_stmt", extract_amex.extract(p))
    p = find(a.downloads, "gastos_amex_nu*.csv")
    if p:
        for k, d in normalize_csv.normalize(p, docs.get("amex_stmt")).items():
            save(f"csv_{k}", d)
    if a.transcription:
        p1 = json.load(open(a.transcription[0]))
        p2 = json.load(open(a.transcription[1])) if len(a.transcription) > 1 else None
        known, rfc_acq = build_movements.build_known([docs[k] for k in ("explora_stmt", "costco_stmt") if k in docs])
        cards = {d["card_bin8"]: build_movements.SPEC[k.split("_")[0]][1]
                 for k, d in docs.items() if k in ("explora_stmt", "costco_stmt") and d.get("card_bin8")}
        for key in build_movements.SPEC:
            doc = build_movements.build(p1[key], key, known, rfc_acq, cards)
            if p2 is not None:
                diffs = [(i, x, y) for i, (x, y) in enumerate(zip(p1[key], p2[key])) if x != y]
                nd = len(diffs) + abs(len(p1[key]) - len(p2[key]))
                doc["checks"].append(make_check("transcripcion: pasada 1 vs pasada 2 (diferencias = 0)", 0, nd, unit="count"))
                doc["pass_diffs"] = [{"row": i, "pass1": x, "pass2": y} for i, x, y in diffs]
            save(build_movements.SPEC[key][0], doc)
    else:
        print("aviso: sin --transcription; se omiten movements_*.json", file=sys.stderr)

    cross = cross_checks(docs)
    index = {
        "documents": [
            {"document": d["document"], "card_key": d["card_key"], "file": f"{k}.json", "period": d["period"],
             "as_of": d["as_of"], "transactions": len(d["transactions"]), "plans": len(d["plans"]),
             "checks_ok": all(c["ok"] for c in d["checks"]), "warnings": len(d["warnings"])}
            for k, d in docs.items()
        ],
        "cross_checks": cross,
    }
    write_json(os.path.join(a.out, "index.json"), index)
    write_report(docs, cross, os.path.join(a.out, "REPORT.md"))
    bad = [(k, c["name"]) for k, d in docs.items() for c in d["checks"] if not c["ok"]]
    print(f"{len(docs)} documentos escritos en {a.out}; checks fallidos: {len(bad)}")
    for k, n in bad:
        print("  FALLA", k, n)
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
