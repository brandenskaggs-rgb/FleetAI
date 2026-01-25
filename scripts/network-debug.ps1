Write-Host "Fleet AI Network Debug" -ForegroundColor Cyan
Write-Host ""

Write-Host "IPv4 addresses:"
ipconfig | Select-String -Pattern "IPv4" | ForEach-Object {
  $_.ToString().Trim()
}

Write-Host ""
Write-Host "Listening on port 3000:"
netstat -ano | findstr :3000

Write-Host ""
$ipv4 = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
  Where-Object { $_.IPAddress -ne "127.0.0.1" -and $_.IPAddress -notlike "169.254.*" } |
  Select-Object -First 1 -ExpandProperty IPAddress

if ($ipv4) {
  Write-Host "Expected tablet URL: http://$ipv4:3000/health"
} else {
  Write-Host "Could not determine IPv4 address. Use ipconfig output above."
}
