import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CaseNotices, type LiveCase } from "./notices.js";
import { Journal } from "./store.js";
import type { Job } from "./model.js";
import type { LiveRuling } from "./bradbury.js";

describe("participant appeal notices", () => {
  it("requires both invitations, publishes the ID before a decision, and deduplicates each round across restarts", async () => {
    const folder = mkdtempSync(join(tmpdir(), "court-notices-"));
    const db = new Journal(join(folder,"journal"));
    try {
      const job: Job = JSON.parse(readFileSync("examples/taskmarket/settled-pilot.json","utf8"));
      job.phase = "evaluating";
      job.agreement.milestones[0].webDomains = ["docs.genlayer.com"];
      const {tx, milestone} = job.judgments[0];
      job.judgments = [{milestone}];
      const snapshots: LiveCase[] = [];
      let clock = 10_000, blocked = true;
      let txId: typeof tx;
      let state: LiveRuling = { status:"Pending" };
      const io = {
        now: () => clock, base: "https://court.example", id: async () => txId,
        observe: async () => state, reasons: async () => ({verdict:"approve" as const,reasoning:"Submission meets the terms."}),
        publish: vi.fn(async (doc: LiveCase) => {snapshots.push(doc);}),
        send: vi.fn(async (wallet: string, _subject: string, _body: string, _key: string) => {
          if (blocked && wallet === job.evidence!.worker) throw new Error("inbox unavailable");
        })
      };
      const service = new CaseNotices(db,io);
      io.publish.mockRejectedValueOnce(new Error("storage unavailable"));
      await expect(service.update(job)).rejects.toThrow();
      expect(io.send).not.toHaveBeenCalled();
      await service.update(job); await service.drain();
      expect(service.ready(job)).toBe(false);
      expect(snapshots.at(-1)?.milestones[0].webDomains).toEqual(["docs.genlayer.com"]);
      blocked = false; clock += 6000;
      await service.update(job); await service.drain();
      expect(service.ready(job)).toBe(true);
      expect(io.send.mock.calls.filter(([wallet])=>wallet === job.evidence!.requester)).toHaveLength(1);
      txId = tx;
      await service.update(job); await service.drain();
      expect(snapshots.at(-1)?.milestones[0].tx).toBe(tx);
      state = { status:"Accepted", decision:"1", deadline:70 };
      await service.update(job); await service.drain();
      await service.update(job); await service.drain();
      for (const wallet of [job.evidence!.requester,job.evidence!.worker]) {
        expect(io.send.mock.calls.some(([to,,body])=>to===wallet && body.includes("Submission meets the terms.") && body.includes("00:01:10.000Z") && body.includes(tx!))).toBe(true);
      }
      const count = io.send.mock.calls.length;
      const recovered = new CaseNotices(db,io);
      await recovered.update(job); await recovered.drain();
      expect(io.send.mock.calls).toHaveLength(count);
      state = { status:"Appeal committing" };
      await recovered.update(job); await recovered.drain();
      expect(snapshots.at(-1)?.milestones[0].deadline).toBeUndefined();
      state = {status:"Accepted", decision:"2", deadline:20}; clock=21_000;
      await recovered.update(job); await recovered.drain();
      expect(io.send.mock.calls).toHaveLength(count);
      expect(job.judgments[0].result).toBeUndefined();
    } finally {db.close(); rmSync(folder,{recursive:true,force:true});}
  });
});
