#requires -Version 5.1

# Invoked over SSH by windows/deploy-to-mc-pc.sh. Runs on the Minecraft PC.
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('Stop', 'Build', 'Start')]
    [string]$Action,
    [switch]$SkipClientInstall
)

$ErrorActionPreference = 'Stop'
$sandboxRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$managerRoot = Join-Path $sandboxRoot 'mc-manager'
$managerUrl = 'http://127.0.0.1:3000'
$taskName = 'MCManagerTrayRelaunch'

function Get-EnvValue {
    param([string]$Name)

    $envPath = Join-Path $managerRoot '.env'
    if (-not (Test-Path -LiteralPath $envPath)) { return '' }
    $line = Get-Content -LiteralPath $envPath | Where-Object { $_ -match "^\s*$([regex]::Escape($Name))\s*=" } | Select-Object -First 1
    if (-not $line) { return '' }
    return ($line -split '=', 2)[1].Trim().Trim('"').Trim("'")
}

function Get-ManagerProcesses {
    $serverScript = Join-Path $managerRoot 'server.js'
    Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -like "*$serverScript*" }
}

function Get-TrayProcesses {
    Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -like '*mc-manager-tray.ps1*' }
}

function Stop-All {
    $token = Get-EnvValue 'SUPERVISOR_TOKEN'
    if ((Get-ManagerProcesses) -and $token) {
        try {
            Invoke-RestMethod -Uri "$managerUrl/api/supervisor/shutdown" -Method Post `
                -Headers @{ 'x-manager-supervisor-token' = $token } -TimeoutSec 5 | Out-Null
            Write-Host 'Requested graceful manager shutdown.'
        } catch {
            Write-Host "Graceful shutdown request failed: $($_.Exception.Message)"
        }
    }

    $deadline = (Get-Date).AddSeconds(25)
    while ((Get-ManagerProcesses) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 500 }

    foreach ($proc in @(Get-ManagerProcesses)) {
        Write-Host "Force-stopping manager process $($proc.ProcessId)."
        & taskkill.exe /PID $proc.ProcessId /T /F | Out-Null
    }

    foreach ($proc in @(Get-TrayProcesses)) {
        Write-Host "Stopping tray controller $($proc.ProcessId)."
        Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
    }
    Write-Host 'Manager and tray stopped.'
}

function Invoke-Npm {
    param([string]$WorkingDirectory, [string[]]$Arguments)

    Push-Location -LiteralPath $WorkingDirectory
    try {
        & npm.cmd @Arguments
        if ($LASTEXITCODE -ne 0) { throw "npm $($Arguments -join ' ') failed in $WorkingDirectory" }
    } finally {
        Pop-Location
    }
}

function Build-Manager {
    Invoke-Npm $managerRoot @('ci', '--omit=dev', '--no-audit', '--no-fund')
    $clientRoot = Join-Path $managerRoot 'client'
    if (-not $SkipClientInstall -or -not (Test-Path -LiteralPath (Join-Path $clientRoot 'node_modules'))) {
        Invoke-Npm $clientRoot @('ci', '--no-audit', '--no-fund')
    }
    Invoke-Npm $clientRoot @('run', 'build')
    Write-Host 'Build complete.'
}

function Start-Tray {
    # Processes started from an SSH session stay in that session. An interactive
    # scheduled task runs in the logged-on user's desktop session instead, so
    # the tray icon is visible and survives the SSH disconnect.
    $launcher = Join-Path $PSScriptRoot 'start-tray.vbs'
    $taskAction = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument ('"' + $launcher + '" -StartManagerAtLaunch')
    $principal = New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
    Register-ScheduledTask -TaskName $taskName -Action $taskAction -Principal $principal -Force | Out-Null
    Start-ScheduledTask -TaskName $taskName

    $deadline = (Get-Date).AddSeconds(60)
    while ((Get-Date) -lt $deadline) {
        try {
            $health = Invoke-RestMethod -Uri "$managerUrl/api/health" -TimeoutSec 2
            if ($health.ok) {
                Write-Host "Manager healthy. Minecraft: $($health.minecraft)"
                return
            }
        } catch {}
        Start-Sleep -Seconds 1
    }
    throw 'Manager did not become healthy within 60 seconds. Check logs\manager.log.'
}

switch ($Action) {
    'Stop' { Stop-All }
    'Build' { Build-Manager }
    'Start' { Start-Tray }
}
