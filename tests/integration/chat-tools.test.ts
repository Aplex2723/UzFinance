import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { executeTool, type ToolCtx } from "@/lib/chat/tools";
import { closePool } from "@/lib/db/pool";
import { createCard, listCards } from "@/lib/repo/cards";
import { createCategory, listCategories } from "@/lib/repo/categories";
import { setMonthlyIncome } from "@/lib/repo/settings";
import { createManual } from "@/lib/repo/transactions";
import { createGoal } from "@/lib/repo/goals";
import { resetDb } from "../helpers";

const NOW = new Date("2026-10-15T18:00:00Z"); // 12:00 CDMX, jueves
let ctx: ToolCtx;
let amex: number, bnx: number, comida: number, transporte: number;

const tx = (date: string, cents: number, card: number, merchant: string, category: number | null) =>
  createManual({ occurredAt: new Date(`${date}T18:00:00Z`), amountCents: cents, merchant, cardId: card, categoryId: category, notes: "NOTA PRIVADA" });
const call = async (name: string, args: unknown = {}) => {
  const r = await executeTool(name, JSON.stringify(args), ctx);
  return { ok: r.ok, data: JSON.parse(r.content) as Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
};

beforeAll(async () => {
  await resetDb();
  await setMonthlyIncome(5_000_000); // $50,000
  amex = (await createCard({ name: "Amex Gold", issuer: "amex", last4: "1234", aliases: null, color: "#aaa" })).id;
  bnx = (await createCard({ name: "Banamex Clásica", issuer: "banamex", last4: "5678", aliases: null, color: "#f00" })).id;
  comida = (await createCategory({ name: "Restaurantes", color: "#f50" })).id;
  transporte = (await createCategory({ name: "Transporte", color: "#05f" })).id;
  // Julio–septiembre: meses cerrados con gasto repartido (los 3 últimos alimentan el "gasto típico").
  for (const m of ["2026-07", "2026-08", "2026-09"]) {
    await tx(`${m}-03`, 1_000_000, amex, "RENTA DEPTO", null);
    await tx(`${m}-10`, 800_000, bnx, "RESTAURANTE LA CASA", comida);
    await tx(`${m}-12`, 200_000, bnx, "UBER TRIP", transporte);
  }
  // Octubre (mes en curso, día 15)
  await tx("2026-10-02", 900_000, bnx, "RESTAURANTE LA CASA", comida);
  await tx("2026-10-05", 150_000, bnx, "UBER TRIP", transporte);
  await tx("2026-10-09", 50_000, amex, "UBER EATS", comida);
  await tx("2026-10-12", -20_000, amex, "UBER EATS REEMBOLSO", comida);
  await tx("2026-10-30", 99_999, amex, "FUTURO", comida); // aún no pasa: no debe contar
  ctx = { now: NOW, categories: await listCategories(), cards: await listCards() };
});
afterAll(closePool);

describe("herramientas de UzChat contra la base real", () => {
  it("spending_summary: total del mes en curso, reembolsos y comparación con el mes anterior", async () => {
    const { ok, data } = await call("spending_summary");
    expect(ok).toBe(true);
    expect(data.periodo).toEqual({ desde: "2026-10-01", hasta: "2026-10-15", dias: 15 });
    expect(data.total_gastado).toBe(9000 + 1500 + 500 - 200);
    expect(data.reembolsos).toBe(200);
    expect(data.compra_mas_grande).toMatchObject({ comercio: "RESTAURANTE LA CASA", monto: 9000 });
    expect(data.periodo_anterior_comparable).toMatchObject({ desde: "2026-09-01", hasta: "2026-09-15", total_gastado: 8000 + 2000 + 10000 });
  });

  it("spending_by_category: ordenado, con % y cambio; respeta limit", async () => {
    const { data } = await call("spending_by_category", { month: "2026-10" });
    expect(data.categorias.map((c: { categoria: string }) => c.categoria)).toEqual(["Restaurantes", "Transporte"]);
    expect(data.categorias[0]).toMatchObject({ gastado: 9000 + 500 - 200, movimientos: 3 });
    expect(data.categorias[0].periodo_anterior).toBe(8000);
    const one = await call("spending_by_category", { month: "2026-09", limit: 1 });
    expect(one.data.categorias).toHaveLength(1);
    expect(one.data.categorias[0].categoria).toBe("Sin categoría"); // la renta (10,000) no tiene categoría y es la mayor
    expect(one.data.otras_categorias.cantidad).toBe(2);
  });

  it("spending_by_card y top_merchants", async () => {
    const cards = await call("spending_by_card", { month: "2026-09" });
    expect(cards.data.tarjetas.map((c: { tarjeta: string; gastado: number }) => [c.tarjeta, c.gastado])).toEqual([["Amex Gold", 10000], ["Banamex Clásica", 10000]]);
    const m = await call("top_merchants", { month: "2026-10", limit: 2 });
    expect(m.data.comercios[0]).toMatchObject({ comercio: "RESTAURANTE LA CASA", gastado: 9000, compras: 1, categoria: "Restaurantes" });
    const onlyCat = await call("top_merchants", { month: "2026-10", category: "transporte" }); // sin acentos ni mayúsculas
    expect(onlyCat.data.comercios.map((x: { comercio: string }) => x.comercio)).toEqual(["UBER TRIP"]);
    const bad = await call("top_merchants", { category: "Inexistente" });
    expect(bad.ok).toBe(false);
    expect(bad.data.error).toContain("Restaurantes");
  });

  it("search_transactions: monto total de TODAS las coincidencias aunque se muestren pocas, y filtros", async () => {
    const r = await call("search_transactions", { q: "uber", from: "2026-07-01", limit: 2, sort: "amount_desc", only_purchases: false });
    expect(r.data.coincidencias).toBe(3 + 1 + 2); // 3 meses × UBER TRIP + octubre: TRIP, EATS, REEMBOLSO
    expect(r.data.mostrando).toBe(2);
    expect(r.data.monto_total_de_todas_las_coincidencias).toBe(3 * 2000 + 1500 + 500 - 200);
    expect(r.data.movimientos[0]).toMatchObject({ monto: 2000, comercio: "UBER TRIP", categoria: "Transporte" });
    const card = await call("search_transactions", { card: "1234", month: "2026-10" }); // por últimos 4
    expect(card.data.movimientos.every((m: { tarjeta: string }) => m.tarjeta === "Amex Gold")).toBe(true);
    const min = await call("search_transactions", { min_amount: 5000, month: "2026-10" });
    expect(min.data.movimientos.map((m: { monto: number }) => m.monto)).toEqual([9000]);
    expect((await call("search_transactions", { card: "Visa" })).ok).toBe(false);
  });

  it("q busca solo en el comercio: las notas no se pueden deducir por conteos ni inflan totales", async () => {
    const byNote = await call("search_transactions", { q: "NOTA PRIVADA" });
    expect(byNote.data.coincidencias).toBe(0);
    expect(byNote.data.monto_total_de_todas_las_coincidencias).toBe(0);
    const partial = await call("search_transactions", { q: "PRIVADA", from: "2026-01-01" });
    expect(partial.data.coincidencias).toBe(0);
  });

  it("ordenar por monto no pone un reembolso grande como la compra más grande", async () => {
    const r = await call("search_transactions", { month: "2026-10", sort: "amount_desc", limit: 3 });
    expect(r.data.filtros_aplicados.solo_cargos_sin_reembolsos).toBe(true);
    expect(r.data.movimientos.every((m: { monto: number }) => m.monto > 0)).toBe(true);
    const withRefunds = await call("search_transactions", { month: "2026-10", only_purchases: false });
    expect(withRefunds.data.movimientos.some((m: { monto: number }) => m.monto < 0)).toBe(true);
  });

  it("categoría y tarjeta: coincidencia única o error, y se dice cuál se usó", async () => {
    const ok = await call("search_transactions", { category: "restaur", month: "2026-10" });
    expect(ok.data.filtros_aplicados.categoria).toBe("Restaurantes");
    for (const bad of [{ category: "a" }, { category: "$$$" }, { category: "   " }, { card: "  " }, { card: "a" }, { card: "Ban" + "x" }]) {
      expect((await call("search_transactions", bad)).ok, JSON.stringify(bad)).toBe(false);
    }
    // "am" está en Amex Gold y en Banamex: ambigua → error que las lista, nunca "la primera".
    const amb = await call("search_transactions", { card: "am" });
    expect(amb.ok).toBe(false);
    expect(amb.data.error).toContain("Amex Gold");
    expect(amb.data.error).toContain("Banamex");
    const two = await call("search_transactions", { card: "an" });
    expect(two.data.filtros_aplicados.tarjeta).toBe("Banamex Clásica");
    expect((await call("top_merchants", { category: "sin categoría" })).data.categoria_filtrada).toBe("Sin categoría");
  });

  it("search_transactions nunca expone notas ni identificadores internos", async () => {
    const r = await executeTool("search_transactions", "{}", ctx);
    expect(r.content).not.toContain("NOTA PRIVADA");
    expect(r.content).not.toMatch(/auth_code|account_ref|notes|"id"/);
  });

  it("spending_over_time: por mes (con ingreso y ahorro), por día y topes", async () => {
    const m = await call("spending_over_time");
    expect(m.data.agrupado_por).toBe("month");
    expect(m.data.serie.map((p: { periodo: string }) => p.periodo)).toEqual(["2026-07", "2026-08", "2026-09", "2026-10"]);
    expect(m.data.serie[0]).toMatchObject({ gastado: 20000, ahorro_estimado: 30000 });
    const d = await call("spending_over_time", { month: "2026-10" });
    expect(d.data.agrupado_por).toBe("day");
    expect(d.data.serie).toHaveLength(4);
    expect((await call("spending_over_time", { from: "2026-01-01", grain: "day" })).ok).toBe(false);
    const w = await call("spending_over_time", { from: "2026-09-28", to: "2026-10-15", grain: "week" });
    expect(w.data.serie.map((p: { periodo: string }) => p.periodo)).toEqual(["2026-09-28", "2026-10-05", "2026-10-12"]); // lunes
  });

  it("month_overview: ingreso, gasto, proyección y lo que puedes gastar al día", async () => {
    const { data } = await call("month_overview");
    expect(data).toMatchObject({ mes: "2026-10", ingreso_mensual: 50000, gastado: 10800, dias_restantes: 16 });
    expect(data.proyeccion_al_cierre).toBe(Math.round((10800 / 15) * 31));
    expect(data.puedes_gastar_al_dia_lo_que_resta).toBe(Math.round((50000 - 10800) / 16));
  });

  it("savings_simulation: cuánto apartar, si alcanza y de dónde recortar", async () => {
    const { ok, data } = await call("savings_simulation", { target_amount: 120000, months: 6 });
    expect(ok).toBe(true);
    expect(data).toMatchObject({ hay_que_apartar_al_mes: 20000, ingreso_mensual: 50000, gasto_tipico_mensual: 20000, excedente_mensual_tipico: 30000, alcanza_sin_recortar: true, falta_liberar_al_mes: 0 });
    const hard = await call("savings_simulation", { target_amount: 600000, target_date: "2027-04-15", already_saved: 0 });
    expect(hard.data.meses).toBe(6);
    expect(hard.data.alcanza_sin_recortar).toBe(false);
    expect(hard.data.falta_liberar_al_mes).toBe(70000);
    expect(hard.data.sin_recortar_llegarias_en_meses).toBe(20);
    expect(hard.data.donde_recortar[0].categoria).toBe("Restaurantes");
    expect((await call("savings_simulation", { target_amount: 1000 })).ok).toBe(false); // sin plazo
    expect((await call("savings_simulation", { target_amount: 1000, target_date: "2026-01-01" })).ok).toBe(false);
  });

  it("savings_goals y installments_msi responden aunque estén vacíos / con metas", async () => {
    const empty = await call("savings_goals");
    expect(empty.data.metas).toEqual([]);
    await createGoal({ name: "Viaje <script>", kind: "viaje", priority: 2, targetCents: 6_000_000, targetDate: "2027-04-30", monthOnly: false, savedCents: 0 }, "2026-10-15");
    const g = await call("savings_goals");
    expect(g.data.metas[0]).toMatchObject({ nombre: "Viaje script", monto_meta: 60000, tipo: "Viaje" });
    const msi = await call("installments_msi");
    expect(msi.data).toMatchObject({ se_cobra_este_mes: 0, saldo_total_por_pagar: 0, planes_vigentes: [] });
  });

  it("recurring_charges detecta lo que se repite", async () => {
    const { data } = await call("recurring_charges");
    expect(data.cargos.map((c: { comercio: string }) => c.comercio.toLowerCase())).toEqual(expect.arrayContaining(["renta depto"]));
    expect(data.total_mensual_aproximado).toBeGreaterThan(0);
  });
});
