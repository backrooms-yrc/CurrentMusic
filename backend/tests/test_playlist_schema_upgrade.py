"""旧库重启时必须先补列，后创建使用新列的索引。"""
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import cm_db


class PlaylistSchemaUpgradeTests(unittest.TestCase):
    def test_legacy_database_can_start_twice(self):
        with tempfile.TemporaryDirectory(prefix='cm-schema-') as tmp:
            path = str(Path(tmp) / 'old.db')
            with sqlite3.connect(path) as conn:
                conn.execute('CREATE TABLE playlists (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, '
                             'name TEXT NOT NULL, description TEXT DEFAULT "", source TEXT DEFAULT "local", '
                             'ncm_pl_id INTEGER DEFAULT 0, cover TEXT DEFAULT "", '
                             'created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)')
            with patch.object(cm_db, 'DB_PATH', path):
                cm_db.init()
                cm_db.init()
            with sqlite3.connect(path) as conn:
                self.assertIn('ncm_order', {r[1] for r in conn.execute('PRAGMA table_info(playlists)')})
                self.assertIn('idx_pl_ncm_order', {r[1] for r in conn.execute('PRAGMA index_list(playlists)')})
