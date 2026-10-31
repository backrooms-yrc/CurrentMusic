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
with GPL-3.0-only for LDDC and provide the corresponding source. The CurrentMusic
backend's own license is not decided in this repository; consult the repository
owner before publishing.

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
