"""Operator-only model inventory, promotion and rollback; no HTTP endpoint."""
import argparse
import json
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from backend.app.ml.artifact_registry import configured_registry


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["list", "promote", "rollback"])
    parser.add_argument("--id")
    parser.add_argument("--slot")
    parser.add_argument("--scope", default="global_synthetic")
    parser.add_argument("--reason")
    args = parser.parse_args()
    registry = configured_registry()
    if registry is None:
        parser.error("Set FLEETAI_ML_ARTIFACT_DIR to the persistent registry directory")
    if args.action == "list":
        print(json.dumps(registry.inventory(), indent=2))
    elif args.action == "promote":
        if not args.id or not args.reason:
            parser.error("Promotion requires --id and --reason")
        registry.promote(args.id, args.reason)
        print("Active pointer updated. Restart the ML service to load it; verify model status afterward.")
    else:
        if not args.slot or not args.reason:
            parser.error("Rollback requires --slot and --reason")
        registry.rollback(args.slot, args.scope, args.reason)
        print("Previous artifact restored. Restart the ML service to load it.")


if __name__ == "__main__":
    main()
