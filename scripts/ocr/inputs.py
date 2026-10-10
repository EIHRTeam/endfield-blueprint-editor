"""Bounded image, ZIP and video loading shared by CLI and local HTTP bridge."""
from __future__ import annotations

import base64
import io
import warnings
import zipfile
import zlib
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

MAX_BYTES = 64 * 1024 * 1024
MAX_IMAGES = 16
MAX_PIXELS = 24_000_000
IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".webp"}
MAX_VIDEO_BYTES = 256 * 1024 * 1024
VIDEO_SUFFIXES = {".mp4", ".mov", ".webm", ".mkv"}


class VideoFrames(list):
    """Selected image rows plus auditable recording metadata; no decoder handles."""
    def __init__(self, rows, video_report):
        super().__init__(rows)
        self.video_report = video_report


def load_video(path, name=None):
    path = Path(path)
    if path.suffix.lower() not in VIDEO_SUFFIXES:
        raise ValueError("录屏仅支持 MP4、MOV、WebM 或 MKV。")
    size = path.stat().st_size
    if not 0 < size <= MAX_VIDEO_BYTES:
        raise ValueError("请上传非空且不超过 256 MiB 的录屏。")
    from .video import extract_keyframes
    rows, report = extract_keyframes(path, max_frames=MAX_IMAGES)
    report.update(name=name or path.name, sizeBytes=size)
    return VideoFrames(rows, report)


def decode_files(files):
    if not isinstance(files, list) or not 1 <= len(files) <= MAX_IMAGES:
        raise ValueError("请选择 1–16 张截图，或一个 ZIP。")
    decoded, total = [], 0
    for item in files:
        if not isinstance(item, dict) or not isinstance(item.get("name"), str) or not isinstance(item.get("data"), str):
            raise ValueError("files 必须包含 name 和 base64 data。")
        if len(item["data"]) > (MAX_BYTES * 4 // 3 + 4):
            raise ValueError("文件总大小不能超过 64 MiB。")
        try:
            raw = base64.b64decode(item["data"], validate=True)
        except ValueError as error:
            raise ValueError("文件 base64 编码无效。") from error
        total += len(raw)
        if total > MAX_BYTES:
            raise ValueError("文件总大小不能超过 64 MiB。")
        decoded.append((item["name"], raw))
    return load_images(decoded)


def load_paths(paths):
    videos = [p for p in paths if Path(p).suffix.lower() in VIDEO_SUFFIXES]
    if videos:
        if len(paths) != 1:
            raise ValueError("请单独识别一个视频，不能和图片或 ZIP 混选。")
        return load_video(videos[0])
    total = sum(Path(p).stat().st_size for p in paths)
    if total > MAX_BYTES:
        raise ValueError("文件总大小不能超过 64 MiB。")
    return load_images([(Path(p).name, Path(p).read_bytes()) for p in paths])


def load_images(files):
    if not 1 <= len(files) <= MAX_IMAGES or sum(len(data) for _, data in files) > MAX_BYTES:
        raise ValueError("输入超出 16 个文件或 64 MiB 限制。")
    archives = [name for name, _ in files if Path(name).suffix.lower() == ".zip"]
    if archives:
        if len(files) != 1:
            raise ValueError("ZIP 请单独上传，不能和图片混选。")
        try:
            with zipfile.ZipFile(io.BytesIO(files[0][1])) as archive:
                entries = [e for e in archive.infolist() if not e.is_dir()
                           and Path(e.filename).suffix.lower() in IMAGE_SUFFIXES
                           and not e.filename.startswith("__MACOSX/")]
                if not 1 <= len(entries) <= MAX_IMAGES:
                    raise ValueError("ZIP 内需要有 1–16 张 PNG/JPEG/WebP 图片。")
                if sum(e.file_size for e in entries) > MAX_BYTES or any(e.flag_bits & 1 for e in entries):
                    raise ValueError("ZIP 解压大小超过 64 MiB，或含加密文件。")
                # No archive paths are ever written to the filesystem.
                files = [(Path(e.filename).name, archive.read(e)) for e in sorted(entries, key=lambda e: e.filename)]
        except (zipfile.BadZipFile, RuntimeError, NotImplementedError, zlib.error) as error:
            raise ValueError("无法读取此 ZIP 文件。") from error
    result, total_pixels = [], 0
    for name, data in files:
        if Path(name).suffix.lower() not in IMAGE_SUFFIXES:
            raise ValueError("只支持 PNG、JPEG、WebP 和 ZIP。")
        try:
            with warnings.catch_warnings():
                warnings.simplefilter("error", Image.DecompressionBombWarning)
                with Image.open(io.BytesIO(data)) as im:
                    width, height = im.size
                    total_pixels += width * height
                    if min(width, height) < 128 or width * height > MAX_PIXELS or total_pixels > 120_000_000:
                        raise ValueError("图片尺寸不适合识别：每张需至少 128px，最多 2400 万像素，总共最多 1.2 亿像素。")
                    if getattr(im, "n_frames", 1) != 1:
                        raise ValueError("请上传静态截图。")
                    pixels = cv2.cvtColor(np.asarray(im.convert("RGB")), cv2.COLOR_RGB2BGR)
        except (OSError, Image.DecompressionBombError, Image.DecompressionBombWarning) as error:
            raise ValueError(f"无法解码图片：{name}") from error
        result.append({"name": name, "image": pixels})
    return result
