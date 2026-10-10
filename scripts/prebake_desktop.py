"""Bake the editor sprites once at build time for the desktop edition.

The web edition composes ~2,000 sprites in the browser through Pyodide on first
start (about a minute, then cached in IndexedDB). The desktop app ships them
pre-composed so it opens immediately. The very same Python modules run here
under native CPython; only the ``js.__endfieldHost`` bridge is replaced.

    python scripts/prebake_desktop.py dist-desktop

Writes ``<out>/baked/prebaked.json`` (payload, reports, image index) and
``<out>/baked/prebaked.bin`` (all encoded images back to back).
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
import time
import types
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BAKE = ROOT / "src/bake/python"


class Host:
    def __init__(self):
        self.images = []
        self.reports = {}

    def emitImage(self, key, extension, data):  # noqa: N802 - mirrors the worker's JS API
        self.images.append((key, extension, bytes(data)))

    def emitJson(self, name, text):  # noqa: N802
        self.reports[name] = text

    def report(self, stage):
        print(f"  {stage}", flush=True)


def python_digest():
    """Same idea as the browser cache key: editing a bake module invalidates the result."""
    digest = hashlib.sha256()
    for path in sorted(BAKE.glob("*.py")):
        digest.update(path.name.encode() + b"\0" + path.read_bytes())
    return digest.hexdigest()[:16]


def bake(out):
    import PIL

    host = Host()
    sys.modules["js"] = types.SimpleNamespace(__endfieldHost=host)
    sys.path.insert(0, str(BAKE))
    import bake_blueprint_sprites

    bake_blueprint_sprites.ROOT = ROOT
    import bake_editor_payload

    started = time.time()
    payload = bake_editor_payload.bake()
    target = Path(out) / "baked"
    target.mkdir(parents=True, exist_ok=True)
    index, offset = [], 0
    with (target / "prebaked.bin").open("wb") as stream:
        for key, extension, data in host.images:
            stream.write(data)
            index.append([key, extension, offset, len(data)])
            offset += len(data)
    meta = {"version": 1, "pythonDigest": python_digest(), "pillow": PIL.__version__,
            "payload": payload, "reports": host.reports, "images": index}
    (target / "prebaked.json").write_text(json.dumps(meta, ensure_ascii=False, separators=(",", ":")), "utf-8")
    print(f"prebaked {len(index)} images, {offset / 2**20:.1f} MiB, Pillow {PIL.__version__}, "
          f"{time.time() - started:.1f}s -> {target}")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("out", nargs="?", default=str(ROOT / "dist-desktop"))
    bake(parser.parse_args().out)


if __name__ == "__main__":
    main()
