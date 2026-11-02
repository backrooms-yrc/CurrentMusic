"""Test package bootstrap.

Set a throwaway database before any test module imports cm_db/cm_ai/cm_server.
`unittest discover -s backend/tests` imports modules as top-level and may not run
this file; tools/run-tests.sh sets the same variables in the shell as a second
line of defence. test_listen_ms additionally refuses to delete a non-temp DB.
"""
import os
import tempfile

_TEST_ROOT = tempfile.mkdtemp(prefix="cm-tests-")
os.environ["CM_DB"] = os.path.join(_TEST_ROOT, "cm.db")
os.environ["CM_DATA_DIR"] = _TEST_ROOT
