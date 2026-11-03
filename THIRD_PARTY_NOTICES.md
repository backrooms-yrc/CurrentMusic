# Third-party notices

## LDDC (optional, separate installation)

- Project: https://github.com/chenmozhijin/LDDC
- Copyright: Copyright (C) 2024-2025 沉默の金 <cmzj@cmzj.org>
- License: **GPL-3.0-only**
- Version/commit used by `deploy/install-lddc.sh`: `84631e8cd011fcc3f71ca0ae017e2c9758958ffc` (v0.9.2)
- Installation location: `/opt/lddc/src` (separate git checkout; not part of this repository)
- Runtime: `/opt/lddc/venv` (separate virtualenv; dependencies listed in `deploy/lddc-requirements.txt`)

CurrentMusic does not copy or link LDDC source code. `tools/lddc_bridge.py`
starts a loopback-only HTTP service in the LDDC virtualenv; `backend/cm_lddc.py`
consumes its JSON over `127.0.0.1`. LDDC can be stopped or removed at any time and
the backend falls back to its own lyric timing.

If you redistribute a system image or bundle that includes LDDC, you must comply
with GPL-3.0-only for LDDC and provide the corresponding source. CurrentMusic's own source code is licensed under MIT;
that license does not replace LDDC's license.

The headless compatibility shim under `tools/lddc_headless/` contains no LDDC code;
it only provides a few empty `PySide6.QtCore` types so LDDC's non-GUI modules can
be imported without installing the Qt GUI stack.
## API documentation site

- Docusaurus 3.10.2 / Classic theme (MIT), https://github.com/facebook/docusaurus.
  Source in `api-docs/`, fixed npm dependencies, license in `api-docs/licenses/docusaurus-MIT.txt`.
- @easyops-cn/docusaurus-search-local 0.55.3 (MIT),
  https://github.com/easyops-cn/docusaurus-search-local, local search indexes only.
  License in `api-docs/licenses/search-local-MIT.txt`.

- Docsify 4.13.1 (MIT), https://github.com/docsifyjs/docsify. Local JS/CSS/search assets
  under `api-docs/vendor/`; license in `api-docs/licenses/docsify-MIT.txt`.
  The deployed CSS removes the Google Fonts import and uses system fonts.
- NetEaseCloudMusicApiEnhanced documentation excerpts and module parameter references
  (MIT), https://github.com/NeteaseCloudMusicApiEnhanced/api-enhanced.
  Source is the deployed upstream checkout; license in `api-docs/licenses/ncm-api-MIT.txt`.
  CurrentMusic gateway restrictions take precedence over original upstream examples.

## Web and client dependencies

- MDUI 2 (MIT), https://github.com/zdhxiong/mdui. License copy: `licenses/mdui-MIT.txt`.
- Material Design Icons font (Apache-2.0), https://github.com/google/material-design-icons.
  Distributed through @material-design-icons/font; license copy: `licenses/material-icons-Apache-2.0.txt`.
- qrcode-generator (MIT), https://github.com/kazuhikoarase/qrcode-generator.
  The installed npm package includes its copyright/license notice in the QR implementation.
- esbuild (MIT), https://github.com/evanw/esbuild (build-time dependency).
- .NET / Windows App SDK / WinUI dependencies are restored from NuGet under their
  respective licenses; no Microsoft runtime source is relicensed by this repository.
- Windows diagnostic audio fixtures are synthetic 440 Hz sine waves generated
  with FFmpeg, not recordings of third-party songs.

## Backend dependencies and content

- opencc-python-reimplemented 0.1.7 (Apache-2.0), https://github.com/yichen0831/opencc-python,
  uses OpenCC dictionaries (https://github.com/BYVoid/OpenCC) to normalize traditional/simplified
  Chinese matching keys. Displayed lyric text is preserved. Pinned in `deploy/requirements-search.txt`;
  license copy: `licenses/opencc-Apache-2.0.txt`; attribution: `licenses/opencc-NOTICE.txt`.

- py_webauthn (BSD-3-Clause), https://github.com/duo-labs/py_webauthn,
  pinned in `deploy/requirements-auth.txt`; transitive dependencies retain their own licenses.
- Pillow (HPND) and segno (BSD-3-Clause) are optional sharing-image dependencies.
- NetEaseCloudMusicApiEnhanced / api-enhanced (MIT) is deployed separately;
  its backend source and account cookies are not bundled here. The license for
  documentation excerpts is retained in `api-docs/licenses/ncm-api-MIT.txt`.
- CurrentMusic branding in `assets/brand/` was generated for this project;
  provenance is recorded in its README. Third-party decoration metadata does
  not grant rights to the images referenced by it. User uploads, avatars,
  music/audio, covers, and third-party service responses are not licensed by
  CurrentMusic's MIT license and are not included in the source snapshot.
