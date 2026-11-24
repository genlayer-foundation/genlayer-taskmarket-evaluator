import {evidenceLabel, finalOutcome, juryLabels, juryStage, milestoneLabel} from "./jury.mjs";

const form = document.querySelector("#filters");
const statusLine = document.querySelector("#status");
const records = document.querySelector("#records");
const retry = document.querySelector("#retry");
const clear = document.querySelector("#clear");
const params = new URLSearchParams(location.search);
// The original case permalinks were issued exclusively for Tempo testnet.
if (params.has("case") && !params.has("network")) params.set("network", "tempo-testnet");
const networks = {
  "tempo-mainnet": {label: "Tempo mainnet", token: "OUSD", task: "https://taskmarket.dev/tasks/", tx: "https://explore.tempo.xyz/tx/"},
  "tempo-testnet": {label: "Tempo testnet", token: "test OUSD", task: "https://testnet-market.daydreams.systems/tasks/", tx: "https://explore.testnet.tempo.xyz/tx/"},
};
const transaction = /^0x[0-9a-f]{64}$/i;
const units = /^\d{1,31}$/;
const date = new Intl.DateTimeFormat("en", {day: "numeric", month: "long", year: "numeric", timeZone: "UTC"});
const live = new Map();
const nextLiveCheck = new Map();
const staleLive = new Set();
const caseKey = row => row.network + "/" + row.id;
let cases = [];
let ready = false;
let busy = false;
let nextIndex = 0;
let lastRender;

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function link(label, url) {
  const node = element("a", label);
  node.href = url;
  return node;
}

function money(amount, token) {
  const value = BigInt(amount);
  const decimals = (value % 1000000n).toString().padStart(6, "0").replace(/0+$/, "");
  return (value / 1000000n).toLocaleString("en") + (decimals ? "." + decimals : "") + " " + token;
}

function validRecord(row, group) {
  if (!row || row.venue !== "taskmarket" || !Object.hasOwn(networks, row.network) ||
      !transaction.test(row.id) || typeof row.brief !== "string" ||
      !(row.rulingNetwork === "bradbury-testnet" || (row.network === "tempo-testnet" && row.rulingNetwork === undefined))) return false;
  const settled = group === "evaluations", active = group === "inProgress";
  if (!Number.isFinite(Date.parse(settled ? row.completedAt : row.updatedAt))) return false;
  if (settled) {
    if (row.settledBy !== undefined && (row.settledBy !== "requester" || row.verdict !== "needs_review" ||
        row.settlementKind !== "refund" || !units.test(row.workerFeeUnits) || !transaction.test(row.timeoutTx))) return false;
    if (!transaction.test(row.settlementTx) || !["payment","refund"].includes(row.settlementKind) || !units.test(row.amountUnits)) return false;
  } else if (row.settlementTx || !units.test(row.rewardUnits)) return false;
  if (active) {
    if (!["tracked","evaluating","review","disputed","appealing","ready"].includes(row.phase)) return false;
  } else {
    const outcomes = ["approve","partial","reject"];
    if (!settled || row.settledBy === "requester") outcomes.push("needs_review");
    if (!settled) outcomes.push("finalized","error");
    if (!outcomes.includes(row.verdict)) return false;
  }
  return Array.isArray(row.rulings) && row.rulings.length > 0 && row.rulings.every(m => {
    if (!m || typeof m.milestone !== "string" || typeof m.rubric !== "string" || !units.test(m.priceUnits)) return false;
    if (m.webDomains !== undefined && !(Array.isArray(m.webDomains) && m.webDomains.every(h => typeof h === "string"))) return false;
    if (active && m.result === undefined) return m.tx === undefined || transaction.test(m.tx);
    return transaction.test(m.tx) && typeof m.reason === "string" && ["approve","reject","needs_review","error"].includes(m.result);
  });
}

function milestones(row, snapshot) {
  return row.rulings.map(r => {
    const base = {milestone: r.milestone, tx: r.tx, status: r.tx ? "Pending" : "Awaiting jury"};
    if (r.result) return {...base, status: "Finalized", result: {verdict: r.result, reasoning: r.reason}};
    const m = snapshot?.milestones.find(item => item.milestone === r.milestone);
    if (!m || !transaction.test(m.tx) || (r.tx && m.tx !== r.tx)) return base;
    return m;
  });
}

function caseCard(row, stage, ms, inProgress, stale, expanded) {
  const network = networks[row.network], key = caseKey(row);
  const card = element("article", undefined, "case");
  card.dataset.key = key;
  const meta = element("div", undefined, "case-meta");
  const timestamp = row.completedAt || row.updatedAt;
  const time = element("time", date.format(new Date(timestamp)));
  time.dateTime = timestamp;
  meta.append(element("strong", inProgress ? "Case in progress" : "Final jury decision"), element("span", network.label), time);
  const headline = row.brief.length <= 160 ? row.brief : row.brief.match(/^.{1,157}?[.!?](?=\s)/s)?.[0] ||
    row.brief.slice(0,157).replace(/\s+\S*$/, "") + "…";
  const decision = stage === "provisional" && ms.length === 1 ? milestoneLabel(ms[0]) : juryLabels[stage];
  card.append(meta, element("h2", decision), element("p", headline, "case-brief"));
  if (stale) card.append(element("p", "Showing the last observed jury update. Reconnecting…"));
  const reasoning = element("div", undefined, "reasons");
  for (const m of ms) {
    if (!m.result?.reasoning || !(m.status === "Finalized" || (m.status === "Accepted" && m.decision))) continue;
    const label = m.status === "Finalized" ? "Jury reasoning" : "Provisional reasoning";
    reasoning.append(element("h3", ms.length > 1 ? m.milestone + " · " + milestoneLabel(m) : label), element("p", m.result.reasoning));
  }
  if (reasoning.childElementCount) card.append(reasoning);
  const links = element("div", undefined, "case-links");
  const permalink = "/explorer?case=" + row.id + "&network=" + row.network;
  links.append(link("Link to this case", permalink));
  if (live.has(key)) links.append(link("Follow live jury record", "/case?network=" + row.network + "&task=" + row.id));
  if (ms.length === 1 && transaction.test(ms[0].tx)) links.append(link("Inspect jury transaction", "https://scan.bradbury.genlayer.com/tx/" + ms[0].tx));
  const detail = element("details");
  detail.open = expanded;
  detail.append(element("summary", "Milestones, terms and payment"));
  if (headline !== row.brief) detail.append(element("h3", "Agreed brief"), element("p", row.brief));
  const items = element("ol");
  row.rulings.forEach((r, i) => {
    const m = ms[i], item = element("li");
    item.append(element("h3", r.milestone + " · " + milestoneLabel(m)), element("p", r.rubric),
      element("p", evidenceLabel(r.webDomains)),
      element("p", "Agreed price " + money(r.priceUnits, network.token)));
    if (ms.length > 1 && transaction.test(m.tx)) item.append(link("Inspect jury transaction", "https://scan.bradbury.genlayer.com/tx/" + m.tx));
    items.append(item);
  });
  detail.append(items, link("Task on Taskmarket", network.task + row.id));
  if (row.settledBy === "requester") {
    card.append(element("p", "The buyer rejected the delivery after the evaluator timeout. " +
      money(row.workerFeeUnits, network.token) + " went to the worker as the agreed rejection fee and " +
      money(row.amountUnits, network.token) + " returned to the buyer."),
      link("Verify requester settlement", network.tx + row.settlementTx));
    detail.append(link("View evaluator timeout", network.tx + row.timeoutTx));
  }
  if (row.settlementTx) {
    detail.append(element("p", money(row.amountUnits, network.token) +
      (row.settlementKind === "refund" ? " refunded to the requester" : " paid to the worker")),
      link(network.label + " settlement receipt", network.tx + row.settlementTx));
  } else detail.append(element("p", "Agreed reward " + money(row.rewardUnits, network.token)));
  card.append(links, detail);
  return card;
}

function withinScope(row) {
  const id = params.get("case"), network = params.get("network"), venue = params.get("venue");
  const q = (params.get("q") || "").trim().toLowerCase();
  return (!id || id.toLowerCase() === row.id.toLowerCase()) && (!network || network === row.network) &&
    (!venue || venue === row.venue) && (!q || [row.brief, row.id, ...row.rulings.map(r => r.milestone)].some(s => s.toLowerCase().includes(q)));
}

function render() {
  if (!ready) return;
  const decision = params.get("verdict");
  const visible = [];
  for (const row of cases.filter(withinScope)) {
    const snapshot = row.active && live.get(caseKey(row));
    const ms = milestones(row, snapshot || undefined);
    const final = row.verdict && row.verdict !== "finalized" ? row.verdict : finalOutcome(ms);
    const stage = final || juryStage(snapshot?.phase || row.phase, ms);
    const inProgress = row.active && !final;
    if (!decision || decision === stage || (decision === "in_progress" && inProgress))
      visible.push({row, stage, ms, inProgress, stale: staleLive.has(caseKey(row))});
  }
  clear.hidden = !["q","venue","network","verdict","case"].some(k => params.get(k));
  const signature = JSON.stringify([params.toString(), visible]);
  if (signature === lastRender) return;
  lastRender = signature;
  const expanded = new Set(Array.from(records.querySelectorAll("article")).filter(a => a.querySelector("details").open).map(a => a.dataset.key));
  statusLine.textContent = visible.length ? visible.length + (visible.length === 1 ? " case" : " cases") :
    clear.hidden ? "No enrolled cases yet." : "No cases match these filters.";
  records.replaceChildren(...visible.map(({row, stage, ms, inProgress, stale}) => caseCard(row, stage, ms, inProgress, stale, expanded.has(caseKey(row)))));
}

function filter() {
  params.delete("case");
  for (const [name, value] of new FormData(form)) {
    if (value.trim()) params.set(name, value.trim());
    else params.delete(name);
  }
  history.replaceState(null, "", "/explorer" + (params.size ? "?" + params : ""));
  render();
  refresh();
}

async function readIndex() {
  const response = await fetch("/completed.json", {signal: AbortSignal.timeout(12000)});
  if (!response.ok) throw Error();
  const feed = await response.json();
  if (feed.version !== 1) throw Error();
  const rows = [];
  for (const group of ["evaluations","unsettled","inProgress"]) {
    const entries = feed[group] === undefined && group !== "evaluations" ? [] : feed[group];
    if (!Array.isArray(entries) || !entries.every(row => validRecord(row, group))) throw Error();
    rows.push(...entries.map(row => ({...row, active: group === "inProgress"})));
  }
  cases = rows.sort((a,b) => Date.parse(b.completedAt || b.updatedAt) - Date.parse(a.completedAt || a.updatedAt));
  const active = new Set(cases.filter(r => r.active).map(caseKey));
  for (const key of live.keys()) if (!active.has(key)) live.delete(key);
  for (const key of nextLiveCheck.keys()) if (!active.has(key)) nextLiveCheck.delete(key);
  for (const key of staleLive) if (!active.has(key)) staleLive.delete(key);
  ready = true;
}

async function readLive(row) {
  const key = caseKey(row);
  if (row.phase === "tracked" && Date.now() < (nextLiveCheck.get(key) || 0)) return;
  try {
    const response = await fetch("/cases/" + key + ".json", {cache:"no-store", signal:AbortSignal.timeout(4500)});
    if (!response.ok) throw Error();
    const record = await response.json();
    if (record.network !== row.network || record.id !== row.id || !Array.isArray(record.milestones) ||
        !record.milestones.every(m => m && typeof m.milestone === "string" && typeof m.status === "string" &&
          (!m.result || (typeof m.result.reasoning === "string" && ["approve","reject","needs_review","error"].includes(m.result.verdict))))) throw Error();
    live.set(key, record);
    staleLive.delete(key);
    nextLiveCheck.delete(key);
  } catch {
    // Newly enrolled cases have no public jury file until the worker receives evidence.
    if (live.has(key)) staleLive.add(key);
    if (row.phase === "tracked") nextLiveCheck.set(key, Date.now() + 20000);
  }
}

async function refresh() {
  if (busy || document.hidden) return;
  busy = true;
  try {
    if (Date.now() >= nextIndex) {
      await readIndex();
      nextIndex = Date.now() + 30000;
    }
    retry.hidden = true;
    render();
    await Promise.all(cases.filter(r => r.active && withinScope(r)).map(readLive));
    render();
  } catch {
    lastRender = undefined;
    statusLine.textContent = ready ? "Showing the last case update. Retrying…" : "Court records are temporarily unavailable.";
    retry.hidden = false;
  } finally {
    busy = false;
  }
}

for (const field of form.elements) {
  if (!field.name) continue;
  const value = params.get(field.name) || "";
  if (field instanceof HTMLSelectElement && !Array.from(field.options).some(o => o.value === value)) field.add(new Option("Unknown filter", value));
  field.value = value;
}
form.addEventListener("submit", event => { event.preventDefault(); filter(); });
form.addEventListener("change", event => { if (event.target instanceof HTMLSelectElement) filter(); });
retry.addEventListener("click", refresh);
document.addEventListener("visibilitychange", refresh);
setInterval(refresh, 5000);
refresh();
