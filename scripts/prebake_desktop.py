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


def png_only_encode(module):
    """Force every prebaked image to PNG.

    The bake emits small palettes as WebP to keep the browser payload small. Some WebView2
    installs cannot decode those (the picture stays broken while the log shows no HTTP error,
    because the bytes never travel over the network), so the desktop package ships PNG only.
    """
    import io
    import hashlib
    from PIL import Image as _Image

    def encode(image, palette=False):
        image = image.convert("RGBA")
        if palette:
            image.thumbnail((96, 96), module.RESAMPLE)
        key = hashlib.sha256(image.tobytes()).hexdigest()[:24]
        if key in module._emitted:
            return key
        buffer = io.BytesIO()
        image.save(buffer, "PNG", optimize=True)
        raw = buffer.getvalue()
        module.host.emitImage(key, "png", raw)
        module._emitted[key] = (image.width, image.height, "png", len(raw))
        return key

    module._encode = encode


def bake(out):
    import PIL

    host = Host()
    sys.modules["js"] = types.SimpleNamespace(__endfieldHost=host)
    sys.path.insert(0, str(BAKE))
    import bake_blueprint_sprites

    bake_blueprint_sprites.ROOT = ROOT
    import bake_editor_payload

    png_only_encode(bake_editor_payload)
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
    verify_decodes(target, host.images)
    meta = {"version": 1, "pythonDigest": python_digest(), "pillow": PIL.__version__,
            "payload": payload, "reports": host.reports, "images": index}
    (target / "prebaked.json").write_text(json.dumps(meta, ensure_ascii=False, separators=(",", ":")), "utf-8")
    print(f"prebaked {len(index)} images, {offset / 2**20:.1f} MiB, Pillow {PIL.__version__}, "
          f"{time.time() - started:.1f}s -> {target}")


def verify_decodes(target, images):
    """Fail the build if any emitted image is not a readable PNG."""
    from PIL import Image

    for key, extension, data in images:
        if extension != "png":
            raise SystemExit(f"prebaked asset {key} is {extension}, expected PNG")
        try:
            Image.open(__import__("io").BytesIO(data)).load()
        except Exception as error:  # noqa: BLE001 - any decoder failure invalidates the package
            raise SystemExit(f"prebaked asset {key} does not decode: {error}") from error


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("out", nargs="?", default=str(ROOT / "dist-desktop"))
    bake(parser.parse_args().out)


if __name__ == "__main__":
    main()
