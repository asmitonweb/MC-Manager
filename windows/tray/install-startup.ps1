#requires -Version 5.1

$ErrorActionPreference = 'Stop'
$trayLauncher = Join-Path $PSScriptRoot 'start-tray.vbs'
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'

if (-not (Test-Path -LiteralPath $trayLauncher)) {
    throw "Tray launcher not found: $trayLauncher"
}

New-Item -Path $runKey -Force | Out-Null
Set-ItemProperty -Path $runKey -Name 'MCManagerTray' -Value ('wscript.exe "' + $trayLauncher + '"')
Write-Host 'MC Manager tray controller will start when this Windows user logs in.'
