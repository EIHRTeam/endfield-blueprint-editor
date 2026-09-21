"""Pyodide boot entry point.

The worker writes every `.py` module into `/bake` and the whole static asset tree into `/kernel`,
then imports this module. Keeping the wiring here (rather than in JavaScript string literals) means
no Python source is ever embedded in a bundle.

`ROOT` is rebound *before* the modules that read it at import time are imported, which is why the
imports below are deliberately ordered after the assignment and carry `noqa` markers.
"""
import sys
from pathlib import Path

import bake_blueprint_sprites

# The worker mounts the static tree here; rebind the module constant before anything reads it.
bake_blueprint_sprites.ROOT = Path('/kernel')

if '/bake' not in sys.path:
    sys.path.insert(0, '/bake')

import bake_editor_payload  # noqa: E402


def run():
    """Bake every sprite and return the editor payload as JSON. Called by the worker."""
    return bake_editor_payload.bake()


def bake_cover(item_id):
    """Compose a single cover on demand; returns its asset key or None."""
    return bake_editor_payload.bake_cover(item_id)
