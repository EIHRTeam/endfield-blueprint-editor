"""Desktop app server: page, same-origin recognition from disk, native save/open routes."""
import importlib.util
import json
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
spec = importlib.util.spec_from_file_location("desktop_app", ROOT / "desktop/app.py")
app = importlib.util.module_from_spec(spec)
spec.loader.exec_module(app)


class FakeDialogs:
    def __init__(self):
        self.open_result = None
        self.save_target = None
        self.saved_names = []
        self.focused = 0

    def open_files(self, _types):
        return self.open_result

    def save_file(self, name, _types):
        self.saved_names.append(name)
        return self.save_target

    def focus(self):
        self.focused += 1


@pytest.fixture
def served(tmp_path):
    web = tmp_path / "web"
    (web / "assets").mkdir(parents=True)
    (web / "index.html").write_text("<!doctype html><title>editor</title>", encoding="utf-8")
    (web / "assets/app.js").write_text("console.log(1)", encoding="utf-8")
    (tmp_path / "secret.txt").write_text("nope", encoding="utf-8")
    dialogs = FakeDialogs()
    calls = []

    def recognize(images, size=None):
        calls.append((images, size))
        return {"layout": {"name": "x"}, "report": {}}

    def loader(paths):
        return [p.name for p in paths]

    server, origin = app.bind(lambda origins: app.make_desktop_handler(web, dialogs, origins, recognize, loader),
                              first=47900, tries=50)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield origin, dialogs, calls, tmp_path, server
    server.shutdown()
    server.server_close()


def request(url, data=None, headers=None, method=None):
    req = urllib.request.Request(url, data=data, headers=headers or {}, method=method)
    try:
        with urllib.request.urlopen(req, timeout=5) as response:
            return response.status, response.headers, response.read()
    except urllib.error.HTTPError as error:
        return error.code, error.headers, error.read()


def post_json(origin, path, body, with_origin=True):
    headers = {"Content-Type": "application/json", **({"Origin": origin} if with_origin else {})}
    status, _, raw = request(origin + path, json.dumps(body).encode(), headers)
    return status, json.loads(raw)


def test_serves_the_page_and_reports_desktop_health(served):
    origin, *_ = served
    status, headers, body = request(origin + "/")
    assert status == 200 and b"editor" in body and headers["Content-Type"].startswith("text/html")
    status, headers, _ = request(origin + "/assets/app.js")
    assert status == 200 and headers["Content-Type"].startswith("text/javascript")
    status, _, raw = request(origin + "/health")
    assert status == 200 and json.loads(raw)["desktop"] is True
    assert app.running_instance(int(origin.rsplit(":", 1)[1]))


def test_static_files_cannot_escape_the_web_folder(served):
    origin, *_ = served
    for path in ("/../secret.txt", "/%2e%2e/secret.txt", "/assets/../../secret.txt", "/missing.js"):
        status, _, body = request(origin + path)
        assert status == 404 and b"nope" not in body


def test_recognizes_files_read_from_disk(served):
    origin, _, calls, tmp, _ = served
    shot = tmp / "a.png"
    shot.write_bytes(b"png")
    status, body = post_json(origin, "/api/jobs/files", {"paths": [str(shot)], "size": [3, 4]})
    assert status == 202 and body["job"]["name"] == "a.png"
    job = body["job"]["id"]
    for _ in range(100):
        status, _, raw = request(f"{origin}/api/jobs/{job}")
        if json.loads(raw)["job"]["status"] != "running":
            break
        time.sleep(.02)
    assert json.loads(raw)["job"]["status"] == "done"
    assert calls == [(["a.png"], [3, 4])]


def test_file_routes_reject_bad_input_and_foreign_pages(served):
    origin, _, calls, tmp, _ = served
    video, shot = tmp / "a.mp4", tmp / "b.png"
    video.write_bytes(b"v")
    shot.write_bytes(b"p")
    assert post_json(origin, "/api/jobs/files", {"paths": [str(tmp / "none.png")]})[0] == 422
    assert post_json(origin, "/api/jobs/files", {"paths": [str(video), str(shot)]})[0] == 422
    assert post_json(origin, "/api/jobs/files", {"paths": [str(tmp / "secret.txt")]})[0] == 422
    # Another web page (or a request without the app's Origin) may not read local files.
    status, _, _ = request(origin + "/api/jobs/files", json.dumps({"paths": [str(shot)]}).encode(),
                           {"Content-Type": "application/json", "Origin": "https://evil.example"})
    assert status == 403
    assert post_json(origin, "/api/jobs/files", {"paths": [str(shot)]}, with_origin=False)[0] == 403
    assert calls == []


def test_native_open_and_save(served):
    origin, dialogs, _, tmp, _ = served
    assert post_json(origin, "/api/desktop/choose", {}) == (200, {"cancelled": True})
    shot = tmp / "c.png"
    shot.write_bytes(b"12345")
    dialogs.open_result = (str(shot),)
    status, body = post_json(origin, "/api/desktop/choose", {})
    assert status == 200 and body["files"] == [{"path": str(shot), "name": "c.png", "size": 5}]

    headers = {"Content-Type": "application/octet-stream", "Origin": origin}
    status, _, raw = request(origin + "/api/desktop/save?name=" + urllib.request.quote("蓝图.json"), b"{}", headers)
    assert status == 200 and json.loads(raw) == {"cancelled": True}
    dialogs.save_target = str(tmp / "out" / "保存")
    (tmp / "out").mkdir()
    status, _, raw = request(origin + "/api/desktop/save?name=x.json", b'{"a":1}', headers)
    assert status == 200 and json.loads(raw)["path"].endswith("保存.json")
    assert (tmp / "out/保存.json").read_bytes() == b'{"a":1}'
    assert dialogs.saved_names == ["蓝图.json", "x.json"]


def test_second_launch_finds_and_focuses_the_running_app(served):
    origin, dialogs, *_ = served
    port = int(origin.rsplit(":", 1)[1])
    server, found = app.bind(lambda origins: app.make_desktop_handler(".", FakeDialogs(), origins), first=port, tries=1)
    assert server is None and found == port
    app.focus_instance(found)
    assert dialogs.focused == 1


def test_stop_cancels_a_running_recognition(served):
    origin, _, _, tmp, server = served
    jobs = server.RequestHandlerClass.recognition_jobs
    job = jobs.create("x", "images")
    assert jobs.running.acquire(blocking=False)
    threading.Timer(.1, jobs.running.release).start()
    app.stop(server, jobs, wait=2)
    assert job["cancel"].is_set()
