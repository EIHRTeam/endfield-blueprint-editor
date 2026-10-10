"""Local Chinese OCR for blueprint metadata and inventory counts."""
from __future__ import annotations

import os
import re
import threading
from concurrent.futures import ThreadPoolExecutor
from functools import lru_cache

import cv2


@lru_cache(maxsize=1)
def engine():
    from rapidocr_onnxruntime import RapidOCR
    return RapidOCR(intra_op_num_threads=2, inter_op_num_threads=2)


_local = threading.local()


def _thread_engine():
    # One engine per worker thread: ONNX Runtime sessions are thread-safe, but
    # RapidOCR's Python wrapper keeps no such promise.
    if threading.current_thread() is threading.main_thread():
        return engine()
    if not hasattr(_local, "engine"):
        from rapidocr_onnxruntime import RapidOCR
        _local.engine = RapidOCR(intra_op_num_threads=2, inter_op_num_threads=2)
    return _local.engine


def read_text(image):
    result, _ = _thread_engine()(image)
    return [{"box": box, "text": text, "confidence": float(score)}
            for box, text, score in result or []]


def read_metadata(image):
    # The detail panel is separate from the panned canvas. Restricting OCR avoids
    # interpreting belt arrows and device symbols as characters.
    offset = round(image.shape[1] * .745)
    rows = read_text(image[:, offset:])
    for row in rows:
        row["box"] = [[x + offset, y] for x, y in row["box"]]
    result = {"text": rows, "warnings": []}
    for row in rows:
        value = row["text"].strip()
        match = re.fullmatch(r"(\d{1,2})\s*[×xX*]\s*(\d{1,2})", value)
        if match and row["confidence"] > .7:
            size = list(map(int, match.groups()))
            if all(1 <= n <= 50 for n in size):
                result["size"] = size
        if value.startswith(("[", "【")) and value.endswith(("]", "】")):
            result["name"] = value[1:-1]
        match = re.search(r"创作者\s*ID[.：:]?\s*(\d+)", value, re.I)
        if match:
            result["creatorId"] = match.group(1)
        if "未知配方" in value and row["confidence"] > .8:
            result["unknownRecipes"] = True
    if "name" not in result:
        # OCR often drops the decorative brackets. The title remains directly
        # above the dimensions label in the same column; don't take descriptions
        # or the general "blueprint details" heading as the blueprint name.
        labels = [row for row in rows if "蓝图尺寸" in row["text"]]
        candidates = []
        for label in labels:
            lx = min(p[0] for p in label["box"])
            ly = min(p[1] for p in label["box"])
            for row in rows:
                x = min(p[0] for p in row["box"])
                bottom = max(p[1] for p in row["box"])
                gap = ly - bottom
                if (row["confidence"] > .8 and 0 <= gap < image.shape[0] * .08
                        and abs(x - lx) < image.shape[1] * .06
                        and row["text"].strip() not in {"蓝图详情", "蓝图预览"}):
                    candidates.append((gap, row))
        if candidates:
            title = min(candidates, key=lambda value: value[0])[1]
            result["name"] = title["text"].strip().strip("[]【】")[:120]
            result["nameSource"] = "title_above_dimensions"
    if result.get("unknownRecipes"):
        result["warnings"].append("游戏截图提示存在未知配方，请核对配方和设备状态。")
    if "size" not in result:
        result["warnings"].append("未可靠识别蓝图尺寸，需人工核对网格范围。")
    return result


def read_count(image, box):
    """Read a card's lower count strip, returning None rather than guessing."""
    x, y, w, h = map(int, box)
    crop = image[y + round(h * .62):y + h, x:x + w]
    if not crop.size:
        return None
    crop = cv2.resize(crop, None, fx=3, fy=3, interpolation=cv2.INTER_CUBIC)
    rows = read_text(crop)
    candidates = [(int(r["text"]), r["confidence"]) for r in rows
                  if re.fullmatch(r"\d{1,3}", r["text"]) and r["confidence"] > .8]
    return max(candidates, key=lambda v: v[1])[0] if candidates else None


def read_counts(image, boxes, reader=None):
    """read_count for several cards; ONNX Runtime releases the GIL while inferring."""
    reader = reader or read_count
    boxes = list(boxes)
    workers = min(len(boxes), max(1, int(os.environ.get("BLUEPRINT_OCR_TEXT_THREADS", 4))))
    if workers <= 1:
        return [reader(image, box) for box in boxes]
    with ThreadPoolExecutor(workers) as pool:
        return list(pool.map(lambda box: reader(image, box), boxes))
