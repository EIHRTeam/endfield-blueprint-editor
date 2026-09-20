"""Serve only this project's dist folder on loopback, optionally opening a browser."""
import argparse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import json
import socket
import urllib.request
import webbrowser

ROOT = Path(__file__).resolve().parents[1]
PROJECT = 'endfield-blueprint-editor'


class Handler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def do_GET(self):
        if self.path == '/__project':
            body = json.dumps({'project': PROJECT}).encode('utf-8')
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        else:
            super().do_GET()


class PreviewServer(ThreadingHTTPServer):
    # Windows SO_REUSEADDR can let two servers bind the same port. Own it exclusively.
    allow_reuse_address = False

    def server_bind(self):
        if hasattr(socket, 'SO_EXCLUSIVEADDRUSE'):
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=8769)
    parser.add_argument('--no-open', action='store_true')
    args = parser.parse_args()
    if not 1024 <= args.port <= 65535:
        parser.error('Port must be between 1024 and 65535')
    if not (ROOT / 'dist/blueprint_editor.html').exists():
        raise SystemExit('Build first: python scripts/build.py')
    url = f'http://127.0.0.1:{args.port}/blueprint_editor.html'
    try:
        server = PreviewServer(('127.0.0.1', args.port), partial(Handler, directory=str(ROOT / 'dist')))
    except OSError as error:
        try:
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
            with opener.open(f'http://127.0.0.1:{args.port}/__project', timeout=2) as response:
                existing = json.load(response).get('project') == PROJECT
        except Exception:
            existing = False
        if not existing:
            raise SystemExit(f'Port {args.port} is in use. Try: python scripts/serve.py --port {args.port + 1}') from error
        print(f'Already running: {url}')
        if not args.no_open:
            webbrowser.open(url)
        return
    print(f'Preview: {url}\nPress Ctrl+C to stop.', flush=True)
    if not args.no_open:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
