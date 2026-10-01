import { HttpError, parseQuery, protectedRoute } from "@/lib/api";
import { csvCell } from "@/lib/csv-export";
import { listTransactions } from "@/lib/repo/transactions";
import { MONTH_RE } from "@/lib/time";
import { z } from "zod";

export const dynamic = "force-dynamic";

export const GET = protectedRoute(async ({ req }) => {
  const { month } = parseQuery(req, z.object({ month: z.string().regex(MONTH_RE) }));
  const { rows } = await listTransactions({ month, limit: 500 });
  if (rows.length >= 500) throw new HttpError(413, "Demasiados movimientos para exportar de una vez");
  const lines = [["fecha", "comercio", "monto", "tarjeta", "categoria", "fuente", "notas"].join(",")];
  for (const r of [...rows].reverse()) {
    lines.push([r.occurred_date, r.merchant_raw, (r.amount_cents / 100).toFixed(2), r.card_name, r.category_name, r.source, r.notes].map((v) => csvCell(v)).join(","));
  }
  return new Response(`﻿${lines.join("\n")}\n`, {
    headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="uzfinance-${month}.csv"`, "Cache-Control": "no-store" },
  });
});
