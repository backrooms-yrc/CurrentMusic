param([ValidateSet('x64','arm64')][string]$Architecture = 'x64', [string]$Version = '1.0.0')
$ErrorActionPreference = 'Stop'
$publish = Join-Path $PSScriptRoot "../artifacts/win-$Architecture"
$output = Join-Path $PSScriptRoot '../artifacts/installers'
New-Item $output -ItemType Directory -Force | Out-Null
New-Item (Join-Path $publish 'Assets') -ItemType Directory -Force | Out-Null
Copy-Item (Join-Path $PSScriptRoot '../CurrentMusic.Windows/Assets/CurrentMusic.ico') (Join-Path $publish 'Assets/CurrentMusic.ico') -Force
$licenses = Join-Path $publish 'Licenses'
New-Item $licenses -ItemType Directory -Force | Out-Null
foreach ($packageName in @('microsoft.windowsappsdk', "microsoft.netcore.app.runtime.win-$Architecture")) {
    $cache = Join-Path $env:USERPROFILE ".nuget/packages/$packageName"
    if (Test-Path $cache) {
        $license = Get-ChildItem $cache -Recurse -File | Where-Object Name -Match '^LICENSE(\.TXT)?$' | Select-Object -First 1
        if ($license) { Copy-Item $license.FullName (Join-Path $licenses "$packageName.txt") -Force }
    }
}
# App-local CRT: MSI must start on a clean PC without a separate VC++ install.
$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
$visualStudio = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $visualStudio) { throw 'Visual C++ redistributable files not found' }
$redistRoot = Join-Path $visualStudio 'VC/Redist/MSVC'
$crt = Get-ChildItem $redistRoot -Directory | Sort-Object Name -Descending | ForEach-Object {
    Get-ChildItem (Join-Path $_.FullName $Architecture) -Directory -Filter 'Microsoft.VC*.CRT' -ErrorAction SilentlyContinue
} | Select-Object -First 1
if (-not $crt) { throw "Missing app-local CRT for $Architecture" }
Copy-Item (Join-Path $crt.FullName '*.dll') $publish -Force
$redistNotice = Join-Path $visualStudio 'VC/Auxiliary/Build/Microsoft.VCToolsVersion.default.txt'
@"
CurrentMusic $Version ($Architecture)
Includes Microsoft .NET, Windows App SDK, Windows SDK runtime files and Visual C++ redistributable CRT.
Third-party components retain their upstream licenses. Microsoft runtime redistribution terms: https://visualstudio.microsoft.com/license-terms/
Microsoft .NET: https://github.com/dotnet/runtime/blob/main/LICENSE.TXT
Windows App SDK: https://github.com/microsoft/WindowsAppSDK/blob/main/LICENSE
"@ | Set-Content (Join-Path $publish 'THIRD-PARTY-NOTICES.txt') -Encoding utf8
python (Join-Path $PSScriptRoot 'generate.py') $publish (Join-Path $output "Package-$Architecture.wxs") --version $Version --architecture $Architecture
if ($LASTEXITCODE -ne 0) { throw 'MSI manifest generation failed' }
dotnet tool install wix --version 4.0.6 --tool-path (Join-Path $output 'tools')
if ($LASTEXITCODE -ne 0) { throw 'WiX installation failed' }
$wix = Join-Path $output 'tools/wix.exe'
& $wix extension add WixToolset.UI.wixext/4.0.6
if ($LASTEXITCODE -ne 0) { throw 'WiX UI extension installation failed' }
$msi = Join-Path $output "CurrentMusic-For-Windows-$Version-$Architecture.msi"
& $wix build (Join-Path $output "Package-$Architecture.wxs") -arch $Architecture -culture zh-CN -ext WixToolset.UI.wixext -o $msi
if ($LASTEXITCODE -ne 0) { throw 'MSI build failed' }
(Get-FileHash $msi -Algorithm SHA256).Hash.ToLowerInvariant() + '  ' + (Split-Path $msi -Leaf) | Set-Content "$msi.sha256" -Encoding ascii
Write-Output $msi
