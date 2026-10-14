#requires -RunAsAdministrator

$ErrorActionPreference = 'Stop'
$ruleName = 'MC-PC-Sandbox-Manager-Tailscale'

& netsh.exe advfirewall firewall show rule name=$ruleName 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) {
    & netsh.exe advfirewall firewall add rule `
        name=$ruleName `
        dir=in `
        action=allow `
        protocol=TCP `
        localport=3000 `
        remoteip=100.64.0.0/10 `
        profile=any | Out-Host

    if ($LASTEXITCODE -ne 0) {
        throw 'Unable to create the Tailscale-only manager firewall rule.'
    }
}

Write-Host 'TCP 3000 is allowed from the Tailscale address range only.'
