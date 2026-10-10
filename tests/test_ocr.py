"""Regression tests for the optional Python recognizer (python -m pytest tests/test_ocr.py)."""
import base64
import io
import json
from pathlib import Path
import sys
import zipfile

import cv2
import numpy as np
from PIL import Image
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from ocr.assets import RecognitionAssets, composite
from ocr.inputs import decode_files, load_images
from ocr.lines import CELL, recognize_lines, tile_templates
from ocr.text import read_metadata


def png(width=128, height=128):
    output = io.BytesIO()
    Image.new("RGB", (width, height), "white").save(output, "PNG")
    return output.getvalue()


def test_zip_paths_are_never_extracted(tmp_path):
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w") as archive:
        archive.writestr("../../escape.png", png())
        archive.writestr("__MACOSX/ignored.png", png())
    result = load_images([("pictures.zip", output.getvalue())])
    assert [row["name"] for row in result] == ["escape.png"]
    assert result[0]["image"].shape == (128, 128, 3)
    assert not (tmp_path / "escape.png").exists()


@pytest.mark.parametrize("files", [[], [{"name": "x.png", "data": "%%%"}],
                                    [{"name": "x.svg", "data": base64.b64encode(png()).decode()}],
                                    [{"name": "x.png", "data": base64.b64encode(b"bad").decode()}]])
def test_invalid_inputs_rejected(files):
    with pytest.raises(ValueError):
        decode_files(files)


def test_zip_file_count_limit():
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w") as archive:
        for i in range(17):
            archive.writestr(f"{i}.png", png())
    with pytest.raises(ValueError, match="1–16"):
        load_images([("many.zip", output.getvalue())])


def test_metadata_uses_real_ocr_boxes(monkeypatch):
    import ocr.text as text_module
    rows = [{"text": t, "confidence": .99, "box": [[0, 0], [10, 0], [10, 10], [0, 10]]}
            for t in ("[测试蓝图]", "33×44", "创作者ID.123")]
    monkeypatch.setattr(text_module, "read_text", lambda _: rows)
    result = read_metadata(np.zeros((200, 300, 3), np.uint8))
    assert result["size"] == [33, 44]
    assert result["name"] == "测试蓝图"
    assert result["creatorId"] == "123"
    assert result["text"][0]["box"][0][0] == round(300 * .745)


def test_title_without_decorative_brackets_uses_size_label_geometry(monkeypatch):
    import ocr.text as text_module
    def row(value, x, y):
        return {"text": value, "confidence": .99, "box": [[x, y], [x+70, y], [x+70, y+12], [x, y+12]]}
    rows = [row("蓝图详情", 0, 50), row("另一座工厂", 80, 90), row("蓝图尺寸", 80, 120),
            row("12×20", 80, 138), row("普通描述文字", 0, 180), row("有部分未知配方", 0, 500)]
    monkeypatch.setattr(text_module, "read_text", lambda _: rows)
    result = read_metadata(np.zeros((600, 1000, 3), np.uint8))
    assert result["name"] == "另一座工厂"
    assert result["nameSource"] == "title_above_dimensions"
    assert result["unknownRecipes"]
    assert result["warnings"] == ["游戏截图提示存在未知配方，请核对配方和设备状态。"]


@pytest.mark.parametrize("kind", ["item", "fluid"])
def test_all_directed_tiles_survive_illumination_and_resize(kind):
    assets = RecognitionAssets()
    templates = tile_templates(assets, kind)
    canvas = np.full((3 * CELL, 8 * CELL, 3), 229, np.uint8)
    expected = {}
    for i, tile in enumerate(templates):
        x, y = (i % 4) * 2, i // 4
        rendered = composite(tile["rgba"])
        # Capture brightness differs from the source asset; exact pixel equality
        # would pass a meaningless identity test but fail real screenshots.
        canvas[y*CELL:(y+1)*CELL, x*CELL:(x+1)*CELL] = np.clip(rendered * .93 + 12, 0, 255)
        expected[(x, y)] = (tile["fromDir"], tile["dir"])
    result = recognize_lines(canvas, {"cell_size": CELL, "origin": [0, 0], "size": [8, 3]}, [], assets)
    observed = {(b["x"], b["z"]): (b["fromDir"], b["dir"]) for b in result["conveyors"] if b["kind"] == kind}
    assert observed == expected


def test_blank_canvas_produces_no_lines():
    image = np.full((96, 96, 3), 229, np.uint8)
    result = recognize_lines(image, {"cell_size": 48, "origin": [0, 0], "size": [2, 2]}, [])
    assert result["conveyors"] == []


def test_pipe_over_device_badge_keeps_its_arrow():
    assets = RecognitionAssets()
    device = assets.building("unloader_1", 3, CELL, with_icon=True)
    canvas = composite(device)
    # Original artwork faces right; rotating clockwise makes its arrow down.
    pipe = assets.baker.sprite("blueprint/icon_pipe_grid").rotate(-90)
    pipe = cv2.cvtColor(np.asarray(pipe.resize((CELL, CELL))), cv2.COLOR_RGBA2BGRA)
    alpha = pipe[..., 3:4] / 255
    for y in range(3):
        patch = canvas[y*CELL:(y+1)*CELL]
        canvas[y*CELL:(y+1)*CELL] = np.round(pipe[..., :3]*alpha + patch*(1-alpha))
    node = {"templateId": "unloader_1", "position": {"x": 0, "z": 0}, "direction": 3}
    result = recognize_lines(canvas, {"cell_size": CELL, "origin": [0, 0], "size": [1, 3]}, [node], assets)
    assert [(b["z"], b["kind"], b["dir"]) for b in result["conveyors"]] == [(0, "fluid", 1), (1, "fluid", 1), (2, "fluid", 1)]


def test_occlusion_bridge_never_fills_visible_blank_cells():
    from ocr.lines import bridge_occlusions
    endpoints = [{"x": x, "z": 0, "kind": "item", "dir": 0, "fromDir": 0} for x in (0, 2)]
    visible = np.ones((CELL, 3*CELL), bool)
    evidence, uncertain = [], []
    lines = list(endpoints)
    bridge_occlusions(lines, evidence, uncertain, visible, set(), (3, 1))
    assert len(lines) == 2
    visible[:, CELL:2*CELL] = False
    bridge_occlusions(lines, evidence, uncertain, visible, set(), (3, 1))
    assert len(lines) == 3
    assert evidence[0]["inferredFromConnectivity"]
    assert uncertain[0]["resolved"]


def test_translucent_recovery_preserves_visible_pixels_and_masks_white_labels():
    from ocr.occlusion import tooltip_evidence
    image = np.full((96, 96, 3), 28, np.uint8)
    image[30:40, 30:40] = 255
    mosaic = np.full_like(image, 229)
    coverage = np.zeros((96, 96), np.uint8)
    coverage[:10] = 1
    registration = {"images": [{"occlusions": [[0, 0, 96, 96]], "transform": [[1, 0, 0], [0, 1, 0]]}]}
    restored, seen, weak = tooltip_evidence([image], registration, mosaic, coverage)
    assert np.all(restored[:10] == mosaic[:10])
    assert weak[20, 20] == 1 and seen[20, 20] == 1
    assert weak[35, 35] == 0 and seen[35, 35] == 0


def test_weak_lines_cannot_override_conflicting_direct_evidence():
    from ocr.occlusion import supplement_lines
    direct = {"x": 0, "z": 0, "kind": "item", "dir": 0, "fromDir": 0}
    other = {**direct, "dir": 2, "fromDir": 2}
    primary = {"conveyors": [direct], "evidence": [], "uncertain": []}
    auxiliary = {"conveyors": [other], "evidence": [{**other, "score": .98}]}
    result = supplement_lines(primary, auxiliary, np.ones((48, 48), np.uint8), {"cell_size": 48})
    assert result == [] and primary["conveyors"] == [direct]
    assert primary["uncertain"][0]["alternative"] == other


def test_strong_pipe_strokes_cross_large_storage_without_matching_its_watermark():
    assets = RecognitionAssets()
    canvas = composite(assets.building("log_hongs_bus", 2, CELL, with_icon=True))
    node = {"templateId": "log_hongs_bus", "position": {"x": 0, "z": 0}, "direction": 2}
    grid = {"cell_size": CELL, "origin": [0, 0], "size": [canvas.shape[1]//CELL, canvas.shape[0]//CELL]}
    assert recognize_lines(canvas, grid, [node], assets)["conveyors"] == []
    pipe = assets.baker.sprite("blueprint/icon_pipe_grid").resize((CELL, CELL))
    pipe = cv2.cvtColor(np.asarray(pipe), cv2.COLOR_RGBA2BGRA)
    alpha = pipe[..., 3:4] / 255
    for x in (0, 1):
        patch = canvas[3*CELL:4*CELL, x*CELL:(x+1)*CELL]
        canvas[3*CELL:4*CELL, x*CELL:(x+1)*CELL] = np.round(pipe[..., :3]*alpha + patch*(1-alpha))
    result = recognize_lines(canvas, grid, [node], assets)
    assert [(b["x"], b["z"], b["kind"], b["dir"]) for b in result["conveyors"]] == [(0, 3, "fluid", 0), (1, 3, "fluid", 0)]


def test_direction_inference_reaches_a_long_reverse_ordered_run():
    from ocr.lines import resolve_directions
    # The only visible arrow is at the right; the scan starts at the left.
    lines = [{"x": x, "z": 0, "kind": "item", "dir": 0 if x == 12 else 2,
              "fromDir": 0 if x == 12 else 2} for x in range(13)]
    evidence = [dict(row) for row in lines]
    uncertain = [dict(row) for row in lines[:-1]]
    choices = {(x, 0, "item"): [(.98, 2, 2), (.97, 0, 0)] for x in range(12)}
    resolve_directions(lines, evidence, uncertain, choices, [], RecognitionAssets())
    assert all(line["dir"] == line["fromDir"] == 0 for line in lines)
    assert all(row.get("resolved") for row in uncertain)
    assert all(row.get("inferredFromConnectivity") for row in evidence[:-1])


def test_unsupported_direction_cycle_remains_unresolved():
    from ocr.lines import resolve_directions
    lines = [{"x": x, "z": 0, "kind": "item", "dir": 0, "fromDir": 0} for x in range(8)]
    uncertain = [dict(row) for row in lines]
    choices = {(x, 0, "item"): [(.98, 2, 2), (.97, 0, 0)] for x in range(8)}
    resolve_directions(lines, [], uncertain, choices, [], RecognitionAssets())
    assert all(not row.get("resolved") for row in uncertain)


def test_resolving_an_arrow_does_not_resolve_occluded_shape():
    from ocr.lines import resolve_directions
    lines = [{"x": x, "z": 0, "kind": "item", "dir": 0, "fromDir": 0} for x in range(2)]
    uncertain = [{**lines[0], "issue": issue} for issue in ("direction", "visibility", "shape")]
    choices = {(0, 0, "item"): [(.98, 2, 2), (.97, 0, 0)]}
    resolve_directions(lines, [], uncertain, choices, [], RecognitionAssets())
    assert uncertain[0]["resolved"]
    assert "resolved" not in uncertain[1]
    assert "resolved" not in uncertain[2]


def test_connection_conflict_marks_both_ends_once_without_mutating_arrows():
    from copy import deepcopy
    from ocr.lines import connection_conflicts
    lines = [{"x": 0, "z": 0, "kind": "item", "dir": 0, "fromDir": 0},
             {"x": 1, "z": 0, "kind": "item", "dir": 2, "fromDir": 2}]
    original = deepcopy(lines)
    conflicts, issues = connection_conflicts(lines)
    assert len(conflicts) == 1
    assert {(i["x"], i["z"]) for i in issues} == {(0, 0), (1, 0)}
    assert all(i["issue"] == "connection" and not i.get("resolved") for i in issues)
    assert lines == original


def test_parallel_routes_crossing_layers_and_valid_turns_do_not_conflict():
    from ocr.lines import connection_conflicts
    lines = [{"x": 0, "z": 0, "kind": "item", "dir": 1, "fromDir": 1},
             {"x": 1, "z": 0, "kind": "item", "dir": 1, "fromDir": 1},
             {"x": 0, "z": 1, "kind": "item", "dir": 2, "fromDir": 1},
             {"x": 1, "z": 1, "kind": "fluid", "dir": 3, "fromDir": 3}]
    assert connection_conflicts(lines) == ([], [])


def test_cli_dispatches_one_video_without_reading_it_as_image(monkeypatch, tmp_path):
    import ocr.inputs as inputs
    path = tmp_path / "蓝图.MP4"
    path.write_bytes(b"video")
    frames = inputs.VideoFrames([{"name": "frame.png", "timestampSeconds": 1.5}], {"selectedFrames": []})
    calls = []
    def load(path):
        calls.append(path)
        return frames
    monkeypatch.setattr(inputs, "load_video", load)
    assert inputs.load_paths([path]) is frames
    assert calls == [path]
    with pytest.raises(ValueError, match="不能和图片"):
        inputs.load_paths([path, tmp_path / "image.png"])
    assert calls == [path]


def test_video_size_checked_before_decoder(monkeypatch, tmp_path):
    import ocr.inputs as inputs
    path = tmp_path / "video.mp4"
    path.write_bytes(b"12345")
    monkeypatch.setattr(inputs, "MAX_VIDEO_BYTES", 4)
    with pytest.raises(ValueError, match="256 MiB"):
        inputs.load_video(path)
