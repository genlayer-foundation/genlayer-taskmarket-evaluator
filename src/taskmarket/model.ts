import { keccak256, stringToHex, type Address, type Hash, zeroAddress } from "viem";
import { z } from "zod";
import { webDomains } from "./webSources.js";

export const claimMode = keccak256(stringToHex("TMP.mode.claim")).slice(0, 10) as Hash;
export const settlementNetwork = z.enum(["tempo-testnet", "tempo-mainnet"]).parse(
  process.env.TASKMARKET_SETTLEMENT_NETWORK ?? "tempo-testnet",
);
export const mainnet = settlementNetwork === "tempo-mainnet";
export const chainId = mainnet ? 4217 : 42431;
export const diamond = mainnet
  ? "0xF4f4a00011B080EbC1E599A765D8bCE7557B97e7"
  : "0xd9f2210Dcf1AabA46804e83876606E229323F29b";
export const api = mainnet ? "https://api.taskmarket.dev" : "https://testnet-api-market.daydreams.systems";
export const rpc = mainnet ? "https://rpc.tempo.xyz" : "https://rpc.moderato.tempo.xyz";
export const cliNetwork = mainnet ? "tempo" : "tempo-testnet";
export const operatorHome = mainnet ? "data/mainnet" : "data/pilot";
export const hash = z
  .string()
  .regex(/^0x[0-9a-f]{64}$/i)
  .transform((s) => s.toLowerCase() as Hash);
export const address = z
  .string()
  .regex(/^0x[0-9a-f]{40}$/i)
  .transform((s) => s.toLowerCase() as Address);
const units = z.string().regex(/^[1-9]\d{0,30}$/);
const rate = z.number().int().min(0).max(10000);
export const agreementSchema = z
  .object({
    version: z.literal("genlayer-taskmarket/v1"),
    settlementNetwork: z.enum(["tempo-mainnet", "tempo-testnet"]).optional(),
    rulingNetwork: z.literal("bradbury-testnet").optional(),
    brief: z.string().trim().min(1).max(12000),
    rubricVersion: z.string().min(1).max(80),
    rewardUnits: units,
    evaluatorFeeBps: rate,
    needsReview: z.literal("withhold-verdict"),
    milestones: z
      .array(
        z
          .object({
            id: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/),
            rubric: z.string().trim().min(1).max(4000),
            awardUnits: units,
            webDomains: webDomains.optional(),
          })
          .strict(),
      )
      .min(1)
      .max(8),
  })
  .strict()
  .superRefine((a, ctx) => {
    if (a.settlementNetwork && a.settlementNetwork !== settlementNetwork)
      ctx.addIssue({ code: "custom", message: "Agreement belongs to another settlement network" });
    if (mainnet && (!a.settlementNetwork || !a.rulingNetwork || a.evaluatorFeeBps !== 0))
      ctx.addIssue({
        code: "custom",
        message: "Mainnet pilot terms must name Tempo mainnet, Bradbury testnet rulings and a zero evaluator fee",
      });
    const reward = BigInt(a.rewardUnits);
    const available = reward - (reward * BigInt(a.evaluatorFeeBps)) / 10000n;
    if (a.milestones.reduce((n, m) => n + BigInt(m.awardUnits), 0n) !== available)
      ctx.addIssue({
        code: "custom",
        message: "Milestone prices must total escrow less the evaluator fee",
      });
    if (new Set(a.milestones.map((m) => m.id)).size !== a.milestones.length)
      ctx.addIssue({ code: "custom", message: "Milestone IDs must be unique" });
  });
export type Agreement = z.infer<typeof agreementSchema>;
export const digest = (text: string) => keccak256(stringToHex(text));
export const commitment = (value: unknown) => digest(JSON.stringify(value));
const percentage = z
  .union([z.number(), z.bigint().min(0n).max(100n).transform(Number)])
  .pipe(z.number().int().min(0).max(100));
export const rulingSchema = z.object({
  verdict: z.enum(["approve", "reject", "needs_review", "error"]),
  score: percentage,
  confidence: percentage,
  success: z.boolean(),
  reasoning: z.string(),
  rubric_version: z.string(),
});
export type Ruling = z.infer<typeof rulingSchema>;
export type Evidence = {
  chainId: 4217 | 42431;
  diamond: Address;
  taskId: Hash;
  requester: Address;
  worker: Address;
  evaluator: Address;
  description: string;
  briefHash: Hash;
  deliverable: Hash;
  submitTx: Hash;
  submitBlock: string;
  submissionId: string;
  manifest: string;
  files: { name: string; keccak256: Hash; text: string }[];
};
export type Judgment = {
  milestone: string;
  signed?: Hash;
  evmTx?: Hash;
  tx?: Hash;
  contract?: Address;
  result?: Ruling;
};
export type Decision = {
  verdict: "approve" | "partial" | "reject";
  score: number;
  confidence: number;
  awardUnits: string;
  worker: Address;
  evidenceHash: Hash;
};
export type Settlement = {
  tx: Hash;
  block: string;
  recipient: Address;
  units: string;
  kind: "payment" | "refund";
};
export type Job = {
  id: Hash;
  scenario?: string;
  agreement: Agreement;
  phase: "tracked" | "evaluating" | "ready" | "appealing" | "disputed" | "review" | "settled";
  evidence?: Evidence;
  judgments: Judgment[];
  decision?: Decision;
  evaluateTx?: Hash;
  finalizeTx?: Hash;
  settlement?: Settlement;
  message?: string;
  updated: string;
  cursor?: string;
  verdictCursor?: string;
};
export class Review extends Error {}
export function decide(job: Job): Decision {
  const { agreement, judgments, evidence } = job;
  if (!evidence || evidence.worker === zeroAddress || judgments.length !== agreement.milestones.length)
    throw new Review("Incomplete evidence or judgments");
  let amount = 0n;
  let score = 0,
    confidence = 1000,
    approved = 0;
  for (const [i, m] of agreement.milestones.entries()) {
    const j = judgments[i];
    const parsed = rulingSchema.safeParse(j.result);
    if (j.milestone !== m.id || !j.tx || !j.contract || !parsed.success)
      throw new Review("Incomplete finalized ruling");
    const r = parsed.data;
    const band = r.score >= 70 ? "approve" : r.score < 40 ? "reject" : "needs_review";
    if (
      !r.success ||
      r.verdict !== band ||
      r.verdict === "needs_review" ||
      r.rubric_version !== agreement.rubricVersion
    )
      throw new Review("Ruling requires review. The agreement withholds the Taskmarket verdict.");
    if (r.verdict === "approve") {
      amount += BigInt(m.awardUnits);
      approved++;
    }
    score += r.score * 10;
    confidence = Math.min(confidence, r.confidence * 10);
  }
  const verdict = approved === 0 ? "reject" : approved === judgments.length ? "approve" : "partial";
  const award = {
    verdict,
    worker: evidence.worker,
    awardUnits: String(amount),
    score: Math.round(score / judgments.length),
    confidence,
  } as const;
  const evidenceHash = commitment({
    version: 1,
    bradburyChainId: 4221,
    evidence,
    agreement,
    rulings: judgments.map(({ milestone, tx, contract, result }) => ({
      milestone,
      tx,
      contract,
      result,
    })),
    award,
  });
  return { ...award, evidenceHash };
}
