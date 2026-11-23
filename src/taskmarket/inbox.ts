import { z } from "zod";
import { type Address } from "viem";
import { Journal } from "./store.js";
import { api, chainId, hash, Review, type Agreement } from "./model.js";
import { matchesTaskDescription } from "./description.js";
import { taskDetail, SourceNotFound } from "./evidence.js";

const queue = z.object({
  items: z.array(
    z.object({
      role: z.string(),
      intent: z.string(),
      task: z.object({ chainId: z.number().nullish() }),
      actions: z.array(
        z.object({
          type: z.string(),
          taskId: hash,
        }),
      ),
    }),
  ),
  nextCursor: z.string().nullable(),
});

// Read one public page per poll. Keep the operator's agreed template as the source of terms.
export async function discover(
  db: Journal,
  wallet: Address,
  offer: Agreement,
  requesters: Set<Address>,
  cursor?: string,
) {
  const url = new URL("/api/agents/action-queue", api);
  url.searchParams.set("address", wallet);
  url.searchParams.set("limit", "50");
  if (cursor) url.searchParams.set("cursor", cursor);
  const response = await fetch(url, { signal: AbortSignal.timeout(15000), redirect: "error" });
  if (!response.ok) throw new Error("Taskmarket inbox unavailable (" + response.status + ")");
  const page = queue.parse(await response.json());
  for (const item of page.items) {
    if (
      (item.task.chainId != null && item.task.chainId !== chainId) ||
      item.role !== "evaluator" ||
      item.intent !== "evaluate_work"
    )
      continue;
    for (const action of item.actions) {
      if (action.type !== "evaluate" || db.get(action.taskId)) continue;
      // Live action cards can omit the chain. The full public task verifies it.
      const t = await taskDetail(action.taskId).catch((err) => {
        if (err instanceof Review || err instanceof SourceNotFound) return undefined;
        throw err;
      });
      if (
        !t ||
        t.evaluator !== wallet ||
        !requesters.has(t.requester) ||
        t.mode !== "claim" ||
        t.status !== "review" ||
        t.taskVisibility !== "public" ||
        t.submissionVisibility !== "public"
      )
        continue;
      if (matchesTaskDescription(t.description, offer)) db.track(action.taskId, offer);
    }
  }
  return page.nextCursor ?? undefined;
}
