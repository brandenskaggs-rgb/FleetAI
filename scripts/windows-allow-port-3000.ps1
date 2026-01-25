param(
  [int]$Port = 3000,
  [string]$RuleName = "FleetAI Dev Server 3000"
)

$existing = Get-NetFirewallRule -DisplayName $RuleName -ErrorAction SilentlyContinue
if ($null -ne $existing) {
  Write-Host "Firewall rule already exists: $RuleName"
  exit 0
}

New-NetFirewallRule `
  -DisplayName $RuleName `
  -Direction Inbound `
  -Action Allow `
  -Protocol TCP `
  -LocalPort $Port `
  -Profile Any | Out-Null

Write-Host "Created firewall rule: $RuleName (TCP $Port)"
