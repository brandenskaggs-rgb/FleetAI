"""Operator entry point; builds datasets and candidates, never promotes."""
import argparse
import asyncio
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from backend.app.ml.learning_worker import run
from backend.app.ml.controlled_learning import COMPONENTS

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--org", required=True)
    parser.add_argument("--component", choices=sorted(COMPONENTS), help="Omit to build a dataset only")
    parser.add_argument("--gates", help="Operator-reviewed evaluation gates JSON file")
    try:
        print(json.dumps(asyncio.run(run(parser.parse_args())), indent=2))
    except Exception as error:
        print("Learning job did not complete: " + type(error).__name__ + ". Check scoped learning status and dataset exclusions.", file=sys.stderr)
        sys.exit(1)
