"""Recognize directed belt and pipe tiles against original game artwork.

Tiles are compared in a normalized cell coordinate system. Colour segmentation
locates belts; silhouette and arrow correlation distinguish the twelve directed
straight/corner variants. Devices occlude belts; strong pipe strokes can be
recognized in front of any device without mistaking its watermark for a route.
"""
from __future__ import annotations

import cv2
import numpy as np

from .assets import RecognitionAssets, composite

CORNER = {0: {3: (1, 180), 1: (2, 270)}, 1: {0: (1, 90), 2: (2, 180)},
          2: {1: (1, 0), 3: (2, 90)}, 3: {2: (1, 270), 0: (2, 0)}}
CELL = 48
DV = [(1, 0), (0, 1), (-1, 0), (0, -1)]


def connection_conflicts(lines):
    """Flag both ends when an outgoing tile meets an incompatible inlet.

    This is a review hint, not authority to reverse a visible arrow. Adjacent
    parallel routes and different layers are deliberately left alone.
    """
    lookup = {(line["x"], line["z"], line["kind"]): line for line in lines}
    seen, conflicts, issues = set(), [], []
    for line in lines:
        dx, dy = DV[line["dir"]]
        key = (line["x"], line["z"], line["kind"])
        next_key = (line["x"] + dx, line["z"] + dy, line["kind"])
        neighbor = lookup.get(next_key)
        if neighbor is None or neighbor.get("fromDir", neighbor["dir"]) == line["dir"]:
            continue
        edge = tuple(sorted((key, next_key)))
        if edge in seen:
            continue
        seen.add(edge)
        conflicts.append({"kind": line["kind"], "from": {"x": key[0], "z": key[1]},
                          "to": {"x": next_key[0], "z": next_key[1]}})
        for current, other in ((line, neighbor), (neighbor, line)):
            issues.append({**current, "issue": "connection", "neighbor": {"x": other["x"], "z": other["z"]},
                           "reason": f"与相邻格 ({other['x']}, {other['z']}) 的出口和入口方向不衔接，请同时核对两端"})
    return conflicts, issues


def device_port_constraints(nodes, assets):
    constraints = {}
    for node in nodes:
        if node.get("ambiguousWarehousePort"):
            continue
        building = assets.buildings.get(node["templateId"])
        if building is None:
            continue
        for input_port, field in ((True, "inputPorts"), (False, "outputPorts")):
            for port in building[field]:
                if node.get("formulaMode") == "normal" and port["isPipe"]:
                    continue
                w, h = building["range"]["width"], building["range"]["depth"]
                position = port["trans"]["position"]
                x, y = position["x"], h - 1 - position["z"]
                direction = (port["trans"]["rotation"]["y"] // 90 + (2 if input_port else 0) + 3) % 4
                for _ in range(node["direction"]):
                    x, y, w, h = h - 1 - y, x, h, w
                    direction = (direction + 1) % 4
                if direction == 0: x = w - 1
                if direction == 2: x = 0
                if direction == 1: y = h - 1
                if direction == 3: y = 0
                dx, dy = DV[direction]
                key = (node["position"]["x"] + x + dx, node["position"]["z"] + y + dy,
                       "fluid" if port["isPipe"] else "item")
                constraint = constraints.setdefault(key, {"dir": set(), "fromDir": set()})
                constraint["dir" if input_port else "fromDir"].add((direction + 2) % 4 if input_port else direction)
    return constraints


def resolve_directions(lines, evidence, uncertain, choices, nodes, assets):
    """Only resolve hidden arrows when adjacent routes/ports favour one candidate."""
    lookup = {(b["x"], b["z"], b["kind"]): b for b in lines}
    constraints = device_port_constraints(nodes, assets)
    unresolved = dict(choices)
    # Each successful pass removes at least one candidate. A fixed four-pass
    # limit leaves long reverse-ordered runs unresolved despite a clear endpoint.
    for _ in range(len(unresolved) + 1):
        changed = False
        for key, candidates in list(unresolved.items()):
            x, y, kind = key
            ranked = []
            for score, incoming, outgoing in candidates:
                support = 0
                required = constraints.get(key, {})
                for field, direction in (("fromDir", incoming), ("dir", outgoing)):
                    if required.get(field):
                        support += 3 if direction in required[field] else -3
                dx, dy = DV[outgoing]
                target = (x + dx, y + dy, kind)
                next_line = lookup.get(target)
                if next_line and target not in unresolved:
                    support += 2 if next_line["fromDir"] == outgoing else -2
                dx, dy = DV[incoming]
                source = (x - dx, y - dy, kind)
                previous = lookup.get(source)
                if previous and source not in unresolved:
                    support += 2 if previous["dir"] == incoming else -2
                ranked.append((support, score, incoming, outgoing))
            ranked.sort(reverse=True)
            if len(ranked) > 1 and ranked[0][0] >= 2 and ranked[0][0] > ranked[1][0]:
                _, _, incoming, outgoing = ranked[0]
                lookup[key].update(fromDir=incoming, dir=outgoing)
                for row in evidence:
                    if (row["x"], row["z"], row["kind"]) == key:
                        row.update(fromDir=incoming, dir=outgoing, inferredFromConnectivity=True)
                del unresolved[key]
                changed = True
        if not changed:
            break
    for row in uncertain:
        key = row["x"], row["z"], row["kind"]
        if key in choices and key not in unresolved and row.get("issue", "direction") == "direction":
            row.update(dir=lookup[key]["dir"], fromDir=lookup[key]["fromDir"],
                       resolved=True, reason="箭头方向由相邻设备接口或线路推断")


def bridge_occlusions(lines, evidence, uncertain, visible, overlay_cells, size, blocked=None):
    """Bridge short straight gaps only where the screenshot cannot show the tile.

    Both visible endpoints must agree on direction. This never fills ordinary
    empty canvas, and every added cell is recorded as inferred, not observed.
    """
    lookup = {(b["x"], b["z"], b["kind"]): b for b in lines}
    blocked = blocked or set()
    for line in list(lines):
        if line["dir"] != line["fromDir"]:
            continue
        direction, kind = line["dir"], line["kind"]
        dx, dy = DV[direction]
        gap = []
        for distance in range(1, 5):
            x, y = line["x"] + distance*dx, line["z"] + distance*dy
            if not (0 <= x < size[0] and 0 <= y < size[1]):
                break
            if (x, y, kind) in blocked:
                break
            next_line = lookup.get((x, y, kind))
            if next_line:
                if gap and next_line["fromDir"] == direction:
                    for gx, gy in gap:
                        added = {"x": gx, "z": gy, "kind": kind, "dir": direction, "fromDir": direction}
                        lines.append(added)
                        lookup[gx, gy, kind] = added
                        evidence.append({**added, "inferredFromConnectivity": True,
                                         "reason": "遮挡区域两端同向直线连续"})
                        uncertain.append({**added, "issue": "gap", "resolved": True, "reason": "遮挡线路由两端同向直线连续推断"})
                break
            covered = visible is None or visible[y*CELL:(y+1)*CELL, x*CELL:(x+1)*CELL].mean() > .90
            if covered and not (kind == "fluid" and (x, y) in overlay_cells):
                break
            gap.append((x, y))


def tile_templates(assets, kind):
    name = "belt" if kind == "item" else "pipe"
    result = []
    for incoming in range(4):
        for outgoing in range(4):
            if (incoming + 2) % 4 == outgoing:
                continue
            start, end = (incoming + 1) % 4, (outgoing + 1) % 4
            corner = CORNER.get(start, {}).get(end)
            if corner:
                variant, rotation = corner
                key, angle = f"icon_{name}_corner_{variant}", rotation
            else:
                key, angle = f"icon_{name}_grid", -outgoing * 90
            im = assets.baker.sprite("blueprint/" + key).rotate(angle)
            rgba = cv2.cvtColor(np.asarray(im), cv2.COLOR_RGBA2BGRA)
            rgba = cv2.resize(rgba, (CELL, CELL), interpolation=cv2.INTER_AREA)
            rgb = composite(rgba)
            result.append({"dir": outgoing, "fromDir": incoming, "rgba": rgba,
                           "gray": cv2.cvtColor(rgb, cv2.COLOR_BGR2GRAY).astype(float),
                           "yellow": yellow(rgb), "mask": rgba[..., 3] > 128})
    return result


def yellow(image):
    b, g, r = cv2.split(image.astype(np.float32))
    return (np.minimum(g, r) - b > 25) & (r > 140) & (g > 140)


def correlate(a, b, mask):
    a, b = a[mask].astype(float), b[mask].astype(float)
    a, b = a - a.mean(), b - b.mean()
    norm = np.linalg.norm(a) * np.linalg.norm(b)
    return float(np.dot(a, b) / norm) if norm > 1 else 0.


def normalized_canvas(mosaic, grid):
    s = grid["cell_size"]
    ox, oy = grid["origin"]
    w, h = grid["size"]
    if ox == 0 and oy == 0:
        # warpAffine's INTER_AREA flag falls back to bilinear. Real area
        # resampling preserves fine arrows when reducing a high-resolution tile.
        return cv2.resize(mosaic, (w * CELL, h * CELL), interpolation=cv2.INTER_AREA)
    transform = np.array([[CELL / s, 0, -ox * CELL / s],
                          [0, CELL / s, -oy * CELL / s]], dtype=np.float32)
    return cv2.warpAffine(mosaic, transform, (w * CELL, h * CELL),
                          flags=cv2.INTER_AREA, borderValue=(229, 229, 229))


def recognize_lines(mosaic, grid, nodes, assets=None, coverage=None):
    assets = assets or RecognitionAssets()
    canvas = normalized_canvas(mosaic, grid)
    w, h = grid["size"]
    occupied = set()
    overlay_cells = set()
    for node in nodes:
        entity = assets.baker.entities[node["templateId"]]
        nw, nh = entity["range"]["width"], entity["range"]["depth"]
        if node["direction"] % 2:
            nw, nh = nh, nw
        x, y = node["position"]["x"], node["position"]["z"]
        occupied.update((x + dx, y + dy) for dx in range(nw) for dy in range(nh))
        if node["templateId"] in assets.logistics or node["templateId"] in {"loader_1", "unloader_1"}:
            overlay_cells.update((x + dx, y + dy) for dx in range(nw) for dy in range(nh))
    templates = {kind: tile_templates(assets, kind) for kind in ("item", "fluid")}
    lines, evidence, uncertain, choices = [], [], [], {}
    visible = None
    if coverage is not None:
        visible = cv2.resize((coverage > 0).astype(np.uint8), (w*CELL, h*CELL), interpolation=cv2.INTER_NEAREST) > 0
    # Ignore antialiasing at tile boundaries, which depends on subpixel capture.
    interior = np.ones((CELL, CELL), bool)
    interior[[0, -1], :] = False
    interior[:, [0, -1]] = False
    for y in range(h):
        for x in range(w):
            patch = canvas[y * CELL:(y + 1) * CELL, x * CELL:(x + 1) * CELL]
            gray = cv2.cvtColor(patch, cv2.COLOR_BGR2GRAY).astype(float)
            color = yellow(patch)
            dark = gray < 140
            cell_mask = interior.copy()
            if visible is not None:
                cell_mask &= visible[y*CELL:(y+1)*CELL, x*CELL:(x+1)*CELL]
                if cell_mask.mean() < .15:
                    continue
            pipe_overlay = None
            for kind in ("fluid", "item"):
                if kind == "item" and (x, y) in occupied:
                    continue
                if kind == "item" and color.mean() < .10:
                    continue
                if kind == "fluid" and dark.mean() < .055:
                    continue
                ranked = []
                for template in templates[kind]:
                    template_gray, template_yellow = template["gray"], template["yellow"]
                    if kind == "item" and pipe_overlay is not None:
                        under = composite(template["rgba"])
                        alpha = pipe_overlay["rgba"][..., 3:4].astype(float) / 255
                        combined = np.round(pipe_overlay["rgba"][..., :3] * alpha + under * (1-alpha)).astype(np.uint8)
                        template_gray = cv2.cvtColor(combined, cv2.COLOR_BGR2GRAY).astype(float)
                        template_yellow = yellow(combined)
                    if kind == "item":
                        union = (color | template_yellow) & cell_mask
                        overlap = (color & template_yellow & cell_mask).sum() / max(1, union.sum())
                        # The arrow is darker than both belt and background.
                        # Highpass removes slow illumination changes without
                        # discarding the central arrow's directional evidence.
                        corr = correlate(gray, template_gray, cell_mask)
                        score = .60 * overlap + .40 * max(0, corr)
                    else:
                        expected = template["gray"] < 140
                        union = (dark | expected) & cell_mask
                        overlap = (dark & expected & cell_mask).sum() / max(1, union.sum())
                        corr = correlate(gray, template["gray"], cell_mask)
                        score = .45 * overlap + .55 * max(0, corr)
                        if (x, y) in occupied:
                            # Opaque pipe strokes lie in front of device icons
                            # and logistics nodes. Their surroundings belong to
                            # the underlying device, not the pipe template.
                            stroke = (template["rgba"][..., 3] > 200) & cell_mask
                            if stroke.sum() > 40:
                                support = (dark & stroke).sum() / stroke.sum()
                                ink_corr = correlate(gray, template["gray"], stroke)
                                score = .35 * support + .65 * max(0, ink_corr)
                    ranked.append((score, template, overlap, corr))
                ranked.sort(key=lambda row: row[0], reverse=True)
                score, best, overlap, corr = ranked[0]
                threshold = .66 if kind == "item" else (.86 if (x, y) in occupied and (x, y) not in overlay_cells else .68)
                if score < threshold:
                    if (kind == "item" and color.mean() > .2) or (kind == "fluid" and score > .5 and (x,y) not in occupied):
                        uncertain.append({"x": x, "z": y, "kind": kind, "issue": "shape", "score": round(score, 3),
                                          "reason": "线路形状不足以可靠判断"})
                    continue
                line = {"x": x, "z": y, "kind": kind, "dir": best["dir"], "fromDir": best["fromDir"]}
                lines.append(line)
                if kind == "fluid":
                    pipe_overlay = best
                margin = score - ranked[1][0]
                evidence.append({**line, "score": round(score, 4), "margin": round(margin, 4),
                                 "overlaidByPipe": kind == "item" and pipe_overlay is not None})
                if margin < .012:
                    choices[x, y, kind] = [(float(s), t["fromDir"], t["dir"]) for s, t, _, _ in ranked if score-s < .035]
                    evidence[-1]["directionCandidates"] = [
                        {"score": round(s, 4), "fromDir": a, "dir": b} for s, a, b in choices[x, y, kind]]
                    uncertain.append({**line, "issue": "direction", "score": round(score, 3), "reason": "线路箭头方向接近，需核对"})
                if cell_mask.mean() < .80:
                    evidence[-1]["visibleFraction"] = round(float(cell_mask.mean()), 4)
                    uncertain.append({**line, "issue": "visibility", "score": round(score, 3),
                                      "reason": "截图缺失或界面遮挡了部分线路，形状与方向需核对"})
    resolve_directions(lines, evidence, uncertain, choices, nodes, assets)
    blocked = {(x, y, "item") for x, y in occupied}
    for node in nodes:
        if node["templateId"].startswith("log_pipe_"):
            blocked.add((node["position"]["x"], node["position"]["z"], "fluid"))
    bridge_occlusions(lines, evidence, uncertain, visible, overlay_cells, (w, h), blocked)
    return {"conveyors": lines, "evidence": evidence, "uncertain": uncertain}
