#!/usr/bin/env python3
"""Bootstrap the evaluator's two credentials and monitor its local SQLite database."""
import datetime
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import urllib.request

ROOT = Path("/srv/taskmarket-evaluator")
SERVICE = "taskmarket-evaluator-testnet"


def command(*args):
    return subprocess.check_output(args, text=True).strip()


def credentials():
    raw = command("aws", "secretsmanager", "get-secret-value", "--secret-id", SERVICE + "/evaluator",
                  "--query", "SecretString", "--output", "text")
    secret = json.loads(raw)
    for relative, value in (("keys/bradbury.key", secret["bradbury"]),
                            ("keys/evaluator/keystore.json", json.dumps(secret["taskmarket"]))):
        dest = ROOT / relative
        dest.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(mode="w", dir=dest.parent, delete=False) as handle:
            handle.write(value)
        os.replace(handle.name, dest)


def backup(database, bucket):
    marker = ROOT / "last-backup-sha256"
    with tempfile.TemporaryDirectory(dir=ROOT) as directory:
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
        command("aws", "s3", "cp", str(filename), "s3://" + bucket + "/backups/journal.sqlite",
                "--only-show-errors")
        marker.write_text(digest)


def approaching_deadline(job):
    if job["phase"] in ("review", "disputed"):
        return True
    if job["phase"] not in ("tracked", "evaluating", "ready"):
        return False
    url = "https://testnet-api-market.daydreams.systems/api/tasks/" + job["id"] + "?chainId=42431"
    with urllib.request.urlopen(url, timeout=8) as response:
        deadline = json.load(response).get("evaluatorDeadline")
    if deadline is None:
        return False
    due = datetime.datetime.fromisoformat(deadline.replace("Z", "+00:00"))
    return (due - datetime.datetime.now(datetime.timezone.utc)).total_seconds() <= 7200


def worker_has_lock():
    path = ROOT / "state/taskmarket.sqlite.worker"
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
        db = sqlite3.connect((ROOT / "state/taskmarket.sqlite").as_uri() + "?mode=ro", uri=True)
        try:
            backup(db, bucket)
            rows = db.execute("SELECT record FROM jobs WHERE json_extract(record, '$.phase') != 'settled'")
            attention = int(any(approaching_deadline(json.loads(row[0])) for row in rows))
        finally:
            db.close()
        processes = command("docker", "inspect", "--format", "{{.State.Running}}",
                            "taskmarket-worker", "taskmarket-ledger").splitlines()
        with urllib.request.urlopen("http://127.0.0.1:4732/evaluations", timeout=5) as response:
            healthy = int(processes == ["true", "true"] and response.status == 200 and worker_has_lock())
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
    elif len(sys.argv) == 3 and sys.argv[1] == "monitor":
        monitor(sys.argv[2])
    else:
        raise SystemExit("Usage: host.py credentials | monitor BUCKET")
