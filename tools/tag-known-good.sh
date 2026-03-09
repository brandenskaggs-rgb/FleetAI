#!/usr/bin/env bash
set -euo pipefail

TAG_PREFIX=${1:-fleetai-known-good}
TAG="${TAG_PREFIX}-$(date +%Y%m%d-%H%M)"

git rev-parse --is-inside-work-tree >/dev/null
if [[ -n "$(git status --porcelain)" ]]; then
  echo "Working tree is not clean. Commit or stash first." >&2
  exit 1
fi

npm run verify

git tag -a "$TAG" -m "Known good"
echo "Created tag: $TAG"
echo "Push with: git push origin $TAG"
