import { isUndoableSources } from "@/lib/chat-sources";
import { dailyTotals, getOverview } from "@/lib/repo/stats";
import { getMonthlyIncome } from "@/lib/repo/settings";
import { listTransactions } from "@/lib/repo/transactions";
import { clearPending, findUndoTarget, undoRegistration } from "@/lib/repo/whatsapp";
import { monthLabel } from "@/lib/format";
import { currentMonth, localDate } from "@/lib/time";
import { eligibleCards } from "./cards";
import type { Ctx, Outcome } from "./conversation";
import type { Command } from "./parse-expense";
import * as R from "./replies";
import { localTime } from "./when";

/** Comandos de una palabra: ayuda, tarjetas, deshacer, cancelar, resumen, hoy. */
export async function handleCommand(c: Ctx, cmd: Command): Promise<Outcome> {
  switch (cmd) {
    case "help":
      return { reply: R.help(c.channel), status: "done" };
    case "cards":
      return { reply: R.cardsList(await eligibleCards()), status: "done" };
    case "cancel":
      return { reply: (await clearPending(c.msg.from)) ? R.CANCELLED : R.NOTHING_TO_CANCEL, status: "done" };
    case "undo":
      return undo(c);
    case "summary":
      return summary(c);
    case "today":
      return today(c);
  }
}

/**
 * Borra el ÚLTIMO registro de ESTE remitente en los últimos 30 min, solo si nadie más lo ha tocado (sources exactamente una etiqueta de
 * chat —`whatsapp`, `telegram`, `…-d`— o 'receipt'). Si el correo o el Atajo ya lo confirmaron/fusionaron, se explica y se deja intacto.
 * Solo se deshace el ÚLTIMO: tras deshacerlo, otro "deshacer" dice que no hay nada reciente (no retrocede al anterior).
 */
async function undo(c: Ctx): Promise<Outcome> {
  const target = await findUndoTarget(c.msg.from);
  if (!target) return { reply: R.undoNothing(), status: "done" };
  if (!isUndoableSources(target.sources)) return { reply: R.undoConfirmed(target.merchant, target.amountCents), status: "done" };
  const r = await undoRegistration(target.txId);
  if (r === "deleted") return { reply: R.undone(target.merchant, target.amountCents, target.card), status: "done" };
  return { reply: r === "confirmed" ? R.undoConfirmed(target.merchant, target.amountCents) : R.undoNothing(), status: "done" };
}

async function summary(c: Ctx): Promise<Outcome> {
  const today = localDate(c.sentAt);
  const month = currentMonth(c.sentAt);
  const [overview, daily, count, income] = await Promise.all([
    getOverview(month, c.sentAt),
    dailyTotals(today, today),
    listTransactions({ from: today, to: today, limit: 1 }),
    getMonthlyIncome(),
  ]);
  return {
    reply: R.summary({ todayCents: daily.get(today) ?? 0, todayCount: count.total, monthLabel: monthLabel(month), monthCents: overview.total, monthCount: overview.count, incomeCents: income }),
    status: "done",
  };
}

async function today(c: Ctx): Promise<Outcome> {
  const day = localDate(c.sentAt);
  const [list, daily] = await Promise.all([listTransactions({ from: day, to: day, limit: 5 }), dailyTotals(day, day)]);
  return {
    reply: R.todayList({
      rows: list.rows.map((x) => ({ merchant: x.merchant_raw, cents: x.amount_cents, card: x.card_name, time: localTime(new Date(x.occurred_at)) })),
      total: list.total, totalCents: daily.get(day) ?? 0,
    }),
    status: "done",
  };
}
