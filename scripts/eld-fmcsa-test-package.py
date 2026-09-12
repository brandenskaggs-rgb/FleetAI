"""Load FMCSA's test package in memory and invoke the Node diagnostic client.

Requires Python cryptography. Never writes extracted keys or changes a trust store.
"""

import argparse
import json
import subprocess
import sys
from pathlib import Path

from lib.eld_test_identity import load_test_package


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("package", type=Path)
    parser.add_argument("--submit-synthetic", action="store_true")
    args = parser.parse_args()
    payload = load_test_package(args.package)
    root = Path(__file__).resolve().parent.parent
    mode = "--submit-synthetic" if args.submit_synthetic else "--ping"
    result = subprocess.run(["node", str(root / "scripts/eld-fmcsa-test.js"), mode],
                            input=json.dumps(payload).encode("utf-8"), cwd=root, check=False)
    return result.returncode


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        print("FMCSA test package could not be loaded; no key material was written or printed.", file=sys.stderr)
        sys.exit(1)
