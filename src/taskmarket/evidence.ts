import { keccak256, sha256 } from "viem";
import { z } from "zod";
import {
  address,
  api,
  chainId,
  diamond,
  digest,
  hash,
  Review,
  type Evidence,
  type Job,
} from "./model.js";
import { matchesTaskDescription } from "./description.js";

export class SourceNotFound extends Error {}
const MAX_TEXT = 48 * 1024;
const textDecoder = new TextDecoder("utf-8", { fatal: true });
async function bytes(url: URL, limit: number) {
  const res = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(20000) });
  if (res.status === 404) throw new SourceNotFound("Public Taskmarket source not found");
  if (!res.ok || !res.body)
    throw new Error("Public Taskmarket evidence unavailable (" + res.status + ")");
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) throw new Review("Public evidence exceeds the supported size");
      parts.push(value);
    }
  } finally {
    await reader.cancel();
  }
  return Buffer.concat(parts);
}
function endpoint(path: string) {
  const url = new URL("/api/tasks/" + path, api);
  url.searchParams.set("chainId", String(chainId));
  return url;
}
async function json(path: string) {
  return JSON.parse(textDecoder.decode(await bytes(endpoint(path), 2_000_000)));
}
const taskSchema = z.object({
  id: hash,
  chainId: z.literal(chainId),
  mode: z.string(),
  description: z.string(),
  requester: address,
  taskVisibility: z.string(),
  submissionVisibility: z.string(),
  evaluatorDeadline: z.string().nullable(),
  appealDeadline: z.string().nullable(),
  claimedBy: address.nullable(),
  evaluator: address.nullable(),
  status: z.string(),
  projectId: z.unknown(),
  hooks: z.array(z.unknown()),
  platformFeeBps: z.number(),
});
export async function taskDetail(id: string) {
  const body = await json(id);
  if (body?.chainId !== chainId) throw new Review("Task detail belongs to another network");
  const t = taskSchema.parse(body);
  if (t.id !== id) throw new Review("Task ID differs from the tracked ID");
  return t;
}
const subSchema = z.object({
  id: z.string().uuid(),
  taskId: hash,
  workerAddress: address,
  rejectedAt: z.string().nullable(),
  submitTxHash: hash,
  deliverableHash: hash,
  artifacts: z.array(
    z.object({ id: z.string().uuid(), displayOrder: z.number().int(), keccak256Hash: hash }),
  ),
});
const manifestSchema = z.object({
  version: z.literal("taskmarket-artifacts-v1"),
  artifacts: z
    .array(
      z.object({
        fileName: z.string(),
        mimeType: z.string(),
        sizeBytes: z.number().int().positive(),
        sha256Hash: z.string().regex(/^(0x)?[a-f0-9]{64}$/i),
        keccak256Hash: hash,
        displayOrder: z.number().int(),
      }),
    )
    .min(1)
    .max(12),
});
export function previewLocation(raw: string) {
  const u = new URL(raw);
  if (
    u.protocol !== "https:" ||
    !/^taskmarket\.[0-9a-f]{32}\.r2\.cloudflarestorage\.com$/.test(u.hostname) ||
    u.port ||
    u.username ||
    u.password
  )
    throw new Review("Unsupported Taskmarket public storage origin");
  return u;
}
export type Source = {
  deliverable: Evidence["deliverable"];
  worker: Evidence["worker"];
  requester: Evidence["requester"];
  evaluator: Evidence["evaluator"];
};
export async function collectEvidence(
  job: Job,
  source: Source,
  verify: (tx: Evidence["submitTx"]) => Promise<bigint>,
): Promise<Evidence> {
  const t = await taskDetail(job.id);
  if (
    t.mode !== "claim" ||
    t.taskVisibility !== "public" ||
    t.submissionVisibility !== "public" ||
    t.projectId != null ||
    t.platformFeeBps !== 0 ||
    t.requester !== source.requester ||
    t.claimedBy !== source.worker ||
    t.evaluator !== source.evaluator
  )
    throw new Review(
      "Pilot requires a matching public, direct, single-worker claim with zero platform fee",
    );
  // The operator pins the exact agreement before enrollment. The remote description must match every field.
  if (!matchesTaskDescription(t.description, job.agreement))
    throw new Review("Published task terms differ from enrolled terms");
  const subs = z.array(subSchema).parse(await json(job.id + "/submissions"));
  const matches = subs.filter(
    (s) =>
      s.taskId === job.id &&
      !s.rejectedAt &&
      s.workerAddress === source.worker &&
      s.deliverableHash === source.deliverable,
  );
  if (matches.length !== 1)
    throw new Error("Waiting for one indexed submission matching the onchain deliverable");
  const sub = matches[0];
  const block = await verify(sub.submitTxHash);
  const raw = await bytes(endpoint(job.id + "/submissions/" + sub.id + "/manifest"), 32000);
  if (keccak256(raw) !== source.deliverable) throw new Review("Manifest differs from Tempo commitment");
  const manifest = textDecoder.decode(raw);
  const entries = manifestSchema.parse(JSON.parse(manifest)).artifacts;
  if (entries.reduce((sum, e) => sum + e.sizeBytes, 0) > MAX_TEXT)
    throw new Review("Submission exceeds text budget");
  const files: Evidence["files"] = [];
  for (const e of entries) {
    if (!/^(text\/(plain|markdown|csv)|application\/json)(;|$)/i.test(e.mimeType))
      throw new Review("Unsupported submission media type");
    const a = sub.artifacts.find(
      (x) => x.displayOrder === e.displayOrder && x.keccak256Hash === e.keccak256Hash,
    );
    if (!a) throw new Review("Artifact missing from the submitted manifest");
    const link = z
      .object({ previewUrl: z.string() })
      .parse(await json(job.id + "/artifacts/" + a.id + "/preview"));
    const data = await bytes(previewLocation(link.previewUrl), e.sizeBytes);
    if (
      data.length !== e.sizeBytes ||
      keccak256(data) !== e.keccak256Hash ||
      sha256(data).slice(2) !== e.sha256Hash.replace(/^0x/, "").toLowerCase()
    )
      throw new Review("Downloaded artifact differs from the submitted bytes");
    files.push({ name: e.fileName, keccak256: e.keccak256Hash, text: textDecoder.decode(data) });
  }
  return {
    chainId,
    diamond,
    taskId: job.id,
    ...source,
    description: t.description,
    briefHash: digest(t.description),
    submissionId: sub.id,
    submitTx: sub.submitTxHash,
    submitBlock: String(block),
    manifest,
    files,
  };
}
