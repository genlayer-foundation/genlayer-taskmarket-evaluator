import copy
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

import host


class PublicReceiptsTest(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        self.addCleanup(self.db.close)
        self.db.execute("CREATE TABLE jobs (id TEXT PRIMARY KEY, record TEXT NOT NULL)")
        self.job = json.loads((Path(__file__).resolve().parents[2] /
                               "examples/taskmarket/settled-pilot.json").read_text())

    def save(self, key, job):
        self.db.execute("INSERT INTO jobs VALUES (?, ?)", (key, json.dumps(job)))

    def test_only_live_settled_jobs_and_explicit_public_fields(self):
        self.job["judgments"][0]["signed"] = "private-signed-bytes"
        self.job["message"] = "internal-error"
        self.save("live", self.job)
        for key, change in (("pending", {"phase": "appealing"}), ("demo", {"scenario": "approval"}),
                            ("wrong-network", {"evidence": {"chainId": 1}})):
            self.save(key, {**self.job, **change})
        feed = host.receipt_feed(self.db)
        self.assertEqual(len(feed["evaluations"]), 1)
        case = feed["evaluations"][0]
        self.assertEqual(case["amountUnits"], "950000")
        self.assertEqual(case["settlementTx"], self.job["settlement"]["tx"])
        self.assertEqual(case["rulings"][0]["reason"], self.job["judgments"][0]["result"]["reasoning"])
        self.assertEqual(set(case), {"id", "venue", "network", "completedAt", "brief", "verdict",
                                     "settlementKind", "amountUnits", "settlementTx", "rulings", "rulingNetwork"})
        self.assertEqual(set(case["rulings"][0]), {"milestone", "tx", "priceUnits", "rubric", "reason", "result"})
        for private in ("private-signed-bytes", "internal-error", "submission.md"):
            self.assertNotIn(private, json.dumps(feed))

    def test_retries_upload_then_publishes_only_when_records_change(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(host, "ROOT", Path(directory)), \
                patch.object(host, "command") as upload:
            upload.side_effect = RuntimeError("storage unavailable")
            with self.assertRaises(RuntimeError):
                host.publish_receipts(host.receipt_feed(self.db)["evaluations"], "receipts")
            upload.side_effect = None
            host.publish_receipts(host.receipt_feed(self.db)["evaluations"], "receipts")
            host.publish_receipts(host.receipt_feed(self.db)["evaluations"], "receipts")
            self.assertEqual(upload.call_count, 2)
            refund = copy.deepcopy(self.job)
            refund["decision"]["verdict"] = "reject"
            refund["settlement"].update(kind="refund", units="1000000")
            self.save("refund", refund)
            host.publish_receipts(host.receipt_feed(self.db)["evaluations"], "receipts")
            self.assertEqual(upload.call_count, 3)
            public = host.receipt_feed(self.db)["evaluations"][0]
            self.assertEqual((public["verdict"], public["settlementKind"], public["amountUnits"]),
                             ("reject", "refund", "1000000"))

    def test_mainnet_settlement_carries_its_testnet_ruling_label(self):
        self.job["evidence"]["chainId"] = 4217
        self.save("hybrid", self.job)
        self.assertEqual(host.receipt_feed(self.db)["evaluations"], [])
        row, = host.receipt_feed(self.db, 4217)["evaluations"]
        self.assertEqual((row["network"], row["rulingNetwork"]), ("tempo-mainnet", "bradbury-testnet"))

    def test_mainnet_finalized_review_is_visible_without_a_transfer(self):
        job = copy.deepcopy(self.job)
        job["evidence"]["chainId"] = 4217
        job["phase"] = "review"
        job.pop("decision")
        job.pop("settlement")
        job["judgments"][0]["result"]["verdict"] = "needs_review"
        job["judgments"][0]["signed"] = "private-signed-bytes"
        self.save("review", job)
        self.save("demo", {**job, "scenario": "uncertain"})
        self.save("incomplete", {**job, "judgments": [{"milestone": "guide"}]})
        feed = host.receipt_feed(self.db, 4217)
        self.assertEqual(feed["evaluations"], [])
        case, = feed["unsettled"]
        self.assertEqual((case["network"], case["verdict"], case["rewardUnits"]),
                         ("tempo-mainnet", "needs_review", job["agreement"]["rewardUnits"]))
        self.assertNotIn("settlementTx", case)
        self.assertNotIn("amountUnits", case)
        self.assertNotIn("private-signed-bytes", json.dumps(case))
        self.assertEqual(host.receipt_feed(self.db)["unsettled"], [])
        self.db.execute("UPDATE jobs SET record = ? WHERE id = 'review'", (json.dumps({
            **self.job, "evidence": job["evidence"]}),))
        settled = host.receipt_feed(self.db, 4217)
        self.assertEqual(settled["unsettled"], [])
        self.assertEqual(len(settled["evaluations"]), 1)
