"""Combine independent screenshot panels without treating counts as quotas."""
from __future__ import annotations

from collections import Counter
from copy import deepcopy
import hashlib

import cv2
import numpy as np

from . import progress
from .devices import inventory_card_boxes, recognize_inventory
from .text import read_count, read_counts, read_metadata


def pixel_signature(image):
    pixels = np.ascontiguousarray(image)
    digest = hashlib.sha256(str(pixels.shape).encode())
    digest.update(pixels.data)
    return digest.hexdigest()


def deduplicate_images(images):
    """Exact decoded-pixel duplicates contribute one observation, regardless of name."""
    unique, records, known = [], [], {}
    for index, row in enumerate(images):
        signature = pixel_signature(row["image"])
        if signature in known:
            unique_index, original_index = known[signature]
            records.append({"inputIndex": index, "name": row["name"],
                            "uniqueIndex": unique_index, "duplicateOf": original_index})
        else:
            known[signature] = (len(unique), index)
            records.append({"inputIndex": index, "name": row["name"], "uniqueIndex": len(unique)})
            unique.append(row)
    return unique, records


def panel_fingerprint(image):
    """Data to recognize the same detail panel in a re-encoded video frame.

    Video frames of one static panel differ by compression noise, so exact
    hashes never repeat. Only the panel proper is compared: the strip between
    the canvas and the panel pans with the blueprint, and the rightmost strip
    carries the canvas scrollbar. Card boxes are compared separately because
    card detection also searches the canvas-side strip.
    """
    height, width = image.shape[:2]
    panel = cv2.cvtColor(image[:, round(width * .745):round(width * .982)], cv2.COLOR_BGR2GRAY)
    return {"panel": panel, "cards": inventory_card_boxes(image)}


def same_panel(first, second):
    """True only for noise-level differences; any changed glyph or card fails."""
    a, b = first["panel"], second["panel"]
    if a.shape != b.shape or len(first["cards"]) != len(second["cards"]):
        return False
    if any(max(abs(p - q) for p, q in zip(one, two)) > 2
           for one, two in zip(first["cards"], second["cards"])):
        return False
    difference = cv2.absdiff(a, b)
    # Measured H.264 noise on a static panel: blocks <= .5, pixels <= 4 levels.
    # A single changed digit moves whole 8x8 blocks by tens of levels.
    blocks = cv2.resize(difference.astype(np.float32), None, fx=1 / 8, fy=1 / 8,
                        interpolation=cv2.INTER_AREA)
    return float(blocks.max()) < 3 and int(np.count_nonzero(difference > 24)) < 16


def collect_panels(images, assets, size_override=None):
    """Read every distinct panel, union its types, and never add repeated counts."""
    cache, card_cache, count_cache, observations = {}, {}, {}, []
    fingerprints = []
    cards_by_type, unknown_cards = {}, []
    for index, row in enumerate(images):
        image = row["image"]
        # The wider crop includes card outlines; text.py makes its own narrower crop.
        signature = pixel_signature(image[:, round(image.shape[1] * .69):])
        reused_from = None
        # Screenshots keep exact-pixel semantics; only decoded video frames of
        # one recording may treat noise-level panel differences as repeats.
        video_frame = "frameIndex" in row
        if signature not in cache and video_frame:
            fingerprint = panel_fingerprint(image)
            match = next((known for known, other in fingerprints if same_panel(fingerprint, other)), None)
            if match is not None:
                signature, reused_from = match, cache[match][2]
        if signature not in cache:
            if video_frame:
                fingerprints.append((signature, fingerprint))
            # Usually one distinct panel does nearly all the work of this stage.
            step = lambda fraction: progress.advance((index + fraction) / len(images) if cache else .85 * fraction)
            metadata = read_metadata(image)
            step(.3)
            cards = recognize_inventory(image, assets=assets, card_cache=card_cache)
            step(.65)
            keys = []
            for card in cards:
                x, y, w, h = card["bounds"]
                # Match read_count's actual input: icon animation above this
                # strip must not repeat OCR, while every changed digit does.
                keys.append(pixel_signature(image[y + round(h * .62):y+h, x:x+w]))
            pending = {key: card["bounds"] for key, card in zip(keys, cards) if key not in count_cache}
            count_cache.update(zip(pending, read_counts(image, pending.values(), reader=read_count)))
            for key, card in zip(keys, cards):
                card["count"] = count_cache[key]
            cache[signature] = (metadata, cards, index)
        progress.advance(.85 + .15 * (index + 1) / len(images) if len(cache) == 1 else (index + 1) / len(images))
        metadata, cards, _ = deepcopy(cache[signature])
        observations.append({"imageIndex": index, "sourceName": row["name"], **metadata})
        if reused_from is not None:
            # Auditable: this frame's panel was not read again.
            observations[-1]["panelReadFrom"] = reused_from
        for card in cards:
            card["imageIndex"] = index
            bid = card.get("templateId")
            if bid:
                cards_by_type.setdefault(bid, []).append(card)
            else:
                unknown_cards.append(card)

    warnings = list(dict.fromkeys(warning for row in observations for warning in row.get("warnings", [])
                                 if warning != "未可靠识别蓝图尺寸，需人工核对网格范围。"))
    sizes = Counter(tuple(row["size"]) for row in observations if row.get("size"))
    if len(sizes) > 1 and size_override is None:
        raise ValueError("不同截图读到互相冲突的蓝图尺寸；请检查是否来自同一蓝图，或指定 --size。")
    selected_size = list(size_override) if size_override is not None else list(next(iter(sizes))) if sizes else None
    if size_override is not None and any(tuple(size_override) != value for value in sizes):
        warnings.append("手动尺寸与部分截图 OCR 尺寸不同，请核对画布边界。")
    if selected_size is None:
        warnings.append("未可靠识别蓝图尺寸，需人工核对网格范围。")
    merged = {"warnings": warnings, "sources": observations,
              "text": [text for row in observations for text in row.get("text", [])]}
    if selected_size is not None:
        merged["size"] = selected_size
    if any(row.get("unknownRecipes") for row in observations):
        merged["unknownRecipes"] = True
    for field in ("name", "creatorId"):
        values = Counter(row[field] for row in observations if row.get(field))
        if values:
            merged[field] = values.most_common(1)[0][0]
            if len(values) > 1:
                warnings.append(f"截图中的 {field} 读数不一致，已保留各图原始读数供核对。")
    inventory = []
    for bid, sightings in sorted(cards_by_type.items()):
        best = deepcopy(max(sightings, key=lambda row: row.get("confidence", 0)))
        counts = sorted({row["count"] for row in sightings if row.get("count") is not None})
        best["count"] = counts[0] if len(counts) == 1 else None
        best["countAlternatives"] = counts
        best["sourceImages"] = sorted({row["imageIndex"] for row in sightings})
        best["observations"] = sightings
        if len(counts) > 1:
            warnings.append(f"{bid} 的清单数量存在冲突 {counts}，数量仅供核对，未据此增删设备。")
        inventory.append(best)
    return merged, inventory + unknown_cards
