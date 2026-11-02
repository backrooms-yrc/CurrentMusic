#!/usr/bin/env python3
"""Compatibility entry point for the unified public-source exporter.

The public repository now includes the backend. Preview by default; use --apply
to export a reviewed snapshot. This no longer writes a frontend-only README.
"""
import runpy
from pathlib import Path

if __name__ == '__main__':
    runpy.run_path(str(Path(__file__).with_name('export-open-source.py')), run_name='__main__')
