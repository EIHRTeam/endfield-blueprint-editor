"""Recognize grid-aligned blueprint devices and product badges from original sprites.

The detector has no example-specific coordinates or device list. Inventory cards
provide a weak prior over the full asset catalog; independently matched device
footprints must agree with the recovered grid and cannot overlap one another.
"""
from __future__ import annotations

import argparse
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path

import cv2
import numpy as np

try:
    from .assets import RecognitionAssets, PROJECT_ROOT, composite
    from . import imageio, progress
except ImportError:
    from assets import RecognitionAssets, PROJECT_ROOT, composite
    import imageio
    import progress


def worker_count():
    """Parallel workers for independent template matches (env BLUEPRINT_OCR_THREADS)."""
    configured = os.environ.get("BLUEPRINT_OCR_THREADS")
    if configured:
        return max(1, int(configured))
    return max(1, min(16, available_cpus()))


def available_cpus():
    """CPUs this process may use (respects affinity/containers where reported)."""
    if hasattr(os, "process_cpu_count"):
        return os.process_cpu_count() or 1
    if hasattr(os, "sched_getaffinity"):
        return len(os.sched_getaffinity(0)) or 1
    return os.cpu_count() or 1


def inventory_card_boxes(image):
    """Square inventory-card boxes in the right-hand panel, in reading order."""
    height, width = image.shape[:2]
    dark = cv2.inRange(image, (0, 0, 0), (85, 85, 85))
    _, _, stats, _ = cv2.connectedComponentsWithStats(dark)
    cards = []
    for x, y, w, h, area in stats:
        # The game's right-hand panel uses square cards. Dark connected regions
        # stop above the rarity stripe or number, hence the relaxed aspect ratio.
        if (x > width * .69 and width * .035 < w < width * .07
                and .70 < h / w < 1.1 and y > height * .28 and area > w * h * .26):
            cards.append((int(x), int(y), int(w), int(w)))
    cards.sort(key=lambda box: (round(box[1] / (width * .015)), box[0]))
    return cards


def recognize_inventory(image, project_root=PROJECT_ROOT, assets=None, card_cache=None):
    """Return visually recognized inventory cards with source-image bounding boxes.

    Counts are deliberately separate: a missing or unreadable numeral is not zero.
    ``count_bounds`` is a suitable crop for a text OCR engine.
    ``card_cache`` may be shared across frames from one asset bank. Only exactly
    identical full-card pixels reuse icon scores; positions and counts stay local.
    """
    assets = assets or RecognitionAssets(project_root)
    if isinstance(image, (str, Path)):
        image = imageio.imread(str(image))
    cards = inventory_card_boxes(image)
    vocabulary = []
    for bid, iid in assets.inventory_items():
        icon = assets.item_icon(iid)
        if icon is not None:
            vocabulary.append((bid, iid, icon))
    if cards and not vocabulary:
        raise ValueError(f"读不到设备图标素材（{assets.root / 'assets/item'}）；请重新安装或解压程序。")
    sprites = {}

    def card_sprites(w, h):
        # One resized, masked icon set per card size, shared by every card.
        if (w, h) not in sprites:
            rows = []
            for bid, iid, icon in vocabulary:
                scaled = []
                for scale in (.80, .86, .91, .94, 1.):
                    size = round(w * scale)
                    sprite = cv2.resize(icon, (size, size), interpolation=cv2.INTER_AREA)
                    sprite = sprite[:min(round(h * .78), size)]
                    mask = (sprite[:, :, 3] > 180).astype(np.uint8)
                    if mask.sum() >= 50:
                        scaled.append((np.ascontiguousarray(sprite[:, :, :3]), mask))
                rows.append((bid, iid, scaled))
            sprites[w, h] = rows
        return sprites[w, h]

    def score_card(box):
        x, y, w, h = box
        crop = image[y:y + round(h * .86), x:x + w]
        choices = []
        for bid, iid, scaled in card_sprites(w, h):
            best = 0.
            for sprite, mask in scaled:
                score = cv2.matchTemplate(crop, sprite, cv2.TM_CCORR_NORMED, mask=mask)
                best = max(best, float(np.nan_to_num(score, nan=0., posinf=0.).max()))
            choices.append((best, bid, iid))
        choices.sort(reverse=True)
        return tuple(choices)

    keys, missing = [], {}
    for x, y, w, h in cards:
        full_card = image[y:y + h, x:x + w]
        key = (w, h, full_card.shape, full_card.dtype.str, full_card.tobytes())
        keys.append(key)
        if (card_cache is None or key not in card_cache) and key not in missing:
            missing[key] = (x, y, w, h)
            card_sprites(w, h)
    with ThreadPoolExecutor(worker_count()) as pool:
        scored = dict(zip(missing, pool.map(score_card, missing.values())))
    if card_cache is not None:
        card_cache.update(scored)
    result = []
    for (x, y, w, h), key in zip(cards, keys):
        choices = card_cache[key] if card_cache is not None else scored[key]
        score, bid, iid = choices[0]
        # Identical internal building variants are canonicalized by the asset bank.
        result.append({"templateId": bid if score > .92 else None,
                       "itemId": iid if score > .92 else None,
                       "confidence": round(score, 5), "bounds": [x, y, w, h],
                       "count_bounds": [x, y + round(h * .62), w, round(h * .37)],
                       "alternatives": [{"templateId": b, "score": round(s, 5)}
                                        for s, b, _ in choices[:3]]})
    return result


def _grid(grid):
    cell = grid.get("cell_size", grid.get("cell_size_px"))
    origin = grid.get("origin", grid.get("origin_px", [0, 0]))
    size = grid.get("size", [grid.get("columns"), grid.get("rows")])
    if not cell or not all(size):
        raise ValueError("grid requires cell_size, origin, and size=[columns, rows]")
    return float(cell), tuple(origin), tuple(map(int, size))


def _foreground_pipe_mask(image, assets, cell):
    """Mask only foreground strokes that match an original pipe tile.

    Pipes are drawn over machines. Darkness alone cannot identify them because
    machine frames and watermarks are gray too; opaque pipe pixels must agree
    with both the arrow's contrast and its monochrome, dark silhouette.
    """
    try:
        from .lines import tile_templates
    except ImportError:
        from lines import tile_templates
    templates = []
    for tile in tile_templates(assets, "fluid"):
        rgba = cv2.resize(tile["rgba"], (cell, cell), interpolation=cv2.INTER_AREA)
        gray = cv2.resize(tile["gray"], (cell, cell), interpolation=cv2.INTER_AREA)
        opaque = rgba[:, :, 3] > 240
        values = gray[opaque].astype(float)
        values -= values.mean()
        templates.append((opaque, values, np.linalg.norm(values), rgba[:, :, 3] > 10))
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    neutral = image.max(2).astype(int) - image.min(2) < 18
    result = np.zeros(gray.shape, np.uint8)
    for y in range(0, gray.shape[0] - cell + 1, cell):
        for x in range(0, gray.shape[1] - cell + 1, cell):
            patch = gray[y:y+cell, x:x+cell]
            if np.mean(patch < 165) < .07:
                continue
            best, stroke = .9, None
            for opaque, expected, norm, alpha in templates:
                values = patch[opaque].astype(float)
                if np.mean(values < 165) < .9 or np.mean(neutral[y:y+cell, x:x+cell][opaque]) < .95:
                    continue
                values -= values.mean()
                score = float(np.dot(values, expected) / max(1., np.linalg.norm(values) * norm))
                if score > best:
                    best, stroke = score, alpha
            if stroke is not None:
                result[y:y+cell, x:x+cell] = stroke
    # Include the antialias fringe, not the entire cell occupied by the pipe.
    return cv2.dilate(result, np.ones((3, 3), np.uint8))


def _scores_on_grid(image, rgba, cell, cols, rows, footprint, exclude_badge=True,
                    coverage=None, badge_radius=.54, pipe_occlusions=None, match_details=None):
    """Masked correlation, sampled near grid intersections to allow raster rounding."""
    gray = cv2.cvtColor(composite(rgba), cv2.COLOR_BGR2GRAY)
    mask = (rgba[:, :, 3] > 10).astype(np.uint8)
    if exclude_badge:
        cv2.circle(mask, (mask.shape[1] // 2, mask.shape[0] // 2), round(cell * badge_radius), 0, -1)
    if mask.sum() < 30 or gray.shape[0] > image.shape[0] or gray.shape[1] > image.shape[1]:
        return []
    scores = cv2.matchTemplate(image, gray, cv2.TM_CCOEFF_NORMED, mask=mask)
    scores = np.nan_to_num(scores, nan=-1, posinf=-1, neginf=-1)
    w, h = footprint
    mask_count = int(mask.sum())
    pipe_integral = cv2.integral(pipe_occlusions) if pipe_occlusions is not None else None
    grid_cols, grid_rows = cols - w + 1, rows - h + 1
    if grid_cols <= 0 or grid_rows <= 0:
        return []
    # Vectorized grid sampling: max of the score map within +-1 px of every
    # grid intersection. Padding with -inf reproduces the clipped window.
    height, width = scores.shape
    ys, xs = np.arange(grid_rows) * cell, np.arange(grid_cols) * cell
    reachable = (ys <= height)[:, None] & (xs <= width)[None, :]
    padded = np.full((height + 3, width + 3), -np.inf, np.float32)
    padded[1:height + 1, 1:width + 1] = scores
    cy, cx = np.minimum(ys, height)[:, None], np.minimum(xs, width)[None, :]
    peak = np.max([padded[cy + dy, cx + dx] for dy in range(3) for dx in range(3)], axis=0)
    # Only windows with missing coverage or a substantial foreground pipe need
    # the per-window refinements below; all other scores are final as sampled.
    template_h, template_w = gray.shape
    window_bottom, window_right = ys + template_h, xs + template_w

    def window_sums(integral, limit_h, limit_w):
        inside = (window_bottom <= limit_h)[:, None] & (window_right <= limit_w)[None, :]
        b, r = np.minimum(window_bottom, limit_h)[:, None], np.minimum(window_right, limit_w)[None, :]
        t, l = np.minimum(ys, limit_h)[:, None], np.minimum(xs, limit_w)[None, :]
        total = (integral[b, r].astype(np.int64) - integral[t, r] - integral[b, l] + integral[t, l])
        return inside, total

    refine_at = np.zeros(peak.shape, bool)
    fully_seen_grid = np.ones(peak.shape, bool)
    if coverage is not None:
        inside, unseen = window_sums(cv2.integral((coverage == 0).astype(np.uint8)), *coverage.shape)
        fully_seen_grid = inside & (unseen == 0)
        refine_at |= ~fully_seen_grid
    if pipe_integral is not None:
        inside, removed = window_sums(pipe_integral, *pipe_occlusions.shape)
        refine_at |= (peak < .9) & (~inside | (removed > mask_count * .08))
    refine_at &= reachable
    final = peak.astype(np.float64)
    for y, x in zip(*np.nonzero(refine_at)):
        y, x = int(y), int(x)
        px, py = x * cell, y * cell
        score = float(peak[y, x])
        fully_seen = bool(fully_seen_grid[y, x])
        if coverage is not None and not fully_seen:
            seen = coverage[py:py+gray.shape[0], px:px+gray.shape[1]] > 0
            valid = mask.astype(bool) & seen
            fraction = valid.sum() / max(1, mask_count)
            if .18 < fraction < .98 and valid.sum() > 75:
                patch = image[py:py+gray.shape[0], px:px+gray.shape[1]]
                partial = cv2.matchTemplate(patch, gray, cv2.TM_CCOEFF_NORMED,
                                            mask=valid.astype(np.uint8))[0, 0]
                if np.isfinite(partial):
                    score = max(score, float(partial) * .94)
        if pipe_integral is not None and score < .9:
            right, bottom = px + gray.shape[1], py + gray.shape[0]
            removed = (pipe_integral[bottom, right] - pipe_integral[py, right]
                       - pipe_integral[bottom, px] + pipe_integral[py, px])
            if removed > mask_count * .08:
                valid = mask & (pipe_occlusions[py:bottom, px:right] == 0)
                # A confirmed longitudinal pipe can be partly hidden by
                # the badge. Extend only that narrow center stroke for
                # a one-cell-wide port; keep bare port arrows otherwise.
                if min(footprint) == 1:
                    stripe = max(1, round(cell * .16))
                    if footprint[0] == 1:
                        middle = valid.shape[1] // 2
                        valid[:, middle-stripe:middle+stripe] = 0
                    else:
                        middle = valid.shape[0] // 2
                        valid[middle-stripe:middle+stripe, :] = 0
                if coverage is not None:
                    valid &= coverage[py:bottom, px:right] > 0
                fraction = 1 - valid.sum() / mask_count
                # Retain a substantial amount of the actual device.
                # A pipe on blank canvas cannot supply frame evidence.
                if .08 < fraction < .60 and valid.sum() > 100:
                    patch = image[py:bottom, px:right]
                    # There is only one alignment here. Direct vector
                    # correlation avoids six FFTs per candidate in
                    # OpenCV's masked sliding-window implementation.
                    keep = valid.astype(bool)
                    observed = patch[keep].astype(np.float32)
                    expected = gray[keep].astype(np.float32)
                    observed -= observed.mean()
                    expected -= expected.mean()
                    norm = float(np.linalg.norm(observed) * np.linalg.norm(expected))
                    partial = float(np.dot(observed, expected) / norm) if norm > 1 else -1.
                    if np.isfinite(partial) and partial > .82 and partial * .94 > score:
                        score = partial * .94
                        if match_details is not None:
                            match_details[x, y] = {"pipeOcclusionFraction": round(float(fraction), 5),
                                                  "matchMaskSource": "original_pipe_strokes"}
        final[y, x] = score
    hits = []
    for y, x in zip(*np.nonzero(reachable & (final > .47))):
        hits.append((float(final[y, x]), int(x), int(y)))
    return hits


_SCAN_STATE = {}


def _scan_init(state):
    # Worker processes already run in parallel; nested OpenCV pools only thrash.
    cv2.setNumThreads(1)
    _SCAN_STATE.clear()
    _SCAN_STATE.update(state)


def _scan(job, state=None):
    state = state or _SCAN_STATE
    rgba, footprint, exclude_badge, badge_radius, use_coverage = job
    details = {}
    hits = _scores_on_grid(state["gray"], rgba, state["cell"], state["cols"], state["rows"], footprint,
                           exclude_badge=exclude_badge,
                           coverage=state["coverage"] if use_coverage else None,
                           badge_radius=badge_radius,
                           pipe_occlusions=state["pipes"] if np.prod(footprint) >= 3 else None,
                           match_details=details)
    return hits, details


def _map_scans(state, jobs, span=(0., 1.)):
    """Score template pictures; results are in job order and independent of workers."""
    return _map_jobs(_scan, state, jobs, minimum=32, span=span)


# How the latest _map_jobs batch ran: "serial", "processes" or "fallback" (pool failed, ran serially).
last_pool_mode = None


def _start_method():
    import multiprocessing
    methods = multiprocessing.get_all_start_methods()
    forced = os.environ.get("BLUEPRINT_OCR_START_METHOD")  # tests: "spawn" mimics Windows
    if forced in methods:
        return forced
    return "forkserver" if "forkserver" in methods else "spawn"  # Windows offers only spawn.


def _map_jobs(function, state, jobs, minimum, span=(0., 1.)):
    """Run ``function(job, state)`` for every job, returning results in job order.

    The matchers interleave OpenCV calls with many small NumPy steps, so threads
    convoy on the GIL. Separate processes scale (forkserver, or spawn on Windows,
    is safe inside the threaded HTTP service); small batches stay in-process.
    """
    low, high = span
    total = max(1, len(jobs))

    def serial(mode="serial"):
        global last_pool_mode
        last_pool_mode = mode
        results = []
        for job in jobs:
            results.append(function(job, state))
            progress.advance(low + (high - low) * len(results) / total)
        return results

    workers = min(worker_count(), len(jobs))
    if workers <= 1 or len(jobs) < minimum:
        return serial()
    import multiprocessing
    from concurrent.futures import ProcessPoolExecutor
    context = multiprocessing.get_context(_start_method())
    if context.get_start_method() == "forkserver":
        # Workers fork from a server that already imported OpenCV and this module.
        context.set_forkserver_preload([__name__])
    from concurrent.futures.process import BrokenProcessPool
    try:
        pool = ProcessPoolExecutor(workers, mp_context=context, initializer=_scan_init, initargs=(state,))
    except (OSError, RuntimeError):
        return serial("fallback")
    finished = False
    try:
        results = []
        for result in pool.map(function, jobs, chunksize=max(1, len(jobs) // (workers * 4))):
            results.append(result)
            progress.advance(low + (high - low) * len(results) / total)
        finished = True
        global last_pool_mode
        last_pool_mode = "processes"
        return results
    except (BrokenProcessPool, OSError, RuntimeError):
        # Embedded hosts without a __main__ guard, sandboxes that forbid
        # subprocesses or memory limits: same results, only slower.
        pool.shutdown(wait=False, cancel_futures=True)
        return serial("fallback")
    finally:
        # A cancelled run must not wait for queued chunks.
        pool.shutdown(wait=finished, cancel_futures=not finished)


_RENDER_ASSETS = {}


def _sprite_small(assets, bid):
    building = assets.baker.entities[bid]
    width, depth = building["range"]["width"], building["range"]["depth"]
    return min(width, depth) <= 2 and bid not in ("loader_1", "unloader_1")


def _render_job(bid, state=None):
    state = state or _SCAN_STATE
    root = str(state["root"])
    assets = _RENDER_ASSETS.get(root)
    if assets is None:
        from .assets import RecognitionAssets
        assets = _RENDER_ASSETS[root] = RecognitionAssets(state["root"])
    small = _sprite_small(assets, bid)
    return {(direction, mode): assets.building(bid, direction, state["cell"], mode, with_icon=small)
            for direction in range(4) for mode in ("normal", None)}


def _render_sprites(assets, template_ids, cell):
    """Detection sprites per building. Rendering is pure, so worker processes
    (each with its own baker; it is not thread-safe) give identical pixels."""
    bids = list(template_ids)
    root = getattr(assets, "root", None)
    if root is None or type(assets).__name__ != "RecognitionAssets":
        return {bid: _render_job_with(assets, bid, cell) for bid in bids}
    _RENDER_ASSETS[str(root)] = assets
    rendered = _map_jobs(_render_job, {"root": root, "cell": cell}, bids, minimum=24, span=(0., .15))
    return dict(zip(bids, rendered))


def _render_job_with(assets, bid, cell):
    small = _sprite_small(assets, bid)
    return {(direction, mode): assets.building(bid, direction, cell, mode, with_icon=small)
            for direction in range(4) for mode in ("normal", None)}


class _BadgeBank:
    """Pre-rendered product badges with the asset-bank interface _product_choices uses."""

    def __init__(self, product_ids, badges):
        self.product_ids = product_ids
        self.badges = badges

    def badge(self, item_id, size, status="normal"):
        return self.badges.get((item_id, size, status))


def _product_job(job, state=None):
    state = state or _SCAN_STATE
    image, coverage, center, occlusion_axis, status = job
    return _product_choices(image, center, state["cell"], state["bank"], occlusion_axis=occlusion_axis,
                            coverage=coverage, status=status)


def _product_window(image, coverage, center, cell_size):
    """Crop around a badge so worker processes receive kilobytes, not the mosaic.

    The crop origin is even and the window reaches either the image edge or well
    past the badge, so rounding (half-to-even) and edge clipping inside
    _product_choices behave exactly as on the full image.
    """
    margin = int(cell_size * 2) + 8
    x0, y0 = max(0, int(center[0]) - margin), max(0, int(center[1]) - margin)
    x0, y0 = x0 - x0 % 2, y0 - y0 % 2
    x1, y1 = int(center[0]) + margin + 1, int(center[1]) + margin + 1
    window = np.ascontiguousarray(image[y0:y1, x0:x1])
    visible = None if coverage is None else np.ascontiguousarray(coverage[y0:y1, x0:x1])
    return window, visible, (center[0] - x0, center[1] - y0)


def _product_choices(image, center, cell_size, assets, item_ids=None, occlusion_axis=None,
                     coverage=None, status="normal"):
    # Work at the original screenshot resolution: product details are often only
    # 20 px wide after the device detector's inexpensive downsampling.
    badge_size = round(cell_size * 120 / 128)
    cx, cy = center
    pad = max(2, round(cell_size * .045))
    x, y = round(cx - badge_size / 2) - pad, round(cy - badge_size / 2) - pad
    patch = image[max(y, 0):y + badge_size + pad * 2, max(x, 0):x + badge_size + pad * 2]
    if patch.shape[0] < badge_size or patch.shape[1] < badge_size:
        return []
    hsv = cv2.cvtColor(patch, cv2.COLOR_BGR2HSV)
    # Monochrome machine glyphs are not product badges.
    if np.mean(hsv[:, :, 1] > 65) < .05:
        return []
    visible = None
    if coverage is not None:
        bx, by = max(0, x + pad), max(0, y + pad)
        visible = (coverage[by:by+badge_size, bx:bx+badge_size] > 0).astype(np.uint8)
        if visible.shape != (badge_size, badge_size):
            return []
        # Matching shifts a few pixels; erode missing-data boundaries so a shift
        # cannot count the UI tooltip or a synthesized white patch as evidence.
        if np.any(visible == 0):
            visible = cv2.erode(visible, np.ones((pad * 2 + 1, pad * 2 + 1), np.uint8))
        if visible.sum() < max(30, badge_size ** 2 * .1):
            return []
    choices = []
    for iid in assets.product_ids if item_ids is None else item_ids:
        sprite = assets.badge(iid, badge_size, status)
        if sprite is None:
            continue
        mask = (sprite[:, :, 3] > 150).astype(np.uint8)
        if visible is not None:
            mask &= visible
        if mask.sum() < max(30, badge_size ** 2 * .1):
            continue
        score = cv2.matchTemplate(patch, sprite[:, :, :3], cv2.TM_CCOEFF_NORMED, mask=mask)
        value = float(np.nan_to_num(score, nan=-1., posinf=-1.).max())
        if occlusion_axis:
            unobscured = mask.copy()
            middle, half = badge_size // 2, max(1, round(cell_size * .14))
            if occlusion_axis == "vertical":
                unobscured[:, middle-half:middle+half] = 0
            else:
                unobscured[middle-half:middle+half, :] = 0
            score = cv2.matchTemplate(patch, sprite[:, :, :3], cv2.TM_CCOEFF_NORMED,
                                      mask=unobscured)
            value = max(value, float(np.nan_to_num(score, nan=-1., posinf=-1.).max()))
        choices.append((value, iid))
    return sorted(choices, reverse=True)[:3]


def recognize_item_status(image, center, cell_size, assets, coverage=None):
    """Match the original small status glyph at its prefab-defined badge offset."""
    scores = []
    scale = cell_size / 128
    for status in ("locked", "expired", "limited"):
        layer = assets.status_layers(status)[-1]
        rgba = cv2.cvtColor(np.asarray(layer["image"]), cv2.COLOR_RGBA2BGRA)
        width, height = round(layer["width"] * scale), round(layer["height"] * scale)
        sprite = cv2.resize(rgba, (width, height), interpolation=cv2.INTER_AREA)
        x = round(center[0] + layer["x"] * scale)
        y = round(center[1] + layer["y"] * scale)
        pad = max(2, round(cell_size * .045))
        x0, y0 = max(0, x-pad), max(0, y-pad)
        patch = image[y0:y+height+pad, x0:x+width+pad]
        if patch.shape[0] < height or patch.shape[1] < width:
            continue
        mask = (sprite[:, :, 3] > 180).astype(np.uint8)
        if coverage is not None:
            visible = coverage[max(0, y):y+height, max(0, x):x+width]
            if visible.shape != mask.shape or np.mean(visible > 0) < .8:
                continue
            mask *= (visible > 0).astype(np.uint8)
        if mask.sum() < 15:
            continue
        values = cv2.matchTemplate(patch, sprite[:, :, :3], cv2.TM_CCORR_NORMED, mask=mask)
        values = np.nan_to_num(values, nan=-1, posinf=-1, neginf=-1)
        best = np.unravel_index(values.argmax(), values.shape)
        score = float(values[best])
        shape_values = cv2.matchTemplate(patch, sprite[:, :, :3], cv2.TM_CCOEFF_NORMED, mask=mask)
        shape_score = float(np.nan_to_num(shape_values, nan=-1, posinf=-1, neginf=-1)[best])
        if shape_score < .65:
            continue
        scores.append({"status": status, "score": round(score, 5), "sprite": layer["sprite"],
                       "shapeScore": round(shape_score, 5), "source": "original_status_sprite"})
    scores.sort(key=lambda row: row["score"], reverse=True)
    if not scores or scores[0]["score"] < .95 or scores[0]["shapeScore"] < .65:
        return None
    if len(scores) > 1 and scores[0]["score"] - scores[1]["score"] < .035:
        return None
    return scores[0]


def _logistic_layer(image, x, y, cell):
    """Disambiguate identical belt/pipe filter glyphs using their adjacent track."""
    yellow = []
    dark = []
    for dx, dy in ((0, -1), (1, 0), (0, 1), (-1, 0)):
        cx, cy = (x + .5 + dx * .72) * cell, (y + .5 + dy * .72) * cell
        half = max(2, round(cell * .11))
        x0, x1 = max(0, round(cx)-half), min(image.shape[1], round(cx)+half)
        y0, y1 = max(0, round(cy)-half), min(image.shape[0], round(cy)+half)
        if x1 <= x0 or y1 <= y0:
            continue
        patch = image[y0:y1, x0:x1]
        if not patch.size:
            continue
        hsv = cv2.cvtColor(patch, cv2.COLOR_BGR2HSV)
        yellow.append(np.mean((hsv[:, :, 0] > 15) & (hsv[:, :, 0] < 40)
                              & (hsv[:, :, 1] > 60) & (hsv[:, :, 2] > 150)))
        dark.append(np.mean(cv2.cvtColor(patch, cv2.COLOR_BGR2GRAY) < 120))
    if yellow and max(yellow) > .25:
        return "belt"
    if dark and max(dark) > .25:
        return "pipe"
    return None


def _product_evidence(mosaic, selected, origin, cell_size, assets, coverage):
    """Badge status and product choices for each selected hit, scored concurrently.

    Only the conditioner layer check later rewrites a hit's type, and it never
    turns a hit into or out of a warehouse port, so the occlusion axis computed
    here is the same one a serial pass would use.
    """
    jobs = []
    for hit in selected:
        center = (origin[0] + (hit["x"] + hit["width"] / 2) * cell_size,
                  origin[1] + (hit["y"] + hit["height"] / 2) * cell_size)
        occlusion_axis = None
        if hit["templateId"] in ("loader_1", "unloader_1"):
            occlusion_axis = "vertical" if hit["width"] == 1 else "horizontal"
        item_status = recognize_item_status(mosaic, center, cell_size, assets, coverage)
        jobs.append((center, occlusion_axis, item_status,
                     item_status["status"] if item_status else "normal"))
    # Render the badge sprites up front; workers only compare pixels.
    badge_size = round(cell_size * 120 / 128)
    product_ids = tuple(assets.product_ids)
    badges = {(iid, badge_size, status): assets.badge(iid, badge_size, status)
              for status in dict.fromkeys(job[3] for job in jobs) for iid in product_ids}
    state = {"cell": cell_size, "bank": _BadgeBank(product_ids, badges)}
    work = []
    for center, occlusion_axis, _, status in jobs:
        window, visible, local_center = _product_window(mosaic, coverage, center, cell_size)
        work.append((window, visible, local_center, occlusion_axis, status))
    choices = _map_jobs(_product_job, state, work, minimum=8, span=(.6, .97))
    return [(job[1], job[2], rows) for job, rows in zip(jobs, choices)]


def recognize_devices(mosaic, grid, project_root=PROJECT_ROOT, inventory=None,
                      template_ids=None, match_products=True, minimum_score=.63,
                      coverage=None, assets=None):
    """Return editor nodes and auditable scores, including rejected/ambiguous hits."""
    assets = assets or RecognitionAssets(project_root)
    if isinstance(mosaic, (str, Path)):
        if coverage is None and Path(mosaic).with_name("coverage.png").exists():
            coverage = Path(mosaic).with_name("coverage.png")
        mosaic = imageio.imread(str(mosaic))
    if mosaic is None:
        raise ValueError("Cannot read mosaic")
    cell_size, origin, (cols, rows) = _grid(grid)
    detection_cell = 24
    aligned = cv2.warpAffine(mosaic, np.float32([[1, 0, -origin[0]], [0, 1, -origin[1]]]),
                             (round(cols * cell_size), round(rows * cell_size)),
                             flags=cv2.INTER_LINEAR, borderValue=(229, 229, 229))
    # warpAffine's INTER_AREA aliases to bilinear; resize performs the actual
    # pixel-area integration required to preserve the game's thin frame lines.
    normalized = cv2.resize(aligned, (cols * detection_cell, rows * detection_cell),
                            interpolation=cv2.INTER_AREA)
    if isinstance(coverage, (str, Path)):
        coverage = imageio.imread(str(coverage), cv2.IMREAD_GRAYSCALE)
    source_coverage = coverage
    if coverage is not None:
        coverage = cv2.warpAffine(coverage, np.float32([[1, 0, -origin[0]], [0, 1, -origin[1]]]),
                                  (round(cols * cell_size), round(rows * cell_size)),
                                  flags=cv2.INTER_NEAREST, borderValue=0)
        coverage = cv2.resize(coverage, (cols * detection_cell, rows * detection_cell),
                              interpolation=cv2.INTER_NEAREST)
    gray = cv2.cvtColor(normalized, cv2.COLOR_BGR2GRAY)
    foreground_pipes = _foreground_pipe_mask(normalized, assets, detection_cell)
    inventory_prior = {}
    for row in inventory or []:
        bid = row.get("templateId")
        if bid in assets.baker.entities:
            inventory_prior[bid] = max(inventory_prior.get(bid, 0.),
                                       min(1., max(0., float(row.get("confidence", 1.)))))
    if template_ids is None:
        template_ids = assets.entity_ids
    candidates = []
    score_cache = {}
    pending = {}

    def score_key(rgba, footprint, exclude_badge, badge_radius=.54, use_coverage=True):
        # Normal/all-port faces and internal aliases often have identical pixels.
        # Scan each distinct picture only once; this does not eliminate any type.
        key = (rgba.shape, rgba.tobytes(), footprint, exclude_badge, badge_radius, use_coverage)
        if key not in pending:
            pending[key] = (rgba, footprint, exclude_badge, badge_radius, use_coverage)
        return key

    # Render sprites serially (the baker is not designed for concurrent use),
    # score every distinct picture concurrently, then assemble candidates in the
    # original catalog order so ranking ties resolve exactly as a serial scan.
    plan = []
    sprites = _render_sprites(assets, dict.fromkeys(template_ids), detection_cell)
    for bid in dict.fromkeys(template_ids):
        building = assets.baker.entities[bid]
        width, depth = building["range"]["width"], building["range"]["depth"]
        small = min(width, depth) <= 2 and bid not in ("loader_1", "unloader_1")
        for direction in range(4):
            w, h = (depth, width) if direction % 2 else (width, depth)
            for mode in ("normal", None):
                rgba = sprites[bid][direction, mode]
                key = score_key(rgba, (w, h), exclude_badge=not small)
                occluded_key = None
                if bid in assets.logistics and mode == "normal":
                    occluded_key = score_key(rgba, (w, h), exclude_badge=True,
                                             badge_radius=.49, use_coverage=False)
                plan.append((bid, direction, w, h, mode, key, occluded_key))
    keys = list(pending)
    state = {"gray": gray, "cell": detection_cell, "cols": cols, "rows": rows,
             "coverage": coverage, "pipes": foreground_pipes}
    score_cache.update(zip(keys, _map_scans(state, [pending[key] for key in keys], span=(.15, .6))))

    for bid, direction, w, h, mode, key, occluded_key in plan:
        hits, details = score_cache[key]
        for score, x, y in hits:
            candidates.append({"templateId": bid, "x": x, "y": y,
                               "direction": direction, "width": w, "height": h,
                               "score": round(score, 5), "formulaMode": mode,
                               **details.get((x, y), {})})
        if occluded_key is not None:
            hits, _ = score_cache[occluded_key]
            for score, x, y in hits:
                patch = normalized[y*detection_cell:(y+1)*detection_cell,
                                   x*detection_cell:(x+1)*detection_cell]
                saturation = cv2.cvtColor(patch, cv2.COLOR_BGR2HSV)[:, :, 1]
                if score > .75 and np.mean(saturation > 65) > .1:
                    candidates.append({"templateId": bid, "x": x, "y": y,
                                       "direction": direction, "width": w, "height": h,
                                       "score": round(score, 5), "formulaMode": mode,
                                       "productOccluded": True})
    # Counts never create nodes or lower acceptance thresholds. A tiny inventory
    # prior only breaks near-ties; strong missing-from-inventory visual matches win.
    candidates.sort(key=lambda row: row["score"] + .003 * inventory_prior.get(row["templateId"], 0.),
                    reverse=True)
    occupied = np.zeros((rows, cols), np.uint8)
    selected = []
    for candidate in candidates:
        if candidate["score"] < minimum_score:
            continue
        x, y, w, h = (candidate[k] for k in ("x", "y", "width", "height"))
        region = occupied[y:y+h, x:x+w]
        if np.any(region):
            continue
        region[:] = 1
        selected.append(candidate)
    selected.sort(key=lambda r: (r["y"], r["x"]))
    product_evidence = (_product_evidence(mosaic, selected, origin, cell_size, assets, source_coverage)
                        if match_products else None)
    nodes, diagnostics = [], []
    for index, hit in enumerate(selected):
        if hit["templateId"] in ("log_conditioner", "log_pipe_conditioner"):
            layer = _logistic_layer(normalized, hit["x"], hit["y"], detection_cell)
            if layer:
                hit["templateId"] = "log_conditioner" if layer == "belt" else "log_pipe_conditioner"
                hit["layerEvidence"] = "adjacent_" + layer + "_pixels"
        node = {"templateId": hit["templateId"], "position": {"x": hit["x"], "z": hit["y"]},
                "direction": hit["direction"]}
        if hit["formulaMode"] == "normal":
            node["formulaMode"] = "normal"
        evidence = {**hit, "nodeIndex": index}
        evidence["inventorySupported"] = hit["templateId"] in inventory_prior
        evidence["inventoryPrior"] = round(.003 * inventory_prior.get(hit["templateId"], 0.), 5)
        if coverage is not None:
            region = coverage[hit["y"]*detection_cell:(hit["y"]+hit["height"])*detection_cell,
                              hit["x"]*detection_cell:(hit["x"]+hit["width"])*detection_cell]
            evidence["visibleFraction"] = round(float(np.mean(region > 0)), 5)
            cx = (hit["x"] + hit["width"] / 2) * detection_cell
            cy = (hit["y"] + hit["height"] / 2) * detection_cell
            half = max(1, round(detection_cell * .44))
            center_region = coverage[max(0, round(cy)-half):round(cy)+half,
                                      max(0, round(cx)-half):round(cx)+half]
            evidence["productVisibleFraction"] = round(float(np.mean(center_region > 0)), 5)
        directions = sorted({c["direction"] for c in candidates
                             if c["templateId"] == hit["templateId"] and c["x"] == hit["x"]
                             and c["y"] == hit["y"] and c["width"] == hit["width"]
                             and c["height"] == hit["height"] and c["score"] > hit["score"] - .005})
        if len(directions) > 1:
            evidence["orientationAlternatives"] = directions
        alternatives = [c for c in candidates if c["x"] == hit["x"] and c["y"] == hit["y"]
                        and c["width"] == hit["width"] and c["height"] == hit["height"]
                        and c["templateId"] != hit["templateId"]][:3]
        evidence["alternatives"] = alternatives
        if hit["templateId"] in ("loader_1", "unloader_1"):
            port_candidates = [c for c in candidates if c["templateId"] in ("loader_1", "unloader_1")
                               and c["x"] == hit["x"] and c["y"] == hit["y"]
                               and c["width"] == hit["width"] and c["height"] == hit["height"]
                               and c["score"] > hit["score"] - .05]
            if len({c["templateId"] for c in port_candidates}) > 1:
                unique = {(c["templateId"], c["direction"]): c for c in port_candidates}
                evidence["warehousePortCandidates"] = list(unique.values())
                evidence["ambiguousWarehousePort"] = True
                node["ambiguousWarehousePort"] = True
        if match_products:
            occlusion_axis, item_status, choices = product_evidence[index]
            evidence["productAlternatives"] = [{"itemId": iid, "score": round(score, 5)}
                                                for score, iid in choices]
            if choices and choices[0][0] > .65:
                node["productIcon"] = choices[0][1]
                evidence["productSource"] = "visual_template"
                if evidence.get("productVisibleFraction", 1) < .99:
                    evidence["productMatchUsesCoverage"] = True
                if occlusion_axis:
                    evidence["productOverlayMask"] = occlusion_axis
                if item_status:
                    node["itemStatus"] = item_status["status"]
                    evidence["itemStatusEvidence"] = item_status
                if node["templateId"] in ("log_conditioner", "log_pipe_conditioner"):
                    phase = assets.factory_items.get(node["productIcon"], {}).get("phaseType")
                    if phase in (1, 2) and choices[0][0] > .8:
                        node["templateId"] = "log_conditioner" if phase == 1 else "log_pipe_conditioner"
                        evidence["templateId"] = node["templateId"]
                        evidence["layerEvidence"] = "recognized_product_factory_phase"
                        evidence["productPhaseType"] = phase
        nodes.append(node)
        diagnostics.append(evidence)
    producing = {row.get("machineId") for row in assets.baker.table("FactoryMachineCraftTable").values()}
    warnings = []
    for node, evidence in zip(nodes, diagnostics):
        if evidence.get("visibleFraction", 1) < .9:
            warnings.append({"code": "partially_occluded_device", "nodeIndex": evidence["nodeIndex"],
                             "visibleFraction": evidence["visibleFraction"],
                             "message": "Device matched only against visible pixels; inspect inventory consistency."})
            if node["templateId"] in producing and "productIcon" not in node:
                warnings.append({"code": "occluded_product", "nodeIndex": evidence["nodeIndex"],
                                 "message": "Product badge is occluded; no item was invented from the blank region."})
        if evidence["score"] < .8:
            warnings.append({"code": "lower_template_score", "nodeIndex": evidence["nodeIndex"],
                             "score": evidence["score"], "message": "Check overlapping tracks and device edges."})
    return {"nodes": nodes, "diagnostics": diagnostics, "warnings": warnings,
            "counts": dict(Counter(node["templateId"] for node in nodes)),
            "candidates": candidates, "inventory": inventory or [],
            "catalog": {"searchedTypes": len(set(template_ids)), "distinctPictures": len(score_cache),
                        "inventoryIsSoftPrior": True}}


DV = ((1, 0), (0, 1), (-1, 0), (0, -1))


def recover_translucent_logistics(images, registration, nodes, diagnostics, assets=None,
                                  minimum_score=.94):
    """Recover strongly visible logistics symbols beneath translucent tooltips.

    The clean mosaic intentionally masks UI overlays. This independent pass uses
    source-image pixels only inside detected tooltip rectangles, suppresses
    bright UI text/edges and compares contrast-normalized original sprites.
    A flat opaque rectangle, weak match, ambiguous type or occupied cell cannot
    create a node. Mutates nodes/diagnostics; returns separate source evidence.
    """
    assets = assets or RecognitionAssets()
    cell_size, origin, (cols, rows) = _grid(registration["grid"])
    sample_cell = 48
    occupied = set()
    for node in nodes:
        entity = assets.baker.entities[node["templateId"]]
        w, h = entity["range"]["width"], entity["range"]["depth"]
        if node.get("direction", 0) % 2:
            w, h = h, w
        occupied.update((node["position"]["x"] + dx, node["position"]["z"] + dz)
                        for dx in range(w) for dz in range(h))
    templates = []
    for bid in assets.logistics:
        for direction in range(4):
            rgba = assets.building(bid, direction, sample_cell)
            templates.append((bid, direction, cv2.cvtColor(composite(rgba), cv2.COLOR_BGR2GRAY),
                              (rgba[:, :, 3] > 10).astype(np.uint8)))
    candidates = []
    for source_index, (source, registered) in enumerate(zip(images, registration["images"])):
        boxes = registered.get("occlusions", [])
        if not boxes:
            continue
        source_image = source["image"] if isinstance(source, dict) else source
        source_gray = cv2.cvtColor(source_image, cv2.COLOR_BGR2GRAY)
        source_mask = np.zeros(source_gray.shape, np.uint8)
        for x0, y0, x1, y1 in boxes:
            source_mask[y0:y1, x0:x1] = 255
        source_mask[source_gray >= 60] = 0
        source_mask = cv2.erode(source_mask, np.ones((3, 3), np.uint8))
        transform = np.asarray(registered["transform"], dtype=np.float32).copy()
        transform[0, 2] -= origin[0]
        transform[1, 2] -= origin[1]
        native_size = (round(cols * cell_size), round(rows * cell_size))
        aligned = cv2.warpAffine(source_gray, transform, native_size, flags=cv2.INTER_LINEAR,
                                 borderValue=229)
        valid = cv2.warpAffine(source_mask, transform, native_size, flags=cv2.INTER_NEAREST,
                               borderValue=0)
        aligned = cv2.resize(aligned, (cols * sample_cell, rows * sample_cell),
                              interpolation=cv2.INTER_AREA)
        valid = cv2.resize(valid, (cols * sample_cell, rows * sample_cell),
                            interpolation=cv2.INTER_AREA) > 250
        for z in range(rows):
            for x in range(cols):
                if (x, z) in occupied:
                    continue
                sx, sy = x * sample_cell, z * sample_cell
                observed = valid[sy:sy+sample_cell, sx:sx+sample_cell]
                fraction = float(observed.mean())
                if fraction < .65:
                    continue
                patch = aligned[sy:sy+sample_cell, sx:sx+sample_cell]
                if float(patch[observed].std()) < 1.2:
                    continue
                ranked = []
                for bid, direction, template, alpha in templates:
                    mask = observed.astype(np.uint8) * alpha
                    if mask.mean() < .45:
                        continue
                    score = float(cv2.matchTemplate(patch, template, cv2.TM_CCOEFF_NORMED,
                                                    mask=mask)[0, 0])
                    if np.isfinite(score):
                        ranked.append((score, bid, direction))
                ranked.sort(reverse=True)
                if not ranked or ranked[0][0] < minimum_score:
                    continue
                score, bid, direction = ranked[0]
                second = next((value for value, other, _ in ranked if other != bid), -1.)
                if score - second < .05:
                    continue
                candidates.append({"templateId": bid, "x": x, "y": z, "direction": direction,
                                   "width": 1, "height": 1, "score": round(score, 5),
                                   "margin": round(score-second, 5), "sourceImageIndex": source_index,
                                   "source": "translucent_tooltip_pixels", "visibleFraction": 0.,
                                   "translucentVisibleFraction": round(fraction, 5),
                                   "alternatives": [{"templateId": b, "direction": d, "score": round(s, 5)}
                                                    for s, b, d in ranked[:3]]})
    recovered = []
    for candidate in sorted(candidates, key=lambda r: r["score"], reverse=True):
        key = candidate["x"], candidate["y"]
        if key in occupied:
            continue
        occupied.add(key)
        candidate["nodeIndex"] = len(nodes)
        nodes.append({"templateId": candidate["templateId"],
                      "position": {"x": key[0], "z": key[1]}, "direction": candidate["direction"]})
        diagnostics.append(candidate)
        recovered.append(candidate)
    return recovered


def resolve_warehouse_ports(nodes, conveyors, diagnostics, assets=None, line_evidence=None):
    """Resolve indistinguishable warehouse faces only from observed route arrows.

    The candidates retain their visual scores. Lines inferred from device ports,
    weak/hidden arrows, absent evidence and contradictory evidence cannot decide
    an intake versus an outlet. Call after detecting lines with ambiguous ports
    excluded from line-direction constraints.
    """
    try:
        from .lines import device_port_constraints
    except ImportError:
        from lines import device_port_constraints
    assets = assets or RecognitionAssets()
    direct = {}
    for row in line_evidence or []:
        if (not row.get("inferredFromConnectivity") and row.get("margin", 0.) >= .012
                and row.get("visibleFraction", 1.) >= .9):
            direct[row["x"], row["z"], row["kind"]] = row
    inferred = []
    for index, node in enumerate(nodes):
        evidence = next((d for d in diagnostics if d.get("nodeIndex") == index), {})
        candidates = evidence.get("warehousePortCandidates", [])
        if not evidence.get("ambiguousWarehousePort") or len(candidates) < 2:
            continue
        ranked = []
        for candidate in candidates:
            hypothesis = {**node, "templateId": candidate["templateId"], "direction": candidate["direction"]}
            hypothesis.pop("ambiguousWarehousePort", None)
            signals, conflicts = [], []
            for key, constraint in device_port_constraints([hypothesis], assets).items():
                line = direct.get(key)
                if line is None:
                    continue
                for field, directions in constraint.items():
                    if not directions:
                        continue
                    record = {"field": field, "expected": sorted(directions), "line": dict(line)}
                    (signals if line.get(field, line.get("dir")) in directions else conflicts).append(record)
            ranked.append((len(signals) if not conflicts else -len(conflicts), candidate, signals, conflicts))
        ranked.sort(key=lambda row: row[0], reverse=True)
        evidence["warehousePortConnectivity"] = [{"templateId": c["templateId"], "direction": c["direction"],
                                                  "support": score, "signals": signals, "conflicts": conflicts}
                                                 for score, c, signals, conflicts in ranked]
        if not ranked or ranked[0][0] <= 0 or (len(ranked) > 1 and ranked[0][0] <= ranked[1][0]):
            continue
        _, candidate, signals, _ = ranked[0]
        result = {"nodeIndex": index, "source": "visible_adjacent_route_arrows",
                  "before": {"templateId": node["templateId"], "direction": node["direction"]},
                  "after": {"templateId": candidate["templateId"], "direction": candidate["direction"]},
                  "signals": signals}
        node.update(result["after"])
        node.pop("ambiguousWarehousePort", None)
        evidence.update(result["after"], ambiguousWarehousePort=False, inferredFromConnectivity=True,
                        warehousePortInference=result)
        inferred.append(result)
    return inferred


def resolve_logistic_directions(nodes, conveyors, diagnostics):
    """Resolve a visually ambiguous filter rotation only from consistent flow.

    Mutates nodes/diagnostics and returns the evidence records. The game's
    FactoryBoxValveTable and FactoryFluidValveTable both give native output
    rotation.y=180, which becomes screen direction 1 (down) before node rotation.
    This mapping is device metadata, independent of any screenshot layout.
    """
    lines = {(row["x"], row["z"], row["kind"]): row for row in conveyors}
    evidence_by_index = {row.get("nodeIndex", i): row for i, row in enumerate(diagnostics)}
    inferred = []
    for index, node in enumerate(nodes):
        bid = node["templateId"]
        if bid not in ("log_conditioner", "log_pipe_conditioner"):
            continue
        evidence = evidence_by_index.get(index, {})
        alternatives = evidence.get("orientationAlternatives", evidence.get("directionAlternatives", []))
        if len(alternatives) < 2:
            continue
        kind = "fluid" if bid == "log_pipe_conditioner" else "item"
        x, z = node["position"]["x"], node["position"]["z"]
        signals = []
        for side, (dx, dz) in enumerate(DV):
            line = lines.get((x + dx, z + dz, kind))
            if line is None:
                continue
            if line["dir"] == (side + 2) % 4:
                signals.append({"role": "input", "flow": line["dir"], "line": dict(line)})
            if line.get("fromDir", line["dir"]) == side:
                signals.append({"role": "output", "flow": side, "line": dict(line)})
        flows = {row["flow"] for row in signals}
        if len(flows) != 1:
            continue
        flow = flows.pop()
        direction = (flow - 1) % 4
        if direction not in alternatives:
            continue
        record = {"nodeIndex": index, "previousDirection": node["direction"],
                  "direction": direction, "nativeOutputRotation": 180,
                  "flow": flow, "signals": signals, "inferredFromConnectivity": True}
        node["direction"] = direction
        evidence["direction"] = direction
        evidence["inferredFromConnectivity"] = True
        evidence["directionInference"] = record
        inferred.append(record)
    return inferred


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mosaic")
    parser.add_argument("registration")
    parser.add_argument("--inventory-image")
    parser.add_argument("--output", default="reports/ocr/devices.json")
    parser.add_argument("--no-products", action="store_true")
    args = parser.parse_args()
    registration = json.loads(Path(args.registration).read_text())
    inventory = recognize_inventory(args.inventory_image) if args.inventory_image else None
    result = recognize_devices(args.mosaic, registration["grid"], inventory=inventory,
                               match_products=not args.no_products)
    Path(args.output).write_text(json.dumps(result, ensure_ascii=False, indent=2))
    print(json.dumps({"nodes": len(result["nodes"]), "counts": result["counts"]}, ensure_ascii=False))


if __name__ == "__main__":
    main()
