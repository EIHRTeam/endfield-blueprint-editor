"""Reuse the editor's original game sprites for screenshot recognition."""
from __future__ import annotations

import importlib.util
from functools import lru_cache
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

try:
    from . import imageio
except ImportError:  # imported by standalone scripts
    import imageio

import os

# The packaged desktop app ships the sprites/data outside this source tree and points here.
PROJECT_ROOT = Path(os.environ.get("BLUEPRINT_ASSET_ROOT") or Path(__file__).resolve().parents[2])


class RecognitionAssets:
    def __init__(self, root=PROJECT_ROOT):
        self.root = Path(root)
        baker_file = self.root / "src/bake/python/bake_blueprint_sprites.py"
        if not baker_file.is_file():
            # A built editor (dist/, dist-desktop/) stages the same module and sprite tree.
            baker_file = self.root / "bake/python/bake_blueprint_sprites.py"
        spec = importlib.util.spec_from_file_location("ocr_blueprint_baker", baker_file)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        self.baker = module.BlueprintBaker(self.root)
        self.buildings = self.baker.buildings
        self.items = self.baker.items
        self.factory_items = self.baker.table("FactoryItemTable")
        self.logistics = self.baker.logistics
        self.reverse = self.baker.table("FactoryBuildingItemReverseTable")
        self.texts = self.baker.table("I18nTextTable_CN")

    @property
    def entity_ids(self):
        """Full drawable catalog, canonicalizing visually identical NOP variants."""
        return tuple(bid for bid in self.baker.entities if "_nop_" not in bid)

    @property
    def product_ids(self):
        # Blueprint-unlock items can reuse a material's exact icon and rarity.
        # Only factory items and actual gas environments belong on machine badges.
        gases = ("[gas]" + key[len("gas/icon_gas_env_"):] for key in self.baker.index
                 if key.startswith("gas/icon_gas_env_"))
        return tuple(iid for iid in self.factory_items if iid in self.items) + tuple(gases)

    def name(self, row):
        value = row.get("name", {})
        if isinstance(value, str):
            return value
        text = self.texts.get(str(value.get("id")), "")
        return value.get("text") or (text.get("text", "") if isinstance(text, dict) else text)

    @lru_cache(maxsize=256)
    def item_icon(self, item_id):
        item = self.items[item_id]
        icon = item.get("iconId") or self.baker.icon_overrides.get(item_id)
        path = self.root / "assets/item" / f"{icon}.png"
        return imageio.imread(str(path), cv2.IMREAD_UNCHANGED) if path.exists() else None

    @lru_cache(maxsize=2048)
    def building(self, bid, direction, cell=24, mode="normal", with_icon=False):
        im = (self.baker.building(bid, direction, formula_mode=mode) if with_icon
              else self.baker.body(bid, direction, mode))
        im = im.resize((round(im.width * cell / 128), round(im.height * cell / 128)), Image.Resampling.LANCZOS)
        rgba = np.asarray(im)
        return cv2.cvtColor(rgba, cv2.COLOR_RGBA2BGRA)

    @lru_cache(maxsize=32)
    def status_layers(self, status):
        """Prefab-accurate status layers, positioned relative to a badge center."""
        suffixes = {"locked": ["LockedNode/BgImage", "LockedNode/IconImage"],
                    "expired": ["TimeLimitedExpiredNode/IconImage"],
                    "limited": ["TimeLimitedActiveNode/TimeLimitedColorTag",
                                "TimeLimitedActiveNode/TimeLimitedColorTag/Icon2Image"]}.get(status, [])
        layers = []
        for suffix in suffixes:
            component = self.baker.component("/NodeCell/IconNode/ItemNode/" + suffix)
            transform = component["transform"]
            size, position = transform["m_SizeDelta"], transform["m_AnchoredPosition"]
            x = position["x"] - size["x"] * transform["m_Pivot"]["x"]
            y = -position["y"] - size["y"] * (1-transform["m_Pivot"]["y"])
            if transform["m_AnchorMin"]["x"] == 0:
                x -= 60
                y -= 60
            if suffix.endswith("/Icon2Image"):
                x -= 5
                y -= 3.6
            color = tuple(round(component["color"][key] * 255) for key in ("r", "g", "b", "a"))
            sprite = self.baker.scaled(component["sprite"], (size["x"], size["y"]), rgba=color)
            layers.append({"image": sprite, "x": x, "y": y, "width": size["x"],
                           "height": size["y"], "sprite": component["sprite"]})
        return layers

    @lru_cache(maxsize=4096)
    def badge(self, item_id, size, status="normal"):
        try:
            im = self.baker.product_badge(item_id)
            for layer in self.status_layers(status):
                im.alpha_composite(layer["image"], (round(layer["x"] + 60), round(layer["y"] + 60)))
            im = im.resize((size, size), Image.Resampling.LANCZOS)
        except (KeyError, ValueError, FileNotFoundError):
            return None
        return cv2.cvtColor(np.asarray(im), cv2.COLOR_RGBA2BGRA)

    def inventory_items(self):
        for bid, row in self.reverse.items():
            # These internal variants share a sprite and cannot be distinguished visually.
            if "_nop_" not in bid:
                yield bid, row["itemId"]
        for iid, row in self.baker.table("FactoryItem2LogisticIdTable").items():
            yield row["logisticId"], iid


def composite(rgba, background=229):
    alpha = rgba[..., 3:4].astype(np.float32) / 255
    return np.round(rgba[..., :3] * alpha + background * (1 - alpha)).astype(np.uint8)
