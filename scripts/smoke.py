"""Run the UI acceptance workflow against an isolated local preview server."""
import os
from pathlib import Path
import socket
import shutil
import subprocess
import sys
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[1]


def main():
    if not (ROOT / 'dist/blueprint_editor.html').is_file():
        raise SystemExit('Build first: python scripts/build.py')
    node = shutil.which('node')
    if not node:
        raise SystemExit('Node.js is required to run the browser workflow.')
    with socket.socket() as probe:
        probe.bind(('127.0.0.1', 0))
        port = probe.getsockname()[1]
    out = ROOT / 'reports/live-workflow'
    out.mkdir(parents=True, exist_ok=True)
    flags = subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0
    with (out / 'server.log').open('w', encoding='utf-8') as log:
        server = subprocess.Popen(
            [sys.executable, str(ROOT / 'scripts/serve.py'), '--no-open', '--port', str(port)],
            cwd=ROOT, stdout=log, stderr=subprocess.STDOUT, creationflags=flags,
        )
        try:
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
            for _ in range(100):
                if server.poll() is not None:
                    raise SystemExit('Preview server exited; see reports/live-workflow/server.log')
                try:
                    with opener.open(f'http://127.0.0.1:{port}/__project', timeout=1) as response:
                        if response.status == 200:
                            break
                except OSError:
                    time.sleep(0.1)
            else:
                raise SystemExit('Preview server did not become ready')
            result = subprocess.run(
                [node, str(ROOT / 'scripts/smoke_live.cjs'),
                 f'http://127.0.0.1:{port}/blueprint_editor.html'], cwd=ROOT,
            )
            return result.returncode
        finally:
            server.terminate()
            try:
                server.wait(timeout=5)
            except subprocess.TimeoutExpired:
                server.kill()
                server.wait()


if __name__ == '__main__':
    raise SystemExit(main())
