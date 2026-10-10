#!/usr/bin/env python3
"""Restore an editable blueprint from overlapping game preview screenshots."""
import argparse
import json
from pathlib import Path

from ocr.inputs import load_paths
from ocr.pipeline import recognize


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", nargs="+", type=Path, help="一个录屏、一个 ZIP 或多张同倍率游戏蓝图预览截图")
    parser.add_argument("--output", type=Path, default=Path("reports/ocr-result"))
    parser.add_argument("--size", nargs=2, type=int, metavar=("WIDTH", "HEIGHT"), help="覆盖 OCR 尺寸，单位为格")
    args = parser.parse_args()
    try:
        result = recognize(load_paths(args.input), args.output, args.size)
    except (ValueError, OSError) as error:
        parser.exit(2, f"识别失败：{error}\n")
    print(json.dumps(result["report"]["summary"], ensure_ascii=False, indent=2))
    for warning in result["report"]["warnings"]:
        print("需核对：" + warning)
    print(f"布局：{args.output / 'blueprint.json'}\n报告：{args.output / 'recognition.json'}")


if __name__ == "__main__":
    main()
