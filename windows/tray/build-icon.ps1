#requires -Version 5.1

# Draws the creeper tray icon as pixel art and writes a multi-size .ico
# (32-bit DIB frames at 16/24/32/48/256; .NET Framework cannot read PNG frames)
# plus a 256px PNG preview.
[CmdletBinding()]
param(
    [string]$Destination,
    [string]$PreviewPng,
    [string]$FaviconPng
)

$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $Destination) { $Destination = Join-Path $scriptDir 'mc-manager.ico' }
if (-not $PreviewPng) { $PreviewPng = Join-Path $scriptDir 'assets\creeper-256.png' }
Add-Type -AssemblyName System.Drawing

# 8x8 creeper face: G = green skin, D = dark face.
$face = @(
    'GGGGGGGG',
    'GGGGGGGG',
    'GDDGGDDG',
    'GDDGGDDG',
    'GGGDDGGG',
    'GGDDDDGG',
    'GGDDDDGG',
    'GGDGGDGG'
)
# Fixed "noise" so the skin looks like the in-game texture, the same on every build.
$greens = @(
    [System.Drawing.Color]::FromArgb(255, 94, 186, 82),
    [System.Drawing.Color]::FromArgb(255, 76, 160, 66),
    [System.Drawing.Color]::FromArgb(255, 112, 204, 96),
    [System.Drawing.Color]::FromArgb(255, 64, 140, 58)
)
$shade = @(
    @(0, 2, 1, 0, 3, 0, 2, 1),
    @(1, 0, 3, 2, 0, 1, 0, 2),
    @(2, 0, 0, 1, 2, 0, 0, 3),
    @(0, 0, 0, 3, 0, 0, 0, 1),
    @(3, 1, 2, 0, 0, 2, 1, 0),
    @(0, 2, 0, 0, 0, 0, 3, 2),
    @(1, 3, 0, 0, 0, 0, 1, 0),
    @(2, 0, 0, 1, 3, 0, 2, 1)
)
$dark = [System.Drawing.Color]::FromArgb(255, 24, 28, 24)

function New-CreeperBitmap {
    param([int]$Size)

    $bitmap = New-Object System.Drawing.Bitmap($Size, $Size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    for ($y = 0; $y -lt $Size; $y++) {
        $row = [Math]::Min(7, [Math]::Floor($y * 8 / $Size))
        for ($x = 0; $x -lt $Size; $x++) {
            $col = [Math]::Min(7, [Math]::Floor($x * 8 / $Size))
            $color = if ($face[$row][$col] -eq 'D') { $dark } else { $greens[$shade[$row][$col]] }
            $bitmap.SetPixel($x, $y, $color)
        }
    }
    return $bitmap
}

# Icon DIB: BITMAPINFOHEADER (height doubled), bottom-up BGRA pixels, then a 1-bit AND mask.
function Get-DibBytes {
    param([System.Drawing.Bitmap]$Bitmap)

    $size = $Bitmap.Width
    $stream = New-Object System.IO.MemoryStream
    $writer = New-Object System.IO.BinaryWriter($stream)
    try {
        $maskRowBytes = [int]([Math]::Ceiling($size / 32.0) * 4)
        $writer.Write([uint32]40)
        $writer.Write([int32]$size)
        $writer.Write([int32]($size * 2))
        $writer.Write([uint16]1)
        $writer.Write([uint16]32)
        $writer.Write([uint32]0)
        $writer.Write([uint32]($size * $size * 4 + $maskRowBytes * $size))
        $writer.Write([int32]0)
        $writer.Write([int32]0)
        $writer.Write([uint32]0)
        $writer.Write([uint32]0)
        for ($y = $size - 1; $y -ge 0; $y--) {
            for ($x = 0; $x -lt $size; $x++) {
                $pixel = $Bitmap.GetPixel($x, $y)
                $writer.Write([byte]$pixel.B)
                $writer.Write([byte]$pixel.G)
                $writer.Write([byte]$pixel.R)
                $writer.Write([byte]$pixel.A)
            }
        }
        # Fully opaque: an all-zero AND mask.
        $writer.Write((New-Object byte[] ($maskRowBytes * $size)))
        $writer.Flush()
        return ,$stream.ToArray()
    } finally {
        $writer.Dispose()
        $stream.Dispose()
    }
}

$sizes = @(16, 24, 32, 48, 256)
$frames = foreach ($size in $sizes) {
    $bitmap = New-CreeperBitmap $size
    try {
        if ($size -eq 256) {
            $preview = Split-Path -Parent $PreviewPng
            if ($preview) { New-Item -ItemType Directory -Path $preview -Force | Out-Null }
            $bitmap.Save($PreviewPng, [System.Drawing.Imaging.ImageFormat]::Png)
        }
        if ($size -eq 32 -and $FaviconPng) { $bitmap.Save($FaviconPng, [System.Drawing.Imaging.ImageFormat]::Png) }
        [pscustomobject]@{ Size = $size; Bytes = [byte[]](Get-DibBytes $bitmap) }
    } finally {
        $bitmap.Dispose()
    }
}

$stream = New-Object System.IO.MemoryStream
$writer = New-Object System.IO.BinaryWriter($stream)
try {
    $writer.Write([uint16]0)
    $writer.Write([uint16]1)
    $writer.Write([uint16]$frames.Count)
    $offset = 6 + 16 * $frames.Count
    foreach ($frame in $frames) {
        $dimension = if ($frame.Size -ge 256) { 0 } else { $frame.Size }
        $writer.Write([byte]$dimension)
        $writer.Write([byte]$dimension)
        $writer.Write([byte]0)
        $writer.Write([byte]0)
        $writer.Write([uint16]1)
        $writer.Write([uint16]32)
        $writer.Write([uint32]$frame.Bytes.Length)
        $writer.Write([uint32]$offset)
        $offset += $frame.Bytes.Length
    }
    foreach ($frame in $frames) { $writer.Write($frame.Bytes) }
    $writer.Flush()
    [System.IO.File]::WriteAllBytes($Destination, $stream.ToArray())
} finally {
    $writer.Dispose()
    $stream.Dispose()
}

# Make sure the tray sizes load (.NET Framework never selects 256px frames; Explorer does).
foreach ($size in ($sizes | Where-Object { $_ -le 48 })) {
    $icon = New-Object System.Drawing.Icon($Destination, $size, $size)
    if ($icon.Width -ne $size) { throw "Frame $size did not load correctly (got $($icon.Width))." }
    $icon.Dispose()
}
Write-Host "Created $Destination with sizes $($sizes -join ', ')"
