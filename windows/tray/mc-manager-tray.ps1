#requires -Version 5.1

[CmdletBinding()]
param(
    [switch]$StartManagerAtLaunch
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
    $script:TrayMutex.Dispose()
    exit 0
}

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

    $icon = switch ($State) {
        'RUNNING' { [System.Drawing.SystemIcons]::Information; break }
        'STARTING' { [System.Drawing.SystemIcons]::Warning; break }
        'STOPPING' { [System.Drawing.SystemIcons]::Warning; break }
        'ERROR' { [System.Drawing.SystemIcons]::Error; break }
        default { [System.Drawing.SystemIcons]::Application; break }
    }

    $script:NotifyIcon.Icon = $icon
    $tooltip = if ($Detail) { "MC Manager: $State - $Detail" } else { "MC Manager: $State" }
    $script:NotifyIcon.Text = $tooltip.Substring(0, [Math]::Min($tooltip.Length, 63))
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
    $processState = Get-ManagerProcessState
    if ($processState -eq 'STOPPED') {
        Set-TrayIconState 'STOPPED'
        return
    }

    $health = Get-ManagerHealth
    if ($health -and $health.ok) {
        Set-TrayIconState 'RUNNING' "Minecraft $($health.minecraft)"
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
        $startInfo.RedirectStandardOutput = $true
        $startInfo.RedirectStandardError = $true

        $process = New-Object System.Diagnostics.Process
        $process.StartInfo = $startInfo
        $process.EnableRaisingEvents = $true
        $process.add_OutputDataReceived({
            param($sender, $eventArgs)
            if ($eventArgs.Data) {
                Add-Content -LiteralPath $managerLog -Value "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] $($eventArgs.Data)"
            }
        })
        $process.add_ErrorDataReceived({
            param($sender, $eventArgs)
            if ($eventArgs.Data) {
                Add-Content -LiteralPath $managerLog -Value "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] ERROR $($eventArgs.Data)"
            }
        })
        $process.add_Exited({
            Write-TrayLog "Manager process exited with code $($sender.ExitCode)."
        })

        [void]$process.Start()
        $process.BeginOutputReadLine()
        $process.BeginErrorReadLine()
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
    New-Object System.Drawing.Icon($script:IconPath)
} else {
    [System.Drawing.SystemIcons]::Application
}
$script:NotifyIcon.Text = 'MC Manager: STOPPED'

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
