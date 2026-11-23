"use strict";

const form = document.querySelector("#filters");
const statusLine = document.querySelector("#status");
const records = document.querySelector("#records");
const retry = document.querySelector("#retry");
const clear = document.querySelector("#clear");
const params = new URLSearchParams(location.search);
// The original case permalinks were issued exclusively for Tempo testnet.
if (params.has("case") && !params.has("network")) params.set("network", "tempo-testnet");
const labels = {approve: "Approved", reject: "Rejected", partial: "Partial award"};
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

function validRecord(row) {
  return row && row.venue === "taskmarket" && Object.hasOwn(networks, row.network) &&
    (row.rulingNetwork === "bradbury-testnet" || (row.network === "tempo-testnet" && row.rulingNetwork === undefined)) &&
    transaction.test(row.id) && transaction.test(row.settlementTx) &&
    Object.hasOwn(labels, row.verdict) && ["payment","refund"].includes(row.settlementKind) &&
    units.test(row.amountUnits) && typeof row.brief === "string" && Number.isFinite(Date.parse(row.completedAt)) &&
    Array.isArray(row.rulings) && row.rulings.length > 0 && row.rulings.every(ruling =>
      ruling && typeof ruling.milestone === "string" && transaction.test(ruling.tx) &&
      units.test(ruling.priceUnits) && ["approve","reject"].includes(ruling.result) &&
      typeof ruling.rubric === "string" && typeof ruling.reason === "string");
}

function caseCard(row, open) {
  const network = networks[row.network];
  const card = element("article", undefined, "case");
  const meta = element("div", undefined, "case-meta");
  const completed = element("time", date.format(new Date(row.completedAt)));
  completed.dateTime = row.completedAt;
  meta.append(element("strong", labels[row.verdict]), element("span", "Payment: " + network.label),
    element("span", "Ruling: GenLayer Bradbury testnet"), completed);
  const transfer = money(row.amountUnits, network.token) +
    (row.settlementKind === "refund" ? " refunded to the requester" : " paid to the worker");
  const links = element("div", undefined, "case-links");
  links.append(link("Task on Taskmarket", network.task + row.id),
    link(network.label + " settlement receipt", network.tx + row.settlementTx),
    link("Link to this case", "/explorer?case=" + row.id + "&network=" + row.network));
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
  detail.append(items);
  card.append(meta, element("h2", row.brief), element("p", transfer, "transfer"), links, detail);
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
  statusLine.textContent = filtered.length ? filtered.length + (filtered.length === 1 ? " completed evaluation" : " completed evaluations") :
    clear.hidden ? "No evaluations have settled yet." : "No completed evaluations match these filters.";
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
    if (feed.version !== 1 || !Array.isArray(feed.evaluations) || !feed.evaluations.every(validRecord))
      throw new Error("Invalid receipt feed");
    cases = feed.evaluations;
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
