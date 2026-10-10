#!/usr/bin/env python3
"""Optional loopback-only screenshot/video recognition service for the static editor."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import shutil
import sys
import tempfile
import threading
import time
import traceback
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from ocr import progress
from ocr.inputs import MAX_BYTES, MAX_VIDEO_BYTES, VIDEO_SUFFIXES, decode_files, load_video

MAX_REQUEST = MAX_BYTES * 4 // 3 + 65536


JOB_KEEP_SECONDS = 3600
JOB_KEEP_COUNT = 3
FAILED_UPLOAD_DIR = Path(__file__).resolve().parent.parent / ".ocr-debug"


def keep_failed_upload(job, path, directory=FAILED_UPLOAD_DIR):
    """Keep only the latest unrecognized recording locally so it can be diagnosed."""
    if directory is None or path is None or job["status"] != "error" or not path.exists():
        return
    try:
        directory.mkdir(parents=True, exist_ok=True)
        for old in directory.glob("last-failed*"):
            old.unlink()
        target = directory / ("last-failed" + path.suffix)
        shutil.copyfile(path, target)
        print(f"未识别的录屏已保存到 {target}，方便排查；可随时删除。", file=sys.stderr, flush=True)
    except OSError:
        pass


class Jobs:
    """Background recognitions: one at a time, pollable, cancellable.

    A page reload or a discarded browser tab does not lose the work; the editor
    reattaches with the job id (or ``latest``) and fetches the kept result.
    """

    def __init__(self, recognize):
        self.recognize = recognize
        self.running = threading.Lock()
        self.guard = threading.Lock()
        self.jobs = {}

    def status(self, job):
        with self.guard:
            row = {key: job[key] for key in ("id", "name", "kind", "status", "stage", "progress", "error")}
            end = job["finishedAt"] or time.time()
        row["elapsedSeconds"] = round(end - job["createdAt"], 1)
        row["hasResult"] = job["result"] is not None
        return row

    def get(self, job_id):
        now = time.time()
        with self.guard:
            for key, job in list(self.jobs.items()):
                if job["finishedAt"] and now - job["finishedAt"] > JOB_KEEP_SECONDS:
                    del self.jobs[key]
            if job_id == "latest":
                return next(reversed(self.jobs.values()), None)
            return self.jobs.get(job_id)

    def current(self):
        with self.guard:
            return next((job for job in self.jobs.values() if job["status"] == "running"), None)

    def create(self, name, kind):
        job = {"id": uuid.uuid4().hex, "name": name, "kind": kind, "status": "running", "stage": "排队中",
               "progress": 0., "error": None, "result": None, "createdAt": time.time(), "finishedAt": None,
               "cancel": threading.Event()}
        with self.guard:
            self.jobs[job["id"]] = job
            while len(self.jobs) > JOB_KEEP_COUNT:
                oldest = next(key for key, row in self.jobs.items() if row["status"] != "running")
                del self.jobs[oldest]
        return job

    def execute(self, job, load, size):
        """Run in the calling thread; returns (http status, body)."""
        started = time.monotonic()

        def report(stage, fraction):
            if job["cancel"].is_set():
                raise progress.Cancelled()
            with self.guard:
                if stage != job["stage"]:
                    # One line per stage, so a stuck run's log shows where it stopped.
                    print(f"[识别 {job['id'][:8]}] {time.monotonic() - started:6.1f}s {stage}",
                          file=sys.stderr, flush=True)
                job["stage"] = stage
                if fraction is not None:
                    job["progress"] = max(job["progress"], round(fraction, 4))

        status, body = 500, {"error": "识别失败，详细原因见本地服务终端。"}
        try:
            with progress.reporting(report):
                images = load()
                progress.check()
                result = self.recognize(images, size=size) if size is not None else self.recognize(images)
            status, body = 200, result
        except progress.Cancelled:
            status, body = 409, {"error": "识别已取消。"}
        except (ValueError, KeyError) as error:
            print(f"识别未完成：{error}", file=sys.stderr, flush=True)
            status, body = 422, {"error": str(error)}
        except Exception:
            traceback.print_exc()
        print(f"[识别 {job['id'][:8]}] {time.monotonic() - started:6.1f}s 结束（HTTP {status}）",
              file=sys.stderr, flush=True)
        with self.guard:
            job["finishedAt"] = time.time()
            if status == 200:
                job.update(status="done", stage="完成", progress=1., result=body)
            else:
                job.update(status="cancelled" if status == 409 else "error", error=body["error"])
        return status, body


def make_handler(origins, recognize=None, video_loader=None, failed_upload_dir=FAILED_UPLOAD_DIR):
    """Request handler class; ``origins`` may be mutated later (the desktop app adds its own origin)."""
    if recognize is None:
        from ocr.pipeline import recognize
    video_loader = video_loader or load_video
    jobs = Jobs(recognize)

    class Handler(BaseHTTPRequestHandler):
        server_version = "BlueprintOCR/2"
        # Exposed so the desktop app can add routes and cancel work when its window closes.
        recognition_jobs = jobs
        allowed_origins = origins

        def start_background(self, name, kind, load, size, cleanup, upload=None):
            """Hand a validated input to a worker thread; the caller holds ``jobs.running``."""
            job = jobs.create(name, kind)

            def work():
                try:
                    jobs.execute(job, load, size)
                    keep_failed_upload(job, upload, failed_upload_dir)
                finally:
                    cleanup()
                    jobs.running.release()
            threading.Thread(target=work, name=f"recognition-{job['id'][:8]}", daemon=True).start()
            return self.reply(202, {"job": jobs.status(job)})

        def busy_reply(self):
            running = jobs.current()
            return self.reply(429, {"error": "正在执行另一项识别，请稍后重试。",
                                    **({"job": jobs.status(running)} if running else {})})

        def allowed(self):
            try:
                host = urlparse("http://" + self.headers.get("Host", "")).hostname
            except ValueError:
                return False
            origin = self.headers.get("Origin")
            return host in {"127.0.0.1", "localhost", "::1"} and (origin is None or origin in origins)

        def reply(self, status, body):
            raw = json.dumps(body, ensure_ascii=False, allow_nan=False).encode()
            self.send_response(status)
            origin = self.headers.get("Origin")
            if origin in origins:
                self.send_header("Access-Control-Allow-Origin", origin)
                self.send_header("Vary", "Origin")
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(raw)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            self.wfile.write(raw)

        def log_request(self, code="-", size="-"):
            # Progress polling would flood the terminal.
            if not (self.command == "GET" and self.path.startswith("/api/jobs/") and code == 200):
                super().log_request(code, size)

        def do_OPTIONS(self):
            if not self.allowed():
                return self.reply(403, {"error": "此网页来源未获允许，请使用 --allow-origin 指定编辑器地址。"})
            self.send_response(204)
            self.send_header("Access-Control-Allow-Origin", self.headers.get("Origin", ""))
            self.send_header("Access-Control-Allow-Methods", "POST, GET, DELETE, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.send_header("Access-Control-Allow-Private-Network", "true")
            self.send_header("Vary", "Origin")
            self.end_headers()

        def job_route(self):
            parts = urlparse(self.path).path.split("/")
            # ["", "api", "jobs", id, ("result")?]
            if len(parts) not in (4, 5) or parts[:3] != ["", "api", "jobs"] or (len(parts) == 5 and parts[4] != "result"):
                return None, None
            return jobs.get(parts[3]), len(parts) == 5

        def do_GET(self):
            if not self.allowed():
                return self.reply(403, {"error": "不允许的请求来源"})
            if self.path == "/":
                # People often open the service address itself in a browser.
                return self.reply(200, {"status": "ready",
                                        "message": "截图 / 录屏识别服务正在运行。这里没有网页；请在编辑器的「截图 / 录屏识别」中填写此地址。"})
            if self.path.startswith("/api/jobs/"):
                job, want_result = self.job_route()
                if job is None:
                    return self.reply(404, {"error": "识别任务不存在或已过期，请重新识别。"})
                if want_result:
                    if job["result"] is None:
                        return self.reply(409, {"error": "识别尚未完成。", "job": jobs.status(job)})
                    return self.reply(200, job["result"])
                return self.reply(200, {"job": jobs.status(job)})
            self.reply(200 if self.path == "/health" else 404,
                       {"status": "ready"} if self.path == "/health" else {"error": "不存在的接口"})

        def do_DELETE(self):
            if not self.allowed():
                return self.reply(403, {"error": "不允许的请求来源"})
            job, want_result = self.job_route()
            if job is None or want_result:
                return self.reply(404, {"error": "识别任务不存在或已过期。"})
            job["cancel"].set()
            self.reply(202, {"job": jobs.status(job)})

        def read_input(self, is_video, route, length):
            """Validate and read the body; returns (name, load, size, cleanup)."""
            if is_video:
                query = parse_qs(route.query, keep_blank_values=True, max_num_fields=8)
                if any(len(values) != 1 for values in query.values()):
                    raise ValueError("视频参数不能重复。")
                name = query.get("name", [""])[0]
                if not name or len(name) > 255 or "\x00" in name or Path(name).suffix.lower() not in VIDEO_SUFFIXES:
                    raise ValueError("请提供 MP4、MOV、WebM 或 MKV 文件名。")
                size = None
                if "width" in query or "height" in query:
                    try:
                        size = [int(query.get(key, [""])[0]) for key in ("width", "height")]
                    except ValueError as error:
                        raise ValueError("请同时提供 1–50 的整数宽高。") from error
                    if any(not 1 <= n <= 50 for n in size):
                        raise ValueError("请同时提供 1–50 的整数宽高。")
                # Stream the binary body to a bounded temporary file instead
                # of keeping a video and its base64 copy in memory.
                directory = tempfile.mkdtemp(prefix="blueprint-video-upload-")
                cleanup = lambda: shutil.rmtree(directory, ignore_errors=True)
                try:
                    path = Path(directory) / ("recording" + Path(name).suffix.lower())
                    remaining = length
                    with path.open("wb") as stream:
                        while remaining:
                            chunk = self.rfile.read(min(1024 * 1024, remaining))
                            if not chunk:
                                raise ValueError("视频上传不完整，请重试。")
                            stream.write(chunk)
                            remaining -= len(chunk)
                except BaseException:
                    cleanup()
                    raise
                display = Path(name).name
                cleanup.upload = path
                return display, lambda: video_loader(path, name=display), size, cleanup
            data = json.loads(self.rfile.read(length))
            if not isinstance(data, dict):
                raise ValueError("请求必须是 JSON 对象。")
            size = data.get("size")
            if size is not None and (not isinstance(size, list) or len(size) != 2
                                     or any(type(n) is not int or not 1 <= n <= 50 for n in size)):
                raise ValueError("size 必须是两个 1–50 的整数：[宽, 高]。")
            images = decode_files(data.get("files"))
            files = data.get("files") or []
            name = files[0].get("name", "截图") if len(files) == 1 else f"{len(files)} 张截图"
            return name, lambda: images, size, lambda: None

        def do_POST(self):
            self.connection.settimeout(120)
            if not self.allowed():
                return self.reply(403, {"error": "此网页来源未获允许，请使用 --allow-origin 指定编辑器地址。"})
            route = urlparse(self.path)
            background = route.path in {"/api/jobs", "/api/jobs/video"}
            is_video = route.path in {"/api/recognize-video", "/api/jobs/video"}
            if route.path not in {"/api/recognize", "/api/recognize-video", "/api/jobs", "/api/jobs/video"}:
                return self.reply(404, {"error": "不存在的接口"})
            content_type = self.headers.get("Content-Type", "").split(";")[0].strip()
            if is_video and content_type != "application/octet-stream":
                return self.reply(415, {"error": "视频需要 application/octet-stream 二进制上传。"})
            if not is_video and content_type != "application/json":
                return self.reply(415, {"error": "需要 application/json。"})
            try:
                length = int(self.headers.get("Content-Length", "0"))
            except ValueError:
                return self.reply(400, {"error": "Content-Length 无效。"})
            if not 0 < length <= (MAX_VIDEO_BYTES if is_video else MAX_REQUEST):
                return self.reply(413, {"error": "视频不能超过 256 MiB。" if is_video else "请求超过 64 MiB 文件大小限制。"})
            if not jobs.running.acquire(blocking=False):
                return self.busy_reply()
            handed_off = False
            try:
                name, load, size, cleanup = self.read_input(is_video, route, length)
                kind = "video" if is_video else "images"
                if background:
                    handed_off = True
                    return self.start_background(name, kind, load, size, cleanup, getattr(cleanup, "upload", None))
                job = jobs.create(name, kind)
                try:
                    status, body = jobs.execute(job, load, size)
                finally:
                    cleanup()
                self.reply(status, body)
            except (ValueError, KeyError) as error:
                self.reply(422, {"error": str(error)})
            except (BrokenPipeError, ConnectionResetError):
                pass
            except TimeoutError:
                self.reply(408, {"error": "请求读取超时，请重试。"})
            except Exception:
                traceback.print_exc()
                self.reply(500, {"error": "识别失败，详细原因见本地服务终端。"})
            finally:
                if not handed_off:
                    jobs.running.release()

    return Handler


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--allow-origin", action="append", default=[], help="额外允许的编辑器 Origin，如 https://example.pages.dev")
    args = parser.parse_args()
    origins = {f"http://{host}:{port}" for host in ("127.0.0.1", "localhost") for port in (5173, 4173)}
    for origin in args.allow_origin:
        parsed = urlparse(origin)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc or parsed.path or parsed.query or parsed.fragment:
            parser.error("--allow-origin 必须是无路径的 http(s) Origin")
        origins.add(origin)
    server = ThreadingHTTPServer(("127.0.0.1", args.port), make_handler(origins))
    print(f"截图 / 录屏识别服务：http://127.0.0.1:{args.port}；文件只在本机处理。", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
