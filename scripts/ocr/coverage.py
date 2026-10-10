"""Turn observed screenshot coverage into a visible map and actionable regions."""
from __future__ import annotations

import cv2
import numpy as np


def coverage_review(mosaic, registration):
    fractions = np.asarray(registration["coverage"]["cell_fractions"], dtype=float)
    columns, rows = registration["grid"]["size"]
    if fractions.shape != (rows, columns):
        raise ValueError("覆盖范围与蓝图尺寸不一致。")
    # BGR equivalents of the legend's green, yellow and red.
    colors = np.empty((rows, columns, 3), np.uint8)
    colors[:] = (111, 166, 46)
    colors[fractions < .98] = (56, 173, 232)
    colors[fractions < .10] = (81, 77, 219)
    tint = cv2.resize(colors, (mosaic.shape[1], mosaic.shape[0]), interpolation=cv2.INTER_NEAREST)
    annotated = cv2.addWeighted(mosaic, .60, tint, .40, 0)

    # Small antialiasing gaps at canvas edges should not overwhelm the queue.
    # The pixel coverage remains unchanged; this is only the review threshold.
    missing = (fractions < .90).astype(np.uint8)
    _, labels, stats, _ = cv2.connectedComponentsWithStats(missing, connectivity=4)
    regions = []
    for label, (x, z, width, height, area) in enumerate(stats[1:], start=1):
        bounds = {"x0": int(x), "z0": int(z), "x1": int(x+width), "z1": int(z+height)}
        fraction = float(np.mean(1 - fractions[labels == label]))
        regions.append({"bounds": bounds, "missingFraction": round(fraction, 5), "cells": int(area),
                        "reason": f"这一范围内有 {int(area)} 格未完整拍清；请补录对应区域，尽量移开鼠标提示框。"})
    return annotated, regions
