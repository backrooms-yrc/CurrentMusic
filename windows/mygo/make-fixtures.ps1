param(
    [string]$FFmpeg = 'ffmpeg',
    [string]$Output = (Join-Path $PSScriptRoot '../artifacts/mygo-fixtures')
)
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force -Path $Output | Out-Null
$Output = (Resolve-Path $Output).Path

# Continuous phase with a distinct pitch in each 15-second quarter.
$signal = 'aevalsrc=0.12*sin(2*PI*(440*t+220*max(0\,t-15)+220*max(0\,t-30)+220*max(0\,t-45))):s=96000:d=60'

function Write-Fixture([string]$Name, [string[]]$Encoding) {
    & $FFmpeg -hide_banner -loglevel error -nostdin -y -f lavfi -i $signal -ac 2 @Encoding (Join-Path $Output $Name)
    if ($LASTEXITCODE -ne 0) { throw "FFmpeg failed to write $Name." }
}

Write-Fixture 'range-44100.mp3' @('-ar', '44100', '-c:a', 'libmp3lame', '-b:a', '128k')
Write-Fixture 'range-44100.flac' @('-ar', '44100', '-c:a', 'flac', '-sample_fmt', 's16')
Write-Fixture 'range-96000-24bit.flac' @('-ar', '96000', '-c:a', 'flac', '-sample_fmt', 's32', '-bits_per_raw_sample', '24')
Write-Fixture 'range-48000.m4a' @('-ar', '48000', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart')
