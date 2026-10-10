"""Multi-image panels must not lose unseen types or count the same device twice."""
from pathlib import Path
import sys

import cv2
import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from ocr import metadata
from ocr.devices import recognize_inventory


def shots(*values):
    return [{"name": f"{index}.png", "image": np.full((128, 200, 3), value, np.uint8)}
            for index, value in enumerate(values)]


def mock_panels(monkeypatch, panels, inventories, counts):
    monkeypatch.setattr(metadata, "read_metadata", lambda image: panels[int(image[0, 0, 0])])
    monkeypatch.setattr(metadata, "recognize_inventory", lambda image, **kw: inventories[int(image[0, 0, 0])])
    monkeypatch.setattr(metadata, "read_count", lambda image, bounds: counts[int(image[0, 0, 0])])


def card(bid):
    return {"templateId": bid, "confidence": .98, "bounds": [150, 20, 12, 12]}


def test_exact_duplicates_ignore_filenames_but_keep_different_visible_content():
    images = shots(1, 1, 2)
    images[1]["name"] = "different-name.jpg"
    unique, records = metadata.deduplicate_images(images)
    assert len(unique) == 2
    assert records[1]["duplicateOf"] == 0
    assert [row["uniqueIndex"] for row in records] == [0, 0, 1]
    assert "duplicateOf" not in records[2]


def test_missing_first_panel_falls_back_to_later_screenshot(monkeypatch):
    mock_panels(monkeypatch, {1: {"warnings": ["未可靠识别蓝图尺寸，需人工核对网格范围。"]},
                             2: {"size": [39, 23], "name": "第二张读到名称", "warnings": []}},
                {1: [], 2: [card("new_device")]}, {1: None, 2: 3})
    result, inventory = metadata.collect_panels(shots(1, 2), None)
    assert result["size"] == [39, 23]
    assert result["name"] == "第二张读到名称"
    assert result["warnings"] == []
    assert inventory[0]["templateId"] == "new_device"
    assert inventory[0]["count"] == 3
    assert inventory[0]["sourceImages"] == [1]


def test_union_inventory_never_sums_repeated_count(monkeypatch):
    panels = {i: {"size": [10, 10], "warnings": []} for i in (1, 2)}
    mock_panels(monkeypatch, panels, {1: [card("first")], 2: [card("first"), card("second")]}, {1: 4, 2: 4})
    _, inventory = metadata.collect_panels(shots(1, 2), None)
    assert [(row["templateId"], row["count"]) for row in inventory] == [("first", 4), ("second", 4)]
    assert inventory[0]["sourceImages"] == [0, 1]


def test_conflicting_counts_are_unknown_and_auditable(monkeypatch):
    panels = {i: {"size": [10, 10], "warnings": []} for i in (1, 2)}
    mock_panels(monkeypatch, panels, {1: [card("first")], 2: [card("first")]}, {1: 1, 2: 11})
    result, inventory = metadata.collect_panels(shots(1, 2), None)
    assert inventory[0]["count"] is None
    assert inventory[0]["countAlternatives"] == [1, 11]
    assert any("冲突" in warning for warning in result["warnings"])


def test_conflicting_sizes_require_explicit_override(monkeypatch):
    mock_panels(monkeypatch, {1: {"size": [10, 10]}, 2: {"size": [11, 10]}},
                {1: [], 2: []}, {})
    with pytest.raises(ValueError, match="冲突"):
        metadata.collect_panels(shots(1, 2), None)
    result, _ = metadata.collect_panels(shots(1, 2), None, size_override=[10, 10])
    assert result["size"] == [10, 10]
    assert result["warnings"]


def test_identical_sidebar_ocr_is_cached_even_when_canvas_changes(monkeypatch):
    images = shots(1, 1)
    images[1]["image"][:, :130] = 255
    calls = []
    monkeypatch.setattr(metadata, "read_metadata", lambda image: calls.append(1) or {"size": [10, 10]})
    monkeypatch.setattr(metadata, "recognize_inventory", lambda image, **kw: [])
    result, _ = metadata.collect_panels(images, None)
    assert len(calls) == 1
    assert len(result["sources"]) == 2
    assert "name" not in result


def test_game_warning_survives_panel_fusion_once(monkeypatch):
    panels = {i: {"size": [10, 10], "unknownRecipes": True, "warnings": ["游戏提示未知配方"]} for i in (1, 2)}
    mock_panels(monkeypatch, panels, {1: [], 2: []}, {})
    result, _ = metadata.collect_panels(shots(1, 2), None)
    assert result["unknownRecipes"]
    assert result["warnings"] == ["游戏提示未知配方"]


class InventoryAssets:
    colors = {"red": (30, 50, 70), "blue": (70, 50, 30)}

    def inventory_items(self):
        return [(name, name) for name in self.colors]

    def item_icon(self, name):
        icon = np.empty((32, 32, 4), np.uint8)
        icon[:, :, :3] = self.colors[name]
        icon[:, :, 3] = 255
        return icon


def inventory_capture(color="red", x=800):
    image = np.full((400, 1000, 3), 255, np.uint8)
    image[200:250, x:x+50] = InventoryAssets.colors[color]
    return image


def test_inventory_cache_reuses_exact_pixels_at_new_positions_without_sharing_mutable_results(monkeypatch):
    assets, cache, calls = InventoryAssets(), {}, []
    match = cv2.matchTemplate

    def track(*args, **kwargs):
        calls.append(1)
        return match(*args, **kwargs)

    monkeypatch.setattr(cv2, "matchTemplate", track)
    first = recognize_inventory(inventory_capture(), assets=assets, card_cache=cache)
    assert first[0]["templateId"] == "red"
    initial_calls = len(calls)
    assert initial_calls > 0
    first[0]["alternatives"][0]["score"] = -1
    moved = recognize_inventory(inventory_capture(x=810), assets=assets, card_cache=cache)
    assert len(calls) == initial_calls
    assert moved[0]["bounds"] == [810, 200, 50, 50]
    assert moved[0]["count_bounds"][0] == 810
    assert moved[0]["alternatives"][0]["score"] > .99
    changed = recognize_inventory(inventory_capture("blue"), assets=assets, card_cache=cache)
    assert len(calls) > initial_calls
    assert changed[0]["templateId"] == "blue"
    assert changed == recognize_inventory(inventory_capture("blue"), assets=assets)


def test_panel_collection_reuses_unchanged_cards_but_rechecks_changed_count_pixels(monkeypatch):
    assets, match_calls, count_calls = InventoryAssets(), [], []
    first = inventory_capture()
    same_card = first.copy()
    same_card[100, 900] = 60  # Distinct panel, identical complete inventory card.
    changed_icon = same_card.copy()
    changed_icon[205, 801, 0] = 40  # Icon changes must not repeat OCR of unchanged digits.
    changed_count = changed_icon.copy()
    changed_count[248, 801, 0] = 40  # Outside the icon matching crop, inside the count strip.
    match = cv2.matchTemplate

    def track(*args, **kwargs):
        match_calls.append(1)
        return match(*args, **kwargs)

    def count(image, bounds):
        count_calls.append(1)
        x, y, w, h = bounds
        return int(image[y+h-2, x+1, 0])

    monkeypatch.setattr(cv2, "matchTemplate", track)
    monkeypatch.setattr(metadata, "read_metadata", lambda image: {"size": [10, 10], "warnings": []})
    monkeypatch.setattr(metadata, "read_count", count)
    images = [{"name": f"{index}.png", "image": image}
              for index, image in enumerate((first, same_card, changed_icon, changed_count))]
    result, inventory = metadata.collect_panels(images, assets)
    assert len(match_calls) == 3 * len(assets.colors) * 5
    assert len(count_calls) == 2
    assert inventory[0]["templateId"] == "red"
    assert inventory[0]["count"] is None
    assert inventory[0]["countAlternatives"] == [30, 40]
    assert inventory[0]["sourceImages"] == [0, 1, 2, 3]
    assert [row["count"] for row in inventory[0]["observations"]] == [30, 30, 30, 40]
    assert any("冲突" in warning for warning in result["warnings"])


def video_frames(*images):
    return [{"name": f"frame-{index}.png", "image": image, "frameIndex": index * 10}
            for index, image in enumerate(images)]


def textured_panel(seed=7):
    rng = np.random.default_rng(seed)
    image = np.full((400, 800, 3), 200, np.uint8)
    image[:, 600:] = rng.integers(60, 200, (400, 200, 1), dtype=np.uint8)
    return image


def test_video_frames_with_compression_noise_read_the_panel_once(monkeypatch):
    calls = []
    monkeypatch.setattr(metadata, "read_metadata", lambda image: calls.append(1) or {"size": [5, 5], "warnings": []})
    monkeypatch.setattr(metadata, "recognize_inventory", lambda image, **kw: [])
    first = textured_panel()
    noisy = cv2.add(first, np.random.default_rng(1).integers(0, 4, first.shape, dtype=np.uint8))
    # The canvas-side strip pans with the blueprint and must not prevent reuse.
    noisy[:, 560:590] = 30
    result, _ = metadata.collect_panels(video_frames(first, noisy), None)
    assert len(calls) == 1
    assert result["sources"][1]["panelReadFrom"] == 0


def test_video_frames_with_a_changed_glyph_are_read_again(monkeypatch):
    calls = []
    monkeypatch.setattr(metadata, "read_metadata", lambda image: calls.append(1) or {"size": [5, 5], "warnings": []})
    monkeypatch.setattr(metadata, "recognize_inventory", lambda image, **kw: [])
    first = textured_panel()
    changed = first.copy()
    cv2.putText(changed, "7", (680, 200), cv2.FONT_HERSHEY_SIMPLEX, .6, (255, 255, 255), 2)
    result, _ = metadata.collect_panels(video_frames(first, changed), None)
    assert len(calls) == 2
    assert "panelReadFrom" not in result["sources"][1]


def test_screenshots_never_use_noise_tolerant_panel_reuse(monkeypatch):
    calls = []
    monkeypatch.setattr(metadata, "read_metadata", lambda image: calls.append(1) or {"size": [5, 5], "warnings": []})
    monkeypatch.setattr(metadata, "recognize_inventory", lambda image, **kw: [])
    first = textured_panel()
    shots_ = [{"name": "a.png", "image": first}, {"name": "b.png", "image": cv2.add(first, 1)}]
    metadata.collect_panels(shots_, None)
    assert len(calls) == 2
