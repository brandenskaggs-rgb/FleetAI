"""Select one available iPhone and iPad without assuming a runner's device names."""
import json
import re
import sys
from pathlib import Path

inventory = json.loads(sys.stdin.read() if sys.argv[1] == "-" else Path(sys.argv[1]).read_text())
runtimes = []
for runtime, entries in inventory["devices"].items():
    version = re.search(r"\.iOS-(\d+)(?:-(\d+))?", runtime)
    if version and int(version[1]) >= 16:
        runtimes.append(((int(version[1]), int(version[2] or 0)), entries))
devices = [device for _, entries in sorted(runtimes, key=lambda item: item[0], reverse=True)
           for device in entries if device.get("isAvailable")]
for family in ("iPhone", "iPad"):
    matching = [device for device in devices if device["name"].startswith(family)]
    if not matching:
        sys.exit(f"No available {family} simulator. Install an iOS runtime in Xcode.")
    print(f"{family} {matching[0]['udid']}")
