"use strict";

const form = document.querySelector("#filters");
const statusLine = document.querySelector("#status");
const records = document.querySelector("#records");
const retry = document.querySelector("#retry");
const clear = document.querySelector("#clear");
const params = new URLSearchParams(location.search);
// The original case permalinks were issued exclusively for Tempo testnet.
if (params.has("case") && !params.has("network")) params.set("network", "tempo-testnet");
const labels = {approve: "Approved", reject: "Rejected", partial: "Partial award", needs_review: "Needs review", finalized: "Jury rulings finalized", error: "Ruling error"};
const networks = {
  "tempo-mainnet": { label: "Tempo mainnet", token: "OUSD", task: "https://taskmarket.dev/tasks/", tx: "https://explore.tempo.xyz/tx/" },
  "tempo-testnet": { label: "Tempo testnet", token: "test OUSD", task: "https://testnet-market.daydreams.systems/tasks/", tx: "https://explore.testnet.tempo.xyz/tx/" },
};
const transaction = /^0x[0-9a-f]{64}$/i;
const units = /^\d{1,31}$/;
const date = new Intl.DateTimeFormat("en", {day: "numeric", month: "long", year: "numeric", timeZone: "UTC"});
let cases = [];
let ready = false;

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

function validRecord(row, settled) {
  if (!row) return false;
  const validOutcome = settled
    ? transaction.test(row.settlementTx) && ["approve","partial","reject"].includes(row.verdict) &&
      ["payment","refund"].includes(row.settlementKind) && units.test(row.amountUnits) && Number.isFinite(Date.parse(row.completedAt))
    : !row.settlementTx && !row.settlementKind && units.test(row.rewardUnits) && Number.isFinite(Date.parse(row.updatedAt)) &&
      ["approve","partial","reject","needs_review","finalized"].includes(row.verdict);
  return validOutcome && row.venue === "taskmarket" && Object.hasOwn(networks, row.network) &&
    (row.rulingNetwork === "bradbury-testnet" || (row.network === "tempo-testnet" && row.rulingNetwork === undefined)) &&
    transaction.test(row.id) && typeof row.brief === "string" &&
    Array.isArray(row.rulings) && row.rulings.length > 0 && row.rulings.every(ruling =>
      ruling && typeof ruling.milestone === "string" && transaction.test(ruling.tx) &&
      units.test(ruling.priceUnits) && (settled ? ["approve","reject"] : ["approve","reject","needs_review","error"]).includes(ruling.result) &&
      typeof ruling.rubric === "string" && typeof ruling.reason === "string");
}

function caseCard(row, open) {
  const network = networks[row.network];
  const card = element("article", undefined, "case");
  const meta = element("div", undefined, "case-meta");
  const timestamp = row.completedAt || row.updatedAt;
  const completed = element("time", date.format(new Date(timestamp)));
  completed.dateTime = timestamp;
  meta.append(element("strong", labels[row.verdict]), element("span", "Payment: " + network.label),
    element("span", "Ruling: GenLayer Bradbury testnet"), completed);
  const transfer = row.settlementTx
    ? money(row.amountUnits, network.token) + (row.settlementKind === "refund" ? " refunded to the requester" : " paid to the worker")
    : "Agreed reward " + money(row.rewardUnits, network.token) + " · No verified payment or refund";
  const links = element("div", undefined, "case-links");
  links.append(link("Task on Taskmarket", network.task + row.id));
  if (row.settlementTx) links.append(link(network.label + " settlement receipt", network.tx + row.settlementTx));
  links.append(link("Link to this evaluation", "/explorer?case=" + row.id + "&network=" + row.network));
  const detail = element("details");
  detail.open = open;
  const count = row.rulings.length;
  detail.append(element("summary", count + (count === 1 ? " milestone ruling" : " milestone rulings")));
  const items = element("ol");
  for (const ruling of row.rulings) {
    const item = element("li");
    item.append(element("h3", ruling.milestone + " · " + labels[ruling.result]),
      element("p", "Agreed price: " + money(ruling.priceUnits, network.token)),
      element("p", "Rubric: " + ruling.rubric), element("p", "Ruling: " + ruling.reason),
      link("Finalized ruling on Bradbury testnet", "https://scan.bradbury.genlayer.com/tx/" + ruling.tx));
    items.append(item);
  }
  const headline = row.brief.length <= 160 ? row.brief : row.brief.match(/^.{1,157}?[.!?](?=\s)/s)?.[0] ||
    row.brief.slice(0, 157).replace(/\s+\S*$/, "") + "…";
  if (headline !== row.brief) detail.append(element("h3", "Agreed brief"), element("p", row.brief));
  detail.append(items);
  card.append(meta, element("h2", headline), element("p", transfer, "transfer"), links, detail);
  return card;
}

function render() {
  if (!ready) return;
  const q = (params.get("q") || "").trim().toLowerCase();
  const venue = params.get("venue");
  const verdict = params.get("verdict");
  const network = params.get("network");
  const id = params.get("case")?.toLowerCase();
  const filtered = cases.filter(row => (!venue || venue === row.venue) && (!verdict || verdict === row.verdict) &&
    (!network || network === row.network) && (!id || id === row.id.toLowerCase()) &&
    (!q || [row.brief, row.id, ...row.rulings.map(r => r.milestone)].some(s => s.toLowerCase().includes(q))));
  clear.hidden = !(q || venue || verdict || network || id);
  statusLine.textContent = filtered.length ? filtered.length + (filtered.length === 1 ? " evaluation" : " evaluations") :
    clear.hidden ? "No finalized evaluations yet." : "No evaluations match these filters.";
  records.replaceChildren(...filtered.map(row => caseCard(row, Boolean(id))));
}

function readFilters() {
  for (const name of ["q", "venue", "network", "verdict"]) {
    const field = form.elements.namedItem(name);
    const value = params.get(name) || "";
    if (field instanceof HTMLSelectElement && !Array.from(field.options).some(o => o.value === value)) {
      field.add(new Option("Unknown " + (name === "verdict" ? "decision" : name), value));
    }
    field.value = value;
  }
}

function filter() {
  params.delete("case");
  for (const [name, value] of new FormData(form)) {
    if (value.trim()) params.set(name, value.trim());
    else params.delete(name);
  }
  const query = params.toString();
  history.replaceState(null, "", "/explorer" + (query ? "?" + query : ""));
  render();
}

async function load() {
  ready = false;
  retry.hidden = true;
  statusLine.textContent = "Loading court records…";
  try {
    const response = await fetch("/completed.json", {signal: AbortSignal.timeout(15000)});
    if (!response.ok) throw new Error("Feed unavailable");
    const feed = await response.json();
    const unsettled = feed.unsettled === undefined ? [] : feed.unsettled;
    if (feed.version !== 1 || !Array.isArray(feed.evaluations) || !feed.evaluations.every(row => validRecord(row, true)) ||
        !Array.isArray(unsettled) || !unsettled.every(row => validRecord(row, false)))
      throw new Error("Invalid receipt feed");
    cases = [...feed.evaluations, ...unsettled].sort((a, b) =>
      Date.parse(b.completedAt || b.updatedAt) - Date.parse(a.completedAt || a.updatedAt));
    ready = true;
    render();
  } catch {
    records.replaceChildren();
    statusLine.textContent = "The receipt feed is temporarily unavailable.";
    retry.hidden = false;
  }
}

form.addEventListener("submit", event => { event.preventDefault(); filter(); });
form.addEventListener("change", event => { if (event.target instanceof HTMLSelectElement) filter(); });
retry.addEventListener("click", load);
readFilters();
load();
