import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { advance } from "./engine.js";
import { example, fixtureAddress, runExample, simulation, type Scenario } from "./demo.js";
import { Journal, publicJob } from "./store.js";
import { agreementSchema, digest, type Job } from "./model.js";
import { previewLocation } from "./evidence.js";
import { encodeEventTopics, encodeAbiParameters, parseAbi, zeroHash, type Log } from "viem";
import { operationId, verifySettlement } from "./tempo.js";
import { diamond } from "./model.js";

let dir: string, db: Journal;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "taskmarket-test-"));
  db = new Journal(join(dir, "journal"));
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
function harness(scenario: Scenario = "approval") {
  const id = digest("test task");
  db.track(id, example(scenario === "partial"));
  const sim = simulation(db.get(id)!, scenario);
  const get = () => db.get(id)!;
  const tick = async () => {
    const j = get();
    await advance(j, sim.p, () => db.save(j));
  };
  return { ...sim, get, tick };
}
describe("Taskmarket worker", () => {
  it("uses a stable UUID per paid operation accepted by the Taskmarket API", () => {
    const id = operationId("evaluate-task-a");
    expect(id).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
    expect(operationId("evaluate-task-a")).toBe(id);
    expect(operationId("finalize-task-a")).not.toBe(id);
  });
  it.each([
    ["approval", "approve", "1000000", "payment"],
    ["rejection", "reject", "0", "refund"],
    ["partial", "partial", "30000000", "payment"],
    ["recovery", "approve", "1000000", "payment"],
  ] as const)("settles %s with its explicit award", async (s, verdict, award, kind) => {
    const j = await runExample(db, s);
    expect(j.phase).toBe("settled");
    expect(j.decision).toMatchObject({ verdict, awardUnits: award });
    expect(j.settlement?.kind).toBe(kind);
    expect(j.evaluateTx).toBeTruthy();
  });
  it("holds uncertain and unsuccessful judgments without relaying", async () => {
    expect((await runExample(db, "uncertain")).decision).toBeUndefined();
    const h = harness();
    await h.tick();
    await h.tick();
    const j = h.get();
    j.judgments[0].result!.success = false;
    db.save(j);
    await h.tick();
    expect(h.get().phase).toBe("review");
    expect(h.counts().writes).toBe(0);
  });
  it("persists deployment before finality and waits for the appeal deadline", async () => {
    const h = harness("recovery");
    await h.tick();
    expect(h.get().judgments[0].tx).toBeTruthy();
    expect(h.get().decision).toBeUndefined();
    db.close();
    db = new Journal(join(dir, "journal"));
    await h.tick();
    await h.tick();
    await h.tick(); // the marketplace committed, but the response was lost
    expect(h.counts().writes).toBe(1);
    expect(h.get().evaluateTx).toBeUndefined();
    db.close();
    db = new Journal(join(dir, "journal"));
    await h.tick();
    expect(h.get().evaluateTx).toBeTruthy();
    expect(h.get().phase).toBe("appealing");
    h.s.now = 299999;
    await h.tick();
    expect(h.counts().finalizations).toBe(0);
    h.s.now = 300000;
    await h.tick();
    expect(h.get().settlement).toBeUndefined();
    await h.tick();
    await h.tick();
    expect(h.get().settlement?.units).toBe("1000000");
    expect(h.counts()).toEqual({ writes: 1, deployments: 1, finalizations: 1 });
  });
  it("retries a temporary read outage and hands an appeal to the resolver", async () => {
    const h = harness();
    const read = h.p.state;
    h.p.state = vi.fn().mockRejectedValueOnce(new Error("offline")).mockImplementation(read);
    await h.tick();
    expect(h.get().message).toBe("offline");
    expect(h.get().phase).toBe("tracked");
    await h.tick();
    expect(h.get().message).toBeUndefined();
    h.s.task.status = 9;
    await h.tick();
    expect(h.get().phase).toBe("disputed");
    expect(h.counts().writes).toBe(0);
  });
  it("stops on changed evidence, signer or elapsed deadline", async () => {
    const h = harness();
    await h.tick();
    h.s.task.deliverable = zeroHash;
    await h.tick();
    expect(h.get().phase).toBe("review");
    expect(h.counts().writes).toBe(0);
    const j = h.get();
    j.phase = "tracked";
    delete j.evidence;
    db.save(j);
    h.p.wallet = fixtureAddress("8");
    await h.tick();
    expect(h.get().message).toContain("evaluator");
    j.phase = "tracked";
    db.save(j);
    h.p.wallet = h.s.config.evaluator;
    h.s.now = 90000000;
    await h.tick();
    expect(h.get().message).toContain("deadline");
  });
  it("holds a conflicting already-issued verdict", async () => {
    const h = harness();
    for (let i = 0; i < 4; i++) await h.tick();
    h.s.verdict = { ...h.s.verdict, evidenceHash: zeroHash };
    await h.tick();
    expect(h.get().phase).toBe("review");
    expect(h.counts().finalizations).toBe(0);
  });
  it("rejects unbalanced prices, conflicting enrollment and concurrent writers", () => {
    const agreement = example(false),
      id = digest("job");
    db.track(id, agreement);
    db.track(id, agreement);
    expect(() => agreementSchema.parse({ ...agreement, evaluatorFeeBps: 500 })).toThrow();
    expect(() => db.track(id, { ...agreement, brief: "changed" })).toThrow();
    db.takeWorkerLock();
    const other = new Journal(join(dir, "journal"));
    try {
      expect(() => other.takeWorkerLock()).toThrow();
    } finally {
      other.close();
    }
    const j = db.get(id)!;
    j.judgments = [{ milestone: "guide", signed: zeroHash }];
    expect(publicJob(j).judgments[0]).not.toHaveProperty("signed");
  });
  it("verifies the receipt issuer, task, token, recipient and amount", async () => {
    const j = await runExample(db, "approval");
    const abi = parseAbi([
      "event TaskCompleted(bytes32 indexed taskId,address indexed requester,address indexed worker,uint256 workerPayment,uint256 platformFee)",
      "event Transfer(address indexed from,address indexed to,uint256 value)",
    ]);
    const worker = j.evidence!.worker,
      requester = j.evidence!.requester;
    const paid = {
      address: diamond,
      topics: encodeEventTopics({
        abi,
        eventName: "TaskCompleted",
        args: { taskId: j.id, requester, worker },
      }),
      data: encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [1000000n, 0n]),
    };
    const transfer = {
      address: "0x20c0000000000000000000006a37da5c996874be",
      topics: encodeEventTopics({ abi, eventName: "Transfer", args: { from: diamond, to: worker } }),
      data: encodeAbiParameters([{ type: "uint256" }], [1000000n]),
    };
    const receipt = (logs: unknown[]) =>
      ({
        logs: logs as Log[],
        transactionHash: digest("tx"),
        blockNumber: 5n,
        status: "success",
      }) as Parameters<typeof verifySettlement>[1];
    expect(verifySettlement(j, receipt([paid, transfer])).units).toBe("1000000");
    expect(() => verifySettlement(j, receipt([paid]))).toThrow();
    expect(() => verifySettlement(j, receipt([paid, { ...transfer, address: worker }]))).toThrow();
    expect(() => verifySettlement({ ...j, id: zeroHash } as Job, receipt([paid, transfer]))).toThrow();
  });
  it("restricts artifact downloads to Taskmarket's public storage", () => {
    expect(() => previewLocation("https://127.0.0.1/test")).toThrow();
    expect(() =>
      previewLocation(
        "https://taskmarket." + "a".repeat(32) + ".r2.cloudflarestorage.com.evil.test/test",
      ),
    ).toThrow();
  });
});
