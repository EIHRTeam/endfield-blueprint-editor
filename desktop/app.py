"""终末地蓝图编辑器 · Windows 桌面版入口。

一个进程同时提供编辑器页面和截图 / 录屏识别接口，再用系统自带的 WebView2
打开窗口。页面和识别服务同源，因此不需要填写服务地址，也不存在跨域问题。

开发时可直接运行（需先 ``pnpm build:desktop``）::

    .venv/bin/python desktop/app.py            # 打开窗口（需要 pywebview）
    .venv/bin/python desktop/app.py --serve    # 只启动服务，用浏览器访问
"""
from __future__ import annotations

import argparse
import json
import mimetypes
import multiprocessing
import os
import socket
import sys
import threading
import time
import urllib.request
from email.utils import formatdate, parsedate_to_datetime
from http.server import ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

APP_ID = "EndfieldBlueprintEditor"
APP_NAME = "终末地蓝图编辑器"
VERSION = "1.0.2"
# A fixed port keeps the page origin stable, and with it localStorage/IndexedDB
# (autosave, preferences, recognition job id) across launches.
PORT = 47615
PORT_TRIES = 10
MAX_SAVE_BYTES = 256 * 1024 * 1024
WEBVIEW2_URL = "https://developer.microsoft.com/microsoft-edge/webview2/"

FROZEN = getattr(sys, "frozen", False)
ROOT = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent.parent))
WEB_DIR = ROOT / ("web" if FROZEN else "dist-desktop")
# The built page stages the sprite tree and bake module the recognizer needs (no second copy).
ASSET_ROOT = WEB_DIR if FROZEN else ROOT

# Recognition modules read the sprites through this variable; set it before importing them.
os.environ.setdefault("BLUEPRINT_ASSET_ROOT", str(ASSET_ROOT))
# The packaged app decodes recordings with the FFmpeg built into OpenCV (bit-identical
# frames to the ffmpeg CLI); ignore whatever ffmpeg happens to be on PATH.
if FROZEN:
    os.environ.setdefault("BLUEPRINT_VIDEO_DECODER", "opencv")
if not FROZEN:
    sys.path.insert(0, str(ROOT / "scripts"))

CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".wasm": "application/wasm",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".webp": "image/webp",
    ".jpg": "image/jpeg",
    ".ico": "image/x-icon",
    ".woff2": "font/woff2",
    ".txt": "text/plain; charset=utf-8",
}
SAVE_TYPES = {
    ".json": "JSON 文件 (*.json)",
    ".png": "PNG 图片 (*.png)",
    ".webp": "WebP 图片 (*.webp)",
    ".txt": "文本文件 (*.txt)",
    ".zip": "ZIP 压缩包 (*.zip)",
}
OPEN_TYPES = (
    "截图或录屏 (*.png;*.jpg;*.jpeg;*.webp;*.zip;*.mp4;*.mov;*.webm;*.mkv)",
    "所有文件 (*.*)",
)


def data_dir():
    """Per-user writable folder: WebView2 profile, logs."""
    override = os.environ.get("BLUEPRINT_DESKTOP_DATA")
    if override:
        return Path(override)
    if sys.platform == "win32":
        return Path(os.environ.get("LOCALAPPDATA") or Path.home() / "AppData/Local") / APP_ID
    return Path(os.environ.get("XDG_DATA_HOME") or Path.home() / ".local/share") / APP_ID


def redirect_output(directory):
    """A windowed (no console) build has no stdout/stderr; logging to None would crash."""
    if sys.stdout is not None and sys.stderr is not None:
        return None
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / "app.log"
    if path.exists() and path.stat().st_size > 4 * 1024 * 1024:
        path.replace(directory / "app.old.log")
    stream = open(path, "a", encoding="utf-8", buffering=1, errors="replace")
    sys.stdout = sys.stdout or stream
    sys.stderr = sys.stderr or stream
    print(f"\n==== {time.strftime('%Y-%m-%d %H:%M:%S')} {APP_NAME} {VERSION} ====", file=sys.stderr)
    return path


def _size_field(size):
    if size is not None and (not isinstance(size, list) or len(size) != 2
                             or any(type(n) is not int or not 1 <= n <= 50 for n in size)):
        raise ValueError("size 必须是两个 1–50 的整数：[宽, 高]。")
    return size


def make_desktop_handler(web_dir, dialogs, origins, recognize=None, loader=None):
    """The recognition API from ``scripts/ocr_server.py`` plus the page and desktop-only routes."""
    from ocr_server import make_handler
    from ocr.inputs import IMAGE_SUFFIXES, MAX_IMAGES, VIDEO_SUFFIXES

    if loader is None:
        from ocr.inputs import load_paths as loader
    web_dir = Path(web_dir).resolve()
    # Recordings are read in place from the user's disk, so nothing needs keeping on failure.
    Base = make_handler(origins, recognize, failed_upload_dir=None)
    jobs = Base.recognition_jobs

    class DesktopHandler(Base):
        server_version = "EndfieldBlueprintDesktop/1"
        desktop_dialogs = dialogs

        def log_request(self, code="-", size="-"):
            if self.command == "GET" and not self.path.startswith("/api/") and str(code) in {"200", "304"}:
                return
            super().log_request(code, size)

        def same_origin(self):
            """Desktop routes touch the user's files: only the app page itself may call them."""
            return self.allowed() and self.headers.get("Origin") in origins

        def do_GET(self):
            route = urlparse(self.path).path
            if route == "/health":
                if not self.allowed():
                    return self.reply(403, {"error": "不允许的请求来源"})
                return self.reply(200, {"status": "ready", "desktop": True, "app": APP_ID, "version": VERSION})
            if route.startswith("/api/"):
                return super().do_GET()
            return self.serve_static(route)

        def serve_static(self, route):
            if not self.allowed():
                return self.reply(403, {"error": "不允许的请求来源"})
            relative = unquote(route).lstrip("/") or "index.html"
            target = (web_dir / relative).resolve()
            if not target.is_relative_to(web_dir) or not target.is_file():
                return self.reply(404, {"error": "找不到页面文件"})
            stat = target.stat()
            since = self.headers.get("If-Modified-Since")
            try:
                if since and int(stat.st_mtime) <= parsedate_to_datetime(since).timestamp():
                    self.send_response(304)
                    self.end_headers()
                    return None
            except (TypeError, ValueError, OverflowError):
                pass
            content_type = CONTENT_TYPES.get(target.suffix.lower()) or mimetypes.guess_type(target.name)[0] \
                or "application/octet-stream"
            self.send_response(200)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(stat.st_size))
            self.send_header("Last-Modified", formatdate(stat.st_mtime, usegmt=True))
            self.send_header("Cache-Control", "no-cache")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            try:
                with target.open("rb") as stream:
                    while chunk := stream.read(1024 * 1024):
                        self.wfile.write(chunk)
            except (BrokenPipeError, ConnectionResetError):
                pass
            return None

        def read_json(self, limit=1024 * 1024):
            if self.headers.get("Content-Type", "").split(";")[0].strip() != "application/json":
                raise ValueError("需要 application/json。")
            length = int(self.headers.get("Content-Length", "0") or 0)
            if not 0 <= length <= limit:
                raise ValueError("请求过大。")
            data = json.loads(self.rfile.read(length) or b"{}")
            if not isinstance(data, dict):
                raise ValueError("请求必须是 JSON 对象。")
            return data

        def do_POST(self):
            route = urlparse(self.path)
            handlers = {"/api/jobs/files": self.post_files, "/api/desktop/choose": self.post_choose,
                        "/api/desktop/save": self.post_save, "/api/desktop/focus": self.post_focus}
            if route.path not in handlers:
                return super().do_POST()
            if route.path != "/api/desktop/focus" and not self.same_origin():
                return self.reply(403, {"error": "不允许的请求来源"})
            if route.path == "/api/desktop/focus" and not self.allowed():
                return self.reply(403, {"error": "不允许的请求来源"})
            try:
                return handlers[route.path](route)
            except (ValueError, KeyError) as error:
                return self.reply(422, {"error": str(error)})
            except (BrokenPipeError, ConnectionResetError):
                return None

        def post_files(self, _route):
            """Recognize files picked or dropped in the app, read directly from disk."""
            data = self.read_json()
            size = _size_field(data.get("size"))
            raw = data.get("paths")
            if not isinstance(raw, list) or not 1 <= len(raw) <= MAX_IMAGES \
                    or any(not isinstance(p, str) or not p or "\x00" in p for p in raw):
                raise ValueError(f"请选择 1–{MAX_IMAGES} 个文件。")
            paths = [Path(p) for p in raw]
            missing = [p.name for p in paths if not p.is_file()]
            if missing:
                raise ValueError(f"找不到文件：{missing[0]}")
            allowed = IMAGE_SUFFIXES | VIDEO_SUFFIXES | {".zip"}
            if any(p.suffix.lower() not in allowed for p in paths):
                raise ValueError("只支持 PNG、JPEG、WebP、ZIP 和 MP4、MOV、WebM、MKV 录屏。")
            video = any(p.suffix.lower() in VIDEO_SUFFIXES for p in paths)
            if video and len(paths) != 1:
                raise ValueError("请单独识别一个视频，不能和图片或 ZIP 混选。")
            name = paths[0].name if len(paths) == 1 else f"{len(paths)} 张截图"
            if not jobs.running.acquire(blocking=False):
                return self.busy_reply()
            try:
                return self.start_background(name, "video" if video else "images",
                                             lambda: loader(paths), size, lambda: None)
            except BaseException:
                jobs.running.release()
                raise

        def post_choose(self, _route):
            self.read_json()
            chosen = dialogs.open_files(OPEN_TYPES)
            if not chosen:
                return self.reply(200, {"cancelled": True})
            files = []
            for item in chosen:
                path = Path(item)
                files.append({"path": str(path), "name": path.name,
                              "size": path.stat().st_size if path.is_file() else 0})
            return self.reply(200, {"files": files})

        def post_save(self, route):
            query = parse_qs(route.query, keep_blank_values=True, max_num_fields=4)
            name = Path(query.get("name", ["蓝图"])[0]).name.strip() or "蓝图"
            if len(name) > 200 or "\x00" in name:
                raise ValueError("文件名无效。")
            if self.headers.get("Content-Type", "").split(";")[0].strip() != "application/octet-stream":
                return self.reply(415, {"error": "需要 application/octet-stream。"})
            length = int(self.headers.get("Content-Length", "0") or 0)
            if not 0 <= length <= MAX_SAVE_BYTES:
                return self.reply(413, {"error": "文件过大。"})
            self.connection.settimeout(120)
            body = self.rfile.read(length)
            if len(body) != length:
                raise ValueError("数据不完整，请重试。")
            suffix = Path(name).suffix.lower()
            types = tuple(t for t in (SAVE_TYPES.get(suffix), "所有文件 (*.*)") if t)
            target = dialogs.save_file(name, types)
            if not target:
                return self.reply(200, {"cancelled": True})
            target = Path(target)
            if suffix and not target.suffix:
                target = target.with_suffix(suffix)
            try:
                partial = target.with_name(target.name + ".partial")
                partial.write_bytes(body)
                partial.replace(target)
            except OSError as error:
                return self.reply(500, {"error": f"无法保存到 {target}：{error.strerror or error}"})
            return self.reply(200, {"path": str(target), "name": target.name})

        def post_focus(self, _route):
            dialogs.focus()
            return self.reply(200, {"status": "ok"})

    return DesktopHandler


class DesktopServer(ThreadingHTTPServer):
    daemon_threads = True
    # On Windows SO_REUSEADDR lets a second process steal a port that is in use.
    allow_reuse_address = sys.platform != "win32"

    def server_bind(self):
        if sys.platform == "win32" and hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()


def running_instance(port):
    """True when our app already answers on ``port``."""
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=1) as response:
            return json.load(response).get("app") == APP_ID
    except (OSError, ValueError):
        return False


def focus_instance(port):
    request = urllib.request.Request(f"http://127.0.0.1:{port}/api/desktop/focus", data=b"{}", method="POST",
                                     headers={"Content-Type": "application/json"})
    try:
        urllib.request.urlopen(request, timeout=2).close()
    except OSError:
        pass


def bind(handler_for, first=PORT, tries=PORT_TRIES):
    """Returns (server, origin) or (None, port of an already running instance)."""
    for port in range(first, first + tries):
        origins = set()
        try:
            server = DesktopServer(("127.0.0.1", port), handler_for(origins))
        except OSError:
            if running_instance(port):
                return None, port
            continue
        origin = f"http://127.0.0.1:{port}"
        origins.add(origin)
        return server, origin
    raise OSError(f"端口 {first}–{first + tries - 1} 都被占用，无法启动。")


class WebviewDialogs:
    """Native dialogs through pywebview; every call is marshalled onto the window's UI thread."""

    def __init__(self):
        self.window = None
        self.last_dir = None

    def _ui(self, function):
        native = getattr(self.window, "native", None)
        if sys.platform != "win32" or native is None or not getattr(native, "InvokeRequired", False):
            return function()
        from System import Func, Type  # pythonnet, present with the WinForms backend

        box = {}

        def run():
            try:
                box["value"] = function()
            except Exception as error:  # surfaced in the HTTP thread
                box["error"] = error
        native.Invoke(Func[Type](run))
        if "error" in box:
            raise box["error"]
        return box.get("value")

    @staticmethod
    def _kind(name):
        import webview
        dialog = getattr(webview, "FileDialog", None)
        return getattr(dialog, name) if dialog else getattr(webview, f"{name}_DIALOG")

    def open_files(self, file_types):
        if self.window is None:
            return None
        kind = self._kind("OPEN")
        result = self._ui(lambda: self.window.create_file_dialog(
            kind, directory=self.last_dir or "", allow_multiple=True, file_types=file_types))
        paths = [str(p) for p in (result or ())]
        if paths:
            self.last_dir = str(Path(paths[0]).parent)
        return paths or None

    def save_file(self, name, file_types):
        if self.window is None:
            return None
        kind = self._kind("SAVE")
        result = self._ui(lambda: self.window.create_file_dialog(
            kind, directory=self.last_dir or "", save_filename=name, file_types=file_types))
        if isinstance(result, (tuple, list)):
            result = result[0] if result else None
        if result:
            self.last_dir = str(Path(result).parent)
        return result or None

    def confirm(self, title, message):
        """Called on the UI thread (window closing handler)."""
        if sys.platform == "win32":
            import ctypes
            owner = 0
            try:
                owner = self.window.native.Handle.ToInt64()
            except Exception:
                pass
            # MB_OKCANCEL | MB_ICONWARNING | MB_DEFBUTTON2
            return ctypes.windll.user32.MessageBoxW(owner, message, title, 0x1 | 0x30 | 0x100) == 1
        return True

    def focus(self):
        if self.window is None:
            return
        for action in ("restore", "show"):
            try:
                getattr(self.window, action)()
            except Exception:
                pass


def webview2_installed():
    """Same registry probe pywebview uses; without WebView2 it would fall back to IE (MSHTML)."""
    if sys.platform != "win32":
        return True
    import winreg
    key = "{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"
    for hive, path in ((winreg.HKEY_LOCAL_MACHINE, rf"SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{key}"),
                       (winreg.HKEY_LOCAL_MACHINE, rf"SOFTWARE\Microsoft\EdgeUpdate\Clients\{key}"),
                       (winreg.HKEY_CURRENT_USER, rf"SOFTWARE\Microsoft\EdgeUpdate\Clients\{key}")):
        try:
            with winreg.OpenKey(hive, path) as handle:
                version, _ = winreg.QueryValueEx(handle, "pv")
                if version and version != "0.0.0.0":
                    return True
        except OSError:
            continue
    return False


def message_box(text, flags=0x10):
    if sys.platform == "win32":
        import ctypes
        return ctypes.windll.user32.MessageBoxW(0, text, APP_NAME, flags)
    print(text, file=sys.stderr)
    return 0


def stop(server, jobs, wait=5.):
    """Cancel recognition, stop serving and give worker processes a moment to exit."""
    running = jobs.current()
    if running is not None:
        running["cancel"].set()
    server.shutdown()
    server.server_close()
    if jobs.running.acquire(timeout=wait):
        jobs.running.release()


def self_test(report_path):
    """Exercise what freezing can break: bundled assets, worker processes, OCR models, video decoder.

    Writes a JSON report (a windowed exe has no console) and returns the exit code.
    """
    import cv2
    import numpy as np
    from ocr.assets import RecognitionAssets
    from ocr import devices, text

    report = {"version": VERSION, "frozen": bool(FROZEN), "checks": {}}
    started = time.time()
    try:
        assets = RecognitionAssets(Path(os.environ["BLUEPRINT_ASSET_ROOT"]))
        ids = sorted(assets.entity_ids)[:24]
        pooled = devices._render_sprites(assets, ids, 24)  # >= 24 jobs: worker processes
        serial = {bid: devices._render_job_with(assets, bid, 24) for bid in ids}
        same = all(pooled[b].keys() == serial[b].keys()
                   and all(np.array_equal(np.asarray(pooled[b][k]), np.asarray(serial[b][k])) for k in serial[b])
                   for b in ids)
        mode = devices.last_pool_mode
        report["checks"]["sprites"] = {"count": len(ids), "workers": devices.worker_count(), "pool": mode,
                                       "identical": same}
        if not same:
            raise RuntimeError("worker processes rendered different sprites")
        if devices.worker_count() > 1 and mode != "processes":
            raise RuntimeError(f"worker processes did not start (ran {mode}); recognition would be slow")
        image = np.full((64, 160, 3), 255, np.uint8)
        cv2.putText(image, "12", (40, 48), cv2.FONT_HERSHEY_SIMPLEX, 1.4, (0, 0, 0), 3)
        report["checks"]["ocr"] = {"text": [line["text"] for line in text.read_text(image)]}
        icons = sum(assets.item_icon(iid) is not None for _, iid in assets.inventory_items())
        report["checks"]["icons"] = {"loaded": icons, "root": str(assets.root)}
        if not icons:
            raise RuntimeError("no inventory icon could be read")
        # Install folders and user names may contain Chinese; OpenCV's own file
        # functions cannot open such paths on Windows.
        import tempfile
        from ocr import imageio
        with tempfile.TemporaryDirectory() as folder:
            probe = Path(folder) / "识别测试 图片" / "图标.png"
            probe.parent.mkdir()
            imageio.imwrite(probe, image)
            if not np.array_equal(imageio.imread(probe), image):
                raise RuntimeError("non-ASCII image path round trip failed")
        report["checks"]["unicodePaths"] = True
        if not cv2.videoio_registry.hasBackend(cv2.CAP_FFMPEG):
            raise RuntimeError("OpenCV has no FFMPEG video backend")
        report["checks"]["video"] = {"backend": cv2.videoio_registry.getBackendName(cv2.CAP_FFMPEG)}
        report["ok"] = True
    except Exception as error:  # reported, not raised: the caller reads the file
        import traceback
        report["ok"] = False
        report["error"] = f"{type(error).__name__}: {error}"
        report["traceback"] = traceback.format_exc()
    report["seconds"] = round(time.time() - started, 1)
    Path(report_path).write_text(json.dumps(report, ensure_ascii=False, indent=2, default=str), "utf-8")
    return 0 if report["ok"] else 1


def main(argv=None):
    parser = argparse.ArgumentParser(description=APP_NAME)
    parser.add_argument("--serve", action="store_true", help="只启动本地服务，不打开窗口（调试用）")
    parser.add_argument("--self-test", metavar="REPORT.json", help="检查打包后的识别组件，把结果写入文件后退出")
    parser.add_argument("--port", type=int, default=PORT)
    parser.add_argument("--debug", action="store_true", help="打开 WebView2 开发者工具")
    args = parser.parse_args(argv)

    data = data_dir()
    redirect_output(data / "logs")
    if args.self_test:
        return self_test(args.self_test)
    if not (WEB_DIR / "index.html").is_file():
        message_box(f"找不到页面文件：{WEB_DIR}\n开发时请先运行 pnpm build:desktop。")
        return 1
    if not args.serve and not webview2_installed():
        if message_box("此电脑缺少 Microsoft Edge WebView2 运行时，编辑器窗口无法打开。\n\n"
                       "点「确定」打开微软下载页面，安装后重新启动本程序。", 0x1 | 0x30) == 1:
            import webbrowser
            webbrowser.open(WEBVIEW2_URL)
        return 1

    dialogs = WebviewDialogs()
    server, origin = bind(lambda origins: make_desktop_handler(WEB_DIR, dialogs, origins), args.port)
    if server is None:
        focus_instance(origin)
        return 0
    jobs = server.RequestHandlerClass.recognition_jobs
    threading.Thread(target=server.serve_forever, name="http", daemon=True).start()
    print(f"{APP_NAME} {VERSION}：{origin}", file=sys.stderr, flush=True)

    if args.serve:
        try:
            while True:
                time.sleep(3600)
        except KeyboardInterrupt:
            pass
        stop(server, jobs)
        return 0

    import webview
    webview.settings["ALLOW_DOWNLOADS"] = True
    webview.settings["OPEN_EXTERNAL_LINKS_IN_BROWSER"] = True
    window = webview.create_window(APP_NAME, origin + "/", width=1440, height=900, min_size=(960, 640),
                                   background_color="#20232B", text_select=True)
    dialogs.window = window

    def closing():
        running = jobs.current()
        if running is None:
            return True
        if not dialogs.confirm(APP_NAME, "识别还在进行中，关闭窗口会取消这次识别。\n\n确定要关闭吗？"):
            return False
        running["cancel"].set()
        return True
    window.events.closing += closing

    icon = ROOT / ("app.ico" if FROZEN else "desktop/app.ico")
    webview.start(private_mode=False, storage_path=str(data / "webview"), debug=args.debug,
                  icon=str(icon) if icon.is_file() else None)
    stop(server, jobs)
    return 0


if __name__ == "__main__":
    # Recognition uses worker processes; in the frozen exe each worker re-enters here.
    multiprocessing.freeze_support()
    code = main()
    sys.stdout and sys.stdout.flush()
    # Do not wait for stray daemon threads or a stuck worker pool.
    os._exit(code)
