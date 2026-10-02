import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GET as changes } from "@/app/api/changes/route";
import { createCard } from "@/lib/repo/cards";
import { closePool } from "@/lib/db/pool";
import { createManual, deleteTransaction, updateTransaction } from "@/lib/repo/transactions";
import { authed, ctx, guestPrincipal, req, resetDb } from "../helpers";

beforeEach(resetDb);
afterAll(closePool);

const rev = async () => (await (await changes(req("/api/changes", { headers: authed() }), ctx())).json()).rev as string;

describe("/api/changes (actualización en vivo)", () => {
  it("exige sesión", async () => {
    expect((await changes(req("/api/changes"), ctx())).status).toBe(401);
    expect((await changes(req("/api/changes", { headers: { "x-ms-client-principal": guestPrincipal("intruso@gmail.com") } }), ctx())).status).toBe(403);
  });
  it("la revisión cambia con altas, ediciones y bajas, y es estable sin cambios", async () => {
    const card = await createCard({ name: "Nu", issuer: "nu", last4: null, aliases: null, color: "#8a05be" });
    const r0 = await rev();
    expect(await rev()).toBe(r0);
    const t = await createManual({ occurredAt: new Date("2026-09-10T18:00:00Z"), amountCents: 1000, merchant: "A", cardId: card.id, categoryId: null, notes: null });
    if (t.status !== "inserted") throw new Error("no insertó");
    const r1 = await rev();
    expect(r1).not.toBe(r0);
    await updateTransaction(t.id, { occurredAt: new Date("2026-09-10T18:00:00Z"), amountCents: 2000, merchant: "A", cardId: card.id, categoryId: null, notes: null });
    const r2 = await rev();
    expect(r2).not.toBe(r1);
    await deleteTransaction(t.id);
    expect(await rev()).not.toBe(r2);
  });
});
