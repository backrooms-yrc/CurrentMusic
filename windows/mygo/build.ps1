param(
    [string]$Output,
    [switch]$UIOnly
)
$ErrorActionPreference = 'Stop'

if ((go env GOVERSION) -ne 'go1.27.3') { throw 'Go 1.27.3 is required.' }
if (!$UIOnly -and ($env:VSCMD_ARG_TGT_ARCH -ne 'x64' -or ([string]$env:WindowsSDKVersion).TrimEnd('\') -ne '10.0.26100.0')) {
    throw 'Run from an x64 Visual Studio developer shell with Windows SDK 10.0.26100.0 selected.'
}
if (!$Output) {
    $Output = if ($UIOnly) { Join-Path $PSScriptRoot '../artifacts/mygo-ui' }
              else { Join-Path $PSScriptRoot '../artifacts/mygo-preview' }
}
New-Item -ItemType Directory -Force -Path $Output | Out-Null
$Output = (Resolve-Path $Output).Path
$env:GOOS = 'windows'
$env:GOARCH = 'amd64'
$env:CGO_ENABLED = '0'
$env:GOTOOLCHAIN = 'local'

Push-Location $PSScriptRoot
try {
    go test -mod=readonly ./...
    if ($LASTEXITCODE -ne 0) { throw 'Go tests failed.' }
    go build -mod=readonly -trimpath -ldflags '-H windowsgui' -o (Join-Path $Output 'CurrentMusic.exe') .
    if ($LASTEXITCODE -ne 0) { throw 'Go application build failed.' }
    if ($UIOnly) { return }
    $sdk = Join-Path $env:WindowsSdkDir 'Include/10.0.26100.0/cppwinrt'
    $bridge = Join-Path $PSScriptRoot 'media/bridge.cpp'
    Push-Location $Output
    try {
        cl.exe /nologo /std:c++20 /EHsc /permissive- /O2 /MT /LD "/I$sdk" $bridge /link WindowsApp.lib /OUT:CurrentMusic.Media.dll
        if ($LASTEXITCODE -ne 0) { throw 'C++/WinRT media bridge build failed.' }
    } finally {
        Pop-Location
    }
} finally {
    Pop-Location
}
