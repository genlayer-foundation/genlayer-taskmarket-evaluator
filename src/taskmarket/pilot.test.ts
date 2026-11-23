import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { preparePilot } from "./pilot.js";
import { bradburyPreflight } from "./bradbury.js";
import { cli, state, wallet } from "./tempo.js";
import { taskDetail } from "./evidence.js";
import { Journal } from "./store.js";
import { example, fixtureAddress, simulation } from "./demo.js";
import { digest } from "./model.js";
vi.mock("./tempo.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./tempo.js")>()),
  minimumAppealSeconds: vi.fn(async () => 300),
  cli: vi.fn(),
  wallet: vi.fn(),
  state: vi.fn(),
}));
vi.mock("./bradbury.js", () => ({ bradburyPreflight: vi.fn() }));
vi.mock("./evidence.js", () => ({ taskDetail: vi.fn() }));
vi.mock("node:timers/promises", () => ({ setTimeout: async () => {} }));

let dir: string, db: Journal;
const id = digest("reserved pilot"),
  judge = fixtureAddress("4");
const roles = {
  requester: fixtureAddress("1"),
  worker: fixtureAddress("2"),
  evaluator: fixtureAddress("3"),
};
beforeEach(() => {
  vi.clearAllMocks();
  dir = mkdtempSync(join(tmpdir(), "taskmarket-pilot-"));
  db = new Journal(join(dir, "ledger"));
  vi.mocked(wallet).mockImplementation(async (home) => roles[basename(home!) as keyof typeof roles]);
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
describe("by-address pilot", () => {
  it("checks funding before opening escrow", async () => {
    vi.mocked(bradburyPreflight).mockResolvedValue({ depositCovered: false, balanceGEN: "0" } as Awaited<
      ReturnType<typeof bradburyPreflight>
    >);
    await expect(preparePilot(db, judge)).rejects.toThrow("3 test GEN");
    expect(cli).not.toHaveBeenCalled();
    expect(db.list()).toHaveLength(0);
  });
  it("resumes a lost create response with the same key and submits one reserved worker's file", async () => {
    const agreement = example(false);
    db.track(id, agreement);
    const { s } = simulation(db.get(id)!, "approval");
    s.task.status = 0;
    vi.mocked(state).mockImplementation(async () => structuredClone(s));
    vi.mocked(taskDetail).mockResolvedValue({
      description: JSON.stringify(agreement),
      submissionVisibility: "public",
      taskVisibility: "public",
    } as Awaited<ReturnType<typeof taskDetail>>);
    vi.mocked(bradburyPreflight).mockResolvedValue({ depositCovered: true } as Awaited<
      ReturnType<typeof bradburyPreflight>
    >);
    const writes: { op: string; key?: string; role: string }[] = [];
    vi.mocked(cli).mockImplementation(async (args, key, home) => {
      writes.push({ op: args[1], key, role: basename(home!) });
      if (args[1] === "create") {
        expect(args).toEqual(
          expect.arrayContaining([
            "--evaluator",
            roles.evaluator,
            "--hire-worker",
            roles.worker,
            "--no-stake-required",
          ]),
        );
        if (writes.length === 1) throw Error("response lost");
        return { taskId: id };
      }
      s.task.status = args[1] === "claim" ? 1 : 7;
      return {};
    });
    await expect(preparePilot(db, judge)).rejects.toThrow("response lost");
    db.close();
    db = new Journal(join(dir, "ledger"));
    expect(await preparePilot(db, judge)).toBe(id);
    expect(await preparePilot(db, judge)).toBe(id);
    expect(writes.map((w) => [w.op, w.role])).toEqual([
      ["create", "requester"],
      ["create", "requester"],
      ["claim", "worker"],
      ["submit", "worker"],
    ]);
    expect(writes[0].key).toBe(writes[1].key);
    expect(db.get(id)?.agreement).toEqual(agreement);
  });
});
