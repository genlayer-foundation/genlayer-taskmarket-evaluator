import { afterEach, describe, expect, it, vi } from "vitest";
import { keccak256, sha256, stringToBytes } from "viem";
import { collectEvidence } from "./evidence.js";
import { discover } from "./inbox.js";
import { example, fixtureAddress } from "./demo.js";
import { api, chainId, digest, type Job } from "./model.js";
import type { Journal } from "./store.js";

afterEach(() => vi.unstubAllGlobals());
const agreement = example(false),
  id = digest("task"),
  worker = fixtureAddress("1"),
  requester = fixtureAddress("2"),
  evaluator = fixtureAddress("3");
const subId = "0366d3ac-1a39-4933-aac5-c639b24c6e72",
  artifact = "697ff257-2467-4a93-b3e3-7e7225f8abe1";
const task = {
  id,
  chainId,
  mode: "claim",
  description: JSON.stringify(agreement),
  requester,
  taskVisibility: "public",
  submissionVisibility: "public",
  evaluatorDeadline: null,
  appealDeadline: null,
  claimedBy: worker,
  evaluator,
  status: "review",
  projectId: null,
  hooks: [],
  platformFeeBps: 0,
};
function publicData(tamper: "none" | "manifest" | "file" | "terms") {
  const contents = "A public guide.";
  const file = stringToBytes(contents);
  const item = {
    fileName: "guide.md",
    mimeType: "text/markdown",
    sizeBytes: file.length,
    sha256Hash: sha256(file),
    keccak256Hash: keccak256(file),
    displayOrder: 0,
  };
  const manifest = JSON.stringify({ version: "taskmarket-artifacts-v1", artifacts: [item] });
  const source = { worker, requester, evaluator, deliverable: digest(manifest) };
  const submitTx = digest("submit");
  const previewUrl = "https://taskmarket." + "a".repeat(32) + ".r2.cloudflarestorage.com/guide";
  const path = "/api/tasks/" + id;
  const responses: Record<string, string> = {
    [path]: JSON.stringify(tamper === "terms" ? { ...task, description: "different agreement" } : task),
    [path + "/submissions"]: JSON.stringify([
      {
        id: subId,
        taskId: id,
        workerAddress: worker,
        rejectedAt: null,
        submitTxHash: submitTx,
        deliverableHash: source.deliverable,
        artifacts: [{ id: artifact, displayOrder: 0, keccak256Hash: item.keccak256Hash }],
      },
    ]),
    [path + "/submissions/" + subId + "/manifest"]: manifest + (tamper === "manifest" ? " " : ""),
    [path + "/artifacts/" + artifact + "/preview"]: JSON.stringify({ previewUrl }),
    "/guide": tamper === "file" ? "B public guide." : contents,
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: URL) => new Response(responses[url.pathname], { status: 200 })),
  );
  return { source, submitTx, contents };
}
describe("public evidence", () => {
  it("pins published terms, canonical manifest, file bytes and the verified submission", async () => {
    const { source, submitTx, contents } = publicData("none");
    const verify = vi.fn(async () => 123n);
    const e = await collectEvidence({ id, agreement } as Job, source, verify);
    expect(verify).toHaveBeenCalledWith(submitTx);
    expect(e.submitBlock).toBe("123");
    expect(e.files[0].text).toBe(contents);
    expect(digest(e.manifest)).toBe(e.deliverable);
  });
  it.each(["manifest", "file", "terms"] as const)("withholds changed %s", async (tamper) => {
    const { source } = publicData(tamper);
    await expect(collectEvidence({ id, agreement } as Job, source, async () => 123n)).rejects.toThrow();
  });
});
describe("public evaluator inbox", () => {
  it("enrolls only an assigned task with the pinned brief for an approved buyer", async () => {
    const next = "opaque cursor",
      track = vi.fn();
    const db = { get: () => undefined, track } as unknown as Journal;
    const queueItem = {
      role: "evaluator",
      intent: "evaluate_work",
      task: { status: "review" },
      actions: [{ type: "evaluate", taskId: id }],
    };
    const fn = vi.fn(async (url: URL) =>
      Response.json(
        url.pathname === "/api/agents/action-queue"
          ? { items: [{ ...queueItem, task: { chainId: 84532 } }, queueItem], nextCursor: next }
          : task,
      ),
    );
    vi.stubGlobal("fetch", fn);
    expect(await discover(db, evaluator, agreement, new Set([requester]), "page1")).toBe(next);
    expect(fn.mock.calls[0][0].origin).toBe(api);
    expect(fn.mock.calls[0][0].searchParams.get("cursor")).toBe("page1");
    expect(track).toHaveBeenCalledExactlyOnceWith(id, agreement);
    track.mockClear();
    await discover(db, evaluator, agreement, new Set([worker]));
    await discover(db, evaluator, { ...agreement, brief: "different agreement" }, new Set([requester]));
    expect(track).not.toHaveBeenCalled();
  });
});
