"""Evidence-sensitive device recognition regressions using original game art."""
from pathlib import Path
import sys

import cv2
import numpy as np
from PIL import Image
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from ocr.assets import RecognitionAssets, composite
from ocr.devices import (_logistic_layer, _product_choices, recover_translucent_logistics,
                         recognize_devices, recognize_item_status, resolve_logistic_directions,
                         resolve_warehouse_ports)


@pytest.fixture(scope="module")
def assets():
    return RecognitionAssets()


def badge_capture(assets):
    cell = 64
    item_id = "item_plant_moss_powder_3"
    image = np.full((96, 96, 3), 229, np.uint8)
    sprite = assets.badge(item_id, 60)
    # Lighting changes and an opaque tooltip ensure this exercises recognition,
    # not just equality between a baked sprite and itself.
    image[18:78, 18:78] = np.clip(composite(sprite) * .93 + 9, 0, 255).astype(np.uint8)
    return image, cell, item_id


def test_partial_badge_uses_only_visible_pixels(assets):
    image, cell, item_id = badge_capture(assets)
    image[47:, :] = (40, 60, 140)
    coverage = np.ones(image.shape[:2], np.uint8)
    coverage[47:, :] = 0
    candidates = [item_id, "item_originium_powder", "item_crystal_powder"]

    masked = _product_choices(image, (48, 48), cell, assets, candidates, coverage=coverage)
    unmasked = _product_choices(image, (48, 48), cell, assets, candidates)

    assert masked[0][1] == item_id
    assert masked[0][0] > .9
    assert masked[0][0] - max(score for score, _ in unmasked) > .2


def test_badge_with_no_observed_pixels_is_not_guessed(assets):
    image, cell, item_id = badge_capture(assets)
    # Even a perfect-looking synthesized image is not evidence when no source
    # photograph covered it.
    coverage = np.zeros(image.shape[:2], np.uint8)
    assert _product_choices(image, (48, 48), cell, assets, [item_id], coverage=coverage) == []


def test_plain_machine_center_is_not_reported_as_product(assets):
    gray = np.full((96, 96, 3), 229, np.uint8)
    gray[30:65, 40:55] = 73
    assert _product_choices(gray, (48, 48), 64, assets, ["item_originium_powder"]) == []


def filter_fixture():
    nodes = [{"templateId": "log_conditioner", "position": {"x": 4, "z": 5}, "direction": 3}]
    diagnostics = [{"nodeIndex": 0, "orientationAlternatives": [1, 3]}]
    return nodes, diagnostics


def test_filter_direction_follows_consistent_adjacent_arrows():
    nodes, diagnostics = filter_fixture()
    lines = [{"x": 5, "z": 5, "kind": "item", "dir": 2, "fromDir": 2},
             {"x": 3, "z": 5, "kind": "item", "dir": 2, "fromDir": 2}]

    inferred = resolve_logistic_directions(nodes, lines, diagnostics)

    # A native filter flows down; clockwise rotation 1 makes it flow left.
    assert nodes[0]["direction"] == 1
    assert len(inferred) == 1
    assert diagnostics[0]["inferredFromConnectivity"] is True
    assert {row["role"] for row in inferred[0]["signals"]} == {"input", "output"}


def test_conflicting_adjacent_arrows_leave_filter_unchanged():
    nodes, diagnostics = filter_fixture()
    lines = [{"x": 5, "z": 5, "kind": "item", "dir": 2, "fromDir": 2},
             {"x": 3, "z": 5, "kind": "item", "dir": 0, "fromDir": 0}]

    assert resolve_logistic_directions(nodes, lines, diagnostics) == []
    assert nodes[0]["direction"] == 3
    assert "inferredFromConnectivity" not in diagnostics[0]


@pytest.mark.parametrize("lines", [[], [{"x": 5, "z": 5, "kind": "fluid", "dir": 2, "fromDir": 2}]])
def test_missing_or_other_layer_cannot_set_filter_direction(lines):
    nodes, diagnostics = filter_fixture()
    assert resolve_logistic_directions(nodes, lines, diagnostics) == []
    assert nodes[0]["direction"] == 3


def test_connectivity_does_not_override_unambiguous_visual_direction():
    nodes, _ = filter_fixture()
    diagnostics = [{"nodeIndex": 0}]
    lines = [{"x": 5, "z": 5, "kind": "item", "dir": 2, "fromDir": 2}]
    assert resolve_logistic_directions(nodes, lines, diagnostics) == []
    assert nodes[0]["direction"] == 3


def tooltip_fixture(assets, opaque=False):
    image = np.full((144, 144, 3), 229, np.uint8)
    rgba = assets.building("log_connector", 2, 48)
    image[48:96, 48:96] = np.clip(composite(rgba) * .08 + 12, 0, 255).astype(np.uint8)
    if opaque:
        image[48:96, 48:96] = 25
    # Bright UI lettering is overlay content and must not become source evidence.
    image[48:51, 55:69] = 245
    registration = {"grid": {"cell_size": 48, "origin": [0, 0], "size": [3, 3]},
                    "images": [{"transform": [[1, 0, 0], [0, 1, 0]],
                                "occlusions": [[48, 48, 96, 96]]}]}
    return [{"image": image}], registration


def test_translucent_tooltip_retains_provable_logistic_symbol(assets):
    images, registration = tooltip_fixture(assets)
    nodes, diagnostics = [], []
    recovered = recover_translucent_logistics(images, registration, nodes, diagnostics, assets)
    assert len(recovered) == 1
    assert nodes == [{"templateId": "log_connector", "position": {"x": 1, "z": 1}, "direction": 2}]
    assert recovered[0]["score"] > .94
    assert recovered[0]["source"] == "translucent_tooltip_pixels"


def test_opaque_tooltip_cannot_create_logistic_node(assets):
    images, registration = tooltip_fixture(assets, opaque=True)
    nodes, diagnostics = [], []
    assert recover_translucent_logistics(images, registration, nodes, diagnostics, assets) == []
    assert nodes == []


def test_tooltip_recovery_never_overlaps_existing_device(assets):
    images, registration = tooltip_fixture(assets)
    nodes = [{"templateId": "grinder_1", "position": {"x": 0, "z": 0}, "direction": 0}]
    assert recover_translucent_logistics(images, registration, nodes, [], assets) == []
    assert len(nodes) == 1


def test_incomplete_wrong_inventory_is_only_a_soft_prior(assets):
    cell = 32
    image = Image.new("RGBA", (8*cell, 6*cell), (229, 229, 229, 255))
    for bid, x, z, direction in [("grinder_1", 1, 1, 3), ("power_diffuser_2", 5, 3, 0)]:
        sprite = assets.baker.building(bid, direction)
        sprite = sprite.resize((round(sprite.width*cell/128), round(sprite.height*cell/128)),
                                Image.Resampling.LANCZOS)
        image.alpha_composite(sprite, (x*cell, z*cell))
    pixels = cv2.cvtColor(np.asarray(image.convert("RGB")), cv2.COLOR_RGB2BGR)
    pixels = np.clip(pixels*.93+12, 0, 255).astype(np.uint8)
    result = recognize_devices(pixels, {"cell_size": cell, "origin": [0, 0], "size": [8, 6]},
                               inventory=[{"templateId": "storager_1", "confidence": 1., "count": 50}],
                               match_products=False, assets=assets)
    assert {(n["templateId"], n["position"]["x"], n["position"]["z"]) for n in result["nodes"]} == {
        ("grinder_1", 1, 1), ("power_diffuser_2", 5, 3)}
    assert all(not row["inventorySupported"] for row in result["diagnostics"])
    assert result["catalog"]["inventoryIsSoftPrior"] is True


def test_shared_blueprint_icon_cannot_replace_factory_product_id(assets):
    item_id = "item_xiranite_powder"
    pixels = np.full((96, 96, 3), 229, np.uint8)
    pixels[18:78, 18:78] = composite(assets.badge(item_id, 60))
    choices = _product_choices(pixels, (48, 48), 64, assets)
    assert choices[0][1] == item_id
    assert choices[0][0] > .95
    assert "sysbp_wuling_xiranite_powder_1" not in assets.product_ids


@pytest.mark.parametrize("status", ["normal", "locked"])
def test_status_requires_original_corner_glyph_and_composes_badge_overlay(assets, status):
    canvas = Image.new("RGBA", (160, 160), (229, 229, 229, 255))
    badge = assets.baker.product_badge("item_carbon_powder").resize((60, 60), Image.Resampling.LANCZOS)
    canvas.alpha_composite(badge, (50, 50))
    for layer in assets.status_layers(status):
        sprite = layer["image"].resize((round(layer["width"]*.5), round(layer["height"]*.5)),
                                        Image.Resampling.LANCZOS)
        canvas.alpha_composite(sprite, (round(80+layer["x"]*.5), round(80+layer["y"]*.5)))
    pixels = cv2.cvtColor(np.asarray(canvas.convert("RGB")), cv2.COLOR_RGB2BGR)
    pixels = np.clip(pixels*.95+8, 0, 255).astype(np.uint8)
    evidence = recognize_item_status(pixels, (80, 80), 64, assets)
    if status == "normal":
        assert evidence is None
    else:
        assert evidence["status"] == "locked"
        assert evidence["score"] > .95
        assert evidence["source"] == "original_status_sprite"
        choices = _product_choices(pixels, (80, 80), 64, assets,
                                   ["item_carbon_powder", "item_originium_powder"], status="locked")
        assert choices[0][1] == "item_carbon_powder"
        assert choices[0][0] > .9


@pytest.mark.parametrize("rotation,include_device", [(0, True), (1, True), (0, False)])
def test_foreground_pipes_do_not_hide_or_invent_machine_frames(assets, rotation, include_device):
    cell = 48
    canvas = Image.new("RGBA", (8*cell, 12*cell), (229, 229, 229, 255))
    if include_device:
        body = assets.baker.building("log_hongs_bus", 0).resize((4*cell, 8*cell), Image.Resampling.LANCZOS)
        canvas.alpha_composite(body, (2*cell, 2*cell))
    # Every column of the machine is crossed by a real foreground pipe. The
    # otherwise identical negative case has routes but no machine border.
    pipe = assets.baker.sprite("blueprint/icon_pipe_grid").rotate(-90).resize((cell, cell), Image.Resampling.LANCZOS)
    for x in range(2, 6):
        for y in range(12):
            canvas.alpha_composite(pipe, (x*cell, y*cell))
    pixels = cv2.cvtColor(np.asarray(canvas.convert("RGB")), cv2.COLOR_RGB2BGR)
    pixels = np.rot90(pixels, -rotation).copy()
    pixels = np.clip(pixels*.94+9, 0, 255).astype(np.uint8)
    size = [pixels.shape[1] // cell, pixels.shape[0] // cell]
    result = recognize_devices(pixels, {"cell_size": cell, "origin": [0, 0], "size": size},
                               template_ids=["log_hongs_bus", "grinder_1", "storager_1"],
                               match_products=False, assets=assets)
    if include_device:
        assert [(node["templateId"], node["position"]) for node in result["nodes"]] == [
            ("log_hongs_bus", {"x": 2, "z": 2})]
        assert result["diagnostics"][0]["matchMaskSource"] == "original_pipe_strokes"
        assert result["diagnostics"][0]["score"] > .88
    else:
        assert result["nodes"] == []


def test_border_filter_never_samples_wrapped_image_rows():
    image = np.full((6*24, 6*24, 3), 229, np.uint8)
    image[24:48, 3*24+9:3*24+15] = 80
    # Distant belts cannot be taken as an above-canvas neighbour of a top filter.
    image[48:, 3*24:4*24] = (30, 240, 240)
    assert _logistic_layer(image, 3, 0, 24) == "pipe"


@pytest.mark.parametrize("bid,direction", [("loader_1", 1), ("unloader_1", 3)])
def test_visible_warehouse_port_arrows_distinguish_load_from_unload(assets, bid, direction):
    cell = 48
    canvas = Image.new("RGBA", (5*cell, 5*cell), (229, 229, 229, 255))
    device = assets.baker.building(bid, direction).resize((cell, 3*cell), Image.Resampling.LANCZOS)
    canvas.alpha_composite(device, (2*cell, cell))
    badge = assets.baker.product_badge("item_plant_moss_3").resize((45, 45), Image.Resampling.LANCZOS)
    canvas.alpha_composite(badge, (round(2.5*cell-22.5), round(2.5*cell-22.5)))
    pixels = cv2.cvtColor(np.asarray(canvas.convert("RGB")), cv2.COLOR_RGB2BGR)
    result = recognize_devices(pixels, {"cell_size": cell, "origin": [0, 0], "size": [5, 5]},
                               template_ids=["loader_1", "unloader_1"], match_products=False, assets=assets)
    assert [(node["templateId"], node["direction"]) for node in result["nodes"]] == [(bid, direction)]


@pytest.mark.parametrize("item_id,expected", [("item_liquid_water", "log_pipe_conditioner"),
                                               ("item_plant_grass_2", "log_conditioner")])
def test_badged_filter_layer_uses_original_product_phase(assets, item_id, expected):
    cell = 64
    canvas = Image.new("RGBA", (3*cell, 3*cell), (229, 229, 229, 255))
    symbol = assets.baker.building("log_conditioner", 0).resize((cell, cell), Image.Resampling.LANCZOS)
    canvas.alpha_composite(symbol, (cell, cell))
    badge = assets.baker.product_badge(item_id).resize((60, 60), Image.Resampling.LANCZOS)
    canvas.alpha_composite(badge, (cell+2, cell+2))
    pixels = cv2.cvtColor(np.asarray(canvas.convert("RGB")), cv2.COLOR_RGB2BGR)
    result = recognize_devices(pixels, {"cell_size": cell, "origin": [0, 0], "size": [3, 3]},
                               template_ids=["log_conditioner", "log_pipe_conditioner"], assets=assets)
    assert len(result["nodes"]) == 1
    assert result["nodes"][0]["templateId"] == expected
    assert result["diagnostics"][0]["layerEvidence"] == "recognized_product_factory_phase"


def warehouse_fixture():
    nodes = [{"templateId": "loader_1", "position": {"x": 2, "z": 2}, "direction": 1,
              "ambiguousWarehousePort": True}]
    diagnostics = [{"nodeIndex": 0, "ambiguousWarehousePort": True, "warehousePortCandidates": [
        {"templateId": "loader_1", "direction": 1, "score": .97},
        {"templateId": "unloader_1", "direction": 3, "score": .965}]}]
    line = {"x": 3, "z": 3, "kind": "item", "dir": 0, "fromDir": 0, "margin": .1, "score": .98}
    return nodes, diagnostics, line


def test_warehouse_role_uses_direct_observed_arrow(assets):
    nodes, diagnostics, line = warehouse_fixture()
    result = resolve_warehouse_ports(nodes, [line], diagnostics, assets, [line])
    assert nodes[0]["templateId"] == "unloader_1"
    assert nodes[0]["direction"] == 3
    assert "ambiguousWarehousePort" not in nodes[0]
    assert result[0]["source"] == "visible_adjacent_route_arrows"
    assert diagnostics[0]["warehousePortCandidates"][0]["score"] == .97


@pytest.mark.parametrize("uncertain", [{"margin": .005}, {"inferredFromConnectivity": True},
                                        {"visibleFraction": .5}, None, {"dir": 2}])
def test_warehouse_role_does_not_follow_weak_missing_or_conflicting_evidence(assets, uncertain):
    nodes, diagnostics, line = warehouse_fixture()
    if uncertain is not None:
        line.update(uncertain)
    result = resolve_warehouse_ports(nodes, [line], diagnostics, assets,
                                     [] if uncertain is None else [line])
    assert result == []
    assert nodes[0]["templateId"] == "loader_1"
    assert diagnostics[0]["ambiguousWarehousePort"] is True


def test_parallel_template_scan_matches_serial_scan(monkeypatch):
    from ocr import devices as module
    rng = np.random.default_rng(3)
    gray = rng.integers(0, 255, (24 * 8, 24 * 9), dtype=np.uint8)
    coverage = np.full(gray.shape, 255, np.uint8)
    coverage[:30, :50] = 0
    state = {"gray": gray, "cell": 24, "cols": 9, "rows": 8, "coverage": coverage, "pipes": None}
    jobs = []
    for index in range(40):
        rgba = np.zeros((24, 48, 4), np.uint8)
        rgba[..., :3] = gray[24:48, 24 * (index % 7):24 * (index % 7) + 48, None]
        rgba[..., 3] = 255
        jobs.append((rgba, (2, 1), False, .54, index % 2 == 0))
    monkeypatch.setenv("BLUEPRINT_OCR_THREADS", "1")
    serial = module._map_scans(state, jobs)
    monkeypatch.setenv("BLUEPRINT_OCR_THREADS", "3")
    parallel = module._map_scans(state, jobs)
    assert parallel == serial
    assert any(hits for hits, _ in serial)


@pytest.mark.parametrize("threads", ["1", "3"])
def test_template_scan_reports_progress_and_stops_when_cancelled(monkeypatch, threads):
    from ocr import devices as module, progress
    rng = np.random.default_rng(5)
    gray = rng.integers(0, 255, (24 * 6, 24 * 6), dtype=np.uint8)
    state = {"gray": gray, "cell": 24, "cols": 6, "rows": 6, "coverage": None, "pipes": None}
    rgba = np.dstack([gray[:24, :48]] * 3 + [np.full((24, 48), 255, np.uint8)])
    jobs = [(rgba, (2, 1), False, .54, False)] * 64
    monkeypatch.setenv("BLUEPRINT_OCR_THREADS", threads)
    seen = []

    def report(stage, fraction):
        seen.append(fraction)
        if len(seen) == 3:
            raise progress.Cancelled()

    with progress.reporting(report), pytest.raises(progress.Cancelled):
        progress.stage("设备", .5, .9)
        module._map_scans(state, jobs, span=(0., .5))
    assert seen[0] == .5 and .5 < seen[2] < .7
