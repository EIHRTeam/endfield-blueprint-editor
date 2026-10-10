"""Absolute-coordinate checks must reject captures missing blueprint edges."""
from pathlib import Path
import sys

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from ocr.stitch import normalize_resolutions, resolve_grid_origin, source_transform, _source_box
import ocr.stitch as stitch_module


PITCH = 68.26729941669838
SIZE = (33, 44)
PHASE = np.array([42.42920425850306, 159.79958773767325]) % PITCH
GOLDEN = np.array([42.42920425850306, 159.79958773767325])


def test_complete_envelope_has_one_absolute_grid_origin():
    origin = resolve_grid_origin([40, 154], [2321.82, 3185.18], PHASE, PITCH, SIZE)
    np.testing.assert_allclose(origin, GOLDEN)


@pytest.mark.parametrize("translation", [[444.82, 0], [-433.04, -1365.86], [0, -1843.18]])
def test_changing_registration_reference_preserves_absolute_layout(translation):
    translation = np.array(translation)
    origin = resolve_grid_origin(
        np.array([40, 154]) + translation,
        np.array([2321.82, 3185.18]) + translation,
        (PHASE + translation) % PITCH, PITCH, SIZE,
    )
    np.testing.assert_allclose(origin - translation, GOLDEN)


@pytest.mark.parametrize("translation", [[0, 0], [0, 1398.71], [444.80, 1843.18], [444.82, 0]])
def test_single_partial_screenshot_is_not_silently_centered(translation):
    # Viewport extents from screenshots 1, 3, 5, and 8. Relative registration
    # cannot tell which omitted grid cells are above/below or left/right.
    translation = np.array(translation)
    with pytest.raises(ValueError, match="请补拍左右和上下两端"):
        resolve_grid_origin(
            np.array([40, 154]) + translation,
            np.array([1877, 1342]) + translation,
            PHASE, PITCH, SIZE,
        )


@pytest.mark.parametrize("low,high,edges", [
    ([40, 154], [2321.82, 2200], "上下"),
    ([40, 154], [1877, 3185.18], "左右"),
])
def test_missing_one_axis_reports_which_edges_to_capture(low, high, edges):
    with pytest.raises(ValueError, match=f"请补拍{edges}两端"):
        resolve_grid_origin(low, high, PHASE, PITCH, SIZE)


def test_multiple_grid_origins_are_rejected_instead_of_guessing_center():
    with pytest.raises(ValueError, match="多个可能的网格位置"):
        resolve_grid_origin([0, 0], [2500, 3400], PHASE, PITCH, SIZE)


def test_different_whole_screen_resolutions_preserve_original_coordinate_mapping():
    high=np.full((360,640,3),229,np.uint8)
    low=np.full((180,320,3),229,np.uint8)
    low[40:50,60:70]=[5,20,100]
    normalized,scales=normalize_resolutions([low,high])
    assert scales==[(2.,2.),(1.,1.)]
    assert normalized[0].shape==high.shape
    assert normalized[1] is high
    assert normalized[0][90,130].tolist()==[5,20,100]
    assert _source_box([120,80,140,100],scales[0])==[60,40,70,50]


def test_cropped_aspect_ratio_is_rejected_instead_of_stretched():
    with pytest.raises(ValueError,match="宽高比不同"):
        normalize_resolutions([np.zeros((360,640,3),np.uint8),np.zeros((300,640,3),np.uint8)])


def test_same_resolution_images_are_not_resampled():
    images=[np.zeros((180,320,3),np.uint8),np.full((180,320,3),50,np.uint8)]
    normalized,scales=normalize_resolutions(images)
    assert all(a is b for a,b in zip(images,normalized))
    assert scales==[(1.,1.),(1.,1.)]


def test_source_transform_matches_resize_pixel_centers():
    registration=np.array([[1,0,-42.4],[0,1,385.1]])
    composed=source_transform(registration,(2.,2.))
    # OpenCV resize maps source pixel center (10,20) to (20.5,40.5).
    np.testing.assert_allclose(composed@np.array([10,20,1]),registration@np.array([20.5,40.5,1]))
    np.testing.assert_array_equal(source_transform(registration,(1.,1.)),registration)


def test_normalized_pixel_limit_is_checked_before_resampling(monkeypatch):
    high=np.zeros((20,20,3),np.uint8)
    low=np.zeros((10,10,3),np.uint8)
    # Originals total 500 pixels, but normalization would allocate 800.
    monkeypatch.setattr(stitch_module,"MAX_NORMALIZED_PIXELS",600)
    def forbidden_resize(*args,**kwargs):
        raise AssertionError("Resize ran before total-pixel validation")
    monkeypatch.setattr(stitch_module.cv2,"resize",forbidden_resize)
    with pytest.raises(ValueError,match="统一分辨率后总像素"):
        normalize_resolutions([high,low])


def test_scaled_registration_is_consumed_in_original_tooltip_coordinates():
    from ocr.occlusion import tooltip_evidence
    image=np.full((80,80,3),229,np.uint8)
    image[10:50,10:50]=20
    record={"occlusions":[[10,10,50,50]],"transform":source_transform(
        np.array([[1,0,20],[0,1,10]]),(2.,2.)).tolist()}
    canvas=np.full((200,200,3),232,np.uint8)
    coverage=np.zeros((200,200),np.uint8)
    restored,seen,weak=tooltip_evidence([{"image":image}],{"images":[record]},canvas,coverage)
    assert weak[70,80]==1
    assert restored[70,80].tolist()==[96,96,96]
    assert weak[30,30]==0


@pytest.mark.parametrize("scale", [1, 2])
def test_tooltip_touching_a_long_route_is_masked_without_hiding_the_route(scale):
    import cv2
    image=np.full((720,1280,3),229,np.uint8)
    image[110:600,520:531]=30
    image[300:345,400:561]=20
    # Text holes and an adjacent product badge reproduce the connected dark
    # component that used to be rejected for being taller than a tooltip.
    image[309:329,419:425]=230
    image[309:329,436:442]=230
    cv2.circle(image,(573,324),14,(25,25,25),-1)
    cv2.circle(image,(800,240),15,(25,25,25),-1)
    if scale!=1:
        image=cv2.resize(image,None,fx=scale,fy=scale,interpolation=cv2.INTER_NEAREST)
    mask,boxes=stitch_module.usable_mask(image,{"bounds":[20*scale,80*scale,1100*scale,670*scale]})
    assert boxes
    assert not mask[301*scale:344*scale,401*scale:560*scale].any()
    assert mask[200*scale,525*scale]==255
    assert mask[500*scale,525*scale]==255
    assert mask[240*scale,800*scale]==255


def synthetic_preview(horizontal=True, vertical=True, w=2560, h=1440):
    """Bare preview chrome: sidebar divider plus optional scroll thumbs."""
    image = np.full((h, w, 3), 215, np.uint8)
    image[int(h * .075):int(h * .28), 1906:1912] = (0, 220, 255)  # yellow divider
    if vertical:
        image[150:617, 1885:1893] = 50
    if horizontal:
        image[1355:1363, 85:1357] = 50
    return image


def test_preview_without_horizontal_scrollbar_uses_full_view_thumb():
    from ocr.stitch import preview_geometry
    scrolling = preview_geometry(synthetic_preview())
    fitted = preview_geometry(synthetic_preview(horizontal=False))
    # Same usable area; the missing axis gets a full-width thumb (no scroll offset).
    assert fitted["bounds"] == scrolling["bounds"] == [40, 154, 1877, 1342]
    assert fitted["scrolls"] == [False, True] and scrolling["scrolls"] == [True, True]
    x0, _, x1, _ = fitted["bounds"]
    assert fitted["horizontal_thumb"][0] == x0 and fitted["horizontal_thumb"][2] == x1 - x0
    no_vertical = preview_geometry(synthetic_preview(vertical=False))
    assert no_vertical["scrolls"] == [True, False] and no_vertical["bounds"][2] == scrolling["bounds"][2]
    with pytest.raises(ValueError, match="either preview scroll thumb"):
        preview_geometry(synthetic_preview(horizontal=False, vertical=False))


def test_fixed_axis_origin_is_chosen_by_where_the_content_lies():
    from ocr.stitch import resolve_fixed_axes
    pitch, size, phase = 68.27, (25, 45), np.array([24.73, 23.13])
    counts = np.zeros(1900, np.int64)
    counts[121:1792] = 300  # strokes span columns 1..25
    counts[1830:1848] = 40  # a tooltip that slipped past the occlusion mask
    profile = lambda axis: (0, counts)
    first, last = resolve_fixed_axes([1, 2], [2, 2], phase, pitch, size, [True, False], profile)
    assert list(first) == list(last) == [1, 2]
    # A scrolling axis is never guessed from content.
    first, last = resolve_fixed_axes([1, 2], [2, 2], phase, pitch, size, [False, False], profile)
    assert list(first) == [1, 2] and list(last) == [2, 2]
    # Content narrower than the blueprint stays ambiguous instead of guessing.
    counts[:] = 0
    counts[400:1200] = 300
    first, last = resolve_fixed_axes([1, 2], [2, 2], phase, pitch, size, [True, False], profile)
    assert first[0] != last[0]
