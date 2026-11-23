import "dotenv/config";
import express from "express";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { z } from "zod";
import { Journal, publicJob } from "./store.js";
import { address, agreementSchema, hash, mainnet, operatorHome, settlementNetwork } from "./model.js";
import { discover } from "./inbox.js";
import { preparePilot } from "./pilot.js";
import { advance } from "./engine.js";
import { bradbury, bradburyPreflight } from "./bradbury.js";
import * as tempo from "./tempo.js";
import { collectEvidence } from "./evidence.js";
import { runExample, scenarios } from "./demo.js";
import { CaseNotices, noticeIO } from "./notices.js";
import { taskDescription } from "./description.js";

const [command = "serve", ...args] = process.argv.slice(2);
const demo = command === "demo";
async function serve(db: Journal) {
  const app = express();
  app.use(express.json({ limit: "2kb" }));
  app.get("/evaluations", (_req, res) =>
    res.json({ mode: demo ? "simulation" : settlementNetwork, rulingNetwork: "bradbury-testnet", jobs: db.list().map(publicJob) }),
  );
  app.get("/evaluations/:id", (req, res) => {
    const job = db.get(req.params.id);
    if (!job) return res.status(404).json({ error: "Unknown task" });
    res.json(publicJob(job));
  });
  if (demo) {
    app.post("/demo/jobs", async (req, res) => {
      const scenario = z.enum(scenarios).safeParse(req.body?.scenario);
      if (!scenario.success) return res.status(400).json({ error: "Unknown scenario" });
      try {
        res.status(201).json(publicJob(await runExample(db, scenario.data)));
      } catch {
        res.status(500).json({ error: "Local demonstration failed" });
      }
    });
    for (const scenario of ["approval", "rejection", "partial", "recovery"] as const) {
      const existing = db.list().find((j) => j.scenario === scenario);
      if (!existing || existing.phase === "tracked") await runExample(db, scenario, existing?.id);
    }
  }
  const assets = new URL(
    "../../dashboard/dist/",
    new URL(import.meta.url.replace("/dist/src/", "/src/")),
  );
  app.use(express.static(decodeURIComponent(assets.pathname)));
  const host = demo ? "127.0.0.1" : (process.env.HOST ?? "127.0.0.1");
  const port = Number(process.env.PORT ?? (demo ? 4731 : 3000));
  app.listen(port, host, () =>
    console.log(
      (demo ? "Local simulation" : "Taskmarket evaluator") + " at http://" + host + ":" + port,
    ),
  );
}
async function main() {
  if (command === "describe" && args.length === 1) {
    const terms = agreementSchema.parse(JSON.parse(readFileSync(args[0], "utf8")));
    process.stdout.write(taskDescription(terms));
    return;
  }
  if (mainnet && (command === "pilot" || demo)) throw new Error("The automated demo and funded pilot commands run only on Tempo testnet");
  const keyFile = resolve(operatorHome, "bradbury.key");
  if (command === "preflight") {
    const key =
      process.env.GENLAYER_PRIVATE_KEY ??
      (existsSync(keyFile) ? readFileSync(keyFile, "utf8").trim() : undefined);
    const wallet = key ? privateKeyToAccount(hash.parse(key)).address : undefined;
    const [market, judge] = await Promise.all([tempo.preflight(), bradburyPreflight(wallet)]);
    console.log(JSON.stringify({ tempo: market, bradbury: judge }, null, 2));
    return;
  }
  if (command === "prepare-signer") {
    mkdirSync(resolve(operatorHome), { recursive: true, mode: 0o700 });
    if (!existsSync(keyFile)) writeFileSync(keyFile, generatePrivateKey(), { flag: "wx", mode: 0o600 });
    const signer = privateKeyToAccount(hash.parse(readFileSync(keyFile, "utf8").trim()));
    console.log("Bradbury test GEN funding address", signer.address);
    return;
  }
  const db = new Journal(
    demo ? resolve(process.env.TASKMARKET_DEMO_DB ?? "data/demo.sqlite") : undefined,
  );
  if (command === "serve" || demo) {
    await serve(db);
    return;
  }
  let noticeTimer: ReturnType<typeof setInterval> | undefined;
  let notices: CaseNotices | undefined;
  try {
    if (command === "track" && args.length === 2) {
      const id = hash.parse(args[0]);
      db.track(id, agreementSchema.parse(JSON.parse(readFileSync(args[1], "utf8"))));
      console.log("Tracking", id);
      return;
    }
    if (command === "show" && args.length === 1) {
      const job = db.get(hash.parse(args[0]));
      if (!job) throw new Error("Unknown task");
      console.log(JSON.stringify(publicJob(job), null, 2));
      return;
    }
    if (!["work", "once", "pilot"].includes(command))
      throw new Error(
        "Usage: serve | demo | preflight | prepare-signer | describe BRIEF.json | track TASK_ID BRIEF.json | show TASK_ID | pilot | work | once",
      );
    db.takeWorkerLock();
    await tempo.preflight();
    process.env.TASKMARKET_HOME ??= resolve(operatorHome, "evaluator");
    const key = hash.parse(process.env.GENLAYER_PRIVATE_KEY ?? readFileSync(keyFile, "utf8").trim());
    if (command === "pilot") process.env.TASKMARKET_HOME = resolve("data/pilot/evaluator");
    const wallet = await tempo.wallet();
    if (command === "pilot" && !existsSync(process.env.TASKMARKET_PUBLISH_SOCKET ?? "/run/taskmarket-live/publish.sock")) {
      throw new Error("Start the live case publisher before posting a pilot task. See deploy/aws/README.md for the local publisher command.");
    }
    const pilotId =
      command === "pilot" ? await preparePilot(db, privateKeyToAccount(key).address) : undefined;
    const judge = await bradbury(key);
    notices = new CaseNotices(db, noticeIO());
    const ports = { ...tempo, wallet, judge, collect: collectEvidence, noticesReady: notices.ready.bind(notices) };
    if (command !== "once") {
      notices.tick();
      noticeTimer = setInterval(notices.tick.bind(notices), 1000);
    }
    const offerPath = command === "work" ? process.env.TASKMARKET_ACCEPT_BRIEF : undefined;
    const offer = offerPath
      ? agreementSchema.parse(JSON.parse(readFileSync(offerPath, "utf8")))
      : undefined;
    const buyers = new Set(
      (process.env.TASKMARKET_ACCEPT_REQUESTERS ?? "")
        .split(",")
        .filter(Boolean)
        .map((v) => address.parse(v.trim())),
    );
    if (offer && !buyers.size)
      throw new Error("Specify the requester addresses eligible for automatic enrollment");
    let cursor: string | undefined;
    do {
      if (offer) {
        try {
          cursor = await discover(db, wallet, offer, buyers, cursor);
        } catch (err) {
          console.error("Inbox retry:", err instanceof Error ? err.message : "unavailable");
        }
      }
      const jobs = db.list();
      // Recover any signed but unacknowledged deployment before allocating another nonce.
      const pending = jobs.find(
        (j) => j.phase === "evaluating" && j.judgments.some((r) => r.signed && !r.tx),
      );
      for (const j of pending ? [pending] : jobs) {
        await advance(j, ports, () => db.save(j));
        if (j.judgments.some((r) => r.signed && !r.tx) && j.phase === "evaluating") break;
      }
      if (command === "once") for (const job of db.list()) await notices.update(job);
      if (pilotId) {
        const job = db.get(pilotId)!;
        if (job.phase === "settled") {
          console.log(JSON.stringify(publicJob(job), null, 2));
          return;
        }
        if (["disputed", "review"].includes(job.phase))
          throw new Error("Pilot needs attention: " + (job.message ?? job.phase));
      }
      if (command !== "once") await delay(10000);
    } while (command !== "once");
  } finally {
    clearInterval(noticeTimer);
    await notices?.drain();
    db.close();
  }
}
main().catch((err) => {
  console.error(err instanceof Error ? err.message : "Startup failed");
  process.exitCode = 1;
});
