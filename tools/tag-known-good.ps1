param(
  [string]$TagPrefix = "fleetai-known-good"
)

$now = Get-Date
$tag = "{0}-{1:yyyyMMdd-HHmm}" -f $TagPrefix, $now

git rev-parse --is-inside-work-tree | Out-Null
if ($LASTEXITCODE -ne 0) { Write-Error "Not a git repo"; exit 1 }

$dirty = git status --porcelain
if ($dirty) {
  Write-Error "Working tree is not clean. Commit or stash first."; exit 1
}

npm run verify
if ($LASTEXITCODE -ne 0) { Write-Error "Verify failed"; exit 1 }

git tag -a $tag -m "Known good"
Write-Host "Created tag: $tag"
Write-Host "Push with: git push origin $tag"
