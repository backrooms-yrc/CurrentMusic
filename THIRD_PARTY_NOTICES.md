# Third-party notices

## Gatus (service status page)

- Project: https://github.com/TwiN/gatus
- License: **Apache-2.0**
- Version deployed: v5.38.0 (built from the upstream source tarball with
  `CGO_ENABLED=0 go build`; the repository's embedded frontend is used as-is)
- Installation location: `/opt/gatus/gatus` (binary only; no source copied into
  this repository)
- Configuration: `deploy/gatus/config.yaml` (declarative endpoint list)

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
- The expressive loading indicator uses the fixed blue/red/yellow/green palette of MDUI 1.0.2
  colorful spinners (MIT), https://github.com/zdhxiong/mdui/blob/v1.0.2/dist/css/mdui.css.
  MDUI 1 runtime code is not bundled; see the MDUI MIT notice above.
- Material Design Icons font (Apache-2.0), https://github.com/google/material-design-icons.
  Distributed through @material-design-icons/font; license copy: `licenses/material-icons-Apache-2.0.txt`.
- Aimo uses SVG paths adapted from Lucide (ISC), https://lucide.dev/license,
  including Feather-derived icons (MIT), https://github.com/feathericons/feather.
  The notices are retained in `web/src/aimo-icons.js` and the Web bundle.
- qrcode-generator (MIT), https://github.com/kazuhikoarase/qrcode-generator.
  The installed npm package includes its copyright/license notice in the QR implementation.
- esbuild (MIT), https://github.com/evanw/esbuild (build-time dependency).
- .NET / Windows App SDK / WinUI dependencies are restored from NuGet under their
  respective licenses; no Microsoft runtime source is relicensed by this repository.
- Windows diagnostic audio fixtures are synthetic 440 Hz sine waves generated
  with FFmpeg, not recordings of third-party songs.
- The Windows 2.0 prototype uses MyGo 0.8.3 (MIT), https://github.com/egoist/mygo,
  and Go 1.27.3 (BSD-3-Clause). The pinned Windows Go module dependencies are
  purego (Apache-2.0), go-text/typesetting (Unlicense OR BSD-3-Clause), and Go's x/image,
  x/net and x/text (BSD-3-Clause). Prototype bundles include their notices.
  The media bridge uses Windows SDK APIs and the Microsoft C++ runtime
  under the [Visual Studio license terms](https://visualstudio.microsoft.com/license-terms/).

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
- yakult-green-tea/qq-music-api v3.3.6 (MIT), https://github.com/yakult-green-tea/qq-music-api,
  is a separate loopback service. CurrentMusic ships its own HTTP gateway and
  route allowlist. See the upstream [license](https://github.com/yakult-green-tea/qq-music-api/blob/v3.3.6/LICENSE).
- @neteasecloudmusicapienhanced/unblockmusic-utils 0.4.4 (MIT),
  https://github.com/NeteaseCloudMusicApiEnhanced/UnblockNeteaseMusic-utils,
  and @unblockneteasemusic/server 0.28.0 (LGPL-3.0-only),
  https://github.com/UnblockNeteaseMusic/server, remain dependencies of that separate
  upstream deployment. The CurrentMusic matcher hooks contain independently written
  validation/adapter code; upstream dependency source and binaries are not distributed here.
- FFmpeg / ffprobe, https://ffmpeg.org/legal.html, is invoked as a separate system
  process to inspect matched audio. Its license depends on the system build: the
  validated Debian 5.1.9 build enables GPL components and reports GPL-2.0-or-later.
  No FFmpeg binary or source is bundled by this repository; redistribution of a
  system image must preserve the applicable FFmpeg and dependency licenses.
- The optional grey-track matching path also calls the public Vkeys service,
  https://doc.vkeys.cn/, for QQ song metadata and stream URLs. Its REST adapter is
  independently implemented; no service source, API keys or cookies are bundled.
  Service responses and third-party music remain outside this repository's MIT license.
- SoaringBird developed `soaringbird-music` as a discontinued third-party
  CurrentMusic Web client. The author contributed the adapted theme to this
  repository under its MIT license in
  [PR #3](https://github.com/backrooms-yrc/CurrentMusic/pull/3).
- CurrentMusic branding in `assets/brand/` was generated for this project;
  provenance is recorded in its README. Third-party decoration metadata does
  not grant rights to the images referenced by it. User uploads, avatars,
  music/audio, covers, and third-party service responses are not licensed by
  CurrentMusic's MIT license and are not included in the source snapshot.
