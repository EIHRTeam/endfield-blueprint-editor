"""Unicode-safe image file I/O.

``cv2.imread``/``cv2.imwrite`` take narrow C strings, so on Windows they fail
silently (returning None / False) for any path outside the ANSI code page, e.g.
an install folder or user name with Chinese characters. Python opens the file
here and OpenCV only encodes/decodes bytes.
"""
from pathlib import Path

import cv2
import numpy as np


def imread(path, flags=cv2.IMREAD_COLOR):
    """Like cv2.imread: None when the file is missing or not a decodable image."""
    try:
        data = np.fromfile(str(path), np.uint8)
    except OSError:
        return None
    if not data.size:
        return None
    return cv2.imdecode(data, flags)


def imwrite(path, image, params=()):
    """Like cv2.imwrite, raising instead of returning False so output is never silently missing."""
    path = Path(path)
    ok, encoded = cv2.imencode(path.suffix or ".png", image, list(params))
    if not ok:
        raise OSError(f"无法编码图片：{path.name}")
    encoded.tofile(str(path))
    return True
