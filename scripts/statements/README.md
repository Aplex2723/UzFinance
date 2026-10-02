# Extraccion de estados de cuenta (capa de extraccion)

Convierte estados de cuenta reales (PDF/CSV de Banamex, Nu y American Express) en JSON
normalizado. **No toca la base de datos**: otro proceso importa esos JSON. No hay datos
reales en este directorio y las salidas deben escribirse FUERA del repo.

## Uso

```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python run_all.py --downloads ~/Downloads --out /ruta/fuera/del/repo/extract \
    --transcription pasada1.json pasada2.json     # opcional: exportaciones de app en imagen
.venv/bin/python test_parsers.py                  # pruebas con lineas sinteticas (solo asserts)
```

`run_all.py` escribe un JSON por documento, `index.json` y `REPORT.md` (checks, conteos por
tipo, warnings y decisiones). Sale con codigo 1 si algun check falla.

## Que espera cada parser

| Archivo | Modulo | Notas |
|---|---|---|
| `Estado de cuenta_<tarjeta>.pdf` (Banamex credito: Explora, Costco) | `extract_banamex_credit.py` | PDF con texto. Secciones 'Tarjeta titular' y 'Tarjeta digital' (= misma cuenta; `holder` titular/digital). Tablas 'A MESES SIN INTERESES' -> `plans`. |
| `Estado de cuenta_debito.pdf` (MiCuenta) | `extract_banamex_debit.py` | Lee columnas por posicion (RETIROS/DEPOSITOS/SALDO); la **cadena de saldos** decide retiro vs deposito. |
| `*_edc_nu.pdf` | `extract_nu.py` | Anexa a cada movimiento las lineas 'Tarjeta virtual ****' y 'Cambio (USD 1 = $x)'. |
| `*_edc_amex.pdf` | `extract_amex.py` | Usa posiciones de palabras (la fecha se parte en dos renglones y puede quedar en otra pagina). Bloques por titular cerrados por 'Total de las transacciones ... de NOMBRE'. |
| `gastos_amex_nu.csv` | `normalize_csv.py` | Escribe `csv_amex.json` y `csv_nu.json`. Los renglones `TOTAL ...` son checksums. Necesita `amex_stmt` para enlazar mensualidades con sus planes. |
| `Envio_movimientos_*.pdf` (solo imagen) | `build_movements.py` | No hay OCR: se transcribe a mano a un JSON `{"explora"\|"costco"\|"debito": [[pagina, "DD Mon", descripcion, signo, monto], ...]}` (2 pasadas independientes, se comparan). La transcripcion tiene datos reales: guardarla fuera del repo. |

## Esquema de salida

```jsonc
{
  "document": "explora_stmt", "card_key": "explora|costco|debito|nu|amex",
  "period": {"start": "YYYY-MM-DD", "end": "YYYY-MM-DD"}, "as_of": "YYYY-MM-DD",
  "transactions": [{
    "date": "YYYY-MM-DD",            // fecha de operacion (no la de cargo)
    "post_date": "YYYY-MM-DD|null", "time": "HH:MM|null",
    "merchant": "nombre limpio",     // 'raw' conserva el texto original
    "raw": "descripcion original unida con espacios",
    "amount_cents": 12345,           // entero; positivo = cargo/retiro, negativo = abono/reembolso/deposito
    "type": "purchase|fee|interest|payment|installment|installment_credit|transfer_own|transfer_out|income|domiciliation_card_payment|domiciliation_other|cash_withdrawal|tax|refund",
    "holder": "titular|digital|virtual|NOMBRE|null", "section": "regular|digital|virtual|foreign",
    "installment": {"n": 12, "total": 24},   // o null; en el CSV de Amex n/total son null (ver plan_ref)
    "pending": false, "foreign": {"currency": "USD", "amount": "14.99", "fx": "17.70981"}, "note": null
    // campos extra segun fuente: plan_ref, inferred_installment, rfc, status, page/row, merchant_unverified, ...
  }],
  "plans": [{"merchant": "", "original_cents": 0, "pending_cents": 0, "monthly_cents": 0, "n_current": 1,
             "n_total": 3, "rate_pct": "0.00", "with_interest": false, "op_date": "YYYY-MM-DD|null",
             "kind": "purchase|cash_advance|auto_msi", "holder": null, "note": null}],
  "installment_postings": [],        // solo Amex: mensualidades cargadas este periodo (NO son compras nuevas)
  "checks": [{"name": "", "expected_cents": 0, "actual_cents": 0, "ok": true}],   // unit=count -> conteos
  "warnings": []
}
```

## Trampas de signo y otras reglas

* **Credito (estados y exportaciones Banamex)**: `+$X` = cargo; `- $X` o monto sin signo en la
  exportacion de app = abono (pago `SU ABONO...GRACIAS` o reembolso). **Debito**: en la
  exportacion de app `+$X` verde = deposito y sin signo = retiro (al reves). En el JSON siempre:
  gasto/retiro positivo, abono/deposito negativo.
* Importes en centavos enteros; se parsean tambien digitos separados por espacios (`$ 1 2 5 . 0 0`).
* Banamex credito: `plans[].op_date` es la fecha del **ultimo** cargo mensual
  (`op_date_is_latest_installment: true`), no la de la compra original. En Amex/Nu si es la compra.
* Amex: `MONTO A DIFERIR ... CR` (`installment_credit`) neutraliza una compra convertida a meses
  en automatico; `CARGO 01 DE 03` en el mismo ciclo es la primera mensualidad de una compra nueva.
* Nu: el 'Total de cargos' impreso excluye las lineas 'IVA sobre intereses'; en CSV de Nu
  `3 MSI` = compra nueva a 3 meses; el monto del renglon es la MENSUALIDAD (total = monto x meses) (`msi_new_purchase_installment_assumed`).
* Debito: personas ajenas aparecen solo con iniciales; cuentas/CLABE/rastreos se quitan de `raw`.
* Exportaciones de app: palabras pegadas; el comercio se limpia con un diccionario aprendido de
  los estados y se marca `merchant_unverified` cuando es heuristico. Filas 'EN PROCESO' = `pending`.
* Los periodos de exportaciones/CSV pueden traslaparse con el estado de cuenta en el dia de
  corte: deduplicar por (fecha, monto, comercio).
