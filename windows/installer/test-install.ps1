param([Parameter(Mandatory)][string]$Installer)
$ErrorActionPreference = 'Stop'
$Installer = (Resolve-Path $Installer).Path
$reportFolder = Join-Path (Split-Path $Installer) 'verification'
New-Item $reportFolder -ItemType Directory -Force | Out-Null
function RunMsi([string]$operation, [string]$log) {
    $process = Start-Process msiexec.exe -ArgumentList "$operation `"$Installer`" /qn /norestart /l*v `"$log`"" -Wait -PassThru
    if ($process.ExitCode -notin 0,3010) { throw "MSI operation $operation failed: $($process.ExitCode)" }
}
# Build disposable packages to exercise major upgrade and transaction rollback.
$wix = Join-Path (Split-Path $Installer) 'tools/wix.exe'
$manifest = Join-Path (Split-Path $Installer) 'Package-x64.wxs'
function BuildTestMsi([string]$version, [bool]$fail) {
    [xml]$document = Get-Content $manifest -Raw
    $document.Wix.Package.SetAttribute('Version', $version)
    $document.Wix.Package.MediaTemplate.SetAttribute('CompressionLevel', 'none')
    if ($fail) {
        $action = $document.CreateElement('CustomAction', 'http://wixtoolset.org/schemas/v4/wxs')
        $action.SetAttribute('Id', 'TestRollbackFailure'); $action.SetAttribute('Error', 'Intentional rollback validation failure')
        [void]$document.Wix.Package.AppendChild($action)
        $sequence = $document.CreateElement('InstallExecuteSequence', 'http://wixtoolset.org/schemas/v4/wxs')
        $custom = $document.CreateElement('Custom', 'http://wixtoolset.org/schemas/v4/wxs')
        $custom.SetAttribute('Action','TestRollbackFailure'); $custom.SetAttribute('Before','InstallFinalize'); $custom.SetAttribute('Condition','NOT REMOVE')
        [void]$sequence.AppendChild($custom); [void]$document.Wix.Package.AppendChild($sequence)
    }
    $source = Join-Path $env:RUNNER_TEMP "CurrentMusic-test-$version.wxs"
    $target = Join-Path $env:RUNNER_TEMP "CurrentMusic-test-$version.msi"
    $document.Save($source)
    & $wix build $source -arch x64 -culture zh-CN -ext WixToolset.UI.wixext -o $target | Out-Host
    if ($LASTEXITCODE -ne 0) { throw 'Disposable upgrade MSI generation failed' }
    return $target
}
$older = BuildTestMsi '0.9.0' $false
$rollback = BuildTestMsi '1.0.1' $true
$oldProcess = Start-Process msiexec.exe -ArgumentList "/i `"$older`" /qn /norestart /l*v `"$(Join-Path $reportFolder 'old-install.log')`"" -Wait -PassThru
if ($oldProcess.ExitCode -notin 0,3010) { throw 'Baseline installation failed' }
RunMsi '/i' (Join-Path $reportFolder 'install-upgrade.log')
$app = Join-Path $env:ProgramFiles 'CurrentMusic/CurrentMusic.Windows.exe'
if (-not (Test-Path $app)) { throw 'Installed executable missing' }
try {
    $smoke = Join-Path $reportFolder 'native-smoke.json'
    $process = Start-Process $app -ArgumentList "--smoke-test=`"$smoke`"" -PassThru
    if (-not $process.WaitForExit(90000)) { Stop-Process -Id $process.Id -Force; throw 'Native UI smoke test timed out' }
    if (-not (Test-Path $smoke)) {
        $crash = Join-Path $env:LOCALAPPDATA 'CurrentMusic/Windows/logs/last-crash.txt'
        if (Test-Path $crash) { Copy-Item $crash $reportFolder; Get-Content $crash }
        Get-WinEvent -FilterHashtable @{ LogName='Application'; StartTime=(Get-Date).AddMinutes(-10) } -ErrorAction SilentlyContinue | Select-Object TimeCreated,ProviderName,Id,Message | ConvertTo-Json -Depth 4 | Set-Content (Join-Path $reportFolder 'events.json')
        throw "Native application did not produce a report (exit $($process.ExitCode))"
    }
    $result = Get-Content $smoke -Raw | ConvertFrom-Json
    if (-not $result.success) { Get-Content $smoke; throw 'Native UI smoke test failed' }
    $result.checks | ForEach-Object { Write-Output "PASS $_" }
    $rollbackLog = Join-Path $reportFolder 'rollback.log'
    $failure = Start-Process msiexec.exe -ArgumentList "/i `"$rollback`" /qn /norestart /l*v `"$rollbackLog`"" -Wait -PassThru
    if ($failure.ExitCode -eq 0) { throw 'Intentional failure unexpectedly installed' }
    if (-not (Select-String -Path $rollbackLog -SimpleMatch 'Intentional rollback validation failure')) { throw 'Rollback test did not reach intentional failure' }
    $installed = Get-ItemProperty 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*' | Where-Object DisplayName -eq 'CurrentMusic for Windows'
    if (-not ($installed | Where-Object DisplayVersion -eq '1.0.0')) { throw 'Rollback did not restore version 1.0.0' }
    if (-not (Test-Path $app)) { throw 'Rollback lost installed application' }
    $downgradeLog = Join-Path $reportFolder 'downgrade-block.log'
    $downgrade = Start-Process msiexec.exe -ArgumentList "/i `"$older`" /qn /norestart /l*v `"$downgradeLog`"" -Wait -PassThru
    if ($downgrade.ExitCode -eq 0) { throw 'Downgrade unexpectedly allowed' }
    # Repair must preserve an executable installation.
    RunMsi '/fa' (Join-Path $reportFolder 'repair.log')
    if (-not (Test-Path $app)) { throw 'Repair removed executable' }
}
finally { RunMsi '/x' (Join-Path $reportFolder 'uninstall.log') }
if (Test-Path $app) { throw 'Uninstall left program executable behind' }
@{ success = $true; install = $true; upgrade = $true; rollback = $true; downgradeBlocked = $true; repair = $true; uninstall = $true; nativeUi = $true } | ConvertTo-Json | Set-Content (Join-Path $reportFolder 'installer-result.json')
