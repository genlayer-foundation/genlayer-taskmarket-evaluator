import {evidenceLabel, finalOutcome, juryLabels, juryStage, milestoneLabel} from "./jury.mjs";
const query = new URLSearchParams(location.search);
const network = query.get("network"), task = query.get("task");
const validId = value => /^0x[a-f0-9]{64}$/.test(value || "");
const statusLine = document.querySelector("#status"), list = document.querySelector("#milestones");
const page = document.querySelector("#task");
const rpc = "https://rpc-bradbury.genlayer.com";
function el(tag, text) { const node = document.createElement(tag); node.textContent = text; return node; }
function link(label, url) { const a = el("a", label); a.href = url; a.className = "text-link"; return a; }
let last = "", stopped = false, connected = false;
function render(data) {
  const outcome = finalOutcome(data.milestones);
  statusLine.textContent = outcome ? "Final jury decision · " + juryLabels[outcome] : juryLabels[juryStage(data.phase, data.milestones)];
  const content = JSON.stringify(data);
  if (content === last) return;
  last = content;
  list.replaceChildren();
  for (const m of data.milestones) {
    const card = el("article", ""); card.className = "live-milestone";
    card.append(el("h2",milestoneLabel(m)), el("p",m.milestone), el("p",evidenceLabel(m.webDomains)));
    if (m.result && (m.status === "Finalized" || (m.status === "Accepted" && m.decision)))
      card.append(el("h3","Jury reasoning"),el("p",m.result.reasoning));
    if (validId(m.tx)) {
      card.append(link("Inspect the Bradbury ruling", "https://scan.bradbury.genlayer.com/tx/" + m.tx), el("code",m.tx));
    }
    if (m.decision && Number.isSafeInteger(m.deadline) && validId(m.tx)) {
      const epoch = m.deadline * 1000;
      card.append(el("p","Decision " + m.decision + " · Appeal deadline " + new Date(epoch).toISOString().replace("T"," ").replace(".000Z"," UTC")));
      const clock = el("strong",""); clock.dataset.deadline = String(epoch); card.append(clock);
    }
    if (validId(m.tx) && !["Finalized","Canceled"].includes(m.status)) {
      const commands = el("details",""); commands.dataset.expires = String((m.deadline || 0) * 1000);
      commands.append(el("summary", m.decision ? "Check the quote and appeal with the GenLayer CLI" : "Prepare the commands for this ruling"),
        el("p","Once the jury has issued an eligible decision, check the quote. Use the second command only if you want to fund an appeal from your wallet."),
        el("pre","genlayer appeal-bond " + m.tx + " --rpc " + rpc + "\n" + "genlayer appeal " + m.tx + " --rpc " + rpc));
      card.append(commands);
    }
    list.append(card);
  }
  if (data.phase === "settled" && outcome === "needs_review")
    list.append(el("p", "The buyer rejected the delivery after the evaluator timeout. The settlement receipt shows the buyer’s refund and the worker’s rejection fee."));
  if (data.phase === "settled") list.append(link("View settlement receipt","/explorer?network=" + network + "&case=" + task));
  countdown();
}
function countdown() {
  for (const node of list.querySelectorAll("[data-deadline]")) {
    const secs = Math.ceil((Number(node.dataset.deadline) - Date.now()) / 1000);
    node.textContent = secs > 0 ? secs + " seconds remaining by your device clock" : "The recorded appeal deadline has passed.";
  }
  for (const commands of list.querySelectorAll("details[data-expires]")) {
    const expires = Number(commands.dataset.expires);
    commands.hidden = !connected || (expires !== 0 && expires <= Date.now());
  }
}
async function refresh() {
  try {
    const response = await fetch("/cases/" + network + "/" + task + ".json", {cache:"no-store", signal:AbortSignal.timeout(4500)});
    if (!response.ok) throw Error();
    const data = await response.json();
    if (data.id !== task || data.network !== network || !Array.isArray(data.milestones)) throw Error();
    connected = true; render(data);
    stopped = ["settled","disputed","review"].includes(data.phase) && data.milestones.every(m => !m.tx || ["Finalized","Canceled"].includes(m.status));
  } catch {
    connected = false;
    statusLine.textContent = last ? "Live updates interrupted. Check the linked Bradbury transaction for the current decision." : "Case data unavailable. Retrying…";
    if (last) for (const details of list.querySelectorAll("details")) details.hidden = true;
  }
  if (!stopped) setTimeout(refresh, 1000);
}
if (["tempo-mainnet","tempo-testnet"].includes(network) && validId(task)) {
  page.href = (network === "tempo-mainnet" ? "https://taskmarket.dev" : "https://testnet-market.daydreams.systems") + "/tasks/" + task;
  page.hidden = false; setInterval(countdown, 1000); refresh();
} else statusLine.textContent = "Open the case link sent to the buyer and worker for your Taskmarket job.";
