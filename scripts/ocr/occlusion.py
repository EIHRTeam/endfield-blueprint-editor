"""Recover weak visual evidence beneath translucent game tooltips.

This is an auxiliary image, never a replacement for the original coverage map.
White tooltip glyphs carry no scene information and remain masked. Low-contrast
background pixels retain the underlying artwork; affine contrast enhancement
makes their colour and shape usable by the line detector.
"""
from __future__ import annotations

import cv2
import numpy as np


def tooltip_evidence(images, registration, mosaic, coverage):
    restored = mosaic.copy()
    seen = (coverage > 0).astype(np.uint8)
    weak = np.zeros(coverage.shape, np.uint8)
    height, width = coverage.shape
    for source, record in zip(images, registration["images"]):
        image = source["image"] if isinstance(source, dict) else source
        gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
        mask = np.zeros(gray.shape, np.uint8)
        for x0, y0, x1, y1 in record["occlusions"]:
            # Work inside the opaque-looking background, excluding drop shadow.
            mask[y0+3:y1-3, x0+3:x1-3] = 1
        # Bright text and its antialiased boundary have replaced, rather than
        # merely attenuated, scene pixels. Remove them before any correlation.
        glyphs = cv2.dilate((gray > 55).astype(np.uint8), np.ones((3, 3), np.uint8))
        mask[glyphs > 0] = 0
        enhanced = np.clip((image.astype(np.float32)-8)*8, 0, 255).astype(np.uint8)
        transform = np.array(record["transform"], dtype=float)
        available = cv2.warpAffine(mask, transform, (width, height), flags=cv2.INTER_NEAREST) > 0
        recovered = cv2.warpAffine(enhanced, transform, (width, height), flags=cv2.INTER_LINEAR)
        select = available & (seen == 0)
        restored[select] = recovered[select]
        seen[select] = 1
        weak[select] = 1
    return restored, seen, weak


def supplement_lines(primary, auxiliary, weak, grid):
    """Add only newly supported tiles; conflicting observations stay reviewable."""
    lookup = {(b["x"], b["z"], b["kind"]): b for b in primary["conveyors"]}
    scores = {(b["x"], b["z"], b["kind"]): b for b in auxiliary["evidence"]}
    recovered = []
    cell = grid["cell_size"]
    for line in auxiliary["conveyors"]:
        x, y = line["x"], line["z"]
        patch = weak[round(y*cell):round((y+1)*cell), round(x*cell):round((x+1)*cell)]
        if not patch.size or patch.mean() < .05:
            continue
        key = (x, y, line["kind"])
        evidence = scores[key]
        if evidence.get("score", 0) < .75 or evidence.get("inferredFromConnectivity"):
            continue
        previous = lookup.get(key)
        if previous:
            if (previous["dir"], previous["fromDir"]) != (line["dir"], line["fromDir"]):
                primary["uncertain"].append({**previous, "alternative": line,
                    "issue": "conflict", "reason": "半透明提示框残留与可见区域的方向候选不同，需核对"})
            continue
        record = {**evidence, "source": "translucent_tooltip_pixels",
                  "weakPixelFraction": round(float(patch.mean()), 4)}
        primary["conveyors"].append(dict(line))
        primary["evidence"].append(record)
        lookup[key] = line
        recovered.append(record)
    return recovered
