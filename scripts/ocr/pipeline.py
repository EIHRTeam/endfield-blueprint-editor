"""Run the same auditable recognition pipeline from CLI and local service."""
from __future__ import annotations

import base64
from collections import Counter
import json
from pathlib import Path
import tempfile

import cv2

from .assets import RecognitionAssets
from .devices import (recognize_devices, resolve_logistic_directions, recover_translucent_logistics,
                      resolve_warehouse_ports)
from .lines import recognize_lines, connection_conflicts
from .occlusion import tooltip_evidence, supplement_lines
from .stitch import stitch
from .metadata import collect_panels, deduplicate_images
from .coverage import coverage_review
from . import imageio, progress


def validate_reconstruction(layout, assets):
    """Check the editor's geometric limits before writing or offering a result."""
    if len(layout["nodes"]) > 160:
        raise ValueError("识别到超过 160 个设备；请核对尺寸和截图是否来自同一蓝图。")
    occupied = set()
    for node in layout["nodes"]:
        row = assets.baker.entities[node["templateId"]]
        w, h = row["range"]["width"], row["range"]["depth"]
        if node["direction"] % 2:
            w, h = h, w
        x, z = node["position"]["x"], node["position"]["z"]
        if x < 0 or z < 0 or x+w > layout["size"]["x"] or z+h > layout["size"]["z"]:
            raise ValueError("识别的设备超出网格，不能输出有效布局。")
        cells = {(x+dx, z+dz) for dx in range(w) for dz in range(h)}
        if occupied & cells:
            raise ValueError("识别的设备存在重叠，不能输出有效布局。")
        occupied.update(cells)
    line_keys = set()
    for line in layout["conveyors"]:
        x, z = line["x"], line["z"]
        key = (x, z, line["kind"])
        if not (0 <= x < layout["size"]["x"] and 0 <= z < layout["size"]["z"]):
            raise ValueError("识别的线路超出网格。")
        if key in line_keys:
            raise ValueError("识别的线路重复。")
        line_keys.add(key)


def recognize(images, output_dir=None, size=None):
    if output_dir is None:
        with tempfile.TemporaryDirectory(prefix="blueprint-ocr-") as directory:
            return _recognize(images, Path(directory), size)
    return _recognize(images, Path(output_dir), size)


def _recognize(images, output, size):
    output.mkdir(parents=True, exist_ok=True)
    # Overall progress: a video's frame extraction (in load_video) owns 0–.14 (seconds-weighted).
    start = .14 if getattr(images, "video_report", None) is not None else 0.

    def span(a, b):
        return start + (1-start)*a, start + (1-start)*b
    progress.stage("加载识别素材", *span(0, .01))
    assets = RecognitionAssets()
    video_report = getattr(images, "video_report", None)
    input_count = len(images)
    images, input_records = deduplicate_images(images)
    progress.stage("读取右侧蓝图信息和设备清单", *span(.01, .24))
    metadata, inventory = collect_panels(images, assets, size_override=size)
    size = size or metadata.get("size")
    if not size or len(size) != 2 or not all(isinstance(n, int) and 1 <= n <= 50 for n in size):
        raise ValueError("无法可靠读取蓝图尺寸；请保留右侧蓝图详情，或在命令行指定 --size 宽 高。")
    paths = []
    for i, row in enumerate(images):
        path = output / f"input-{i+1:02}.png"
        imageio.imwrite(str(path), row["image"])
        paths.append(path)
    progress.stage("对齐并拼接画面", *span(.24, .66))
    registration = stitch(paths, output, tuple(size))
    mosaic = imageio.imread(str(output / registration["mosaic"]))
    coverage = imageio.imread(str(output / registration["coverage_mask"]), cv2.IMREAD_GRAYSCALE)
    coverage_map, review_regions = coverage_review(mosaic, registration)
    imageio.imwrite(str(output / "coverage-review.png"), coverage_map)
    progress.stage("识别设备和物品", *span(.66, .94))
    devices = recognize_devices(mosaic, registration["grid"], inventory=inventory, coverage=coverage, assets=assets)
    tooltip_nodes = recover_translucent_logistics(images, registration, devices["nodes"], devices["diagnostics"], assets)
    progress.stage("识别传送带和管道", *span(.94, .98))
    lines = recognize_lines(mosaic, registration["grid"], devices["nodes"], assets=assets, coverage=coverage)
    underlay, underlay_seen, weak = tooltip_evidence(images, registration, mosaic, coverage)
    tooltip_lines = []
    if weak.any():
        auxiliary = recognize_lines(underlay, registration["grid"], devices["nodes"], assets=assets, coverage=underlay_seen)
        tooltip_lines = supplement_lines(lines, auxiliary, weak, registration["grid"])
        imageio.imwrite(str(output / "tooltip-underlay.png"), underlay)
        imageio.imwrite(str(output / "tooltip-evidence.png"), weak*255)
    progress.stage("整理结果", *span(.98, 1))
    direction_inferences = resolve_logistic_directions(devices["nodes"], lines["conveyors"], devices["diagnostics"])
    warehouse_inferences = resolve_warehouse_ports(devices["nodes"], lines["conveyors"], devices["diagnostics"],
                                                   assets, lines["evidence"])
    for node in devices["nodes"]:
        node.pop("ambiguousWarehousePort", None)
    conflicts, connection_issues = connection_conflicts(lines["conveyors"])
    lines["uncertain"].extend(connection_issues)
    layout = {"schemaVersion": 2, "name": metadata.get("name", "截图识别蓝图"),
              "size": {"x": size[0], "z": size[1]}, "nodes": devices["nodes"],
              "conveyors": lines["conveyors"]}
    if metadata.get("creatorId"):
        layout["presentation"] = {"creatorId": metadata["creatorId"]}
    validate_reconstruction(layout, assets)
    warnings = list(metadata["warnings"])
    fraction = registration["coverage"]["pixel_fraction"]
    if fraction < .9999:
        warnings.append(f"截图有效覆盖 {fraction:.2%}；遮挡或未拍到的区域不能证明已完整还原，见覆盖图。")
    if tooltip_nodes or tooltip_lines:
        warnings.append(f"另从半透明提示框的低对比残留中恢复 {len(tooltip_nodes)} 个物流节点、{len(tooltip_lines)} 格线路；证据单列，未提高无遮挡覆盖率。")
    counts = Counter(node["templateId"] for node in layout["nodes"])
    inventory_check = []
    for card in inventory:
        bid = card.get("templateId")
        if bid not in assets.buildings or card.get("count") is None:
            continue
        expected, found = card["count"], counts[bid]
        inventory_check.append({"templateId": bid, "expected": expected, "recognized": found})
        if expected != found:
            warnings.append(f"{assets.name(assets.buildings[bid])}：清单 OCR 为 {expected}，布局识别为 {found}，需要核对。")
    if lines["uncertain"]:
        unresolved_cells = {(row["x"], row["z"], row["kind"]) for row in lines["uncertain"] if not row.get("resolved")}
        inferred_cells = {(row["x"], row["z"], row["kind"]) for row in lines["evidence"] if row.get("inferredFromConnectivity")}
        warnings.append(f"有 {len(unresolved_cells)} 处线路形状、可见范围或箭头待核对；{len(inferred_cells)} 处线路方向或线段由连接关系推断（两者可能重叠）；具体格坐标见识别报告。")
    else:
        unresolved_cells, inferred_cells = set(), set()
    partly_hidden = [row for row in devices["diagnostics"] if row.get("visibleFraction", 1) < .95]
    if partly_hidden:
        warnings.append(f"有 {len(partly_hidden)} 个设备部分被遮挡，位置与类型由可见轮廓匹配；被盖住的徽标需单独核对。")
    symmetric = [row for row in devices["diagnostics"] if len(row.get("orientationAlternatives", [])) > 1
                 and not row.get("inferredFromConnectivity")]
    if symmetric:
        warnings.append(f"有 {len(symmetric)} 个设备或物流节点有多个外观相近的候选朝向，见报告 orientationAlternatives。")
    ambiguous_ports = sum(bool(row.get("ambiguousWarehousePort")) for row in devices["diagnostics"])
    if ambiguous_ports:
        warnings.append(f"有 {ambiguous_ports} 个仓库口的徽标遮住类型箭头，缺少清晰相邻线路证据，取货/存货类型待核对；候选原始分数见报告。")
    warnings.append("截图无法证明隐藏配方、未显示的端口设置或地下管道配对；结果仅还原可见布局，需核对后导入。")
    report = {"version": 1, "status": "needs_review", "warnings": warnings,
              "summary": {"images": input_count, "uniqueImages": len(images), "nodes": len(layout["nodes"]),
                          "devices": sum(n["templateId"] in assets.buildings for n in layout["nodes"]),
                          "logistics": sum(n["templateId"] in assets.logistics for n in layout["nodes"]),
                          "productIcons": sum(bool(n.get("productIcon")) for n in layout["nodes"]),
                          "conveyors": len(layout["conveyors"]), "coverage": fraction,
                          "uncertainLineCells": len(unresolved_cells), "inferredLineCells": len(inferred_cells)},
              "metadata": metadata, "inventory": inventory, "inventoryCheck": inventory_check,
              "inputDeduplication": input_records,
              "registration": registration, "devices": devices["diagnostics"],
              "lines": lines["evidence"], "uncertainLines": lines["uncertain"],
              "connectionConflicts": conflicts,
              "reviewRegions": review_regions,
              "directionInferences": direction_inferences,
              "warehousePortInferences": warehouse_inferences,
              "translucentRecovery": {"nodes": tooltip_nodes, "lines": tooltip_lines}}
    # Paths in the service's temporary work area are not useful to the browser.
    for record, source in zip(report["registration"]["images"], images):
        record["path"] = source["name"]
        for field in ("timestampSeconds", "frameIndex"):
            if field in source:
                record[field] = source[field]
    if video_report is not None:
        report["video"] = video_report
        (output / "video-selection.json").write_text(json.dumps(video_report, ensure_ascii=False, indent=2), encoding="utf-8")
    scale = min(1., 1400 / max(mosaic.shape[:2]))
    preview = cv2.resize(mosaic, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
    _, encoded = cv2.imencode(".png", preview)
    coverage_preview = cv2.resize(coverage_map, (preview.shape[1], preview.shape[0]), interpolation=cv2.INTER_AREA)
    _, encoded_coverage = cv2.imencode(".png", coverage_preview)
    result = {"layout": layout, "report": report,
              "preview": "data:image/png;base64," + base64.b64encode(encoded).decode(),
              "coveragePreview": "data:image/png;base64," + base64.b64encode(encoded_coverage).decode()}
    (output / "blueprint.json").write_text(json.dumps(layout, ensure_ascii=False, indent=2), encoding="utf-8")
    (output / "recognition.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    return result
