import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { zeroHash, type Address, type Hash } from "viem";
import { agreementSchema, claimMode, commitment, hash, type Agreement } from "./model.js";
import { cli, state, wallet, minimumAppealSeconds } from "./tempo.js";
import { Journal } from "./store.js";
import { taskDetail } from "./evidence.js";
import { bradburyPreflight } from "./bradbury.js";

// One pilot per journal. A persistent intent precedes the first funded request.
export async function preparePilot(db: Journal, bradburyWallet: Address) {
  const home = (role: string) => resolve("data/pilot", role);
  const [requester, worker, evaluator] = await Promise.all(
    ["requester", "worker", "evaluator"].map((role) => wallet(home(role))),
  );
  if (new Set([requester, worker, evaluator]).size !== 3)
    throw new Error("The pilot needs three separate registered test wallets");
  let agreement = agreementSchema.parse(
    JSON.parse(readFileSync(resolve("examples/taskmarket/fixed.json"), "utf8")),
  );
  const intentFor = (terms: Agreement) =>
    commitment({ network: 42431, requester, worker, evaluator, bradburyWallet, agreement: terms });
  db.db.exec(
    "CREATE TABLE IF NOT EXISTS pilot (slot INTEGER PRIMARY KEY CHECK(slot=1), intent TEXT NOT NULL, task TEXT, claimed INTEGER DEFAULT 0, submitted INTEGER DEFAULT 0)",
  );
  db.db.prepare("INSERT OR IGNORE INTO pilot(slot,intent) VALUES (1,?)").run(intentFor(agreement));
  const record = db.db.prepare("SELECT * FROM pilot WHERE slot=1").get()!;
  if (record.intent !== intentFor(agreement)) {
    // A run that started before the fee waiver must retain its original terms and request key.
    const original = JSON.parse(readFileSync(resolve("examples/taskmarket/settled-pilot.json"), "utf8"));
    agreement = agreementSchema.parse(original.agreement);
    if (record.intent !== intentFor(agreement))
      throw new Error("Pilot wallets or agreement differ from the saved run");
  }
  const description = JSON.stringify(agreement);
  const intent = intentFor(agreement);
  let id: Hash;
  if (record.task) id = hash.parse(record.task);
  else {
    const readiness = await bradburyPreflight(bradburyWallet);
    if (!readiness.depositCovered)
      throw new Error(
        "Fund " +
          bradburyWallet +
          " on Bradbury with 3 test GEN before posting. Current balance: " +
          readiness.balanceGEN +
          " GEN",
      );
    const appealSeconds = await minimumAppealSeconds();
    const result = await cli(
      [
        "task",
        "create",
        "--description",
        description,
        "--mode",
        "claim",
        "--duration",
        "72",
        "--reward",
        "1",
        "--hire-worker",
        worker,
        "--no-stake-required",
        "--evaluator",
        evaluator,
        "--evaluator-fee-bps",
        String(agreement.evaluatorFeeBps),
        "--evaluation-window",
        "24",
        "--appeal-window",
        String(appealSeconds / 3600),
        "--submission-visibility",
        "public",
      ],
      "pilot-create-" + intent.slice(2),
      home("requester"),
    );
    id = z.object({ taskId: hash }).parse(result).taskId;
    db.db.prepare("UPDATE pilot SET task=? WHERE slot=1").run(id);
  }
  db.track(id, agreement);
  console.log("Pilot task", id);
  for (;;) {
    const s = await state(id);
    if (s.task.id === zeroHash) {
      await delay(5000);
      continue;
    }
    if (![0, 1].includes(s.task.status)) return id;
    if (
      s.task.requester.toLowerCase() !== requester ||
      s.config.evaluator.toLowerCase() !== evaluator ||
      s.task.mode !== claimMode ||
      s.task.reward !== BigInt(agreement.rewardUnits) ||
      s.config.evaluatorFeeBps !== agreement.evaluatorFeeBps ||
      s.config.evaluatorStake !== 0n ||
      s.task.stakeRequired ||
      s.task.stakeAmount !== 0n ||
      s.task.feeBps !== 0 ||
      s.transformingHook
    )
      throw new Error("Created task differs from the stake-free pilot agreement");
    const t = await taskDetail(id);
    if (
      t.description !== description ||
      t.submissionVisibility !== "public" ||
      t.taskVisibility !== "public"
    )
      throw new Error("Published pilot terms or visibility changed");
    if (s.task.status === 0 && !record.claimed) {
      await cli(["task", "claim", id], "pilot-claim-" + id.slice(2), home("worker"));
      record.claimed = 1;
      db.db.exec("UPDATE pilot SET claimed=1 WHERE slot=1");
    }
    if (s.task.status === 1 && !record.submitted) {
      if (s.task.worker.toLowerCase() !== worker) throw new Error("Unexpected pilot worker");
      await cli(
        [
          "task",
          "submit",
          id,
          "--file",
          resolve("examples/taskmarket/submission.md"),
          "--role",
          "final",
        ],
        "pilot-submit-" + id.slice(2),
        home("worker"),
      );
      record.submitted = 1;
      db.db.exec("UPDATE pilot SET submitted=1 WHERE slot=1");
    }
    await delay(5000);
  }
}
