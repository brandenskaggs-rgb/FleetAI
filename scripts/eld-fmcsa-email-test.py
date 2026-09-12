"""Generate a synthetic FMCSA test email locally. Does not send email."""

import argparse
import hashlib
import json
import subprocess
import sys
from pathlib import Path
from uuid import uuid4

from cryptography import x509
from cryptography.hazmat.primitives import serialization

from lib.eld_smime import build_test_email, load_recipient_package
from lib.eld_test_identity import load_test_package


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--test-package", type=Path, required=True)
    parser.add_argument("--recipient-package", type=Path, required=True)
    parser.add_argument("--sender", required=True)
    args = parser.parse_args()
    identity = load_test_package(args.test_package)
    recipient = load_recipient_package(args.recipient_package)
    root = Path(__file__).resolve().parent.parent
    # The existing synthetic generator has no database access. Keys pass only through stdin.
    program = """
const fs = require('node:fs');
const { syntheticSubmission } = require('./scripts/lib/eld-synthetic-submission');
const identity = JSON.parse(fs.readFileSync(0, 'utf8'));
process.stdout.write(JSON.stringify(syntheticSubmission(identity, identity.key)));
"""
    generated = subprocess.run(["node", "-e", program], input=json.dumps(identity).encode("ascii"),
                               cwd=root, capture_output=True, timeout=30, check=False)
    if generated.returncode != 0:
        raise ValueError("Synthetic output generation failed")
    submission = json.loads(generated.stdout)
    cert = x509.load_pem_x509_certificate(identity["cert"].encode("ascii"))
    key = serialization.load_pem_private_key(identity["key"].encode("ascii"), password=None)
    message = build_test_email(submission, identity, args.sender, cert, key, recipient)
    artifact_dir = root / "artifacts" / "eld"
    artifact_dir.mkdir(parents=True, exist_ok=True)
    path = artifact_dir / f"fmcsa-email-test-{uuid4()}.eml"
    with path.open("xb") as output:
        output.write(message)
    print(json.dumps({"status": "GENERATED_NOT_SENT", "test": True,
                      "customerRecordsUsed": False, "registrationSubmitted": False,
                      "path": str(path), "bytes": len(message),
                      "sha256": hashlib.sha256(message).hexdigest(),
                      "recipientExpiresAt": recipient.not_valid_after_utc.isoformat()}))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        print("Test email generation failed. No email sent; key material was not printed.", file=sys.stderr)
        sys.exit(1)
