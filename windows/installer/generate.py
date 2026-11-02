"""Generate a deterministic WiX 4 file/component tree from the publish folder only."""
from pathlib import Path
import argparse
import uuid
import xml.etree.ElementTree as ET

NS = 'http://wixtoolset.org/schemas/v4/wxs'
UI = 'http://wixtoolset.org/schemas/v4/wxs/ui'
ET.register_namespace('', NS)
ET.register_namespace('ui', UI)

def element(parent, tag, **attributes):
    return ET.SubElement(parent, '{' + NS + '}' + tag, attributes)

def generate(source, destination, version, architecture):
    source = source.resolve()
    root = ET.Element('{' + NS + '}Wix')
    package = element(root, 'Package', Name='CurrentMusic for Windows', Manufacturer='CurrentMusic',
                      Version=version, UpgradeCode='A967FC74-EA94-4561-B552-89C2A50FF194',
                      Language='2052', Codepage='936', Scope='perMachine', InstallerVersion='500')
    element(package, 'MajorUpgrade', DowngradeErrorMessage='A newer version of CurrentMusic is already installed.', Schedule='afterInstallInitialize')
    element(package, 'MediaTemplate', EmbedCab='yes', CompressionLevel='high')
    element(package, 'Property', Id='ARPURLINFOABOUT', Value='https://music.20110208.xyz')
    element(package, 'Icon', Id='AppIcon', SourceFile=str(source / 'Assets' / 'CurrentMusic.ico'))
    element(package, 'Property', Id='ARPPRODUCTICON', Value='AppIcon')
    build = element(package, 'Property', Id='WINDOWSBUILD')
    element(build, 'RegistrySearch', Id='BuildNumber', Root='HKLM', Key=r'SOFTWARE\Microsoft\Windows NT\CurrentVersion', Name='CurrentBuildNumber', Type='raw', Bitness='always64')
    element(package, 'Launch', Condition='Installed OR WINDOWSBUILD >= 19041', Message='CurrentMusic requires Windows 10 version 2004 (build 19041) or newer.')
    program = element(package, 'StandardDirectory', Id='ProgramFiles64Folder')
    folder = element(program, 'Directory', Id='INSTALLFOLDER', Name='CurrentMusic')
    element(package, 'StandardDirectory', Id='ProgramMenuFolder')
    feature = element(package, 'Feature', Id='MainFeature', Title='CurrentMusic', Level='1')
    directories = {Path('.'): folder}
    files = sorted(p for p in source.rglob('*') if p.is_file() and p.suffix.lower() not in ('.pdb', '.msi', '.wixpdb'))
    if not (source / 'CurrentMusic.Windows.exe').is_file():
        raise RuntimeError('Published executable missing')
    if not (source / 'CurrentMusic.Windows.pri').is_file():
        raise RuntimeError('Published XAML resource index missing')
    for path in files:
        relative = path.relative_to(source)
        parent = Path('.')
        for part in relative.parts[:-1]:
            child = parent / part
            if child not in directories:
                directories[child] = element(directories[parent], 'Directory', Id='D' + uuid.uuid5(uuid.NAMESPACE_URL, child.as_posix()).hex, Name=part)
            parent = child
        key = uuid.uuid5(uuid.NAMESPACE_URL, 'currentmusic/windows/' + relative.as_posix())
        component = element(directories[parent], 'Component', Id='C' + key.hex, Guid=str(key), Bitness='always64')
        file = element(component, 'File', Id='F' + key.hex, Source=str(path), KeyPath='yes')
        if relative.as_posix() == 'CurrentMusic.Windows.exe':
            element(file, 'Shortcut', Id='StartMenuShortcut', Directory='ProgramMenuFolder', Name='CurrentMusic',
                    WorkingDirectory='INSTALLFOLDER', Advertise='yes', Icon='AppIcon')
        element(feature, 'ComponentRef', Id='C' + key.hex)
    ET.SubElement(package, '{' + UI + '}WixUI', {'Id': 'WixUI_Minimal'})
    element(package, 'WixVariable', Id='WixUILicenseRtf', Value=str(Path(__file__).with_name('Notice.rtf').resolve()))
    ET.indent(root)
    ET.ElementTree(root).write(destination, encoding='utf-8', xml_declaration=True)
    print(f'Installer manifest: {len(files)} files, {architecture}, {version}')

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('source', type=Path)
    parser.add_argument('destination', type=Path)
    parser.add_argument('--version', default='1.0.0')
    parser.add_argument('--architecture', choices=['x64', 'arm64'], default='x64')
    args = parser.parse_args()
    generate(args.source, args.destination, args.version, args.architecture)
