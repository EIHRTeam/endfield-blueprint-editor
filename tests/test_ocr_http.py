"""Exercise the loopback HTTP boundary with real image decoding, without OCR."""
from __future__ import annotations

import base64
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
import http.client
from http.server import ThreadingHTTPServer
import io
import json
from pathlib import Path
import sys
import threading

from PIL import Image
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from ocr_server import MAX_REQUEST, MAX_VIDEO_BYTES, make_handler


ORIGIN = "http://localhost:5173"
FAKE_RESULT = {
    "layout": {
        "schemaVersion": 2,
        "name": "HTTP 测试",
        "size": {"x": 2, "z": 3},
        "nodes": [],
        "conveyors": [],
    },
    "report": {"status": "needs_review"},
}


@pytest.fixture
def payload():
    data = io.BytesIO()
    Image.new("RGB", (128, 160), (12, 34, 56)).save(data, "PNG")
    return {"files": [{"name": "截图.png", "data": base64.b64encode(data.getvalue()).decode()}]}


class Client:
    def __init__(self, server):
        self.port = server.server_port

    def request(self, method="POST", path="/api/recognize", body=None, headers=None):
        if isinstance(body, (dict, list)):
            body = json.dumps(body, ensure_ascii=False).encode("utf-8")
        request_headers = {"Origin": ORIGIN, "Content-Type": "application/json"}
        request_headers.update(headers or {})
        request_headers = {key: value for key, value in request_headers.items() if value is not None}
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        try:
            connection.request(method, path, body=body, headers=request_headers)
            response = connection.getresponse()
            raw = response.read()
            return response.status, dict(response.getheaders()), json.loads(raw) if raw else None
        finally:
            connection.close()


@contextmanager
def running_server(recognize, video_loader=None):
    handler = make_handler({ORIGIN}, recognize=recognize, video_loader=video_loader)
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": .02}, daemon=True)
    thread.start()
    try:
        yield Client(server)
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)
        assert not thread.is_alive(), "HTTP test server failed to stop"


@pytest.fixture
def service():
    calls = []

    def fake_recognize(images):
        calls.append(images)
        return FAKE_RESULT

    with running_server(fake_recognize) as client:
        yield client, calls


def test_post_decodes_image_and_dispatches_layout(service, payload):
    client, calls = service
    status, headers, body = client.request(body=payload)
    assert status == 200
    assert body == FAKE_RESULT
    assert headers["Access-Control-Allow-Origin"] == ORIGIN
    assert headers["Cache-Control"] == "no-store"
    assert headers["X-Content-Type-Options"] == "nosniff"
    assert len(calls) == 1
    assert calls[0][0]["name"] == "截图.png"
    image = calls[0][0]["image"]
    assert image.shape == (160, 128, 3)
    assert image.dtype.name == "uint8"
    assert image[0, 0].tolist() == [56, 34, 12], "The actual loader must decode RGB into OpenCV BGR"


def test_explicit_dimensions_reach_the_recognizer(payload):
    calls = []

    def recognize(images, size=None):
        calls.append((images, size))
        return FAKE_RESULT

    with running_server(recognize) as client:
        assert client.request(body={**payload, "size": [39, 23]})[0] == 200
    assert calls[0][1] == [39, 23]


def test_video_upload_is_binary_streamed_and_temporary_file_is_removed():
    paths, calls = [], []
    content = b"fake video bytes" * 100_000

    def load_video(path, name):
        assert path.read_bytes() == content
        assert name == "recording.mp4"
        paths.append(path)
        return ["selected frame"]

    def recognize(images, size=None):
        calls.append((images, size))
        return FAKE_RESULT

    with running_server(recognize, load_video) as client:
        status, headers, result = client.request(path="/api/recognize-video?name=../../recording.mp4&width=37&height=43",
                                               body=content, headers={"Content-Type": "application/octet-stream"})
    assert status == 200 and result == FAKE_RESULT
    assert headers["Access-Control-Allow-Origin"] == ORIGIN
    assert calls == [(["selected frame"], [37, 43])]
    assert paths and not paths[0].exists()


@pytest.mark.parametrize("query", ["", "name=x.txt", "name=a.mp4&name=b.mp4", "name=x.mp4&width=3", "name=x.mp4&width=0&height=3"])
def test_invalid_video_query_never_decodes(service, query):
    client, calls = service
    status, _, result = client.request(path="/api/recognize-video?" + query, body=b"xx",
                                       headers={"Content-Type": "application/octet-stream"})
    assert status == 422 and result["error"]
    assert calls == []


def test_video_size_is_rejected_before_body_read(service):
    client, calls = service
    status, _, _ = client.request(path="/api/recognize-video?name=x.mp4", body=b"xx",
                                 headers={"Content-Type": "application/octet-stream", "Content-Length": str(MAX_VIDEO_BYTES+1)})
    assert status == 413 and not calls


def test_failed_video_decode_cleans_up_and_releases_lock(payload):
    paths = []

    def invalid_video(path, name):
        paths.append(path)
        raise ValueError("视频内容无效")

    with running_server(lambda images: FAKE_RESULT, invalid_video) as client:
        status, _, result = client.request(path="/api/recognize-video?name=x.mp4", body=b"invalid",
                                          headers={"Content-Type": "application/octet-stream"})
        assert status == 422 and result["error"] == "视频内容无效"
        assert client.request(body=payload)[0] == 200
    assert paths and not paths[0].exists()


def test_video_rejects_untrusted_origins_and_wrong_content_type(service):
    client, calls = service
    assert client.request(path="/api/recognize-video?name=x.mp4", body=b"xx")[0] == 415
    assert client.request(path="/api/recognize-video?name=x.mp4", body=b"xx", headers={
        "Content-Type": "application/octet-stream", "Origin": "https://untrusted.example"})[0] == 403
    assert not calls


@pytest.mark.parametrize("size", [[True, 2], [0, 2], [51, 2], [2.5, 2], [2], "2x3"])
def test_invalid_dimensions_never_dispatch(service, payload, size):
    client, calls = service
    status, _, body = client.request(body={**payload, "size": size})
    assert status == 422
    assert "size" in body["error"]
    assert not calls


@pytest.mark.parametrize("origin", [ORIGIN, None])
def test_health_accepts_editor_and_nonbrowser_clients(service, origin):
    client, calls = service
    status, headers, body = client.request("GET", "/health", headers={"Origin": origin})
    assert (status, body) == (200, {"status": "ready"})
    assert not calls
    if origin is None:
        assert "Access-Control-Allow-Origin" not in headers


def test_editor_preflight(service):
    client, calls = service
    status, headers, body = client.request("OPTIONS", headers={
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type",
    })
    assert status == 204
    assert body is None
    assert headers["Access-Control-Allow-Origin"] == ORIGIN
    assert "POST" in headers["Access-Control-Allow-Methods"]
    assert headers["Access-Control-Allow-Headers"] == "Content-Type"
    assert headers["Access-Control-Allow-Private-Network"] == "true"
    assert not calls


@pytest.mark.parametrize("method,path", [("POST", "/api/recognize"), ("GET", "/health"), ("OPTIONS", "/api/recognize")])
@pytest.mark.parametrize("origin", ["https://untrusted.example", "null", "http://localhost:5173.evil"])
def test_rejects_untrusted_and_invalid_origins(service, payload, method, path, origin):
    client, calls = service
    status, headers, body = client.request(method, path, body=payload, headers={"Origin": origin})
    assert status == 403
    assert body["error"]
    assert "Access-Control-Allow-Origin" not in headers
    assert not calls


@pytest.mark.parametrize("host", ["attacker.example", "127.0.0.1.attacker.example", "["])
def test_rejects_rebinding_and_malformed_host(service, payload, host):
    client, calls = service
    status, _, body = client.request(body=payload, headers={"Host": host})
    assert status == 403
    assert body["error"]
    assert not calls


@pytest.mark.parametrize("content_type", ["text/plain", "application/x-www-form-urlencoded", None])
def test_wrong_content_type_cannot_dispatch(service, payload, content_type):
    client, calls = service
    status, _, body = client.request(body=payload, headers={"Content-Type": content_type})
    assert status == 415
    assert body["error"]
    assert not calls


def test_oversize_is_rejected_before_reading_the_announced_body(service):
    client, calls = service
    # Announce an oversized body but transmit only two bytes. The endpoint must
    # reject the header immediately rather than waiting to read MAX_REQUEST.
    status, _, body = client.request(body=b"{}", headers={"Content-Length": str(MAX_REQUEST + 1)})
    assert status == 413
    assert body["error"]
    assert not calls


def test_malformed_content_length_is_a_client_error(service):
    client, calls = service
    status, _, body = client.request(body=b"{}", headers={"Content-Length": "not-a-number"})
    assert status == 400
    assert body["error"]
    assert not calls


@pytest.mark.parametrize("body", [
    {"files": [{"name": "bad.png", "data": "%%% not base64 %%%"}]},
    {"files": [{"name": "bad.png", "data": base64.b64encode(b"not an image").decode()}]},
    {"files": []},
    [],
    b"{broken json",
])
def test_invalid_body_never_dispatches_and_does_not_keep_lock(service, payload, body):
    client, calls = service
    status, _, error = client.request(body=body)
    assert status == 422
    assert error["error"]
    assert not calls
    assert client.request(body=payload)[0] == 200
    assert len(calls) == 1


def test_unknown_route_does_not_dispatch(service, payload):
    client, calls = service
    assert client.request(path="/unknown", body=payload)[0] == 404
    assert client.request("GET", "/unknown")[0] == 404
    assert not calls


def test_concurrent_request_is_busy_then_recovers(payload):
    entered = threading.Event()
    release = threading.Event()
    calls = []

    def slow_recognize(images):
        calls.append(images)
        if len(calls) == 1:
            entered.set()
            assert release.wait(timeout=5), "Test failed to release fake recognition"
        return FAKE_RESULT

    with running_server(slow_recognize) as client:
        with ThreadPoolExecutor(max_workers=1) as pool:
            first = pool.submit(client.request, body=payload)
            try:
                assert entered.wait(timeout=5), "First request never reached recognition"
                status, _, body = client.request(body=payload)
                assert status == 429
                assert body["error"]
                assert len(calls) == 1
                assert client.request("GET", "/health")[0] == 200
            finally:
                release.set()
            assert first.result(timeout=5)[0] == 200
        assert client.request(body=payload)[0] == 200
        assert len(calls) == 2


def test_recognizer_failure_releases_lock_without_exposing_internal_error(payload):
    calls = []

    def flaky_recognize(images):
        calls.append(images)
        if len(calls) == 1:
            raise RuntimeError("private internal diagnostic")
        return FAKE_RESULT

    with running_server(flaky_recognize) as client:
        status, _, body = client.request(body=payload)
        assert status == 500
        assert "private internal diagnostic" not in body["error"]
        assert client.request(body=payload)[0] == 200
        assert len(calls) == 2


def wait_for(client, job_id, predicate, timeout=5):
    import time
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        status, _, body = client.request("GET", f"/api/jobs/{job_id}")
        assert status == 200
        if predicate(body["job"]):
            return body["job"]
        time.sleep(.02)
    raise AssertionError(f"job never reached the expected state: {body}")


def test_background_job_reports_progress_and_keeps_result(payload):
    from ocr import progress
    entered, release = threading.Event(), threading.Event()

    def recognize(images):
        progress.stage("识别设备和物品", .5, .8)
        progress.advance(.5)
        entered.set()
        assert release.wait(timeout=5)
        return FAKE_RESULT

    with running_server(recognize) as client:
        status, headers, body = client.request(path="/api/jobs", body=payload)
        assert status == 202 and headers["Access-Control-Allow-Origin"] == ORIGIN
        job_id = body["job"]["id"]
        assert entered.wait(timeout=5)
        job = wait_for(client, job_id, lambda job: job["progress"] > 0)
        assert job["status"] == "running" and job["stage"] == "识别设备和物品"
        assert job["progress"] == pytest.approx(.65)
        assert client.request("GET", f"/api/jobs/{job_id}/result")[0] == 409
        # A second recognition is refused but points at the running job.
        status, _, busy = client.request(path="/api/jobs", body=payload)
        assert status == 429 and busy["job"]["id"] == job_id
        release.set()
        job = wait_for(client, job_id, lambda job: job["status"] != "running")
        assert job["status"] == "done" and job["progress"] == 1
        # The result survives the page that started it (reload / discarded tab).
        assert client.request("GET", f"/api/jobs/{job_id}/result")[2] == FAKE_RESULT
        assert client.request("GET", "/api/jobs/latest")[2]["job"]["id"] == job_id
        assert client.request("GET", "/api/jobs/" + "0" * 32)[0] == 404


def test_background_job_can_be_cancelled_and_releases_the_service(payload):
    from ocr import progress
    entered = threading.Event()
    calls = []

    def recognize(images):
        calls.append(images)
        if len(calls) == 1:
            entered.set()
            while True:
                progress.check()
                threading.Event().wait(.01)
        return FAKE_RESULT

    with running_server(recognize) as client:
        job_id = client.request(path="/api/jobs", body=payload)[2]["job"]["id"]
        assert entered.wait(timeout=5)
        status, headers, _ = client.request("DELETE", f"/api/jobs/{job_id}")
        assert status == 202
        job = wait_for(client, job_id, lambda job: job["status"] != "running")
        assert job["status"] == "cancelled"
        second = client.request(path="/api/jobs", body=payload)[2]["job"]["id"]
        assert wait_for(client, second, lambda job: job["status"] != "running")["status"] == "done"


def test_background_video_job_streams_upload_and_cleans_up():
    paths = []
    content = b"fake video bytes" * 10_000

    def load_video(path, name):
        assert path.read_bytes() == content and name == "录屏.mp4"
        paths.append(path)
        return ["frame"]

    with running_server(lambda images, size=None: FAKE_RESULT, load_video) as client:
        status, _, body = client.request(path="/api/jobs/video?name=%E5%BD%95%E5%B1%8F.mp4", body=content,
                                         headers={"Content-Type": "application/octet-stream"})
        assert status == 202 and body["job"]["name"] == "录屏.mp4"
        job = wait_for(client, body["job"]["id"], lambda job: job["status"] != "running")
        assert job["status"] == "done"
    assert paths and not paths[0].parent.exists()


def test_background_job_failure_is_reported_to_the_poller(payload):
    def recognize(images):
        raise ValueError("录屏中没有识别到完整蓝图预览界面。")

    with running_server(recognize) as client:
        job_id = client.request(path="/api/jobs", body=payload)[2]["job"]["id"]
        job = wait_for(client, job_id, lambda job: job["status"] != "running")
        assert job["status"] == "error" and job["error"] == "录屏中没有识别到完整蓝图预览界面。"


def test_preflight_allows_job_cancellation(service):
    client, _ = service
    _, headers, _ = client.request("OPTIONS", path="/api/jobs/x", headers={"Access-Control-Request-Method": "DELETE"})
    assert "DELETE" in headers["Access-Control-Allow-Methods"]
