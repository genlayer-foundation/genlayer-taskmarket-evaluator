import { zeroHash, zeroAddress, type Address } from "viem";
import { claimMode, address, decide, Review, type Job, type Judgment } from "./model.js";
import type { MarketState } from "./tempo.js";
import * as tempo from "./tempo.js";
import * as evidence from "./evidence.js";

export type Ports = {
  wallet: Address;
  state: typeof tempo.state;
  deadlineFromTransaction: typeof tempo.deadlineFromTransaction;
  collect: typeof evidence.collectEvidence;
  submissionBlock: typeof tempo.submissionBlock;
  judge: (job: Job, j: Judgment, save: () => void) => Promise<void>;
  noticesReady?: (job: Job) => boolean;
  relay: typeof tempo.relay;
  settlement: typeof tempo.settlement;
  recoverVerdict: typeof tempo.recoverVerdict;
  verifySent: typeof tempo.verifySent;
};
function assertTerms(job: Job, s: MarketState, wallet: Address) {
  if (
    s.task.id !== job.id ||
    s.task.mode !== claimMode ||
    s.task.reward !== BigInt(job.agreement.rewardUnits) ||
    s.config.evaluatorFeeBps !== job.agreement.evaluatorFeeBps ||
    s.config.evaluator.toLowerCase() !== wallet ||
    s.task.feeBps !== 0 ||
    s.task.stakeRequired ||
    s.task.stakeAmount !== 0n ||
    s.config.evaluatorStake !== 0n ||
    s.transformingHook
  )
    throw new Review("Onchain task, evaluator, fee, stake, hooks or reward differs from pilot terms");
}
export async function advance(job: Job, p: Ports, persist: () => void) {
  if (job.phase === "review" || job.phase === "settled" || job.phase === "disputed") return;
  const save = () => {
    delete job.message;
    persist();
  };
  try {
    const s = await p.state(job.id);
    if (s.task.id === zeroHash) return;
    if (s.task.status === 9) {
      job.phase = "disputed";
      save();
      return;
    }
    if (s.verdict.issued) {
      if (!job.decision || !tempo.matches(job.decision, s.verdict))
        throw new Review("Recorded Taskmarket verdict differs from this ruling");
      if (!job.evaluateTx) {
        job.evaluateTx = await p.recoverVerdict(job);
        if (!job.evaluateTx) {
          persist();
          return;
        }
      }
      if (s.task.status === 8) {
        job.phase = "appealing";
        const time = await p.deadlineFromTransaction(job.evaluateTx, s.config.appealWindow);
        if (job.finalizeTx) await p.verifySent(job.finalizeTx);
        else if (s.now >= time) job.finalizeTx = await p.relay(job, "finalize-verdict");
      } else if ([4, 6].includes(s.task.status)) {
        const receipt = await p.settlement(job);
        if (receipt) {
          job.settlement = receipt;
          job.phase = "settled";
        }
      } else throw new Review("Unexpected task state after verdict");
      save();
      return;
    }
    assertTerms(job, s, p.wallet);
    if (s.task.status !== 7) {
      if (job.evidence || ![0, 1].includes(s.task.status))
        throw new Review("Task left the expected review lifecycle");
      return;
    }
    const source = {
      worker: address.parse(s.task.worker),
      requester: address.parse(s.task.requester),
      evaluator: p.wallet,
      deliverable: s.task.deliverable,
    };
    if (
      source.worker === zeroAddress ||
      source.worker === source.requester ||
      source.worker === source.evaluator ||
      source.requester === source.evaluator
    )
      throw new Review("Expected distinct requester, evaluator and assigned worker");
    if (!job.evidence) {
      job.evidence = await p.collect(job, source, (tx) =>
        p.submissionBlock(tx, job.id, source.worker, source.deliverable),
      );
      job.judgments = job.agreement.milestones.map((m) => ({ milestone: m.id }));
      job.phase = "evaluating";
      save();
    }
    if (
      job.evidence.worker !== source.worker ||
      job.evidence.deliverable !== source.deliverable ||
      job.evidence.requester !== source.requester
    )
      throw new Review("Assignment or deliverable changed after evaluation started");
    // Revision 31 starts the review at the submission block. The API can lag the contract status.
    if ((await p.deadlineFromTransaction(job.evidence.submitTx, s.config.evaluationWindow)) < s.now)
      throw new Review("Evaluation deadline passed");
    const j = job.judgments.find((x) => !x.result);
    if (j) {
      if (!j.signed && !j.tx && !j.evmTx && p.noticesReady && !p.noticesReady(job)) return;
      await p.judge(job, j, save);
      save();
      return;
    }
    if (!job.decision) {
      job.decision = decide(job);
      job.phase = "ready";
      save();
      return;
    }
    if (job.evaluateTx) await p.verifySent(job.evaluateTx);
    else job.evaluateTx = await p.relay(job, "evaluate");
    save();
  } catch (err) {
    if (err instanceof Review) job.phase = "review";
    const message =
      err instanceof Error && "shortMessage" in err && typeof err.shortMessage === "string"
        ? err.shortMessage
        : err instanceof Error
          ? err.message
          : "Service unavailable";
    job.message = message
      .replace(/0x[0-9a-f]{65,}/gi, "[transaction data]")
      .replace(/https?:\/\/\S+\?\S+/g, "[signed URL]")
      .slice(0, 400);
    persist();
  }
}
