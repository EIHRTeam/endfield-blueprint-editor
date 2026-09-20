"""Build the portable editor from this project's native PNG and JSON inputs."""
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'src'))

if __name__ == '__main__':
    try:
        from build_editor import build
    except ModuleNotFoundError as error:
        if error.name == 'PIL':
            raise SystemExit('Install the build dependency: python -m pip install -r requirements.txt') from error
        raise
    output = build()
    print(f'Ready: {output}')
