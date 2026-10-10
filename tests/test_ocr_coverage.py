"""Coverage review distinguishes absent evidence from small rasterization edges."""
from pathlib import Path
import sys

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from ocr.coverage import coverage_review


def test_map_and_review_regions_preserve_observed_coverage():
    fractions = [[0., .5, .995], [0., 1., 1.]]
    registration = {"coverage": {"cell_fractions": fractions}, "grid": {"size": [3, 2]}}
    source = np.full((96, 144, 3), 229, np.uint8)
    preview, regions = coverage_review(source, registration)
    assert preview.shape == source.shape
    assert len(regions) == 1
    assert regions[0]["bounds"] == {"x0": 0, "z0": 0, "x1": 2, "z1": 2}
    assert regions[0]["cells"] == 3
    assert regions[0]["missingFraction"] == .83333
    assert registration["coverage"]["cell_fractions"] == fractions
    assert np.all(source == 229)
    # Each legend class has a different rendered colour.
    assert len({tuple(preview[20, x]) for x in (20, 68, 116)}) == 3


def test_small_pixel_edge_gaps_do_not_create_review_tasks():
    registration = {"coverage": {"cell_fractions": [[.99, 1.], [.95, 1.]]}, "grid": {"size": [2, 2]}}
    _, regions = coverage_review(np.full((96, 96, 3), 229, np.uint8), registration)
    assert regions == []
