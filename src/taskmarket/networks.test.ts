import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

const fixture = (name: string) => JSON.parse(readFileSync("examples/taskmarket/" + name + ".json", "utf8"));
afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });
describe("Bradbury rulings for Tempo mainnet", () => {
  it("binds new rulings to Phase 3 and preserves the published Phase 2 evidence hash", async () => {
    const { bindRulingDeployment, inputs, publicRulingId } = await import("./bradbury.js");
    const { decide } = await import("./model.js");
    const job = fixture("settled-pilot");
    const original = job.judgments[0];
    expect(decide(job).evidenceHash).toBe(job.decision.evidenceHash);
    expect(() => bindRulingDeployment(original)).toThrow("earlier Bradbury deployment");
    for (const field of ["signed", "evmTx", "tx", "contract", "result"]) {
      const persisted = { milestone: original.milestone, [field]: original[field] ?? original.tx };
      expect(() => bindRulingDeployment(persisted)).toThrow("earlier Bradbury deployment");
    }
    await expect(publicRulingId({milestone: original.milestone, evmTx: original.evmTx})).resolves.toBeUndefined();
    const fresh = { milestone: original.milestone };
    bindRulingDeployment(fresh);
    expect(fresh).toHaveProperty("bradburyPhase", 3);
    expect(JSON.parse(inputs(job, fresh)[3]).bradburyConsensus).toBe("0x0f4f0e05475723790e4a2ed0598370783c300926");
    expect(decide({...job, judgments:[{...original, ...fresh}]}).evidenceHash).not.toBe(job.decision.evidenceHash);
  });
  it("requires explicit payment and ruling networks and a zero evaluator fee", async () => {
    vi.stubEnv("TASKMARKET_SETTLEMENT_NETWORK", "tempo-mainnet");
    vi.resetModules();
    const { agreementSchema, chainId, cliNetwork } = await import("./model.js");
    const { operationId } = await import("./tempo.js");
    expect([chainId, cliNetwork]).toEqual([4217, "tempo"]);
    expect(agreementSchema.safeParse(fixture("fixed")).success).toBe(false);
    const agreement = fixture("hybrid");
    expect(agreementSchema.safeParse(agreement).success).toBe(true);
    expect(agreementSchema.safeParse({ ...agreement, rulingNetwork: undefined }).success).toBe(false);
    const key = operationId("evaluate-same-task");
    vi.stubEnv("TASKMARKET_SETTLEMENT_NETWORK", "tempo-testnet");
    vi.resetModules();
    expect((await import("./tempo.js")).operationId("evaluate-same-task")).not.toBe(key);
    expect((await import("./model.js")).agreementSchema.safeParse(agreement).success).toBe(false);
  });
  it("rejects a legacy testnet journal and keeps a mainnet journal isolated", async () => {
    const folder = mkdtempSync(join(tmpdir(), "hybrid-network-"));
    try {
      const legacy = join(folder, "legacy.sqlite"), fresh = join(folder, "fresh.sqlite");
      const db = new DatabaseSync(legacy);
      db.exec("CREATE TABLE jobs (id TEXT PRIMARY KEY, record TEXT NOT NULL); INSERT INTO jobs VALUES ('id','{}')");
      db.close();
      vi.stubEnv("TASKMARKET_SETTLEMENT_NETWORK", "tempo-mainnet");
      vi.resetModules();
      const { Journal } = await import("./store.js");
      expect(() => new Journal(legacy)).toThrow("Legacy jobs");
      new Journal(fresh).close();
      vi.stubEnv("TASKMARKET_SETTLEMENT_NETWORK", "tempo-testnet");
      vi.resetModules();
      const other = await import("./store.js");
      expect(() => new other.Journal(fresh)).toThrow("different Tempo network");
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });
});
