import { useEffect, useState } from "react";
import type { Job, Judgment } from "../../src/taskmarket/model";
type Entry = Omit<Job, "judgments"> & { judgments: Omit<Judgment, "signed">[]; scenario?: string };
const networks = {
  simulation: { label: "Local simulation", token: "simulated OUSD", tx: undefined },
  "tempo-testnet": { label: "Tempo testnet (Moderato)", token: "test OUSD", tx: "https://explore.testnet.tempo.xyz/tx/" },
  "tempo-mainnet": { label: "Tempo mainnet", token: "OUSD", tx: "https://explore.tempo.xyz/tx/" },
} as const;
type Mode = keyof typeof networks;
type Feed = { mode: Mode; jobs: Entry[] };
const scenarios = {
  approval: "Full approval",
  rejection: "Rejection",
  partial: "Partial award",
  uncertain: "Needs review",
  recovery: "Lost response",
};
const labels: Record<string, string> = {
  settled: "Settled",
  appealing: "Appeal window",
  evaluating: "Awaiting finality",
  disputed: "With resolver",
  ready: "Ready to relay",
  tracked: "Awaiting work",
  review: "Needs review",
};
function ousd(raw: string, mode: Mode) {
  const value = BigInt(raw);
  const decimal = (value % 1000000n).toString().padStart(6, "0").replace(/0+$/, "");
  return String(value / 1000000n) + (decimal ? "." + decimal : "") + " " + networks[mode].token;
}
function title(j: Entry) {
  return j.scenario ? scenarios[j.scenario as keyof typeof scenarios] : j.agreement.rubricVersion;
}
function shortened(v: string) {
  return v.slice(0, 10) + "…" + v.slice(-6);
}
function LinkHash({ value, base }: { value?: string; base?: string }) {
  if (!value) return <span>Pending</span>;
  return base ? (
    <a target="_blank" rel="noreferrer" href={base + value}>
      {shortened(value)}
    </a>
  ) : (
    <code title={value}>{shortened(value)}</code>
  );
}
function Detail({ j, mode }: { j: Entry; mode: Mode }) {
  const tempo = networks[mode].tx;
  const gl = mode === "simulation" ? undefined : "https://scan.bradbury.genlayer.com/tx/";
  return (
    <article className="tm-detail">
      <header>
        <div>
          <p className="tm-label">Task details</p>
          <h2>{title(j)}</h2>
        </div>
        <span className="tm-status">{labels[j.phase]}</span>
      </header>
      <p>{j.agreement.brief}</p>
      <div className="tm-finance">
        <div>
          <small>Escrow</small>
          <b>{ousd(j.agreement.rewardUnits, mode)}</b>
        </div>
        <div>
          <small>Evaluator fee</small>
          <b>
            {ousd(
              String((BigInt(j.agreement.rewardUnits) * BigInt(j.agreement.evaluatorFeeBps)) / 10000n),
              mode,
            )}
          </b>
        </div>
        <div>
          <small>Worker award</small>
          <b>{j.decision ? ousd(j.decision.awardUnits, mode) : "Pending"}</b>
        </div>
      </div>
      <h3>Milestone rulings</h3>
      {j.agreement.milestones.map((m, i) => {
        const r = j.judgments[i];
        return (
          <section className="tm-milestone" key={m.id}>
            <header>
              <strong>{m.id}</strong>
              <span>{ousd(m.awardUnits, mode)}</span>
            </header>
            <p>{m.rubric}</p>
            {r?.result && (
              <p>
                <b>{r.result.verdict.replace("_", " ")}</b> · {r.result.score}/100 · {r.result.reasoning}
              </p>
            )}
            <small>
              {mode === "simulation" ? "Simulated ruling" : "Bradbury testnet ruling"} <LinkHash value={r?.tx} base={gl} />
            </small>
          </section>
        );
      })}
      {j.message && (
        <p role="status" className="tm-alert">
          {j.message}
        </p>
      )}
      <h3>Settlement record</h3>
      <dl>
        <dt>Task ID</dt>
        <dd>
          <code>{j.id}</code>
        </dd>
        {j.evidence && (
          <>
            <dt>Worker</dt>
            <dd>
              <code>{j.evidence.worker}</code>
            </dd>
            <dt>Submission</dt>
            <dd>
              <LinkHash value={j.evidence.submitTx} base={tempo} />
            </dd>
            <dt>Manifest hash</dt>
            <dd>
              <code>{j.evidence.deliverable}</code>
            </dd>
          </>
        )}
        {j.decision && (
          <>
            <dt>Verdict</dt>
            <dd>{j.decision.verdict}</dd>
            <dt>Evidence hash</dt>
            <dd>
              <code>{j.decision.evidenceHash}</code>
            </dd>
          </>
        )}
        <dt>Verdict transaction</dt>
        <dd>
          <LinkHash value={j.evaluateTx} base={tempo} />
        </dd>
        <dt>Settlement receipt</dt>
        <dd>
          <LinkHash value={j.settlement?.tx} base={tempo} />
        </dd>
        {j.settlement && (
          <>
            <dt>{j.settlement.kind === "refund" ? "Requester refund" : "Worker payment"}</dt>
            <dd>{ousd(j.settlement.units, mode)}</dd>
            <dt>Recipient</dt>
            <dd>
              <code>{j.settlement.recipient}</code>
            </dd>
          </>
        )}
      </dl>
      {j.evidence && (
        <details>
          <summary>Submitted evidence</summary>
          {j.evidence.files.map((f, i) => (
            <section key={i}>
              <h4>{f.name}</h4>
              <pre>{f.text}</pre>
            </section>
          ))}
        </details>
      )}
      <a className="tm-json" href={"/evaluations/" + j.id}>
        Open full record (JSON)
      </a>
    </article>
  );
}
export default function Taskmarket() {
  const [feed, setFeed] = useState<Feed>(),
    [error, setError] = useState(""),
    [selected, setSelected] = useState(location.hash.slice(1));
  const [scenario, setScenario] = useState("partial"),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    const ctrl = new AbortController();
    async function refresh() {
      try {
        const res = await fetch("/evaluations", { signal: ctrl.signal });
        if (!res.ok) throw new Error();
        const data = (await res.json()) as Feed;
        setFeed(data);
        setError("");
      } catch {
        if (!ctrl.signal.aborted) setError("The evaluator is unavailable. Retrying…");
      }
    }
    void refresh();
    const interval = setInterval(refresh, 5000);
    const onHash = () => setSelected(location.hash.slice(1));
    window.addEventListener("hashchange", onHash);
    return () => {
      ctrl.abort();
      clearInterval(interval);
      window.removeEventListener("hashchange", onHash);
    };
  }, []);
  async function run() {
    setBusy(true);
    try {
      const res = await fetch("/demo/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scenario }),
      });
      if (!res.ok) throw new Error();
      const j = (await res.json()) as Entry;
      setFeed((f) => f && { ...f, jobs: [j, ...f.jobs.filter((k) => k.id !== j.id)] });
      location.hash = j.id;
    } catch {
      setError("Could not run the local example.");
    } finally {
      setBusy(false);
    }
  }
  const active = feed?.jobs.find((j) => j.id === selected) ?? feed?.jobs[0];
  return (
    <>
      <nav className="nav court-nav">
        <a className="court-wordmark" href="https://internetcourt.org/" aria-label="Internet Court home">
          <img src="/internet-court.svg" alt="Internet Court" />
        </a>
        {feed && (
          <span className="tm-status">
            {networks[feed.mode].label}
          </span>
        )}
      </nav>
      <main className="container tm-main court-ledger">
        <div className="page-header">
          <h1>Evaluation ledger</h1>
          {feed && <p>
            {feed.mode === "simulation"
              ? "Local examples use simulated judgments, wallets and receipts."
              : feed.mode === "tempo-mainnet"
                ? "Payments use real OUSD on Tempo mainnet. A Foundation-operated wallet relays finalized rulings from GenLayer Bradbury testnet."
                : "Follow each submission from its GenLayer Bradbury testnet ruling to its Tempo testnet receipt."}
          </p>}
        </div>
        {error && <p role="alert">{error}</p>}
        {feed?.mode === "simulation" && (
          <form
            className="tm-controls"
            onSubmit={(e) => {
              e.preventDefault();
              void run();
            }}
          >
            <label htmlFor="scenario">Test a scenario</label>
            <select id="scenario" value={scenario} onChange={(e) => setScenario(e.target.value)}>
              {Object.entries(scenarios).map(([v, l]) => (
                <option value={v} key={v}>
                  {l}
                </option>
              ))}
            </select>
            <button disabled={busy}>{busy ? "Running…" : "Run example"}</button>
          </form>
        )}
        {feed ? (
          <div className="tm-layout">
            <aside>
              <h2>
                Tasks <small>{feed.jobs.length}</small>
              </h2>
              {feed.jobs.map((j) => (
                <a
                  className={active?.id === j.id ? "tm-row chosen" : "tm-row"}
                  key={j.id}
                  href={"#" + j.id}
                >
                  <b>{title(j)}</b>
                  <span>
                    {labels[j.phase]} · {ousd(j.agreement.rewardUnits, feed.mode)}
                  </span>
                  <code>{shortened(j.id)}</code>
                </a>
              ))}
              {!active && <p>No tasks enrolled yet.</p>}
            </aside>
            {active && <Detail j={active} mode={feed.mode} />}
          </div>
        ) : (
          <p>Loading evaluations…</p>
        )}
      </main>
    </>
  );
}
