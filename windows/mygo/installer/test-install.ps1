param(
    [Parameter(Mandatory)][string]$Installer,
    [Parameter(Mandatory)][string]$LegacyInstaller,
    [Parameter(Mandatory)][string]$Wix,
    [string]$WixUI = 'WixToolset.UI.wixext',
    [string]$Dotnet = 'dotnet',
    [switch]$Isolated
)
$ErrorActionPreference = 'Stop'
if (![Environment]::Is64BitProcess -or
    !([Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole(
        [Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Run the installation regression in elevated x64 PowerShell.'
}
$Installer = (Resolve-Path -LiteralPath $Installer).Path
$LegacyInstaller = (Resolve-Path -LiteralPath $LegacyInstaller).Path
$artifact = Split-Path -Parent $Installer
$id = [guid]::NewGuid()
$run = "$(Get-Date -Format yyyyMMdd-HHmmss)-$($id.ToString('N').Substring(0, 8))"
$report = (New-Item -ItemType Directory -Force -Path (Join-Path $artifact "verification/$run")).FullName
$wixTool = (Resolve-Path -LiteralPath $Wix).Path
$wixPrefix = @()
if ([IO.Path]::GetExtension($wixTool) -eq '.dll') {
    $wixPrefix = @($wixTool)
    $wixTool = $Dotnet
}

if (-not ('CurrentMusicInstallerCheck' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class CurrentMusicInstallerCheck {
    [DllImport("msi.dll", CharSet=CharSet.Unicode)]
    private static extern uint MsiOpenDatabase(string path, IntPtr mode, out uint db);
    [DllImport("msi.dll", CharSet=CharSet.Unicode)]
    private static extern uint MsiDatabaseOpenView(uint db, string sql, out uint view);
    [DllImport("msi.dll")]
    private static extern uint MsiViewExecute(uint view, uint record);
    [DllImport("msi.dll")]
    private static extern uint MsiViewFetch(uint view, out uint record);
    [DllImport("msi.dll")]
    private static extern uint MsiViewModify(uint view, int mode, uint record);
    [DllImport("msi.dll", CharSet=CharSet.Unicode)]
    private static extern uint MsiRecordSetString(uint record, uint field, string value);
    [DllImport("msi.dll")]
    private static extern uint MsiDatabaseCommit(uint db);
    [DllImport("msi.dll", CharSet=CharSet.Unicode)]
    private static extern uint MsiGetSummaryInformation(uint db, string path, uint updateCount, out uint summary);
    [DllImport("msi.dll", CharSet=CharSet.Unicode)]
    private static extern uint MsiSummaryInfoSetProperty(uint summary, uint property, uint type, int number, IntPtr time, string value);
    [DllImport("msi.dll")]
    private static extern uint MsiSummaryInfoPersist(uint summary);
    [DllImport("msi.dll", CharSet=CharSet.Unicode)]
    private static extern uint MsiRecordGetString(uint record, uint field, StringBuilder value, ref uint length);
    [DllImport("msi.dll")]
    private static extern uint MsiCloseHandle(uint handle);
    [DllImport("msi.dll", CharSet=CharSet.Unicode)]
    private static extern uint MsiEnumRelatedProducts(string upgradeCode, uint reserved, uint index, StringBuilder product);
    [DllImport("msi.dll", CharSet=CharSet.Unicode)]
    public static extern int MsiQueryProductState(string product);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)]
    private static extern IntPtr FindWindow(string cls, string title);
    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint process);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    private static extern IntPtr LoadLibraryEx(string path, IntPtr file, uint flags);
    [DllImport("kernel32.dll", ExactSpelling=true, SetLastError=true)]
    private static extern IntPtr GetProcAddress(IntPtr library, string name);
    [DllImport("kernel32.dll")]
    private static extern bool FreeLibrary(IntPtr library);

    private static void Check(uint code) {
        if (code != 0) throw new InvalidOperationException("Windows Installer API error " + code);
    }
    private static string Text(uint record, uint column) {
        var buffer = new StringBuilder(32768);
        uint capacity = (uint)buffer.Capacity;
        Check(MsiRecordGetString(record, column, buffer, ref capacity));
        return buffer.ToString();
    }
    public static Dictionary<string,string> Properties(string path) {
        Check(MsiOpenDatabase(path, IntPtr.Zero, out uint db));
        try {
            Check(MsiDatabaseOpenView(db, "SELECT `Property`, `Value` FROM `Property`", out uint view));
            try {
                Check(MsiViewExecute(view, 0));
                var result = new Dictionary<string,string>();
                while (true) {
                    uint code = MsiViewFetch(view, out uint record);
                    if (code == 259) return result;
                    Check(code);
                    try { result.Add(Text(record, 1), Text(record, 2)); }
                    finally { MsiCloseHandle(record); }
                }
            } finally { MsiCloseHandle(view); }
        } finally { MsiCloseHandle(db); }
    }
    private static string NewCode() {
        return Guid.NewGuid().ToString("B").ToUpperInvariant();
    }
    private static void Execute(uint db, string sql) {
        Check(MsiDatabaseOpenView(db, sql, out uint view));
        try { Check(MsiViewExecute(view, 0)); }
        finally { MsiCloseHandle(view); }
    }
    private static void RequireRow(uint db, string sql) {
        Check(MsiDatabaseOpenView(db, sql, out uint view));
        try {
            Check(MsiViewExecute(view, 0));
            Check(MsiViewFetch(view, out uint row));
            MsiCloseHandle(row);
        } finally { MsiCloseHandle(view); }
    }
    public static void IsolatePackage(string path, string originalFamily, string family, string product, string name, Dictionary<string,string> componentCodes) {
        // All replacements are generated identifiers and an ASCII test name.
        Check(MsiOpenDatabase(path, (IntPtr)1, out uint db));
        try {
            Execute(db, "UPDATE `Property` SET `Value`='" + product + "' WHERE `Property`='ProductCode'");
            Execute(db, "UPDATE `Property` SET `Value`='" + family + "' WHERE `Property`='UpgradeCode'");
            Execute(db, "UPDATE `Property` SET `Value`='" + name + "' WHERE `Property`='ProductName'");
            RequireRow(db, "SELECT `DefaultDir` FROM `Directory` WHERE `Directory`='INSTALLFOLDER'");
            RequireRow(db, "SELECT `Name` FROM `Shortcut` WHERE `Shortcut`='StartMenuShortcut'");
            Execute(db, "UPDATE `Directory` SET `DefaultDir`='" + name + "' WHERE `Directory`='INSTALLFOLDER'");
            Execute(db, "UPDATE `Shortcut` SET `Name`='" + name + "' WHERE `Shortcut`='StartMenuShortcut'");
            IsolateUpgrade(db, originalFamily, family);
            IsolateComponents(db, componentCodes);
            Check(MsiGetSummaryInformation(db, null, 1, out uint summary));
            try {
                // PID_REVNUMBER contains the package code and must differ from the source.
                Check(MsiSummaryInfoSetProperty(summary, 9, 30, 0, IntPtr.Zero, NewCode()));
                Check(MsiSummaryInfoPersist(summary));
            } finally { MsiCloseHandle(summary); }
            Check(MsiDatabaseCommit(db));
        } finally { MsiCloseHandle(db); }
    }
    private static void IsolateUpgrade(uint db, string originalFamily, string family) {
        const string columns = "`UpgradeCode`, `VersionMin`, `VersionMax`, `Language`, `Attributes`, `Remove`, `ActionProperty`";
        var rows = new List<uint>();
        try {
            Check(MsiDatabaseOpenView(db, "SELECT " + columns + " FROM `Upgrade`", out uint view));
            try {
                Check(MsiViewExecute(view, 0));
                while (true) {
                    uint code = MsiViewFetch(view, out uint row);
                    if (code == 259) break;
                    Check(code);
                    rows.Add(row);
                    if (Text(row, 1) != originalFamily) throw new InvalidOperationException("Unexpected Upgrade table family.");
                }
            } finally { MsiCloseHandle(view); }

            // UpgradeCode is a primary-key column, so replace the rows.
            if (rows.Count == 0) throw new InvalidOperationException("Missing Upgrade table rules.");
            Execute(db, "DELETE FROM `Upgrade`");
            foreach (uint row in rows) {
                Check(MsiRecordSetString(row, 1, family));
                Check(MsiDatabaseOpenView(db, "INSERT INTO `Upgrade` (" + columns + ") VALUES (?, ?, ?, ?, ?, ?, ?)", out view));
                try { Check(MsiViewExecute(view, row)); }
                finally { MsiCloseHandle(view); }
            }
        } finally {
            foreach (uint row in rows) MsiCloseHandle(row);
        }
    }
    private static void IsolateComponents(uint db, Dictionary<string,string> componentCodes) {
        Check(MsiDatabaseOpenView(db, "SELECT `Component`, `ComponentId` FROM `Component`", out uint view));
        try {
            Check(MsiViewExecute(view, 0));
            while (true) {
                uint code = MsiViewFetch(view, out uint row);
                if (code == 259) return;
                Check(code);
                try {
                    string original = Text(row, 2);
                    if (original == "") continue;
                    if (!componentCodes.TryGetValue(original, out string isolated)) {
                        isolated = NewCode();
                        componentCodes.Add(original, isolated);
                    }
                    Check(MsiRecordSetString(row, 2, isolated));
                    Check(MsiViewModify(view, 2, row)); // UPDATE
                } finally { MsiCloseHandle(row); }
            }
        } finally { MsiCloseHandle(view); }
    }
    public static List<string> RelatedProducts(string upgradeCode) {
        var result = new List<string>();
        var product = new StringBuilder(39);
        for (uint index = 0; ; ++index) {
            uint code = MsiEnumRelatedProducts(upgradeCode, 0, index, product);
            if (code == 259) return result;
            Check(code);
            result.Add(product.ToString());
        }
    }
    public static uint MainWindowProcess() {
        IntPtr hwnd = FindWindow("MyGoWindow", "CurrentMusic 2.0");
        if (hwnd == IntPtr.Zero) return 0;
        GetWindowThreadProcessId(hwnd, out uint process);
        return process;
    }
    public static void VerifyBridge(string path, string[] exports) {
        // Search the installed DLL directory and System32 only.
        IntPtr library = LoadLibraryEx(path, IntPtr.Zero, 0x900);
        if (library == IntPtr.Zero) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        try {
            foreach (string name in exports) {
                if (GetProcAddress(library, name) == IntPtr.Zero) throw new MissingMethodException(name);
            }
        } finally { FreeLibrary(library); }
    }
}
'@
}

$current = [CurrentMusicInstallerCheck]::Properties($Installer)
$legacy = [CurrentMusicInstallerCheck]::Properties($LegacyInstaller)
$family = '{A967FC74-EA94-4561-B552-89C2A50FF194}'
if ($current['UpgradeCode'] -ne $family -or $legacy['UpgradeCode'] -ne $family -or
    [version]$legacy['ProductVersion'] -ge [version]$current['ProductVersion']) {
    throw 'Supply an older CurrentMusic MSI in the same upgrade family.'
}
$originalFamily = $family
$testName = 'CurrentMusic'
$running = Get-Process CurrentMusic,CurrentMusic.Windows -ErrorAction SilentlyContinue
if ($Isolated) {
    $family = $id.ToString('B').ToUpperInvariant()
    $testName = "CurrentMusic MSI QA $($id.ToString('N').Substring(0, 12))"
}
$existing = [CurrentMusicInstallerCheck]::RelatedProducts($family)
$installed = Join-Path $env:ProgramFiles $testName
$shortcut = Join-Path ([Environment]::GetFolderPath('CommonPrograms')) "$testName.lnk"
if ($existing.Count -gt 0 -or (Test-Path -LiteralPath $installed) -or (Test-Path -LiteralPath $shortcut) -or
    (!$Isolated -and $running)) {
    throw 'Use a test machine with no CurrentMusic installation, running client, or CurrentMusic Start menu shortcut.'
}

$payloadNames = @('CurrentMusic.exe','CurrentMusic.Media.dll','LICENSE.txt','THIRD-PARTY-NOTICES.txt')
$stage = (Resolve-Path -LiteralPath (Join-Path $artifact ('obj/' + [IO.Path]::GetFileNameWithoutExtension($Installer) + '/payload'))).Path
$rollbackPayload = (New-Item -ItemType Directory -Force -Path (Join-Path $report 'obj/rollback-payload')).FullName
foreach ($name in $payloadNames) { Copy-Item -LiteralPath (Join-Path $stage $name) -Destination $rollbackPayload -Force }
Add-Content -LiteralPath (Join-Path $rollbackPayload 'THIRD-PARTY-NOTICES.txt') -Value 'Rollback fixture marker'
$currentVersion = [version]$current['ProductVersion']
$rollbackVersion = [version]::new($currentVersion.Major, $currentVersion.Minor, $currentVersion.Build + 1)
$rollbackProduct = [guid]::NewGuid()
$rollbackMsi = Join-Path $report 'obj/rollback-fixture.msi'
$rollbackSource = Join-Path $report 'obj/rollback-fixture.wxs'
$namespace = 'http://wixtoolset.org/schemas/v4/wxs'
$doc = [xml](Get-Content -LiteralPath (Join-Path $PSScriptRoot 'Package.wxs') -Raw)
$action = $doc.CreateElement('CustomAction', $namespace)
$action.SetAttribute('Id', 'TestRollbackFailure')
$action.SetAttribute('Error', 'Intentional CurrentMusic transaction rollback test')
[void]$doc.Wix.Package.AppendChild($action)
$failureProperty = $doc.CreateElement('Property', $namespace)
$failureProperty.SetAttribute('Id', 'CURRENTMUSIC_TEST_ROLLBACK')
$failureProperty.SetAttribute('Secure', 'yes')
[void]$doc.Wix.Package.AppendChild($failureProperty)
$sequence = $doc.CreateElement('InstallExecuteSequence', $namespace)
$execute = $doc.CreateElement('InstallExecute', $namespace)
$execute.SetAttribute('After', 'PublishProduct')
[void]$sequence.AppendChild($execute)
$custom = $doc.CreateElement('Custom', $namespace)
$custom.SetAttribute('Action', 'TestRollbackFailure')
$custom.SetAttribute('After', 'InstallExecute')
$custom.SetAttribute('Condition', 'NOT REMOVE AND CURRENTMUSIC_TEST_ROLLBACK = 1')
[void]$sequence.AppendChild($custom)
[void]$doc.Wix.Package.AppendChild($sequence)
$doc.Save($rollbackSource)
$icon = (Resolve-Path (Join-Path $PSScriptRoot '../../CurrentMusic.Windows/Assets/CurrentMusic.ico')).Path
$notice = Join-Path $PSScriptRoot 'Notice.rtf'
& $wixTool @wixPrefix build $rollbackSource -arch x64 -culture zh-CN -ext $WixUI `
    -d "PayloadDir=$rollbackPayload" -d "ProductVersion=$rollbackVersion" -d "ProductCode=$rollbackProduct" `
    -d "ProjectIcon=$icon" -d "SetupNotice=$notice" -o $rollbackMsi
if ($LASTEXITCODE -ne 0) { throw 'Failed to build rollback fixture.' }

function Copy-IsolatedPackage([string]$Source, [string]$Label) {
    $target = Join-Path $report "obj/isolated-$Label.msi"
    Copy-Item -LiteralPath $Source -Destination $target -Force
    $product = [guid]::NewGuid().ToString('B').ToUpperInvariant()
    [CurrentMusicInstallerCheck]::IsolatePackage($target, $originalFamily, $family, $product, $testName, $componentCodes)
    $properties = [CurrentMusicInstallerCheck]::Properties($target)
    if ($properties['ProductCode'] -ne $product -or $properties['UpgradeCode'] -ne $family) {
        throw 'Failed to isolate the test package identity.'
    }
    return @{ Path = $target; Product = $product }
}

function Run-Msi([string]$Operation, [string]$Target, [string]$Log, [int]$Expected = 0, [switch]$InjectFailure) {
    $logPath = Join-Path $report "$Log.log"
    $arguments = "$Operation `"$Target`" /qn /norestart /l*v `"$logPath`""
    if ($InjectFailure) { $arguments += ' CURRENTMUSIC_TEST_ROLLBACK=1' }
    $process = Start-Process (Join-Path $env:SystemRoot 'System32/msiexec.exe') -WindowStyle Hidden -PassThru -Wait `
        -ArgumentList $arguments
    if ($process.ExitCode -ne $Expected) { throw "$Log exited $($process.ExitCode), expected $Expected. See $logPath." }
}

function Assert-Installed([string]$Product) {
    $related = [CurrentMusicInstallerCheck]::RelatedProducts($family)
    if ($related.Count -ne 1 -or $related[0] -ne $Product -or [CurrentMusicInstallerCheck]::MsiQueryProductState($Product) -ne 5) {
        throw "Unexpected installed product state for $Product."
    }
}

function Assert-Payload {
    foreach ($name in $payloadNames) {
        $expected = Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $stage $name)
        $actual = Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $installed $name)
        if ($actual.Hash -ne $expected.Hash) { throw "Installed payload differs: $name" }
    }
    $installedFiles = @(Get-ChildItem -LiteralPath $installed -Recurse -File)
    if ($installedFiles.Count -ne $payloadNames.Count) { throw 'Unexpected files remain under the install directory.' }
    if (!(Test-Path -LiteralPath $shortcut)) { throw 'Start menu shortcut is missing.' }
}

function Assert-NativeStartup {
    $profile = (New-Item -ItemType Directory -Force -Path (Join-Path $report 'obj/smoke-profile')).FullName
    $app = Join-Path $installed 'CurrentMusic.exe'
    $bridge = Join-Path $installed 'CurrentMusic.Media.dll'
    $process = Start-Process -FilePath $app -WorkingDirectory $installed -WindowStyle Hidden -PassThru `
        -Environment @{ LOCALAPPDATA = $profile; APPDATA = $profile }
    try {
        $until = (Get-Date).AddSeconds(20)
        while (!$process.HasExited -and (Get-Date) -lt $until) {
            $process.Refresh()
            if ([CurrentMusicInstallerCheck]::MainWindowProcess() -eq $process.Id -and $process.Modules.FileName -contains $bridge) { return }
            Start-Sleep -Milliseconds 200
        }
        throw 'Installed application did not create its native window and load the installed media DLL.'
    } finally {
        if (!$process.HasExited) {
            Stop-Process -Id $process.Id
            $process.WaitForExit()
        }
        $process.Dispose()
    }
}

$checks = [ordered]@{
    isolatedPackageCopies = $Isolated.IsPresent
    legacyVersion = $legacy['ProductVersion']
    legacySha256 = (Get-FileHash -LiteralPath $LegacyInstaller -Algorithm SHA256).Hash.ToLowerInvariant()
    version = $current['ProductVersion']
    msiSha256 = (Get-FileHash -LiteralPath $Installer -Algorithm SHA256).Hash.ToLowerInvariant()
}
$currentPackage = @{ Path = $Installer; Product = $current['ProductCode'] }
$legacyPackage = @{ Path = $LegacyInstaller; Product = $legacy['ProductCode'] }
$failingPackage = @{ Path = $rollbackMsi; Product = $rollbackProduct.ToString('B') }
if ($Isolated) {
    $componentCodes = [Collections.Generic.Dictionary[string,string]]::new([StringComparer]::OrdinalIgnoreCase)
    $currentPackage = Copy-IsolatedPackage $Installer 'current'
    $legacyPackage = Copy-IsolatedPackage $LegacyInstaller 'legacy'
    $failingPackage = Copy-IsolatedPackage $rollbackMsi 'rollback'
}
$bridgeExports = @('create','destroy','open','play','pause','seek','volume','close','poll') |
    ForEach-Object { "cm_media_$_" }

try {
    Run-Msi '/i' $currentPackage.Path 'clean-install'
    Assert-Installed $currentPackage.Product
    Assert-Payload
    [CurrentMusicInstallerCheck]::VerifyBridge((Join-Path $installed 'CurrentMusic.Media.dll'), $bridgeExports)
    $checks.installedBridgeLoads = $true
    if (!$running) { Assert-NativeStartup }
    $checks.cleanInstall = $true
    $checks.nativeStartup = if ($running) { 'skipped: existing client owns single instance' } else { 'passed' }
    Run-Msi '/x' $currentPackage.Product 'clean-uninstall'

    Run-Msi '/i' $legacyPackage.Path 'legacy-install'
    Assert-Installed $legacyPackage.Product
    if (!(Test-Path -LiteralPath (Join-Path $installed 'CurrentMusic.Windows.exe'))) { throw 'Legacy program file is missing.' }
    Run-Msi '/i' $currentPackage.Path 'major-upgrade'
    Assert-Installed $currentPackage.Product
    Assert-Payload
    if (Test-Path -LiteralPath (Join-Path $installed 'CurrentMusic.Windows.exe')) { throw 'Legacy executable survived the upgrade.' }
    $checks.legacyUpgrade = $true

    Run-Msi '/i' $failingPackage.Path 'rollback' 1603 -InjectFailure
    $rollbackLog = Join-Path $report 'rollback.log'
    $failure = Select-String -LiteralPath $rollbackLog -SimpleMatch 'Intentional CurrentMusic transaction rollback test' | Select-Object -First 1
    $copy = Select-String -LiteralPath $rollbackLog -Pattern 'Executing op: FileCopy\(SourceName=[^,]*THIRD-PARTY-NOTICES\.txt,.*DestName=THIRD-PARTY-NOTICES\.txt,' | Select-Object -First 1
    if (!$failure -or !$copy -or $copy.LineNumber -ge $failure.LineNumber) {
        throw 'The injected failure did not follow replacement of the installed notices file.'
    }
    Assert-Installed $currentPackage.Product
    Assert-Payload
    $checks.rollback = $true

    Run-Msi '/i' $legacyPackage.Path 'downgrade-block' 1603
    if (!(Select-String -LiteralPath (Join-Path $report 'downgrade-block.log') -SimpleMatch 'A newer version of CurrentMusic is already installed')) {
        throw 'The legacy installer did not reach its downgrade block.'
    }
    Assert-Installed $currentPackage.Product
    Assert-Payload
    $checks.legacyDowngradeBlocked = $true

    $bridge = Join-Path $installed 'CurrentMusic.Media.dll'
    Move-Item -LiteralPath $bridge -Destination (Join-Path $report 'obj/damaged-install.Media.dll') -Force
    Run-Msi '/fa' $currentPackage.Path 'repair'
    Assert-Payload
    [CurrentMusicInstallerCheck]::VerifyBridge($bridge, $bridgeExports)
    if (!$running) { Assert-NativeStartup }
    $checks.repair = $true

    Run-Msi '/i' $failingPackage.Path 'install-newer'
    Assert-Installed $failingPackage.Product
    Run-Msi '/i' $currentPackage.Path 'mygo-downgrade-block' 1603
    if (!(Select-String -LiteralPath (Join-Path $report 'mygo-downgrade-block.log') -SimpleMatch '已安装更新版本的 CurrentMusic。')) {
        throw 'The MyGo installer did not reach its downgrade block.'
    }
    Assert-Installed $failingPackage.Product
    $checks.mygoDowngradeBlocked = $true
} finally {
    foreach ($product in @($currentPackage.Product, $legacyPackage.Product, $failingPackage.Product)) {
        if ([CurrentMusicInstallerCheck]::MsiQueryProductState($product) -eq 5) {
            Run-Msi '/x' $product "uninstall-$($product.Trim('{}'))"
        }
    }
}
if ([CurrentMusicInstallerCheck]::RelatedProducts($family).Count -gt 0 -or
    (Test-Path -LiteralPath $shortcut) -or (Test-Path -LiteralPath $installed)) {
    throw 'Uninstall left an installed product, directory, or shortcut.'
}
$checks.uninstall = $true
$checks.success = $true
$checks | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $report 'installer-result.json') -Encoding utf8
Write-Host "Installation report: $report"
$checks | ConvertTo-Json
