import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { zeroAddress, zeroHash } from "viem";
import { advance, type Ports } from "./engine.js";
import { claimMode, address, agreementSchema, chainId, diamond, digest, type Job } from "./model.js";
import { type MarketState } from "./tempo.js";
import { Journal } from "./store.js";

export const scenarios = ["approval", "rejection", "partial", "uncertain", "recovery"] as const;
export type Scenario = (typeof scenarios)[number];
export const fixtureAddress = (digit: string) => address.parse("0x" + digit.repeat(40));
export function example(milestones: boolean) {
  const name = milestones ? "research" : "fixed";
  return agreementSchema.parse(
    JSON.parse(
      readFileSync(
        new URL(
          "../../examples/taskmarket/" + name + ".json",
          new URL(import.meta.url.replace("/dist/src/", "/src/")),
        ),
        "utf8",
      ),
    ),
  );
}
// Only the external systems are simulated. The worker, persisted journal, finality gate,
// award calculation and recovery loop are shared with the network-backed service.
export function simulation(job: Job, scenario: Scenario) {
  const requester = fixtureAddress("1"),
    worker = fixtureAddress("2"),
    wallet = fixtureAddress("3");
  const text =
    scenario === "rejection"
      ? "No guide supplied."
      : scenario === "partial"
        ? "Comparison of three marketplaces supplied. The third procedure requires a private credential."
        : "Example task command and appeal-window explanation supplied.";
  const manifest = JSON.stringify({ simulation: true, textHash: digest(text) });
  const s: MarketState = {
    transformingHook: false,
    task: {
      id: job.id,
      requester,
      worker,
      status: 7,
      mode: claimMode,
      reward: BigInt(job.agreement.rewardUnits),
      expiryTime: 0n,
      stakeAmount: 0n,
      feeBps: 0,
      deliverable: digest(manifest),
      rating: 0,
      hookContract: zeroAddress,
      stakeRequired: false,
      stakeBps: 0,
    },
    config: {
      evaluator: wallet,
      evaluatorStake: 0n,
      evaluatorFeeBps: job.agreement.evaluatorFeeBps,
      evaluationWindow: 86400,
      appealWindow: 300,
      disputeResolver: zeroAddress,
    },
    verdict: {
      issued: false,
      verdictType: 0,
      score: 0,
      confidence: 0,
      criteriaFlags: [],
      evidenceHash: zeroHash,
      awards: [],
    },
    now: 0,
  };
  let writes = 0,
    finalizations = 0,
    deployments = 0;
  const p: Ports = {
    wallet,
    state: async () => s,
    deadlineFromTransaction: async (_tx, seconds) => seconds * 1000,
    submissionBlock: async () => 1n,
    collect: async (j, src, verify) => {
      const submitTx = digest("submit-" + j.id);
      return {
        chainId,
        diamond,
        taskId: j.id,
        ...src,
        description: JSON.stringify(j.agreement),
        briefHash: digest(JSON.stringify(j.agreement)),
        submitTx,
        submitBlock: String(await verify(submitTx)),
        submissionId: j.id,
        manifest,
        files: [{ name: "submission.md", text, keccak256: digest(text) }],
      };
    },
    judge: async (j, r, save) => {
      if (!r.tx) {
        deployments++;
        r.tx = digest(j.id + r.milestone);
        save();
        return;
      }
      const fail = scenario === "rejection" || (scenario === "partial" && r.milestone === "procedures");
      r.contract = fixtureAddress("4");
      r.result = {
        success: true,
        verdict: scenario === "uncertain" ? "needs_review" : fail ? "reject" : "approve",
        score: scenario === "uncertain" ? 50 : fail ? 18 : 92,
        confidence: 90,
        rubric_version: j.agreement.rubricVersion,
        reasoning:
          scenario === "uncertain"
            ? "The submitted evidence is inconclusive."
            : fail
              ? "The submission does not meet the stated criterion."
              : "The submission meets the stated criterion.",
      };
    },
    relay: async (j, action) => {
      if (action === "evaluate") {
        writes++;
        const d = j.decision!;
        s.verdict = {
          issued: true,
          verdictType: ["approve", "reject", "partial"].indexOf(d.verdict),
          score: d.score,
          confidence: d.confidence,
          evidenceHash: d.evidenceHash,
          criteriaFlags: [],
          awards: d.verdict === "reject" ? [] : [{ worker, amount: BigInt(d.awardUnits), rank: 1 }],
        };
        s.task.status = 8;
        if (scenario === "recovery")
          throw new Error("Simulated lost response after the verdict was submitted");
      } else {
        finalizations++;
        s.task.status = j.decision!.verdict === "reject" ? 6 : 4;
      }
      return digest(action + j.id);
    },
    verifySent: async () => {},
    recoverVerdict: async (j) => digest("evaluate" + j.id),
    settlement: async (j) => ({
      tx: digest("finalize-verdict" + j.id),
      block: "12",
      recipient: j.decision!.verdict === "reject" ? requester : worker,
      units:
        j.decision!.verdict === "reject" ? j.agreement.milestones[0].awardUnits : j.decision!.awardUnits,
      kind: j.decision!.verdict === "reject" ? "refund" : "payment",
    }),
  };
  return { p, s, counts: () => ({ writes, finalizations, deployments }) };
}
export async function runExample(
  db: Journal,
  scenario: Scenario,
  id = digest("demo-" + scenario + randomUUID()),
) {
  db.track(id, example(scenario === "partial"));
  const initial = db.get(id)!;
  initial.scenario = scenario;
  db.save(initial);
  const sim = simulation(initial, scenario);
  for (let i = 0; i < 25; i++) {
    // Reload on each iteration, including after the simulated lost response.
    const j = db.get(id)!;
    if (["settled", "review"].includes(j.phase)) return j;
    await advance(j, sim.p, () => db.save(j));
    sim.s.now += 60000;
  }
  throw new Error("Local scenario did not reach a terminal outcome");
}
