import { formatUnits } from "viem";
import { agreementSchema, commitment, mainnet, type Agreement } from "./model.js";

// Taskmarket displays the first line as the task title. All visible text comes from pinned terms.
export function taskDescription(agreement: Agreement): string {
  const binary = agreement.version === "genlayer-taskmarket/v2";
  const firstLine = agreement.brief.split(/[\r\n]/, 1)[0];
  const opening = firstLine.length <= 100
    ? firstLine
    : firstLine.match(/^.{1,99}?[.!?](?=\s|$)/u)?.[0];
  const title = opening || "Internet Court milestone review";
  const body = opening ? agreement.brief.slice(opening.length).trimStart() : agreement.brief;
  const token = mainnet ? "OUSD" : "test OUSD";
  const amount = (units: string) => formatUnits(BigInt(units), 6).replace(/\.\d$/, "$&0") + " " + token;
  return [
    title,
    body,
    ...agreement.milestones.map((m) => [
      `Milestone · ${m.id} · ${amount(m.awardUnits)}\n${m.rubric}`,
      ...(m.webDomains ? [`Web evidence: cite 1–3 public HTTPS pages from ${m.webDomains.join(", ")} in this rubric or your submission. Each judge reads up to 6,000 characters per page. ${binary ? "Missing required citations fail the milestone. A retrieval failure pauses settlement." : "Missing or unreadable sources require review."}`] : []),
    ].join("\n")),
    [
      `Escrow: ${amount(agreement.rewardUnits)} on Tempo ${mainnet ? "mainnet" : "testnet"}`,
      `Evaluator fee: ${formatUnits(BigInt(agreement.evaluatorFeeBps), 2)}%`,
      binary
        ? "Rulings: GenLayer Bradbury testnet. Each milestone passes at 70–100 and fails at 0–69. Missing required proof fails. An evaluator or network failure pauses settlement."
        : "Rulings: GenLayer Bradbury testnet. A ruling requiring review withholds the verdict.",
      "Rubric: " + agreement.rubricVersion,
      "Agreement reference: " + commitment(agreement),
    ].join("\n"),
  ].filter(Boolean).join("\n\n");
}

export function matchesTaskDescription(description: string, agreement: Agreement): boolean {
  if (description === taskDescription(agreement)) return true;
  // Existing funded tasks published the complete agreement as JSON.
  try {
    const published = agreementSchema.safeParse(JSON.parse(description));
    return published.success && commitment(published.data) === commitment(agreement);
  } catch {
    return false;
  }
}
