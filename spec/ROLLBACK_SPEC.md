# Rollback Spec

## Known-Good Tag Workflow
1) Ensure working tree is clean
2) Run: npm run verify
3) Create tag: fleetai-known-good-YYYYMMDD-HHMM
4) Push tag: git push origin <tag>

## Rollback
- git checkout <tag>
- or: git reset --hard <tag>

If tag missing:
- Use last known good commit hash from git log
