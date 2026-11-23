#!/usr/bin/env python3
"""Bootstrap the evaluator's two credentials and monitor its local SQLite database."""
import datetime
import hashlib
from http.server import BaseHTTPRequestHandler
import json
import os
import re
import socketserver
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import urllib.request

ROOT = Path("/srv/taskmarket-evaluator")
SERVICE = "taskmarket-evaluator-testnet"


def serve_cases(bucket, network, socket_path):
    if network not in ("tempo-testnet", "tempo-mainnet"):
        raise ValueError("Unknown settlement network")

    class Publisher(BaseHTTPRequestHandler):
        def do_PUT(self):
            if not re.fullmatch(r"/0x[0-9a-f]{64}", self.path):
                return self.send_error(400)
            try:
                size = int(self.headers.get("Content-Length", "0"))
                if not 0 < size <= 512_000:
                    return self.send_error(413)
                record = json.loads(self.rfile.read(size))
                if (set(record) != {"id", "network", "phase", "milestones"} or
                        record["network"] != network or record["id"] != self.path[1:]):
                    return self.send_error(400)
                for item in record["milestones"]:
                    if (set(item) - {"milestone", "status", "tx", "decision", "deadline", "result"} or
                            ("result" in item and set(item["result"]) != {"verdict", "reasoning"})):
                        return self.send_error(400)
                subprocess.run(["aws", "s3", "cp", "-", "s3://" + bucket + "/cases/" + network + self.path + ".json",
                                "--content-type", "application/json", "--cache-control", "no-store",
                                "--only-show-errors"], input=json.dumps(record).encode(), check=True, timeout=9)
                self.send_response(204)
                self.end_headers()
            except (ValueError, TypeError, KeyError):
                self.send_error(400)
            except (OSError, subprocess.SubprocessError):
                self.send_error(503)

    class Server(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
        daemon_threads = True

    # BaseHTTPRequestHandler's default access log expects an IP address.
    Publisher.log_message = lambda self, *args: None
    Path(socket_path).parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    Path(socket_path).unlink(missing_ok=True)
    with Server(socket_path, Publisher) as server:
        os.chmod(socket_path, 0o600)
        server.serve_forever()


def command(*args):
    return subprocess.check_output(args, text=True).strip()


def credentials(mainnet=False):
    root = ROOT / "mainnet" if mainnet else ROOT
    secret_name = "/mainnet-evaluator" if mainnet else "/evaluator"
    raw = command("aws", "secretsmanager", "get-secret-value", "--secret-id", SERVICE + secret_name,
                  "--query", "SecretString", "--output", "text")
    secret = json.loads(raw)
    for relative, value in (("keys/bradbury.key", secret["bradbury"]),
                            ("keys/evaluator/keystore.json", json.dumps(secret["taskmarket"]))):
        dest = root / relative
        dest.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(mode="w", dir=dest.parent, delete=False) as handle:
            handle.write(value)
        os.replace(handle.name, dest)


def backup(database, bucket, root, filename_in_bucket):
    marker = root / "last-backup-sha256"
    with tempfile.TemporaryDirectory(dir=root) as directory:
        filename = Path(directory) / "journal.sqlite"
        target = sqlite3.connect(filename)
        try:
            database.backup(target)
            if target.execute("PRAGMA integrity_check").fetchone() != ("ok",):
                raise RuntimeError("SQLite backup failed its integrity check")
        finally:
            target.close()
        digest = hashlib.sha256(filename.read_bytes()).hexdigest()
        if marker.exists() and marker.read_text() == digest:
            return
        command("aws", "s3", "cp", str(filename), "s3://" + bucket + "/backups/" + filename_in_bucket,
                "--only-show-errors")
        marker.write_text(digest)


def receipt_feed(database, chain=42431):
    # The live worker only marks a job settled after matching its Tempo transfer.
    # Project individual public fields. Journal records can contain signed bytes.
    rows = database.execute("""
        SELECT record FROM jobs
        WHERE json_extract(record, '$.phase') = 'settled'
          AND json_extract(record, '$.scenario') IS NULL
          AND json_extract(record, '$.evidence.chainId') = ?
        ORDER BY json_extract(record, '$.updated') DESC, id
    """, (chain,))
    evaluations = []
    for (record,) in rows:
        job = json.loads(record)
        receipt = job["settlement"]
        milestones = {m["id"]: m for m in job["agreement"]["milestones"]}
        evaluations.append({
            "venue": "taskmarket", "network": "tempo-mainnet" if chain == 4217 else "tempo-testnet",
            "rulingNetwork": "bradbury-testnet", "id": job["id"],
            "completedAt": job["updated"], "brief": job["agreement"]["brief"],
            "verdict": job["decision"]["verdict"], "settlementKind": receipt["kind"],
            "amountUnits": receipt["units"], "settlementTx": receipt["tx"],
            "rulings": [{
                "milestone": j["milestone"], "tx": j["tx"],
                "rubric": milestones[j["milestone"]]["rubric"],
                "priceUnits": milestones[j["milestone"]]["awardUnits"],
                "result": j["result"]["verdict"], "reason": j["result"]["reasoning"],
            } for j in job["judgments"]],
        })
    return {"version": 1, "evaluations": evaluations}


def publish_receipts(evaluations, bucket):
    evaluations.sort(key=lambda row: (row["completedAt"], row["network"], row["id"]), reverse=True)
    payload = json.dumps({"version": 1, "evaluations": evaluations}, ensure_ascii=False, separators=(",", ":")).encode()
    digest = hashlib.sha256(payload).hexdigest()
    marker = ROOT / "last-published-receipts"
    stamp = bucket + "/" + digest
    if marker.exists() and marker.read_text() == stamp:
        return
    with tempfile.NamedTemporaryFile(dir=ROOT) as handle:
        handle.write(payload)
        handle.flush()
        command("aws", "s3", "cp", handle.name, "s3://" + bucket + "/completed.json",
                "--content-type", "application/json", "--cache-control", "public, max-age=60",
                "--only-show-errors")
    marker.write_text(stamp)


def approaching_deadline(job, chain):
    if job["phase"] in ("review", "disputed"):
        return True
    if job["phase"] not in ("tracked", "evaluating", "ready"):
        return False
    api = "https://api.taskmarket.dev" if chain == 4217 else "https://testnet-api-market.daydreams.systems"
    url = api + "/api/tasks/" + job["id"] + "?chainId=" + str(chain)
    with urllib.request.urlopen(url, timeout=8) as response:
        deadline = json.load(response).get("evaluatorDeadline")
    if deadline is None:
        return False
    due = datetime.datetime.fromisoformat(deadline.replace("Z", "+00:00"))
    return (due - datetime.datetime.now(datetime.timezone.utc)).total_seconds() <= 7200


def worker_has_lock(root):
    path = root / "state/taskmarket.sqlite.worker"
    if not path.is_file():
        return False
    db = sqlite3.connect(path.as_uri() + "?mode=rw", uri=True, timeout=0)
    try:
        db.execute("BEGIN EXCLUSIVE")
        db.rollback()
        return False
    except sqlite3.OperationalError as error:
        if "locked" in str(error):
            return True
        raise
    finally:
        db.close()


def monitor(bucket):
    healthy, attention = 0, 0
    try:
        deployments = [(ROOT, 42431, "journal.sqlite", "", 4732)]
        if os.environ.get("MONITOR_MAINNET") == "1":
            deployments.append((ROOT / "mainnet", 4217, "mainnet.sqlite", "-mainnet", 4733))
        evaluations = []
        services_healthy = True
        for root, chain, object_name, suffix, port in deployments:
            db = sqlite3.connect((root / "state/taskmarket.sqlite").as_uri() + "?mode=ro", uri=True)
            try:
                backup(db, bucket, root, object_name)
                rows = db.execute("SELECT record FROM jobs WHERE json_extract(record, '$.phase') != 'settled'")
                if any(approaching_deadline(json.loads(row[0]), chain) for row in rows):
                    attention = 1
                evaluations.extend(receipt_feed(db, chain)["evaluations"])
            finally:
                db.close()
            processes = command("docker", "inspect", "--format", "{{.State.Running}}",
                                "taskmarket-worker" + suffix, "taskmarket-ledger" + suffix).splitlines()
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/evaluations", timeout=5) as response:
                services_healthy &= processes == ["true", "true"] and response.status == 200 and worker_has_lock(root)
        publish_receipts(evaluations, os.environ["RECEIPTS_BUCKET"])
        healthy = int(services_healthy)
    finally:
        metrics = [{"MetricName": name, "Value": value, "Unit": "Count",
                    "Dimensions": [{"Name": "Service", "Value": SERVICE}]}
                   for name, value in (("Healthy", healthy), ("NeedsAttention", attention))]
        command("aws", "cloudwatch", "put-metric-data", "--namespace", "GenLayer/Taskmarket",
                "--metric-data", json.dumps(metrics))
    if not healthy:
        raise RuntimeError("Evaluator did not pass its health check")


if __name__ == "__main__":
    os.umask(0o077)
    if sys.argv[1:] == ["credentials"]:
        credentials()
    elif sys.argv[1:] == ["credentials", "tempo-mainnet"]:
        credentials(True)
    elif len(sys.argv) == 3 and sys.argv[1] == "monitor":
        monitor(sys.argv[2])
    elif len(sys.argv) == 5 and sys.argv[1] == "publish-cases":
        serve_cases(*sys.argv[2:])
    else:
        raise SystemExit("Usage: host.py credentials | monitor BUCKET")
