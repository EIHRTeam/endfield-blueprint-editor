"""Verify the packaged build inputs without accessing the game or old toolkit."""
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

if __name__ == '__main__':
    records = json.loads((ROOT / 'data/input_checksums.json').read_text('utf-8'))
    failed = []
    for name, expected in records.items():
        path = (ROOT / name).resolve()
        if not path.is_relative_to(ROOT) or not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest() != expected:
            failed.append(name)
    if failed:
        raise SystemExit('Changed or missing inputs:\n' + '\n'.join(failed))
    print(f'Verified {len(records)} local asset and data inputs')
