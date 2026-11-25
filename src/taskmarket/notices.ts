import { request } from "node:http";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { Address, Hash } from "viem";
import { api, address, settlementNetwork, type Job, type Judgment } from "./model.js";
import { observeRuling, provisionalReasons, publicRulingId, type LiveRuling } from "./bradbury.js";
import { cli } from "./tempo.js";
import type { Journal } from "./store.js";

const appealGuide = "Either party can ask a larger GenLayer jury to review a provisional ruling. Have a Bradbury wallet funded with test GEN before judging starts. The quote covers the bond and extra jury work. Allow for gas too. A failed appeal can cost you the bond. The appeal must reach the chain before its deadline. A Taskmarket appeal is separate.";
export type CaseMilestone = LiveRuling & { milestone: string; tx?: Hash; evmTx?: Hash; bradburyPhase?: 2 | 3; webDomains?: string[] };
export type LiveCase = { id: Hash; network: string; phase: string; milestones: CaseMilestone[] };
type IO = {
  base: string;
  publish: (record: LiveCase) => Promise<void>;
  send: (recipient: Address, title: string, body: string, key: string) => Promise<void>;
  id: typeof publicRulingId;
  observe: typeof observeRuling;
  reasons: typeof provisionalReasons;
  now: () => number;
};
const digest = (s: string) => createHash("sha256").update(s).digest("hex");

export function noticeIO(): IO {
  const base = new URL(process.env.TASKMARKET_PUBLIC_URL ?? "https://d1t95mbzk50y2b.cloudfront.net").origin;
  const mailboxes = new Map<Address, string>();
  return {
    base, id: publicRulingId, observe: observeRuling, reasons: provisionalReasons, now: Date.now,
    async publish(record) {
      const payload = JSON.stringify(record);
      await new Promise<void>((resolve, reject) => {
        const req = request({ socketPath: process.env.TASKMARKET_PUBLISH_SOCKET ?? "/run/taskmarket-live/publish.sock",
          method: "PUT", path: "/" + record.id, headers: { "Content-Length": Buffer.byteLength(payload) } }, res => {
          res.resume();
          res.on("end", () => res.statusCode === 204 ? resolve() : reject(new Error("Case publication failed")));
          res.on("error", reject);
        });
        req.setTimeout(10000, () => req.destroy(new Error("Case publication timed out")));
        req.on("error", reject);
        req.end(payload);
      });
    },
    async send(recipient, title, body, key) {
      let mailbox = mailboxes.get(recipient);
      if (!mailbox) {
        const response = await fetch(api + "/api/agents/stats?address=" + recipient, { signal: AbortSignal.timeout(5000), redirect: "error" });
        if (!response.ok) throw new Error("Participant directory unavailable");
        const stats = z.object({ address, emailAddress: z.string().regex(/^[a-z0-9._+-]+@taskmarket\.dev$/i) }).parse(await response.json());
        if (stats.address !== recipient) throw new Error("Participant address mismatch");
        mailbox = stats.emailAddress;
        mailboxes.set(recipient, mailbox);
      }
      z.object({ sent: z.literal(true) }).parse(await cli(["email", "send", "--to", mailbox, "--subject", title, "--body", body], key));
    },
  };
}

export class CaseNotices {
  private working = new Map<string, Promise<void>>();
  private sending = new Map<string, Promise<void>>();
  private retryAfter = new Map<string, number>();
  private reasons = new Map<string, NonNullable<LiveRuling["result"]>>();
  constructor(private journal: Journal, private io: IO) {
    journal.db.exec(`CREATE TABLE IF NOT EXISTS live_cases (task TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS notice_deliveries (task TEXT, event TEXT, wallet TEXT, PRIMARY KEY(task,event,wallet));`);
  }
  private delivered(task: string, event: string, wallet: string) {
    return !!this.journal.db.prepare("SELECT 1 FROM notice_deliveries WHERE task=? AND event=? AND wallet=?").get(task,event,wallet);
  }
  ready(job: Job) {
    return !!job.evidence && [job.evidence.requester, job.evidence.worker].every(w => this.delivered(job.id, "invite:" + job.evidence!.submitTx, w));
  }
  private mail(job: Job, event: string, subject: string, body: string, expires?: number) {
    const e = job.evidence!;
    for (const wallet of [e.requester, e.worker]) {
      const key = digest([settlementNetwork,job.id,event,wallet].join("/"));
      if (this.delivered(job.id,event,wallet) || this.sending.has(key) || (this.retryAfter.get(key) ?? 0) > this.io.now()) continue;
      if (expires && expires * 1000 <= this.io.now()) continue;
      const pending = this.io.send(wallet, subject, body, key).then(() => {
        this.journal.db.prepare("INSERT OR IGNORE INTO notice_deliveries VALUES(?,?,?)").run(job.id,event,wallet);
        this.retryAfter.delete(key);
      }).catch(() => {
        this.retryAfter.set(key, this.io.now() + 5000);
        console.error("Participant notice pending", job.id, event, wallet);
      }).finally(() => this.sending.delete(key));
      this.sending.set(key, pending);
    }
  }
  private async milestone(job: Job, j: Judgment, previous?: CaseMilestone): Promise<CaseMilestone> {
    const tx = j.tx ?? previous?.tx ?? await this.io.id(j);
    if (!tx) return { milestone: j.milestone, status: "Awaiting jury" };
    if (j.bradburyPhase !== 3) {
      const archived = { milestone: j.milestone, tx, evmTx: j.evmTx, bradburyPhase: 2 as const };
      if (!j.result) return { ...archived, status: "Phase 2 ruling pending verification" };
      return { ...previous, ...archived, status: "Finalized", result: { verdict: j.result.verdict, reasoning: j.result.reasoning.slice(0,6000) } };
    }
    if (j.result && previous?.status === "Finalized" && previous.result) return previous;
    const observation = await this.io.observe(tx).catch(() => undefined);
    if (!observation) return { milestone: j.milestone, tx, bradburyPhase: 3, status: "Checking Bradbury" };
    const result = observation.decision && (this.reasons.get(tx + ":" + observation.decision) ??
      (previous?.tx === tx && previous.decision === observation.decision && previous.status === observation.status ? previous.result : undefined));
    const ruling = j.result ?? result;
    return { milestone: j.milestone, tx, bradburyPhase: 3, ...observation,
      ...(ruling ? { result: { verdict: ruling.verdict, reasoning: ruling.reasoning.slice(0,6000) } } : {}) };
  }
  private async loadReasons(job: Job, j: Judgment, m: CaseMilestone) {
    if (!m.tx || !m.decision || m.status !== "Accepted" || m.result) return;
    const result = await this.io.reasons(job,j,m.tx);
    if (!result) return;
    const latest = await this.io.observe(m.tx);
    if (latest.decision === m.decision && latest.status === m.status) this.reasons.set(m.tx + ":" + m.decision, result);
  }
  async update(job: Job) {
    if (job.scenario || !job.evidence) return;
    const saved = this.journal.db.prepare("SELECT body FROM live_cases WHERE task=?").get(job.id);
    const previous: LiveCase | undefined = saved ? JSON.parse(String(saved.body)) : undefined;
    if (["settled","disputed","review"].includes(job.phase)) {
      if (!previous) return;
      const recipients = [job.evidence.requester, job.evidence.worker];
      const complete = previous.milestones.every(m => {
        if (!m.tx) return true;
        if (!m.bradburyPhase) return false;
        return m.status === "Canceled" || (m.status === "Finalized" &&
          (!m.result || recipients.every(w => this.delivered(job.id, "final:" + m.tx, w))));
      });
      if (previous.phase === job.phase && complete) return;
    }
    const milestones = await Promise.all(job.judgments.map(async j => {
      const record = await this.milestone(job, j, previous?.milestones.find(m => m.milestone === j.milestone));
      const domains = job.agreement.milestones.find(m => m.id === j.milestone)?.webDomains;
      return domains ? { ...record, webDomains: domains } : record;
    }));
    const record: LiveCase = { id: job.id, network: settlementNetwork, phase: job.phase, milestones };
    const body = JSON.stringify(record);
    if (body !== saved?.body) {
      await this.io.publish(record);
      this.journal.db.prepare("INSERT OR REPLACE INTO live_cases VALUES(?,?)").run(job.id,body);
    }
    const link = this.io.base + "/case?network=" + settlementNetwork + "&task=" + job.id;
    const ref = "\n\nLive case: " + link;
    const tag = "Internet Court · ";
    if (job.phase === "evaluating") this.mail(job, "invite:" + job.evidence.submitTx, tag + "follow your case before judging", appealGuide + ref);
    for (const m of milestones) {
      if (!m.tx) continue;
      const details = "\nMilestone: " + m.milestone + "\nBradbury ruling ID: " + m.tx + ref;
      if (m.status === "Finalized") {
        if (m.result) this.mail(job, "final:" + m.tx, tag + "final jury ruling on " + m.milestone,
          "GenLayer finalized the ruling. The GenLayer appeal window is closed. Ruling: " + m.result.verdict + " — " + m.result.reasoning.slice(0,3000) + details);
      } else if (m.decision && m.deadline && this.io.now() < m.deadline * 1000) {
        const info = m.result ? m.result.verdict + " — " + m.result.reasoning.slice(0,3000) : m.status + ". See the live case for the jury’s reasons as they arrive.";
        this.mail(job, "decision:" + m.tx + ":" + m.decision + (m.result ? ":reasons" : ""), tag + (m.result ? "jury reasons for " : "appeal window open for ") + m.milestone,
          "Provisional ruling: " + info + "\nAppeal deadline: " + new Date(m.deadline*1000).toISOString() + " (UTC). " + appealGuide + details, m.deadline);
      } else if (!m.decision && ["Pending","Proposing","Committing","Revealing","Leader revealing","Checking Bradbury"].includes(m.status)) {
        this.mail(job,"ruling:" + m.tx,tag + "jury transaction available", "Your jury transaction is public. Watch the case for its decision and appeal deadline." + details);
      }
    }
    await Promise.all(milestones.map((m,i) => this.loadReasons(job,job.judgments[i],m).catch(() => {})));
  }
  tick() {
    for (const job of this.journal.list()) {
      if (!job.evidence || this.working.has(job.id)) continue;
      const update = this.update(job).catch(() => console.error("Live case update pending",job.id)).finally(() => this.working.delete(job.id));
      this.working.set(job.id, update);
    }
  }
  async drain() {
    await Promise.all(this.working.values());
    await Promise.all(this.sending.values());
  }
}
