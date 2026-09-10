param(
    [ValidatePattern('^emulator-[0-9]+$')][string]$Serial = 'emulator-5554',
    [string]$Adb = "$env:LOCALAPPDATA/Android/Sdk/platform-tools/adb.exe",
    [Parameter(Mandatory=$true)][string]$OutputDirectory
)
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
function Invoke-Adb([string[]]$Arguments) {
    $result = & $Adb -s $Serial @Arguments
    if ($LASTEXITCODE -ne 0) { throw "ADB failed: $($Arguments[0])" }
    return $result
}
function Read-Ui {
    for ($attempt = 0; $attempt -lt 5; $attempt++) {
        $dump = Invoke-Adb @('shell','uiautomator','dump','/sdcard/fleet-smoke.xml')
        if (($dump -join ' ') -match 'dumped to') {
            return [xml](Invoke-Adb @('shell','cat','/sdcard/fleet-smoke.xml'))
        }
        Start-Sleep -Seconds 1
    }
    throw 'No current UI snapshot'
}
function Tap-Label([string]$Label) {
    $tree = Read-Ui
    $node = @($tree.SelectNodes('//node') | Where-Object { $_.text -eq $Label } | ForEach-Object {
        $_.SelectSingleNode('ancestor-or-self::node[@clickable="true"][1]')
    } | Where-Object { $_ }) | Select-Object -First 1
    if (!$node) { throw "Control not visible: $Label" }
    $numbers = [regex]::Matches($node.bounds, '\d+') | ForEach-Object { [int]$_.Value }
    $x = [int](($numbers[0] + $numbers[2]) / 2)
    $y = [int](($numbers[1] + $numbers[3]) / 2)
    Invoke-Adb @('shell','input','tap',"$x","$y") | Out-Null
    Start-Sleep -Milliseconds 700
}
function Capture([string]$Name) {
    $tree = Read-Ui
    if (!$tree.SelectSingleNode('//node[@package="com.fleetai.driver"]')) { throw 'Fleet AI not foreground' }
    Invoke-Adb @('shell','screencap','-p','/sdcard/fleet-smoke.png') | Out-Null
    Invoke-Adb @('pull','/sdcard/fleet-smoke.png',(Join-Path $OutputDirectory "$Name.png")) | Out-Null
    Write-Output "Captured $Name"
}

# Never use a customer's signed-in account for visual automation.
$initial = Read-Ui
if (!$initial.SelectSingleNode('//node[@text="Training Driver"]')) { throw 'Start on Home in the emulator training account only.' }
Capture 'home-landscape'
foreach ($label in @('Logbook','Inspect','Sensors','Updates')) {
    Tap-Label $label
    Capture $label.ToLower()
}
Tap-Label 'Home'
Tap-Label 'Fault codes'
$codes = Read-Ui
if (!$codes.SelectSingleNode('//node[@text="Read-only diagnostics. Codes cannot be erased from this app."]')) { throw 'Fault-code route did not open' }
if ($codes.SelectSingleNode('//node[@text="Clear"]')) { throw 'Code-erasure control is exposed' }
Capture 'fault-codes'
Tap-Label 'Home'
Tap-Label 'Settings'
Tap-Label 'Reset pairing'
$confirm = Read-Ui
if (!$confirm.SelectSingleNode('//node[@text="Keep connected"]')) { throw 'Missing pairing reset confirmation' }
Capture 'pairing-confirmation'
Tap-Label 'Keep connected'
Tap-Label 'Home'
$homeTree = Read-Ui
if (!$homeTree.SelectSingleNode('//node[@text="Training Driver"]')) { throw 'Cancelling reset lost session' }
Write-Output 'PASS: all primary routes, read-only diagnostics, reset cancellation.'
