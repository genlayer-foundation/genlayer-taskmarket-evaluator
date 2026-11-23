import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createClient } from "genlayer-js";
import { testnetBradbury } from "genlayer-js/chains";
import { TransactionHashVariant, type Hash as GenHash } from "genlayer-js/types";
import { privateKeyToAccount } from "viem/accounts";
import {
  createPublicClient,
  http,
  keccak256,
  parseEventLogs,
  parseAbi,
  TransactionReceiptNotFoundError,
  TransactionNotFoundError,
  formatEther,
  type Address,
  type Hash,
} from "viem";
import { address, commitment, Review, rulingSchema, type Job, type Judgment } from "./model.js";

const nodeEndpoint = "https://rpc-bradbury.genlayer.com";
export const code = readFileSync(
  fileURLToPath(
    new URL("../../contracts/acp_evaluator.py", new URL(import.meta.url.replace("/dist/src/", "/src/"))),
  ),
);
const deploymentEvents = parseAbi([
  "event CreatedTransaction(bytes32 indexed txId,uint256 txSlot)",
  "event NewTransaction(bytes32 indexed txId,address indexed recipient,address indexed activator)",
]);
export function inputs(job: Job, j: Judgment) {
  const e = job.evidence!;
  const milestone = job.agreement.milestones.find((m) => m.id === j.milestone)!;
  const metadata = {
    rubric_version: job.agreement.rubricVersion,
    milestone: j.milestone,
    taskId: job.id,
    tempoChainId: e.chainId,
    diamond: e.diamond,
    worker: e.worker,
    briefHash: e.briefHash,
    manifestHash: e.deliverable,
    submissionId: e.submissionId,
    submitTx: e.submitTx,
    evidenceHash: commitment(e),
  };
  return [job.agreement.brief, JSON.stringify(e.files), milestone.rubric, JSON.stringify(metadata)];
}
const evm = createPublicClient({ transport: http(nodeEndpoint) });
const observer = createClient({ chain: testnetBradbury, endpoint: nodeEndpoint });
export async function publicRulingId(j: Judgment) {
  if (j.tx || !j.evmTx) return j.tx;
  const receipt = await evm.getTransactionReceipt({ hash: j.evmTx }).catch((error) => {
    if (error instanceof TransactionReceiptNotFoundError) return null;
    throw error;
  });
  if (!receipt || receipt.status !== "success") return;
  const logs = receipt.logs.filter((l) => l.address.toLowerCase() === observer.chain.consensusMainContract!.address.toLowerCase());
  const ids = new Set(parseEventLogs({ abi: deploymentEvents, logs }).map((e) => e.args.txId));
  if (ids.size === 1) return [...ids][0];
}

export type LiveRuling = {
  status: string;
  decision?: string;
  deadline?: number;
  result?: { verdict: string; reasoning: string };
};
export async function observeRuling(tx: Hash): Promise<LiveRuling> {
  const { address: data, abi } = testnetBradbury.consensusDataContract!;
  const block = await evm.getBlock();
  const lifecycle = await evm.readContract({ address: data, abi, functionName: "getTransactionLifecycle",
    args: [tx, block.timestamp], blockNumber: block.number }) as {
      storedStatus: number; decisionActive: boolean;
      latestDecision: { decisionId: bigint; appealDeadline: bigint };
    };
  const status = ["Unknown", "Pending", "Proposing", "Committing", "Revealing", "Accepted",
    "Undetermined", "Finalized", "Canceled", "Appeal revealing", "Appeal committing",
    "Validators timeout", "Leader timeout", "Leader revealing"][Number(lifecycle.storedStatus)] ?? "Processing";
  if (!lifecycle.decisionActive && (status !== "Finalized" || !lifecycle.latestDecision.appealDeadline)) return { status };
  const decision = String(lifecycle.latestDecision.decisionId);
  const deadline = Number(lifecycle.latestDecision.appealDeadline);
  return { status, decision, deadline };
}

export async function provisionalReasons(job: Job, j: Judgment, tx: Hash) {
  const receipt = await observer.getTransaction({ hash: tx as GenHash });
  if (receipt.lifecycle.state !== "decided" || receipt.lifecycle.outcome !== "accepted" ||
      receipt.txExecutionResultName !== "FINISHED_WITH_RETURN") return;
  const contract = address.parse(receipt.txDataDecoded && "contractAddress" in receipt.txDataDecoded
    ? receipt.txDataDecoded.contractAddress : receipt.recipient);
  const read = (functionName: string) => observer.readContract({ address: contract, functionName, args: [],
    transactionHashVariant: TransactionHashVariant.LATEST_NONFINAL });
  const [pinned, value] = await Promise.all([read("get_input"), read("get_result")]);
  const expected = inputs(job, j);
  if (["task_spec", "submission", "rubric", "metadata_json"].some((key, i) => (pinned as Record<string, unknown>)[key] !== expected[i])) return;
  const result = rulingSchema.parse(value);
  return { verdict: result.verdict, reasoning: result.reasoning };
}
const feeOptions = {
  leaderTimeunitsAllocation: 130n,
  validatorTimeunitsAllocation: 230n,
  executionBudgetPerRound: 1_000_000_000_000_000_000n,
  appealRounds: 0n,
  rotations: [0n],
  totalMessageFees: 0n,
};
const depositCeiling = 3_000_000_000_000_000_000n;
async function connect() {
  const client = createClient({ chain: testnetBradbury, endpoint: nodeEndpoint });
  const [chain, genesis] = await Promise.all([evm.getChainId(), evm.getBlock({ blockNumber: 0n })]);
  if (
    chain !== testnetBradbury.id ||
    genesis.hash !== "0x17d89764d4f4f963158fc4c5e8f2cb670c2837740b35f37081c12860c3df97e4"
  )
    throw new Error("Unexpected Bradbury network");
  if (
    address.parse(client.chain.consensusMainContract?.address) !==
    "0x2e2766cbc3e5e61ce93bbcdcbb3eacb82082a019"
  )
    throw new Error("Unexpected Bradbury consensus contract");
  await client.getContractSchemaForCode(code);
  return client;
}
export async function bradburyPreflight(wallet?: Address) {
  const client = await connect();
  const [fees, balance] = await Promise.all([
    client.estimateTransactionFees(feeOptions),
    wallet ? evm.getBalance({ address: wallet }) : undefined,
  ]);
  return {
    network: "Bradbury Phase 2",
    chainId: client.chain.id,
    consensus: client.chain.consensusMainContract?.address,
    schemaVerified: true,
    depositGEN: formatEther(fees.feeValue),
    wallet,
    balanceGEN: balance === undefined ? undefined : formatEther(balance),
    depositCovered: balance !== undefined && balance > fees.feeValue && fees.feeValue <= depositCeiling,
  };
}
export async function bradbury(privateKey: Hash) {
  const account = privateKeyToAccount(privateKey);
  const client = await connect();
  const consensus = address.parse(client.chain.consensusMainContract?.address);
  return async (job: Job, j: Judgment, save: () => void) => {
    const args = inputs(job, j);
    if (!j.signed && !j.tx) {
      // The SDK signs before broadcasting. Commit the exact envelope inside the signer so
      // a crash before its promise returns can only replay the original nonce and payload.
      const signer: typeof account = {
        ...account,
        async signTransaction(transaction, options) {
          const raw = await account.signTransaction(transaction, options);
          if (j.signed && j.signed !== raw)
            throw new Review("SDK attempted to replace a journaled deployment");
          j.signed = raw;
          j.evmTx = keccak256(raw);
          save();
          return raw;
        },
      };
      const fees = await client.estimateTransactionFees(feeOptions);
      if (fees.feeValue > depositCeiling)
        throw new Review("Quoted deposit exceeds the pilot ceiling of 3 test GEN per milestone");
      if ((await evm.getBalance({ address: account.address })) <= fees.feeValue)
        throw new Error("Waiting for Bradbury test GEN to cover the deposit and network fee");
      j.tx = await client.deployContract({
        account: signer,
        code: new Uint8Array(code),
        args,
        fees,
        consensusMaxRotations: 0,
      });
      delete j.signed;
      save();
    } else if (!j.tx && j.signed && j.evmTx) {
      const receipt = await evm.getTransactionReceipt({ hash: j.evmTx }).catch((err) => {
        if (err instanceof TransactionReceiptNotFoundError) return null;
        throw err;
      });
      if (!receipt) {
        const pending = await evm.getTransaction({ hash: j.evmTx }).catch((err) => {
          if (err instanceof TransactionNotFoundError) return null;
          throw err;
        });
        if (!pending) await evm.sendRawTransaction({ serializedTransaction: j.signed });
        return;
      }
      if (receipt.status === "reverted") throw new Review("Bradbury deployment reverted");
      const events = parseEventLogs({
        abi: deploymentEvents,
        logs: receipt.logs.filter((l) => l.address.toLowerCase() === consensus),
      });
      const ids = new Set(events.map((l) => l.args.txId));
      if (ids.size !== 1) throw new Review("Cannot identify one deployment in the Bradbury receipt");
      j.tx = events[0].args.txId;
      delete j.signed;
      save();
    }
    if (!j.tx) return;
    const tx = await client.getTransaction({ hash: j.tx as GenHash });
    if (tx.lifecycle.state === "canceled") throw new Review("Bradbury consensus ended " + tx.statusName);
    if (tx.lifecycle.state !== "finalized") return;
    if (tx.lifecycle.outcome !== "accepted")
      throw new Review("Finalized consensus did not accept the ruling");
    if (tx.txExecutionResultName !== "FINISHED_WITH_RETURN")
      throw new Review("Finalized deployment did not execute successfully");
    const contract = address.parse(
      tx.txDataDecoded && "contractAddress" in tx.txDataDecoded
        ? tx.txDataDecoded.contractAddress
        : tx.recipient,
    );
    const read = (functionName: string) =>
      client.readContract({
        address: contract,
        functionName,
        args: [],
        transactionHashVariant: TransactionHashVariant.LATEST_FINAL,
      });
    const input = (await read("get_input")) as Record<string, unknown>;
    if (["task_spec", "submission", "rubric", "metadata_json"].some((key, i) => input[key] !== args[i]))
      throw new Review("Finalized contract inputs differ from the pinned deployment");
    j.result = rulingSchema.parse(await read("get_result"));
    j.contract = contract;
    save();
  };
}
