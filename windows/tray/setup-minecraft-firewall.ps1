#requires -RunAsAdministrator

# Lets Tailscale devices (100.64.0.0/10) reach the Minecraft server port.
# The rule is tied to the server's java.exe so Windows does not prompt for (or
# silently create a block rule for) that program on first launch.
[CmdletBinding()]
param(
    [string]$JavaPath = 'C:\Program Files\Eclipse Adoptium\jdk-25.0.4.101-hotspot\bin\java.exe',
    [int]$Port = 25565,
    [int]$RconPort = 25575
)

$ErrorActionPreference = 'Stop'
$ruleName = 'MC-PC-Sandbox-Minecraft-Tailscale'

if (-not (Test-Path -LiteralPath $JavaPath)) { throw "Java not found: $JavaPath" }

Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue | Remove-NetFirewallRule
New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Action Allow -Protocol TCP -LocalPort $Port `
    -RemoteAddress '100.64.0.0/10' -Program $JavaPath -Profile Any | Out-Null

Write-Host "TCP $Port is allowed for $JavaPath from the Tailscale address range only."

# RCON is for the manager on 127.0.0.1 only. Block rules override any broader
# allow rule, and loopback traffic is not filtered, so the manager keeps working.
$rconRule = 'MC-PC-Sandbox-Minecraft-RCON-Block'
Get-NetFirewallRule -DisplayName $rconRule -ErrorAction SilentlyContinue | Remove-NetFirewallRule
New-NetFirewallRule -DisplayName $rconRule -Direction Inbound -Action Block -Protocol TCP -LocalPort $RconPort -Profile Any | Out-Null
Write-Host "TCP $RconPort (RCON) is blocked for all remote hosts."
