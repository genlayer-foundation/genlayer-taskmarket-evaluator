import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import {
  createPublicClient,
  http,
  parseAbi,
  parseAbiItem,
  parseEventLogs,
  TransactionReceiptNotFoundError,
  toFunctionSelector,
  zeroAddress,
  formatUnits,
  type Hash,
  type Address,
} from "viem";
import { z } from "zod";
import {
  address,
  chainId,
  diamond,
  rpc,
  api,
  hash,
  Review,
  type Job,
  type Decision,
  type Settlement,
} from "./model.js";

const client = createPublicClient({ transport: http(rpc) });
const token = "0x20c0000000000000000000006a37da5c996874be";
const abi = parseAbi([
  "function minAppealWindowSecs() view returns (uint32)",
  "function diamondVersion() view returns (uint256)",
  "function facetAddress(bytes4) view returns (address)",
  "function getTask(bytes32) view returns ((bytes32 id,address requester,address worker,uint8 status,bytes4 mode,uint256 reward,uint256 expiryTime,uint256 stakeAmount,uint16 feeBps,bytes32 deliverable,uint8 rating,address hookContract,bool stakeRequired,uint16 stakeBps))",
  "function getTaskEvaluatorConfig(bytes32) view returns ((address evaluator,uint256 evaluatorStake,uint16 evaluatorFeeBps,uint32 evaluationWindow,uint32 appealWindow,address disputeResolver))",
  "function getTaskHooksV2(bytes32) view returns ((address hook,uint32 capabilities,uint16 minDiamondVersion,bool transforming,bytes32 configHash,bytes32 codehash,uint32 callRoles)[])",
  "function getTaskVerdict(bytes32) view returns ((bool issued,uint8 verdictType,uint16 score,uint16 confidence,bytes32[] criteriaFlags,bytes32 evidenceHash,(address worker,uint256 amount,uint16 rank)[] awards))",
]);
const events = parseAbi([
  "event TaskSubmitted(bytes32 indexed taskId,address indexed worker,bytes32 deliverable)",
  "event TaskEvaluated(bytes32 indexed taskId,address indexed evaluator,uint8 verdictType,uint16 score)",
  "event TaskCompleted(bytes32 indexed taskId,address indexed requester,address indexed worker,uint256 workerPayment,uint256 platformFee)",
  "event TaskCancelled(bytes32 indexed taskId,address indexed requester,uint256 refundAmount)",
  "event Transfer(address indexed from,address indexed to,uint256 value)",
]);
const at = { abi, address: diamond } as const;
export async function preflight() {
  const discovery = fetch(new URL("/trpc/network.info", api), {
    signal: AbortSignal.timeout(15000),
  }).then(async (res) => {
    if (!res.ok) throw new Error("Taskmarket network information unavailable");
    return z
      .object({
        result: z.object({
          data: z.object({
            chains: z.array(
              z.object({
                chainId: z.number(),
                contractAddress: address,
                tokenAddress: address,
                paymentMethod: z.string(),
                tokenSymbol: z.string(),
              }),
            ),
          }),
        }),
      })
      .parse(await res.json())
      .result.data.chains.find((c) => c.chainId === chainId);
  });
  const [config, network, revision, ...facets] = await Promise.all([
    discovery,
    client.getChainId(),
    client.readContract({ ...at, functionName: "diamondVersion" }),
    ...[
      "evaluate(bytes32,uint8,uint16,uint16,bytes32,(address,uint256,uint16)[])",
      "finalizeVerdict(bytes32)",
    ].map((sig) =>
      client.readContract({ ...at, functionName: "facetAddress", args: [toFunctionSelector(sig)] }),
    ),
  ]);
  if (
    config?.contractAddress !== diamond.toLowerCase() ||
    config.tokenAddress !== token ||
    config.tokenSymbol !== "OUSD" ||
    config.paymentMethod !== "mpp-tempo" ||
    network !== chainId ||
    Number(revision) !== 31 ||
    facets.includes(zeroAddress)
  )
    throw new Error("Incompatible Tempo deployment");
  return {
    network,
    revision: Number(revision),
    diamond,
    token,
    evaluateFacet: facets[0],
    finalizeFacet: facets[1],
  };
}
export function minimumAppealSeconds() {
  return client.readContract({ ...at, functionName: "minAppealWindowSecs" });
}
export async function state(id: Hash) {
  const block = await client.getBlock();
  const ctx = { ...at, args: [id], blockNumber: block.number } as const;
  const [task, config, verdict, hooks] = await Promise.all([
    client.readContract({ ...ctx, functionName: "getTask" }),
    client.readContract({ ...ctx, functionName: "getTaskEvaluatorConfig" }),
    client.readContract({ ...ctx, functionName: "getTaskVerdict" }),
    client.readContract({ ...ctx, functionName: "getTaskHooksV2" }),
  ]);
  return {
    task,
    config,
    verdict,
    transformingHook: hooks.some((h) => h.transforming),
    now: Number(block.timestamp) * 1000,
  };
}
export type MarketState = Awaited<ReturnType<typeof state>>;
export function matches(d: Decision, v: MarketState["verdict"]) {
  const wanted =
    d.verdict === "reject" ? [] : [{ worker: d.worker, amount: BigInt(d.awardUnits), rank: 1 }];
  return (
    v.issued &&
    v.evidenceHash === d.evidenceHash &&
    v.verdictType === ["approve", "reject", "partial"].indexOf(d.verdict) &&
    v.score === d.score &&
    v.confidence === d.confidence &&
    v.awards.length === wanted.length &&
    wanted.every(
      (a, i) =>
        v.awards[i].worker.toLowerCase() === a.worker &&
        v.awards[i].amount === a.amount &&
        v.awards[i].rank === a.rank,
    )
  );
}
async function receipt(tx: Hash) {
  const r = await client.getTransactionReceipt({ hash: tx });
  if (r.status !== "success") throw new Review("Tempo transaction reverted: " + tx);
  return r;
}
export async function deadlineFromTransaction(tx: Hash, windowSeconds: number) {
  const r = await receipt(tx);
  const block = await client.getBlock({ blockHash: r.blockHash });
  return (Number(block.timestamp) + windowSeconds) * 1000;
}
export async function submissionBlock(tx: Hash, id: Hash, worker: Address, deliverable: Hash) {
  const r = await receipt(tx);
  const logs = parseEventLogs({
    abi: events,
    eventName: "TaskSubmitted",
    logs: r.logs.filter((l) => l.address.toLowerCase() === diamond.toLowerCase()),
  });
  if (
    !logs.some(
      (l) =>
        l.args.taskId === id &&
        l.args.worker.toLowerCase() === worker &&
        l.args.deliverable === deliverable,
    )
  )
    throw new Review("Submission receipt does not bind this task, worker and deliverable");
  return r.blockNumber;
}
export function verifySettlement(job: Job, r: Awaited<ReturnType<typeof receipt>>): Settlement {
  const { decision: d, evidence: e } = job;
  if (!d || !e || r.status !== "success")
    throw new Review("Settlement lacks a successful receipt and decision");
  const logs = r.logs.filter((l) => l.address.toLowerCase() === diamond.toLowerCase());
  const reject = d.verdict === "reject";
  const recipient = reject ? e.requester : d.worker;
  const amount = reject
    ? job.agreement.milestones.reduce((n, m) => n + BigInt(m.awardUnits), 0n)
    : BigInt(d.awardUnits);
  const outcome = reject
    ? parseEventLogs({ abi: events, eventName: "TaskCancelled", logs }).some(
        (l) =>
          l.args.taskId === job.id &&
          l.args.requester.toLowerCase() === recipient &&
          l.args.refundAmount === amount,
      )
    : parseEventLogs({ abi: events, eventName: "TaskCompleted", logs }).some(
        (l) =>
          l.args.taskId === job.id &&
          l.args.requester.toLowerCase() === e.requester &&
          l.args.worker.toLowerCase() === recipient &&
          l.args.workerPayment === amount,
      );
  const transferred = parseEventLogs({
    abi: events,
    eventName: "Transfer",
    logs: r.logs.filter((l) => l.address.toLowerCase() === token),
  }).some(
    (l) =>
      l.args.from.toLowerCase() === diamond.toLowerCase() &&
      l.args.to.toLowerCase() === recipient &&
      l.args.value === amount,
  );
  if (!outcome || !transferred)
    throw new Review(
      "Settlement event or OUSD transfer differs from the expected task, recipient or amount",
    );
  return {
    tx: r.transactionHash,
    block: String(r.blockNumber),
    recipient,
    units: String(amount),
    kind: reject ? "refund" : "payment",
  };
}
export async function recoverVerdict(job: Job) {
  const fromBlock = BigInt(job.verdictCursor ?? job.evidence!.submitBlock);
  const tip = await client.getBlockNumber();
  if (fromBlock > tip) return;
  const toBlock = tip < fromBlock + 19999n ? tip : fromBlock + 19999n;
  const logs = await client.getLogs({
    address: diamond,
    event: events[1],
    args: { taskId: job.id, evaluator: job.evidence!.evaluator },
    fromBlock,
    toBlock,
  });
  if (logs.length) return logs[0].transactionHash;
  job.verdictCursor = String(toBlock + 1n);
}
export async function verifySent(tx: Hash) {
  try {
    await receipt(tx);
  } catch (err) {
    if (!(err instanceof TransactionReceiptNotFoundError)) throw err;
  }
}
export async function settlement(job: Job): Promise<Settlement | undefined> {
  if (job.finalizeTx) return verifySettlement(job, await receipt(job.finalizeTx));
  // Another actor can finalize. Search bounded windows from the verified submission and resume the cursor.
  const fromBlock = BigInt(job.cursor ?? job.evidence!.submitBlock);
  const tip = await client.getBlockNumber();
  if (fromBlock > tip) return;
  const toBlock = tip < fromBlock + 19999n ? tip : fromBlock + 19999n;
  const event =
    job.decision!.verdict === "reject"
      ? parseAbiItem(
          "event TaskCancelled(bytes32 indexed taskId,address indexed requester,uint256 refundAmount)",
        )
      : parseAbiItem(
          "event TaskCompleted(bytes32 indexed taskId,address indexed requester,address indexed worker,uint256 workerPayment,uint256 platformFee)",
        );
  const logs = await client.getLogs({
    address: diamond,
    event,
    args: { taskId: job.id },
    fromBlock,
    toBlock,
  });
  if (logs.length) return verifySettlement(job, await receipt(logs[0].transactionHash));
  job.cursor = String(toBlock + 1n);
}

// RFC 9562 name-based UUID for Taskmarket's idempotency header. A retry must recover the same request.
export function operationId(name: string) {
  const namespace = Buffer.from("6ba7b8119dad11d180b400c04fd430c8", "hex");
  const bytes = createHash("sha1")
    .update(namespace)
    .update("urn:genlayer:taskmarket:moderato:" + name)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 15) | 0x50;
  bytes[8] = (bytes[8] & 63) | 0x80;
  const id = bytes.toString("hex");
  return [id.slice(0, 8), id.slice(8, 12), id.slice(12, 16), id.slice(16, 20), id.slice(20)].join("-");
}
const run = promisify(execFile);
export async function cli(
  args: string[],
  key?: string,
  home = process.env.TASKMARKET_HOME,
): Promise<unknown> {
  const executable = createRequire(import.meta.url).resolve("@lucid-agents/taskmarket/dist/index.js");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    TASKMARKET_HOME: home,
    TASKMARKET_API_URL: api,
    TASKMARKET_NETWORK: "tempo-testnet",
    TASKMARKET_IDEMPOTENCY_KEY: key ? operationId(key) : undefined,
  };
  delete env.GENLAYER_PRIVATE_KEY;
  try {
    const { stdout } = await run(process.execPath, [executable, "--network", "tempo-testnet", ...args], {
      env,
      timeout: 120000,
      maxBuffer: 1024 * 1024,
    });
    return z.object({ ok: z.literal(true), data: z.unknown() }).parse(JSON.parse(stdout)).data;
  } catch (err) {
    // Child-process errors may contain private URLs and credentials. Expose only the operation and structured error code.
    let code = "unavailable";
    if (err && typeof err === "object" && "stderr" in err) {
      try {
        const e = JSON.parse(String(err.stderr));
        const reason = e.reason ?? e.taskmarket?.reason ?? e.code;
        if (typeof reason === "string" && /^[a-z0-9_]+$/i.test(reason)) code = reason;
        else if (Number.isInteger(e.status)) code = "HTTP " + e.status;
      } catch {}
    }
    throw new Error("Taskmarket " + args.slice(0, 2).join(" ") + " failed (" + code + ")");
  }
}
export async function wallet(home?: string) {
  return z.object({ address }).parse(await cli(["address"], undefined, home)).address;
}
export async function relay(job: Job, action: "evaluate" | "finalize-verdict") {
  const d = job.decision!;
  const args = ["task", action, job.id];
  if (action === "evaluate") {
    args.push(
      "--verdict",
      d.verdict,
      "--score",
      String(d.score),
      "--confidence",
      String(d.confidence),
      "--evidence-hash",
      d.evidenceHash,
    );
    if (d.verdict !== "reject")
      args.push("--award", d.worker + ":" + formatUnits(BigInt(d.awardUnits), 6) + ":1");
  }
  const key = "gl-" + action + "-" + d.evidenceHash.slice(2);
  return z.object({ txHash: hash }).parse(await cli(args, key)).txHash;
}
