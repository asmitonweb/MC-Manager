#requires -Version 5.1

[CmdletBinding()]
param(
    [string]$Source,
    [string]$Destination
)

$ErrorActionPreference = 'Stop'

if (-not $Source) { $Source = Join-Path $PSScriptRoot '..\mc-manager\client\public\favicon.png' }
if (-not $Destination) { $Destination = Join-Path $PSScriptRoot 'mc-manager.ico' }

if (-not (Test-Path -LiteralPath $Source)) {
    throw "Logo source was not found: $Source"
}

$png = [System.IO.File]::ReadAllBytes((Resolve-Path -LiteralPath $Source).Path)
if ($png.Length -lt 8 -or $png[0] -ne 137 -or $png[1] -ne 80 -or $png[2] -ne 78 -or $png[3] -ne 71) {
    throw 'The logo source is not a PNG file.'
}

# ICO files may contain PNG image data. This keeps the existing project logo
# intact while making it available to the Windows NotifyIcon API.
$stream = New-Object System.IO.MemoryStream
$writer = New-Object System.IO.BinaryWriter($stream)
try {
    $writer.Write([uint16]0)       # Reserved
    $writer.Write([uint16]1)       # Icon type
    $writer.Write([uint16]1)       # Image count
    $writer.Write([byte]0)         # Width: 0 means 256px
    $writer.Write([byte]0)         # Height: 0 means 256px
    $writer.Write([byte]0)         # Color count
    $writer.Write([byte]0)         # Reserved
    $writer.Write([uint16]1)       # Color planes
    $writer.Write([uint16]32)      # Bits per pixel
    $writer.Write([uint32]$png.Length)
    $writer.Write([uint32]22)      # Header (6) + directory entry (16)
    $writer.Write($png)
    $writer.Flush()
    [System.IO.File]::WriteAllBytes((Join-Path (Resolve-Path -LiteralPath (Split-Path -Parent $Destination)).Path (Split-Path -Leaf $Destination)), $stream.ToArray())
} finally {
    $writer.Dispose()
    $stream.Dispose()
}

Write-Host "Created $Destination"
