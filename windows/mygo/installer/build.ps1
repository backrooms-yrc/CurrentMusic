param(
    [Parameter(Mandatory)][string]$Payload,
    [Parameter(Mandatory)][string]$Wix,
    [string]$WixUI = 'WixToolset.UI.wixext',
    [string]$Dotnet = 'dotnet',
    [string]$Output = (Join-Path $PSScriptRoot '../../artifacts/mygo-stage5'),
    [ValidatePattern('^(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,4})\z')][string]$Version = '2.0.0',
    [string]$SignTool,
    [ValidatePattern('^[0-9A-Fa-f]{40}\z')][string]$CertificateThumbprint,
    [switch]$MachineCertificateStore,
    [uri]$TimestampUrl,
    [switch]$TestSign
)
$ErrorActionPreference = 'Stop'
$versionParts = [version]$Version
if ($versionParts.Major -gt 255 -or $versionParts.Minor -gt 255 -or $versionParts.Build -gt 65535) {
    throw 'MSI version fields must be within 255.255.65535.'
}
if ($TestSign -and ($CertificateThumbprint -or $MachineCertificateStore -or $TimestampUrl)) {
    throw 'Test signing uses a temporary certificate in the current-user store.'
}
if ($CertificateThumbprint -and (!$TimestampUrl -or $TimestampUrl.Scheme -ne 'https')) {
    throw 'Release signing requires an HTTPS RFC 3161 timestamp URL.'
}
if (($TestSign -or $CertificateThumbprint) -and !$SignTool) { throw 'Specify the Windows SDK SignTool path.' }

$Payload = (Resolve-Path -LiteralPath $Payload).Path
$Output = (New-Item -ItemType Directory -Force -Path $Output).FullName
$wixTool = (Resolve-Path -LiteralPath $Wix).Path
$wixPrefix = @()
if ([IO.Path]::GetExtension($wixTool) -eq '.dll') {
    $wixPrefix = @($wixTool)
    $wixTool = $Dotnet
}
$wixVersion = & $wixTool @wixPrefix --version
if ($LASTEXITCODE -ne 0 -or $wixVersion -notmatch '^4\.0\.6(\+|$)') { throw 'WiX 4.0.6 is required.' }

$windows = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$project = Split-Path -Parent $windows
$flavor = if ($TestSign) { '-test-signed' } elseif (!$CertificateThumbprint) { '-unsigned' } else { '' }
$name = "CurrentMusic-Windows-$Version-x64$flavor"
$stage = (New-Item -ItemType Directory -Force -Path (Join-Path $Output "obj/$name/payload")).FullName
$files = @('CurrentMusic.exe', 'CurrentMusic.Media.dll')
foreach ($file in $files) {
    $source = Join-Path $Payload $file
    $reader = [IO.BinaryReader]::new([IO.File]::OpenRead($source))
    try {
        if ($reader.ReadUInt16() -ne 0x5a4d) { throw "$file is not a PE file." }
        $reader.BaseStream.Position = 0x3c
        $reader.BaseStream.Position = $reader.ReadUInt32()
        if ($reader.ReadUInt32() -ne 0x4550 -or $reader.ReadUInt16() -ne 0x8664) { throw "$file must be x64." }
    } finally { $reader.Dispose() }
    Copy-Item -LiteralPath $source -Destination (Join-Path $stage $file) -Force
}
Copy-Item -LiteralPath (Join-Path $project 'LICENSE') -Destination (Join-Path $stage 'LICENSE.txt') -Force

$modules = & go -C (Join-Path $windows 'mygo') list -mod=readonly -deps -f '{{with .Module}}{{if not .Main}}{{.Path}}|{{.Version}}|{{.Dir}}{{end}}{{end}}' .
if ($LASTEXITCODE -ne 0) { throw 'Failed to enumerate runtime modules.' }
$goRoot = & go env GOROOT
if ($LASTEXITCODE -ne 0) { throw 'Failed to locate Go runtime notices.' }
$modules = @("Go runtime|$(go env GOVERSION)|$goRoot") + @($modules | Where-Object { $_ } | Sort-Object -Unique)
$notices = foreach ($module in $modules) {
    $moduleName, $moduleVersion, $moduleDir = $module -split '\|', 3
    $licenseFiles = @(Get-ChildItem -LiteralPath $moduleDir -File | Where-Object Name -Match '^(LICENSE|NOTICE|PATENTS|COPYING)(\.|$)')
    if (!$licenseFiles) { throw "Missing license for $moduleName." }
    if ($moduleName -eq 'github.com/oneo-me/onevra/source') {
        $licenseFiles += Get-Item -LiteralPath (Join-Path $moduleDir 'components/LICENSE.mygo'), (Join-Path $moduleDir 'icons/lucide/LICENSE')
    }
    foreach ($license in $licenseFiles) {
        "$moduleName $moduleVersion · $([IO.Path]::GetRelativePath($moduleDir, $license.FullName))"
        Get-Content -LiteralPath $license.FullName -Raw
        ''
    }
}
$notices | Set-Content -LiteralPath (Join-Path $stage 'THIRD-PARTY-NOTICES.txt') -Encoding utf8

$work = Split-Path -Parent $stage
$msi = Join-Path $work "$name.msi"
$log = Join-Path $work "$name-signature.txt"
$productBytes = [Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes("CurrentMusic/Windows/MyGo/x64/$Version"))
$product = [guid]::new([byte[]]$productBytes[0..15])
$tempCertificate = $null

function Sign-PayloadFile([string]$Path) {
    $signArgs = @('sign', '/fd', 'SHA256', '/s', 'My', '/sha1', $CertificateThumbprint)
    if ($MachineCertificateStore) { $signArgs += '/sm' }
    if ($TimestampUrl) { $signArgs += @('/tr', $TimestampUrl.AbsoluteUri, '/td', 'SHA256') }
    & $SignTool @signArgs $Path | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "SignTool failed for $(Split-Path -Leaf $Path)." }
    $signature = Get-AuthenticodeSignature -LiteralPath $Path
    if ($signature.SignerCertificate.Thumbprint -ne $CertificateThumbprint) { throw 'The expected embedded signer is missing.' }
    "$(Split-Path -Leaf $Path): $($signature.Status) · $($signature.StatusMessage)" | Add-Content -LiteralPath $log -Encoding utf8
    if ($TestSign) {
        if ($signature.Status -notin @('UnknownError', 'NotTrusted') -or $signature.StatusMessage -notmatch '0x800B0109|trust|信任') {
            throw "Unexpected test-signature status: $($signature.StatusMessage)"
        }
        return
    }
    & $SignTool verify /pa /all /tw $Path | Out-Host
    if ($LASTEXITCODE -ne 0 -or $signature.Status -ne 'Valid' -or !$signature.TimeStamperCertificate) {
        throw "Trusted timestamped signature verification failed for $(Split-Path -Leaf $Path)."
    }
}

try {
    if ($TestSign) {
        $tempCertificate = New-SelfSignedCertificate -Type CodeSigningCert -Subject 'CN=CurrentMusic Windows MSI Local QA' `
            -CertStoreLocation Cert:\CurrentUser\My -KeyExportPolicy NonExportable -NotAfter (Get-Date).AddDays(7)
        $CertificateThumbprint = $tempCertificate.Thumbprint
    }
    if ($CertificateThumbprint) {
        'Authenticode signature verification' | Set-Content -LiteralPath $log -Encoding utf8
        foreach ($file in $files) { Sign-PayloadFile (Join-Path $stage $file) }
    }
    $manifest = Join-Path $PSScriptRoot 'Package.wxs'
    $icon = Join-Path $windows 'CurrentMusic.Windows/Assets/CurrentMusic.ico'
    $notice = Join-Path $PSScriptRoot 'Notice.rtf'
    & $wixTool @wixPrefix build $manifest -arch x64 -culture zh-CN -ext $WixUI `
        -d "PayloadDir=$stage" -d "ProductVersion=$Version" -d "ProductCode=$product" `
        -d "ProjectIcon=$icon" -d "SetupNotice=$notice" -o $msi
    if ($LASTEXITCODE -ne 0) { throw 'WiX build failed.' }
    if ($CertificateThumbprint) { Sign-PayloadFile $msi }
    $digest = (Get-FileHash -LiteralPath $msi -Algorithm SHA256).Hash.ToLowerInvariant()
    "$digest  $(Split-Path -Leaf $msi)" | Set-Content -LiteralPath "$msi.sha256" -Encoding ascii
    if ($CertificateThumbprint) { Move-Item -LiteralPath $log -Destination $Output -Force }
    Move-Item -LiteralPath $msi -Destination $Output -Force
    Move-Item -LiteralPath "$msi.sha256" -Destination $Output -Force
    Write-Output (Join-Path $Output "$name.msi")
} finally {
    if ($tempCertificate) {
        Remove-Item -LiteralPath "Cert:\CurrentUser\My\$($tempCertificate.Thumbprint)" -DeleteKey
    }
}
