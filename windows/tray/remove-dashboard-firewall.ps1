#requires -RunAsAdministrator

$ruleName = 'MC-PC-Sandbox-Manager-Tailscale'
& netsh.exe advfirewall firewall delete rule name=$ruleName | Out-Host
Write-Host 'MC Manager dashboard firewall rule removed.'
