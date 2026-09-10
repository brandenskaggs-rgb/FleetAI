"""Immutable model blobs and durable scheduling on an explicitly mounted volume.

The registry is operator-controlled. Never import joblib from an uploaded or
untrusted artifact. SQLite transactions protect activation and scheduling across
workers; promotion is explicit, never a side effect of training.
"""
from __future__ import annotations
import hashlib
import io
import json
import os
from pathlib import Path
import sqlite3
import time
import uuid
from contextlib import contextmanager
import joblib
import platform
from importlib.metadata import version, PackageNotFoundError
from .feature_contract import json_safe


class Registry:
    def __init__(self, root):
        self.root = Path(root).resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self.path = self.root / "registry.sqlite3"
        with self.connect() as db:
            db.executescript('''
                CREATE TABLE IF NOT EXISTS artifacts (
                  id TEXT PRIMARY KEY, slot TEXT NOT NULL, scope TEXT NOT NULL,
                  created REAL NOT NULL, sha256 TEXT NOT NULL, blob BLOB NOT NULL,
                  metadata TEXT NOT NULL, evaluation TEXT, status TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS active (
                  slot TEXT NOT NULL, scope TEXT NOT NULL, id TEXT NOT NULL,
                  PRIMARY KEY(slot,scope));
                CREATE TABLE IF NOT EXISTS promotions (
                  seq INTEGER PRIMARY KEY, at REAL NOT NULL, slot TEXT NOT NULL,
                  scope TEXT NOT NULL, previous_id TEXT, next_id TEXT NOT NULL, reason TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS jobs (
                  name TEXT PRIMARY KEY, due REAL NOT NULL, lease_until REAL NOT NULL DEFAULT 0,
                  token TEXT, last_result TEXT);
            ''')

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.path, timeout=30)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA synchronous=FULL")
        try:
            with db:
                yield db
        finally:
            db.close()

    def candidate(self, slot, bundle, metadata, scope="global_synthetic"):
        if not metadata.get("trainingSource") or not metadata.get("featureSchema"):
            raise ValueError("Candidate requires training source and feature schema")
        if scope == "global_synthetic" and not metadata["trainingSource"].startswith("synthetic"):
            raise ValueError("Real fleet models require a tenant scope")
        identifier = str(uuid.uuid4())
        versions = {"python": platform.python_version()}
        for package in ("numpy", "pandas", "scikit-learn", "lightgbm", "joblib"):
            try:
                versions[package] = version(package)
            except PackageNotFoundError:
                versions[package] = "not_installed"
        metadata = {**metadata, "artifactId": identifier, "runtimeVersions": versions}
        packed = io.BytesIO()
        payload = {**bundle, "artifactId": identifier, "metadata": metadata}
        if payload.get("calibration"):
            payload["calibration"] = {**payload["calibration"], "artifactId": identifier}
        if payload.get("calibration_metadata"):
            payload["calibration_metadata"] = {**payload["calibration_metadata"], "artifactId": identifier}
        if payload.get("conformal"):
            payload["conformal"] = {**payload["conformal"], "metadata": {**payload["conformal"].get("metadata", {}), "artifactId": identifier}}
        joblib.dump(payload, packed)
        blob = packed.getvalue()
        with self.connect() as db:
            db.execute("INSERT INTO artifacts VALUES(?,?,?,?,?,?,?,?,?)", (
                identifier, slot, scope, time.time(), hashlib.sha256(blob).hexdigest(),
                blob, json.dumps(json_safe(metadata), allow_nan=False), None, "candidate"))
        return identifier

    def evaluate(self, identifier, report):
        if report.get("partition") != "untouched_test" or not report.get("evidenceSource"):
            raise ValueError("Evaluation must identify untouched test evidence")
        if not report.get("metrics"):
            raise ValueError("Evaluation metrics are required")
        with self.connect() as db:
            row = db.execute("SELECT status,metadata FROM artifacts WHERE id=?", (identifier,)).fetchone()
            if not row or row["status"] != "candidate":
                raise ValueError("Only a new candidate may be evaluated")
            if report["evidenceSource"] != json.loads(row["metadata"])["trainingSource"]:
                raise ValueError("Evaluation and training evidence sources do not match")
            db.execute("UPDATE artifacts SET evaluation=?,status='evaluated' WHERE id=?",
                       (json.dumps(json_safe(report), allow_nan=False), identifier))

    def promote(self, identifier, reason):
        if not reason or not reason.strip():
            raise ValueError("Promotion requires an operator review reason")
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT * FROM artifacts WHERE id=?", (identifier,)).fetchone()
            if not row or row["status"] not in ("evaluated", "retired", "active"):
                raise ValueError("Candidate must be evaluated before promotion")
            if hashlib.sha256(row["blob"]).hexdigest() != row["sha256"]:
                raise ValueError("Artifact digest mismatch")
            if row["slot"] in ("pretrained", "stage2"):
                from .feature_contract import validate_bundle_schema, PRETRAINED_FEATURES, STAGE2_FEATURES
                bundle = joblib.load(io.BytesIO(row["blob"]))
                validate_bundle_schema(bundle, STAGE2_FEATURES if row["slot"] == "stage2" else PRETRAINED_FEATURES)
            previous = db.execute("SELECT id FROM active WHERE slot=? AND scope=?", (row["slot"],row["scope"])).fetchone()
            if previous:
                db.execute("UPDATE artifacts SET status='retired' WHERE id=?", (previous["id"],))
            db.execute("INSERT OR REPLACE INTO active VALUES(?,?,?)", (row["slot"],row["scope"],identifier))
            db.execute("UPDATE artifacts SET status='active' WHERE id=?", (identifier,))
            db.execute("INSERT INTO promotions(at,slot,scope,previous_id,next_id,reason) VALUES(?,?,?,?,?,?)",
                       (time.time(),row["slot"],row["scope"],previous["id"] if previous else None,identifier,reason))

    def load_active(self, slot, scope="global_synthetic"):
        with self.connect() as db:
            row = db.execute("SELECT a.* FROM artifacts a JOIN active p ON p.id=a.id WHERE p.slot=? AND p.scope=?", (slot,scope)).fetchone()
        if row is None:
            return None
        if hashlib.sha256(row["blob"]).hexdigest() != row["sha256"]:
            raise ValueError("Artifact digest mismatch")
        return joblib.load(io.BytesIO(row["blob"]))

    def rollback(self, slot, scope, reason):
        with self.connect() as db:
            row = db.execute("SELECT previous_id FROM promotions WHERE slot=? AND scope=? ORDER BY seq DESC LIMIT 1", (slot,scope)).fetchone()
        if row is None or not row["previous_id"]:
            raise ValueError("No previous active artifact to roll back to")
        self.promote(row["previous_id"], reason)

    def inventory(self):
        with self.connect() as db:
            return [dict(row) for row in db.execute("SELECT id,slot,scope,created,sha256,status FROM artifacts ORDER BY created DESC")]

    def claim(self, name, now=None, lease_seconds=3600):
        now = time.time() if now is None else now
        token = str(uuid.uuid4())
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            db.execute("INSERT OR IGNORE INTO jobs(name,due) VALUES(?,?)", (name,now))
            result = db.execute("UPDATE jobs SET lease_until=?,token=? WHERE name=? AND due<=? AND lease_until<=?",
                                (now+lease_seconds,token,name,now,now))
            return token if result.rowcount else None

    def finish(self, name, token, result, interval_seconds=7*86400, now=None):
        now = time.time() if now is None else now
        with self.connect() as db:
            updated = db.execute("UPDATE jobs SET due=?,lease_until=0,token=NULL,last_result=? WHERE name=? AND token=? AND lease_until>?",
                                 (now+interval_seconds,result,name,token,now))
            if not updated.rowcount:
                raise ValueError("Job lease expired or no longer owned")


def configured_registry():
    root = os.environ.get("FLEETAI_ML_ARTIFACT_DIR")
    if not root:
        return None
    if not Path(root).is_absolute():
        raise ValueError("FLEETAI_ML_ARTIFACT_DIR must be an absolute persistent-volume path")
    return Registry(root)


def training_registry():
    return configured_registry() or Registry(Path(__file__).resolve().parents[3] / "model_candidates")
