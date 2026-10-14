#requires -Version 5.1

[CmdletBinding()]
param(
    [switch]$StartManagerAtLaunch,
    # Opens the dashboard once the manager is healthy (used by the desktop shortcut).
    [switch]$OpenDashboard
)

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$script:TrayMutex = New-Object System.Threading.Mutex($false, 'Local\MCManagerTray')
$mutexAcquired = $false
try {
    $mutexAcquired = $script:TrayMutex.WaitOne(0, $false)
} catch [System.Threading.AbandonedMutexException] {
    $mutexAcquired = $true
}
if (-not $mutexAcquired) {
    # Already running: ask that tray to start the manager (if stopped) and open the dashboard.
    if ($StartManagerAtLaunch -or $OpenDashboard) {
        try {
            $wake = [System.Threading.EventWaitHandle]::OpenExisting('Local\MCManagerTrayWake')
            [void]$wake.Set()
            $wake.Dispose()
        } catch {
            Start-Process 'http://127.0.0.1:3000'
        }
    }
    $script:TrayMutex.Dispose()
    exit 0
}
$script:WakeEvent = New-Object System.Threading.EventWaitHandle($false, [System.Threading.EventResetMode]::AutoReset, 'Local\MCManagerTrayWake')
$script:OpenWhenHealthy = [bool]$OpenDashboard

$script:SandboxRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$script:ManagerRoot = Join-Path $script:SandboxRoot 'mc-manager'
$script:LogRoot = Join-Path $script:SandboxRoot 'logs'
$script:ManagerUrl = 'http://127.0.0.1:3000'
$script:IconPath = Join-Path $PSScriptRoot 'mc-manager.ico'
$script:NodePath = $null
$script:ManagerProcess = $null
$script:NotifyIcon = $null
$script:StatusTimer = $null
$script:LastState = ''
$script:StopRequested = $false

function Write-TrayLog {
    param([string]$Message)

    New-Item -ItemType Directory -Path $script:LogRoot -Force | Out-Null
    $logPath = Join-Path $script:LogRoot 'manager-tray.log'
    Add-Content -LiteralPath $logPath -Value "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] $Message"
}

function Get-EnvValue {
    param([string]$Name)

    $envPath = Join-Path $script:ManagerRoot '.env'
    if (-not (Test-Path -LiteralPath $envPath)) { return '' }

    $line = Get-Content -LiteralPath $envPath | Where-Object {
        $_ -match "^\s*$([regex]::Escape($Name))\s*="
    } | Select-Object -First 1

    if (-not $line) { return '' }
    $value = ($line -split '=', 2)[1].Trim()
    if ($value.Length -ge 2 -and (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'")))) {
        $value = $value.Substring(1, $value.Length - 2)
    }
    return $value
}

function Set-TrayIconState {
    param(
        [string]$State,
        [string]$Detail = ''
    )

    if (-not $script:NotifyIcon) { return }

    # The creeper icon stays constant; state is shown in the tooltip.
    $label = (Get-Culture).TextInfo.ToTitleCase($State.ToLowerInvariant())
    $tooltip = if ($Detail) { "MC Manager - $label - $Detail" } else { "MC Manager - $label" }
    $script:NotifyIcon.Text = $tooltip.Substring(0, [Math]::Min($tooltip.Length, 63))

    if ($State -eq 'STOPPED' -and ($script:LastState -eq 'RUNNING' -or $script:LastState -eq 'STARTING') -and -not $script:StopRequested) {
        Show-TrayNotice 'MC Manager' 'The manager stopped unexpectedly. Check logs\manager.log.' ([System.Windows.Forms.ToolTipIcon]::Error)
    }
    if ($State -eq 'STOPPED') { $script:StopRequested = $false }
    $script:LastState = $State
}

function Show-TrayNotice {
    param(
        [string]$Title,
        [string]$Message,
        [System.Windows.Forms.ToolTipIcon]$Icon = [System.Windows.Forms.ToolTipIcon]::Info
    )

    if ($script:NotifyIcon) {
        $script:NotifyIcon.ShowBalloonTip(5000, $Title, $Message, $Icon)
    }
}

function Get-ManagerProcessState {
    if (-not $script:ManagerProcess) {
        $existing = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
            Where-Object { $_.CommandLine -like "*$(Join-Path $script:ManagerRoot 'server.js')*" } |
            Select-Object -First 1

        if ($existing) {
            try {
                $script:ManagerProcess = Get-Process -Id $existing.ProcessId -ErrorAction Stop
                Write-TrayLog "Attached to existing manager process $($existing.ProcessId)."
            } catch {
                return 'STOPPED'
            }
        }
    }

    if (-not $script:ManagerProcess) { return 'STOPPED' }

    try {
        if ($script:ManagerProcess.HasExited) {
            if ($script:LastState -eq 'RUNNING' -or $script:LastState -eq 'STARTING') {
                Write-TrayLog "Manager exited with code $($script:ManagerProcess.ExitCode)."
            }
            $script:ManagerProcess = $null
            return 'STOPPED'
        }
        return 'RUNNING'
    } catch {
        return 'STOPPED'
    }
}

function Get-ManagerHealth {
    try {
        return Invoke-RestMethod -Uri "$script:ManagerUrl/api/health" -Method Get -TimeoutSec 1
    } catch {
        return $null
    }
}

function Update-TrayStatus {
    if ($script:WakeEvent.WaitOne(0)) {
        $script:OpenWhenHealthy = $true
        if ((Get-ManagerProcessState) -eq 'STOPPED') { Start-Manager }
    }
    $processState = Get-ManagerProcessState
    if ($processState -eq 'STOPPED') {
        Set-TrayIconState 'STOPPED'
        return
    }

    $health = Get-ManagerHealth
    if ($health -and $health.ok) {
        Set-TrayIconState 'RUNNING' "Minecraft $($health.minecraft)"
        if ($script:OpenWhenHealthy) {
            $script:OpenWhenHealthy = $false
            Open-Manager
        }
    } else {
        Set-TrayIconState 'STARTING'
    }
}

function Start-Manager {
    if ((Get-ManagerProcessState) -eq 'RUNNING') {
        Show-TrayNotice 'MC Manager' 'The manager is already running.'
        return
    }

    $serverScript = Join-Path $script:ManagerRoot 'server.js'
    $envPath = Join-Path $script:ManagerRoot '.env'
    if (-not (Test-Path -LiteralPath $serverScript)) {
        Show-TrayNotice 'MC Manager' "Missing manager entry point: $serverScript" ([System.Windows.Forms.ToolTipIcon]::Error)
        return
    }
    if (-not (Test-Path -LiteralPath $envPath)) {
        Show-TrayNotice 'MC Manager' 'Create mc-manager\.env from .env.example before starting.' ([System.Windows.Forms.ToolTipIcon]::Warning)
        return
    }

    $script:NodePath = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
    if (-not $script:NodePath) {
        Show-TrayNotice 'MC Manager' 'node.exe was not found on PATH.' ([System.Windows.Forms.ToolTipIcon]::Error)
        return
    }

    try {
        New-Item -ItemType Directory -Path $script:LogRoot -Force | Out-Null
        $managerLog = Join-Path $script:LogRoot 'manager.log'
        Write-TrayLog "Starting manager with $script:NodePath."

        $startInfo = New-Object System.Diagnostics.ProcessStartInfo
        $startInfo.FileName = $script:NodePath
        $startInfo.Arguments = '"' + $serverScript + '"'
        $startInfo.WorkingDirectory = $script:ManagerRoot
        $startInfo.UseShellExecute = $false
        $startInfo.CreateNoWindow = $true
        $startInfo.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
        # The manager writes its own log (PowerShell event handlers run on
        # background threads without a runspace and silently drop output).
        $startInfo.EnvironmentVariables['MANAGER_LOG_FILE'] = $managerLog

        $process = New-Object System.Diagnostics.Process
        $process.StartInfo = $startInfo
        [void]$process.Start()
        $script:ManagerProcess = $process
        Set-TrayIconState 'STARTING'
        Show-TrayNotice 'MC Manager' 'Manager startup requested.'
    } catch {
        Write-TrayLog "Manager start failed: $($_.Exception.Message)"
        Set-TrayIconState 'ERROR'
        Show-TrayNotice 'MC Manager' $_.Exception.Message ([System.Windows.Forms.ToolTipIcon]::Error)
    }
}

function Stop-Manager {
    $processState = Get-ManagerProcessState
    if ($processState -eq 'STOPPED') {
        Set-TrayIconState 'STOPPED'
        return
    }

    $script:StopRequested = $true
    Set-TrayIconState 'STOPPING'
    $token = Get-EnvValue 'SUPERVISOR_TOKEN'
    $shutdownRequested = $false

    if ($token) {
        try {
            Invoke-RestMethod `
                -Uri "$script:ManagerUrl/api/supervisor/shutdown" `
                -Method Post `
                -Headers @{ 'x-manager-supervisor-token' = $token } `
                -TimeoutSec 3 | Out-Null
            $shutdownRequested = $true
            Write-TrayLog 'Requested graceful manager shutdown.'
        } catch {
            Write-TrayLog "Graceful shutdown request failed: $($_.Exception.Message)"
        }
    }

    $deadline = (Get-Date).AddSeconds(12)
    while ($script:ManagerProcess -and -not $script:ManagerProcess.HasExited -and (Get-Date) -lt $deadline) {
        [System.Windows.Forms.Application]::DoEvents()
        Start-Sleep -Milliseconds 200
    }

    if ($script:ManagerProcess -and -not $script:ManagerProcess.HasExited) {
        Write-TrayLog 'Using taskkill fallback for the manager process tree.'
        & taskkill.exe /PID $script:ManagerProcess.Id /T /F | Out-Null
    }

    $script:ManagerProcess = $null
    Set-TrayIconState 'STOPPED'
    if (-not $shutdownRequested) {
        Show-TrayNotice 'MC Manager' 'Manager process stopped.'
    }
}

function Restart-Manager {
    Stop-Manager
    Start-Sleep -Milliseconds 500
    Start-Manager
}

function Open-Manager {
    Start-Process $script:ManagerUrl
}

function Exit-Tray {
    if ((Get-ManagerProcessState) -eq 'RUNNING') {
        $choice = [System.Windows.Forms.MessageBox]::Show(
            'The manager is still running. Stop it before exiting the tray controller?',
            'MC Manager',
            [System.Windows.Forms.MessageBoxButtons]::YesNoCancel,
            [System.Windows.Forms.MessageBoxIcon]::Question
        )

        if ($choice -eq [System.Windows.Forms.DialogResult]::Cancel) { return }
        if ($choice -eq [System.Windows.Forms.DialogResult]::Yes) { Stop-Manager }
    }

    $script:StatusTimer.Stop()
    $script:NotifyIcon.Visible = $false
    $script:NotifyIcon.Dispose()
    $script:TrayMutex.ReleaseMutex()
    $script:TrayMutex.Dispose()
    [System.Windows.Forms.Application]::ExitThread()
}

$script:NotifyIcon = New-Object System.Windows.Forms.NotifyIcon
$script:NotifyIcon.Visible = $true
$script:NotifyIcon.Icon = if (Test-Path -LiteralPath $script:IconPath) {
    # Pick the frame that matches the tray size at the current DPI.
    New-Object System.Drawing.Icon($script:IconPath, [System.Windows.Forms.SystemInformation]::SmallIconSize)
} else {
    [System.Drawing.SystemIcons]::Application
}
$script:NotifyIcon.Text = 'MC Manager - Stopped'

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$startItem = $menu.Items.Add('Start Manager')
$startItem.add_Click({ Start-Manager })
$stopItem = $menu.Items.Add('Stop Manager')
$stopItem.add_Click({ Stop-Manager })
$restartItem = $menu.Items.Add('Restart Manager')
$restartItem.add_Click({ Restart-Manager })
$menu.Items.Add('-') | Out-Null
$openItem = $menu.Items.Add('Open Dashboard')
$openItem.add_Click({ Open-Manager })
$menu.Items.Add('-') | Out-Null
$exitItem = $menu.Items.Add('Exit Tray Controller')
$exitItem.add_Click({ Exit-Tray })
$script:NotifyIcon.ContextMenuStrip = $menu
$script:NotifyIcon.add_DoubleClick({ Open-Manager })

$script:StatusTimer = New-Object System.Windows.Forms.Timer
$script:StatusTimer.Interval = 2000
$script:StatusTimer.add_Tick({ Update-TrayStatus })
$script:StatusTimer.Start()
Update-TrayStatus

if ($StartManagerAtLaunch) {
    Start-Sleep -Seconds 1
    Start-Manager
}

Write-TrayLog 'Tray controller started.'
[System.Windows.Forms.Application]::Run()
