"""Pruebas de las funciones puras de parseo con lineas SINTETICAS (datos inventados).

Ejecutar:  python test_parsers.py   (solo asserts, no requiere pytest ni pdfplumber para common.py)
"""
from datetime import date

from common import (
    cents_to_str, clean_banamex_merchant, infer_year, parse_date, parse_installment, parse_money,
    split_amex_city, split_banamex_rfc, split_csv_city,
)


def test_money():
    assert parse_money("$1,487.42") == 148742
    assert parse_money("+$1,487.42") == 148742
    assert parse_money("- $18,890.87") == -1889087
    assert parse_money("-$16,050.00") == -1605000
    assert parse_money("$ 1 2 5 . 0 0") == 12500          # digitos separados por espacios
    assert parse_money("+ $ 1 , 2 5 0 . 5 0") == 125050
    assert parse_money("312.0") == 31200
    assert parse_money("1169") == 116900
    assert parse_money("$0.01") == 1
    assert cents_to_str(-1889087) == "-18,890.87"
    try:
        parse_money("abc")
        raise AssertionError("debio fallar")
    except ValueError:
        pass


def test_dates():
    assert parse_date("19-ago-2026") == date(2026, 8, 19)
    assert parse_date("5-sep-2026") == date(2026, 9, 5)
    assert parse_date("17 AGO 2026") == date(2026, 8, 17)
    assert parse_date("02 SEP 2026") == date(2026, 9, 2)
    assert parse_date("28 deAgosto", year=2026) == date(2026, 8, 28)       # pegado
    assert parse_date("12 de Septiembre", year=2026) == date(2026, 9, 12)
    assert parse_date("25 deJul", year=2026, not_after=date(2026, 9, 25)) == date(2026, 7, 25)
    assert parse_date("01 Oct", year=2026, not_after=date(2026, 10, 2)) == date(2026, 10, 1)
    assert parse_date("28 Dic", year=2026, not_after=date(2026, 1, 15)) == date(2025, 12, 28)  # retrocede un ano
    assert parse_date("2026-10-01") == date(2026, 10, 1)
    assert parse_date("texto") is None
    assert infer_year(25, 12, date(2026, 12, 19), date(2027, 1, 18)) == 2026
    assert infer_year(3, 1, date(2026, 12, 19), date(2027, 1, 18)) == 2027


def test_installments():
    assert parse_installment("TIENDA UNO 012 de 024") == ({"n": 12, "total": 24}, "TIENDA UNO")
    assert parse_installment("TIENDA DOS 94(013:024)") == ({"n": 13, "total": 24}, "TIENDA DOS 94")
    assert parse_installment("Compra Ficticia A Meses - 1/3")[0] == {"n": 1, "total": 3}
    assert parse_installment("Compra Ficticia A Meses - 1/3")[1] == "Compra Ficticia A Meses"
    assert parse_installment("CARGO 05 DE 06")[0] == {"n": 5, "total": 6}
    assert parse_installment("CARGO 03 DE03")[0] == {"n": 3, "total": 3}
    assert parse_installment("TIENDA TRES 7/2")[0] is None                  # n > total no es mensualidad
    assert parse_installment("TIENDA CUATRO")[0] is None


def test_banamex_merchants():
    assert clean_banamex_merchant("CAFE LUNA CENTRO XYZ 250515CC7") == "CAFE LUNA CENTRO"
    assert clean_banamex_merchant("MERPAGO*TIENDAFAKE MAG 2105031W3MX") == "MERPAGO*TIENDAFAKE"
    assert clean_banamex_merchant("SUPER NORTE RGG120522NP6MX") == "SUPER NORTE"
    assert clean_banamex_merchant("TIENDA SOL CCO XYZ830101AB1 MX") == "TIENDA SOL"
    assert clean_banamex_merchant("JOYERIA K E T E N AIBU7904046I6MX") == "JOYERIA KETEN"
    assert clean_banamex_merchant("TIENDA OCHO 940317114") == "TIENDA OCHO"
    assert clean_banamex_merchant("SERV PLAYA VERACRUZ VER MX") == "SERV PLAYA VERACRUZ"
    assert clean_banamex_merchant("APP FICTICIA AMSTERDAM NL") == "APP FICTICIA"
    assert clean_banamex_merchant("TIENDA UNO MERIDA 012 de 024") == "TIENDA UNO MERIDA"
    assert split_banamex_rfc("CAFE LUNA CENTRO XYZ 250515CC7") == ("CAFE LUNA CENTRO", "XYZ", "250515CC7")
    # un nombre normal sin RFC no se toca
    assert clean_banamex_merchant("PAPELERIA LA ESQUINA") == "PAPELERIA LA ESQUINA"


def test_amex_and_csv_merchants():
    assert split_amex_city("MERCADOPAGO*TIENDAFAKE Ciudad de Mex") == ("MERCADOPAGO*TIENDAFAKE", "Ciudad de Mex")
    assert split_amex_city("TIENDA FICTICIA MEXICO CITY") == ("TIENDA FICTICIA", "MEXICO CITY")
    assert split_amex_city("PARQUE SOL BOCA DEL RIO") == ("PARQUE SOL", "BOCA DEL RIO")
    assert split_amex_city("UBER EATS HTTPS://HELP.UB") == ("UBER EATS", "HTTPS://HELP.UB")
    assert split_amex_city("MERIDA") == ("MERIDA", None)                  # conserva al menos una palabra
    assert split_csv_city("TIENDA PRUEBA (Mérida)") == ("TIENDA PRUEBA", "Mérida")
    assert split_csv_city("EMPRESA LUZ (CFE)") == ("EMPRESA LUZ (CFE)", None)   # no es ciudad: se conserva


def test_banamex_credit_classify():
    from extract_banamex_credit import classify
    assert classify("SU ABONO...GRACIAS", -100)[0] == "payment"
    assert classify("COMISION ADMINISTRACION TARJETA TITULAR", 100)[0] == "fee"
    assert classify("IVA COMISION ADMINISTRACION", 16)[0] == "fee"
    assert classify("INTERES GRAVABLE", 10)[0] == "interest"
    assert classify("IVA POR INTERESES Y/O COMISIONES", 10)[0] == "interest"
    t, inst, rest = classify("TIENDA UNO MERIDA 012 de 024", 100)
    assert (t, inst, rest) == ("installment", {"n": 12, "total": 24}, "TIENDA UNO MERIDA")
    assert classify("0123 SUPER EJEMPLO DISP. EFECTIVMX", 250000)[0] == "cash_withdrawal"
    assert classify("TIENDA UNO 123456789MX", -5000)[0] == "refund"
    assert classify("TIENDA UNO 123456789MX", 5000)[0] == "purchase"


def test_nu_classify():
    from extract_nu import classify
    assert classify("¡Grácias por tu pago!", -100)[0] == "payment"
    t, inst, clean, _ = classify("Tienda Falsa A Meses - 1/3", 31634)
    assert (t, inst, clean) == ("installment", {"n": 1, "total": 3}, "Tienda Falsa A Meses")
    assert classify("Disposición de saldo en Cuenta Nu - intereses", 100)[0] == "interest"
    assert classify("Disposición de saldo en Cuenta Nu - 3/3", 100)[0] == "installment"
    assert classify("IVA sobre intereses de plan de pagos fijos", 100)[0] == "interest"
    assert classify("Cafe Inventado", 100)[0] == "purchase"


def test_debit_helpers():
    from extract_banamex_debit import classify_row, initials, is_company, scrub_raw
    assert initials("MARIA,LOPEZ/RUIZ") == "M.L.R."
    assert is_company("DESARROLLOS EJEMPLO SAPI DE CV") and not is_company("MARIA,LOPEZ/RUIZ")
    raw = ("PAGO INTERBANCARIO A BANCO UNO AL BENEF. JUAN,PEREZ/LOPEZ (DATO NO VERIFICADO POR ESTA "
           "INSTITUCION) CTA.BENEFICIARIO 012345678901234567 CLAVE RASTREO 085901234567890123 REF. 0010926 renta MISMO DIA")
    s = scrub_raw(raw)
    assert "J.P.L." in s and "012345678901234567" not in s and "085901234567890123" not in s and "JUAN" not in s
    info = classify_row(raw.split("CTA.")[0:1] + ["CTA.BENEFICIARIO 0123 CLAVE", "RASTREO 0859 REF. 0010926 renta", "MISMO DIA"],
                        "ANA PRUEBA", True, 1000)
    assert info["type"] == "transfer_out" and info["merchant"] == "Transferencia SPEI a BANCO UNO"
    assert info["note"] == "renta"
    own = classify_row(["PAGO RECIBIDO DE BANCO DOS POR ORDEN DE ANA PRUEBA", "CTA.ORDENANTE 0123 REF.1 Transferencia"],
                       "ANA PRUEBA", False, 1000)
    assert own["type"] == "transfer_own"
    third = classify_row(["PAGO RECIBIDO DE BANCO DOS POR ORDEN DE LUIS EJEMPLO GOMEZ", "CTA.ORDENANTE 0123 REF.1"],
                         "ANA PRUEBA", False, 1000)
    assert third["type"] == "income" and "L.E.G." in third["note"]
    assert classify_row(["DOMI AMERICAN EXPRESS CO", "AUT DOMI 123"], "X", True, 1)["type"] == "domiciliation_card_payment"
    assert classify_row(["DOMI GIMNASIO FICTICIO", "AUT DOMI 123"], "X", True, 1)["type"] == "domiciliation_other"
    assert classify_row(["COMISION ALGO"], "X", True, 100)["type"] == "fee"
    assert classify_row(["DEPOSITO INVERSION FONDO UNO"], "X", True, 100)["type"] == "transfer_own"
    card = classify_row(["Tienda Online Falsa", "Ciudad Ejemplo", "20260824 1111222233334444 9001/0011"], "X", True, 900)
    assert card["type"] == "purchase" and card["merchant"] == "Tienda Online Falsa" and card["post_date"] == "2026-08-24"


def test_amex_linking():
    from extract_amex import link_plan
    plans = [
        {"merchant": "TIENDA UNO MX MSI", "original_cents": 47310, "monthly_cents": 15770, "n_current": 2},
        {"merchant": "OTRA TIENDA WEB", "original_cents": 344644, "monthly_cents": 114882, "n_current": 1},
    ]
    assert link_plan(plans, "TIENDA UNO MX MSI (MKT)", 15770)["original_cents"] == 47310
    assert link_plan(plans, "OTRA TIENDA WEB", 114879)["original_cents"] == 344644      # tolerancia 5 centavos
    assert link_plan(plans, "OTRA TIENDA WEB", 114900) is None
    assert link_plan(plans, "OTRA TIENDA WEB", 114882, n=2) is None


def test_csv_holder_match():
    from normalize_csv import match_holder
    assert match_holder("Ana B Perez C", ["TITULAR EJEMPLO", "ANA BETINA PEREZ CASTRO"]) == "ANA BETINA PEREZ CASTRO"
    assert match_holder("Otra Persona X", ["ANA BETINA PEREZ CASTRO"]) is None


def test_image_merchants():
    from build_movements import clean_image_merchant, classify_credit
    known = {"TIENDAUNOCENTROXYZ": "TIENDA UNO CENTRO"}
    rfc_acq = {"2105031W3": "MAG"}
    assert clean_image_merchant("TIENDA UNO CENTROXYZ 250515CC7", known, rfc_acq) == ("TIENDA UNO CENTRO", False)
    assert clean_image_merchant("MERPAGO*FICTICIOMAG 2105031W3MX", known, rfc_acq) == ("MERPAGO*FICTICIO", False)
    assert clean_image_merchant("MERPAGO*DEMOMAG 21", known, rfc_acq, True)[0] == "MERPAGO*DEMO"
    assert clean_image_merchant("CAFETERIA NUEVAXYZ 990101AB1", known, rfc_acq) == ("CAFETERIA NUEVA", True)
    assert clean_image_merchant("TIENDA ALFA 3ABC 990101AB1MX", known, rfc_acq)[1] is True
    assert classify_credit("TIENDA UNO 94(012:024)", "+")[0] == "installment"
    assert classify_credit("TIENDA UNO 123456789MX", "")[0] == "refund"   # sin signo en credito = abono


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for t in tests:
        t()
        print("ok", t.__name__)
    print(f"{len(tests)} grupos de pruebas OK")
