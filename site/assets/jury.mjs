"use strict";

export function rulingLinks(m) {
  const phase = m.bradburyPhase ?? 2;
  if (phase !== 2 && phase !== 3) return [];
  const hash = /^0x[0-9a-f]{64}$/i;
  const links = [];
  if (phase === 3 && hash.test(m.tx))
    links.push({ label: "Inspect Phase 3 ruling", url: "https://scan.bradbury.genlayer.com/tx/" + m.tx });
  if (hash.test(m.evmTx))
    links.push({ label: "Inspect Phase " + phase + " deployment receipt", url: "https://scan.testnet-chain.genlayer.com/tx/" + m.evmTx });
  return links;
}

export const juryLabels = {
  approve: "Approved", reject: "Rejected", partial: "Partial award", needs_review: "Payment decision withheld",
  error: "Evaluation failed", finalized: "Jury rulings finalized", enrolled: "Awaiting submission",
  submitted: "Awaiting jury", judging: "Jury deliberating", provisional: "Provisional decision", appeal: "Appeal in progress",
  paused: "Evaluation paused", finalizing: "Finalizing evaluation",
};

export function evidenceLabel(domains) {
  return Array.isArray(domains) && domains.length
    ? "The jury reads the submitted files and cited public pages from " + domains.join(", ") + "."
    : "The jury reads the submitted files only. Links are treated as text.";
}

export function milestoneLabel(m) {
  if (m.status === "Finalized") return juryLabels[m.result?.verdict] || "Ruling finalized";
  if (m.status === "Accepted" && m.decision) {
    const outcome = {approve: "approve", reject: "reject", needs_review: "withhold payment decision", error: "ruling error"};
    return outcome[m.result?.verdict] ? "Provisional decision · " + outcome[m.result.verdict] : juryLabels.provisional;
  }
  if (m.status?.startsWith("Appeal ")) return juryLabels.appeal;
  return m.status === "Awaiting jury" ? "Awaiting jury" : m.status || juryLabels.judging;
}

export function juryStage(phase, milestones) {
  if (milestones.some(m => m.status?.startsWith("Appeal "))) return "appeal";
  if (milestones.some(m => m.status === "Accepted" && m.decision)) return "provisional";
  if (phase === "review" || phase === "disputed") return "paused";
  if (phase === "tracked" && !milestones.some(m => m.tx)) return "enrolled";
  if (!milestones.some(m => m.tx)) return "submitted";
  if (milestones.length && milestones.every(m => m.status === "Finalized")) return "finalizing";
  return "judging";
}

export function finalOutcome(milestones) {
  if (!milestones.length || !milestones.every(m => m.status === "Finalized" && m.result?.verdict)) return null;
  const verdicts = new Set(milestones.map(m => m.result.verdict));
  if (verdicts.has("error")) return "error";
  if (verdicts.has("needs_review")) return "needs_review";
  return verdicts.size === 1 ? milestones[0].result.verdict : "finalized";
}
