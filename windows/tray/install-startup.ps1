#requires -Version 5.1
# Starts MC Manager when this Windows user logs in, and adds a one-click
# "MC Manager" shortcut to the Desktop and Start Menu.
#
#   install-startup.ps1              # logon start + shortcuts
#   install-startup.ps1 -NoLogon     # shortcuts only

[CmdletBinding()]
param([switch]$NoLogon)

$ErrorActionPreference = 'Stop'
$trayLauncher = Join-Path $PSScriptRoot 'start-tray.vbs'
$icon = Join-Path $PSScriptRoot 'mc-manager.ico'
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'

if (-not (Test-Path -LiteralPath $trayLauncher)) {
    throw "Tray launcher not found: $trayLauncher"
}

if (-not $NoLogon) {
    New-Item -Path $runKey -Force | Out-Null
    Set-ItemProperty -Path $runKey -Name 'MCManagerTray' -Value ('wscript.exe "' + $trayLauncher + '" -StartManagerAtLaunch')
    Write-Host 'MC Manager (tray and manager) will start when this Windows user logs in.'
}

$shell = New-Object -ComObject WScript.Shell
$places = @(
    [Environment]::GetFolderPath('Desktop'),
    (Join-Path ([Environment]::GetFolderPath('Programs')) '')
)
foreach ($dir in $places) {
    $link = $shell.CreateShortcut((Join-Path $dir 'MC Manager.lnk'))
    $link.TargetPath = 'wscript.exe'
    $link.Arguments = '"' + $trayLauncher + '" -StartManagerAtLaunch -OpenDashboard'
    $link.WorkingDirectory = $PSScriptRoot
    if (Test-Path -LiteralPath $icon) { $link.IconLocation = "$icon,0" }
    $link.Description = 'Start MC Manager and open the dashboard'
    $link.Save()
}
Write-Host 'Added the "MC Manager" shortcut to the Desktop and Start Menu.'
