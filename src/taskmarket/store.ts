import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Agreement, Job } from "./model.js";
import { chainId, mainnet, commitment, hash } from "./model.js";

export class Journal {
  readonly db: DatabaseSync;
  private lock?: DatabaseSync;
  constructor(readonly path = resolve(process.env.TASKMARKET_DB ?? (mainnet ? "data/mainnet/taskmarket.sqlite" : "data/taskmarket.sqlite"))) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec(
      "PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, record TEXT NOT NULL)",
    );
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const bound = this.db.prepare("PRAGMA application_id").get()!.application_id;
      if (bound === 0) {
        if (mainnet && (this.db.prepare("SELECT 1 FROM jobs LIMIT 1").get() ||
            this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='pilot'").get()))
          throw new Error("Legacy jobs belong to Tempo testnet");
        this.db.exec("PRAGMA application_id = " + chainId);
      } else if (bound !== chainId) throw new Error("Journal belongs to a different Tempo network");
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  // A separate database holds the process lock while individual journal writes commit.
  // SQLite releases this lock even if the worker is killed.
  takeWorkerLock() {
    this.lock = new DatabaseSync(this.path + ".worker");
    this.lock.exec("BEGIN EXCLUSIVE");
  }
  track(input: string, agreement: Agreement) {
    const id = hash.parse(input);
    const job: Job = {
      id,
      phase: "tracked",
      agreement,
      judgments: [],
      updated: new Date().toISOString(),
    };
    this.db.prepare("INSERT OR IGNORE INTO jobs VALUES (?,?)").run(id, JSON.stringify(job));
    if (commitment(this.get(id)!.agreement) !== commitment(agreement))
      throw new Error("Task already tracked with different terms");
  }
  get(id: string): Job | undefined {
    const row = this.db.prepare("SELECT record FROM jobs WHERE id=?").get(id);
    return row && JSON.parse(String(row.record));
  }
  list(): Job[] {
    return this.db
      .prepare("SELECT record FROM jobs ORDER BY rowid DESC")
      .all()
      .map((r) => JSON.parse(String(r.record)));
  }
  save(job: Job) {
    job.updated = new Date().toISOString();
    this.db.prepare("UPDATE jobs SET record=? WHERE id=?").run(JSON.stringify(job), job.id);
  }
  close() {
    this.lock?.close();
    this.db.close();
  }
}

export function publicJob(job: Job) {
  const { cursor, verdictCursor, ...visible } = job;
  return { ...visible, judgments: job.judgments.map(({ signed, ...judgment }) => judgment) };
}
