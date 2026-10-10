"""Local video boundaries and coverage selection without real OCR/model work."""
import json
from pathlib import Path
import subprocess
import sys
import time
import shutil

import numpy as np
import pytest

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/"scripts"))
from ocr import video


def media_info(**overrides):
    stream={"index":0,"codec_type":"video","codec_name":"h264","width":2560,"height":1440,
            "avg_frame_rate":"60/1","r_frame_rate":"60/1","nb_frames":"594","duration":"9.9"}
    stream.update(overrides)
    return {"format":{"format_name":"mov,mp4,m4a,3gp,3g2,mj2","duration":"10.538"},"streams":[stream]}


def fake_probe(monkeypatch,data,seen=None):
    monkeypatch.setattr(video.shutil,"which",lambda name:f"/usr/bin/{name}")
    def run(command,**kwargs):
        if seen is not None:seen.append((command,kwargs))
        return subprocess.CompletedProcess(command,0,json.dumps(data),"")
    monkeypatch.setattr(video.subprocess,"run",run)


def sample_file(tmp_path,suffix="mp4"):
    path=tmp_path/f"recording.{suffix}";path.write_bytes(b"not-decoded-in-unit-test");return path


def test_probe_uses_video_duration_and_enforces_local_demuxer(tmp_path,monkeypatch):
    calls=[];fake_probe(monkeypatch,media_info(),calls)
    result=video.probe_video(sample_file(tmp_path))
    assert result["durationSeconds"]==9.9
    assert result["containerDurationSeconds"]==10.538
    assert result["sourceFrames"]==594
    assert result["decoderPixelLimit"]==2816*1728
    assert result["decodePixelBudgetUsed"]==2*594*2816*1728
    command,kwargs=calls[0]
    assert command[command.index("-protocol_whitelist")+1]=="file,pipe"
    assert command[command.index("-f")+1]=="mov"
    assert command[command.index("-max_pixels")+1]==str(video.MAX_INPUT_PIXELS)
    assert kwargs["timeout"]==15
    assert not kwargs.get("shell")


@pytest.mark.parametrize("suffix",["webm","mkv"])
def test_matroska_without_declared_frame_count_uses_bounded_estimate(tmp_path,monkeypatch,suffix):
    info=media_info(nb_frames="N/A",duration="N/A")
    info["format"]={"format_name":"matroska,webm","duration":"10"}
    fake_probe(monkeypatch,info)
    result=video.probe_video(sample_file(tmp_path,suffix))
    assert result["demuxer"]=="matroska"
    assert result["sourceFrameCountEstimated"]
    assert result["sourceFrames"]==600


@pytest.mark.parametrize("overrides,message",[
    ({"duration":"181"},"180 秒"),
    ({"width":6400,"height":4000},"2400 万"),
    ({"avg_frame_rate":"121/1"},"120 FPS"),
    ({"nb_frames":"10000","duration":"170"},"实际解码预算"),
])
def test_probe_rejects_excessive_work_before_decoding(tmp_path,monkeypatch,overrides,message):
    fake_probe(monkeypatch,media_info(**overrides))
    with pytest.raises(ValueError,match=message):video.probe_video(sample_file(tmp_path))


def test_network_video_and_oversized_file_never_start_probe(tmp_path,monkeypatch):
    def forbidden(*args,**kwargs):raise AssertionError("Unvalidated media reached a process")
    monkeypatch.setattr(video.subprocess,"run",forbidden)
    with pytest.raises(ValueError,match="本机"):video.probe_video("https://example.test/video.mp4")
    monkeypatch.setattr(video,"MAX_VIDEO_BYTES",2)
    with pytest.raises(ValueError,match="256 MiB"):video.probe_video(sample_file(tmp_path))


def test_candidate_indices_are_bounded_unique_and_include_both_ends():
    indices=video.candidate_indices(10800,60)
    assert len(indices)<=360 and indices==sorted(set(indices))
    assert indices[0]==0 and indices[-1]==10799
    assert video.candidate_indices(1,60)==[0]


def candidate(index,x,y=0,sharpness=1.,shade=40):
    return {"frameIndex":index,"timestampSeconds":index/60,"sharpness":sharpness,"visibleFraction":1.,
            "geometry":{"bounds":[0,0,80,64],"horizontal_thumb":[x,0,80,4],"vertical_thumb":[0,y,4,64]},
            "thumbnail":np.full((16,16),shade,np.uint8),"visibleMask":np.ones((8,10),bool)}


def test_selection_keeps_connected_bridge_and_extreme_coverage():
    candidates=[candidate(0,0),candidate(30,48,sharpness=1.5),candidate(60,96)]
    selected,report=video.select_candidates(candidates,3)
    assert selected==[0,1,2]
    assert report["sampledAreaCovered"]==1
    assert report["selectionOrder"][0]["frameIndex"]==30
    assert all(row["overlapWithSelection"]>=.18 for row in report["selectionOrder"][1:])


def test_static_near_duplicate_keeps_sharper_frame_but_not_different_position():
    candidates=[candidate(0,0,sharpness=.5),candidate(15,0,sharpness=1.5),candidate(30,48)]
    selected,report=video.select_candidates(candidates,3)
    assert selected==[1,2]
    assert report["nearDuplicateFrames"]==[{"frameIndex":0,"similarToFrame":15}]


def test_disconnected_or_budget_limited_coverage_is_not_silently_dropped():
    with pytest.raises(ValueError,match="连通覆盖"):
        video.select_candidates([candidate(0,0),candidate(1,500)],16)
    with pytest.raises(ValueError,match="连通覆盖"):
        video.select_candidates([candidate(0,0),candidate(1,48),candidate(2,96)],1)


def test_candidate_mask_allocation_is_bounded(monkeypatch):
    monkeypatch.setattr(video,"MAX_SELECTION_MASK_PIXELS",10)
    with pytest.raises(ValueError,match="滚动范围"):
        video.select_candidates([candidate(0,0),candidate(1,48)],16)


class FakeDecoder:
    """Stands in for subprocess.Popen(ffmpeg); ``outcome`` runs on the first communicate."""
    def __init__(self,command,outcome,**kwargs):
        self.command,self.kwargs,self.outcome=command,kwargs,outcome
        self.returncode=None;self.killed=False;self.waits=[]
    def communicate(self,timeout=None):
        self.waits.append(timeout)
        if self.killed:
            return "",""
        stderr,self.returncode=self.outcome(self)
        return "",stderr
    def kill(self):
        self.killed=True;self.returncode=-9


def test_decoder_uses_explicit_frame_and_wall_limits(tmp_path,monkeypatch):
    calls=[]
    def outcome(process):
        output=Path(process.command[-1]);output.parent.mkdir(parents=True,exist_ok=True)
        for n in range(1,3):(output.parent/f"frame-{n:04d}.jpg").write_bytes(b"analysis fixture")
        return "n: 0 pts: 0 pts_time:0\nn: 1 pts: 300 pts_time:0.5\n",0
    monkeypatch.setattr(video.subprocess,"Popen",lambda command,**kw:calls.append(FakeDecoder(command,outcome,**kw)) or calls[-1])
    info={"sourceFrames":60,"streamIndex":0,"width":640,"height":360,"demuxer":"mov"}
    rows=video._decode_frames(sample_file(tmp_path),info,[0,30],tmp_path/"frames",time.monotonic()+10,True)
    command=calls[0].command
    assert command[command.index("-protocol_whitelist")+1]=="file,pipe"
    assert command[command.index("-frames:v")+1]=="2"
    # The decoder cap follows the dimensions used for its work estimate, so
    # a later frame cannot silently grow to the global input-pixel maximum.
    assert command[command.index("-max_pixels")+1]==str(896*640)
    assert "trim=end_frame=60" in command[command.index("-vf")+1]
    assert "eq(n\\,30)" in command[command.index("-vf")+1]
    assert all(0<wait<=10 for wait in calls[0].waits)
    assert [(row[1],row[2]) for row in rows]==[(0,0.),(30,.5)]


def test_decode_timeout_is_a_readable_input_error(tmp_path,monkeypatch):
    processes=[]
    def never_finishes(process):
        raise subprocess.TimeoutExpired(process.command,.01)
    monkeypatch.setattr(video.subprocess,"Popen",lambda command,**kw:processes.append(FakeDecoder(command,never_finishes)) or processes[-1])
    info={"sourceFrames":60,"streamIndex":0,"width":640,"height":360,"demuxer":"mov"}
    with pytest.raises(ValueError,match="解码超时"):
        video._decode_frames(sample_file(tmp_path),info,[0],tmp_path/"frames",time.monotonic()+.05,False)
    assert processes[0].killed, "ffmpeg must not outlive the wall budget"


def test_cancelled_decode_kills_ffmpeg(tmp_path,monkeypatch):
    from ocr import progress
    processes=[]
    def never_finishes(process):
        raise subprocess.TimeoutExpired(process.command,.01)
    monkeypatch.setattr(video.subprocess,"Popen",lambda command,**kw:processes.append(FakeDecoder(command,never_finishes)) or processes[-1])
    def report(stage,fraction):
        raise progress.Cancelled()
    info={"sourceFrames":60,"streamIndex":0,"width":640,"height":360,"demuxer":"mov"}
    with progress.reporting(report),pytest.raises(progress.Cancelled):
        video._decode_frames(sample_file(tmp_path),info,[0],tmp_path/"frames",time.monotonic()+10,False)
    assert processes[0].killed


def test_extract_report_preserves_timestamp_index_and_list_contract(tmp_path,monkeypatch):
    info={"width":2560,"height":1440,"sourceFrames":60,"fps":60}
    monkeypatch.setattr(video,"probe_video",lambda path:info)
    monkeypatch.setattr(video,"candidate_indices",lambda *args:[0,30])
    monkeypatch.setattr(video,"_decode_frames",lambda *args,**kw:[(Path("a.png"),0,0.),(Path("b.png"),30,.5)])
    monkeypatch.setattr(video,"_analyze_frame",lambda p,i,t:candidate(i,0 if i==0 else 48))
    monkeypatch.setattr(video.imageio,"imread",lambda path:np.zeros((1440,2560,3),np.uint8))
    images,report=video.extract_keyframes(sample_file(tmp_path))
    assert report["selectedFrameCount"]==2
    assert isinstance(report["selectedFrames"],list)
    assert report["selectedFrames"][1]["timestampSeconds"]==.5
    assert report["selectedFrames"][1]["frameIndex"]==30
    assert "image" not in report["selectedFrames"][0]
    assert images[1]["image"].shape==(1440,2560,3)


@pytest.mark.skipif(not shutil.which("ffmpeg") or not shutil.which("ffprobe"),reason="local ffmpeg tools unavailable")
def test_actual_local_decoder_keeps_requested_frames_and_timestamps(tmp_path):
    path=tmp_path/"tiny.mp4"
    subprocess.run(["ffmpeg","-hide_banner","-loglevel","error","-nostdin","-y",
                    "-f","lavfi","-i","color=c=white:s=160x128:r=10","-frames:v","4",
                    "-c:v","mpeg4",str(path)],check=True,capture_output=True,timeout=10)
    info=video.probe_video(path)
    rows=video._decode_frames(path,info,[0,3],tmp_path/"decoded",time.monotonic()+10,False)
    assert [row[1] for row in rows]==[0,3]
    assert rows[0][2]==pytest.approx(0.) and rows[1][2]==pytest.approx(.3)
    assert video.cv2.imread(str(rows[1][0])).shape==(128,160,3)


@pytest.mark.skipif(not shutil.which("ffmpeg") or not shutil.which("ffprobe"),reason="local ffmpeg tools unavailable")
def test_actual_decoder_rejects_frames_exceeding_probed_pixel_budget(tmp_path):
    path=tmp_path/"larger.mp4"
    subprocess.run(["ffmpeg","-hide_banner","-loglevel","error","-nostdin","-y",
                    "-f","lavfi","-i","color=c=white:s=640x360:r=10","-frames:v","2",
                    "-c:v","mpeg4",str(path)],check=True,capture_output=True,timeout=10)
    info=video.probe_video(path)
    # Simulate a stream whose later decoded size exceeds its initial metadata.
    info.update(width=128,height=128)
    with pytest.raises(ValueError,match="解码失败"):
        video._decode_frames(path,info,[0,1],tmp_path/"decoded",time.monotonic()+10,False)


def tiny_video(path,size="160x128",frames=4):
    subprocess.run(["ffmpeg","-hide_banner","-loglevel","error","-nostdin","-y",
                    "-f","lavfi","-i",f"testsrc=s={size}:r=10","-frames:v",str(frames),
                    "-c:v","mpeg4",str(path)],check=True,capture_output=True,timeout=10)
    return path


def test_decoder_backend_choice(monkeypatch):
    monkeypatch.setattr(video.shutil,"which",lambda name:None)
    monkeypatch.delenv("BLUEPRINT_VIDEO_DECODER",raising=False)
    assert video.decoder_backend()=="opencv"
    monkeypatch.setenv("BLUEPRINT_VIDEO_DECODER","ffmpeg")
    with pytest.raises(ValueError,match="ffmpeg"):video.decoder_backend()
    monkeypatch.setattr(video.shutil,"which",lambda name:f"/usr/bin/{name}")
    monkeypatch.setenv("BLUEPRINT_VIDEO_DECODER","opencv")
    assert video.decoder_backend()=="opencv"
    monkeypatch.delenv("BLUEPRINT_VIDEO_DECODER")
    assert video.decoder_backend()=="ffmpeg"


@pytest.mark.skipif(not shutil.which("ffmpeg") or not shutil.which("ffprobe"),reason="local ffmpeg tools unavailable")
def test_opencv_decoder_matches_ffmpeg_frames_and_timestamps(tmp_path,monkeypatch):
    """The desktop app has no ffmpeg CLI; OpenCV's bundled FFmpeg must give the same pixels."""
    path=tiny_video(tmp_path/"tiny.mp4",frames=6)
    decoded={}
    for backend in ("ffmpeg","opencv"):
        monkeypatch.setenv("BLUEPRINT_VIDEO_DECODER",backend)
        info=video.probe_video(path)
        assert info["decoder"]==backend and info["sourceFrames"]==6 and (info["width"],info["height"])==(160,128)
        rows=video._decode_frames(path,info,[0,2,5],tmp_path/backend,time.monotonic()+10,False)
        decoded[backend]=([row[1] for row in rows],[row[2] for row in rows],
                          [video.cv2.imread(str(row[0])) for row in rows])
    assert decoded["ffmpeg"][0]==decoded["opencv"][0]==[0,2,5]
    assert decoded["opencv"][1]==pytest.approx(decoded["ffmpeg"][1])
    assert decoded["opencv"][1]==pytest.approx([0,.2,.5])
    assert all(np.array_equal(a,b) for a,b in zip(decoded["ffmpeg"][2],decoded["opencv"][2]))


@pytest.mark.skipif(not shutil.which("ffmpeg"),reason="local ffmpeg tools unavailable")
def test_opencv_decoder_rejects_frames_of_another_size_and_cancels(tmp_path,monkeypatch):
    from ocr import progress
    monkeypatch.setenv("BLUEPRINT_VIDEO_DECODER","opencv")
    path=tiny_video(tmp_path/"larger.mp4",size="640x360",frames=40)
    info=video.probe_video(path)
    with pytest.raises(ValueError,match="尺寸改变"):
        video._decode_frames(path,{**info,"width":128,"height":128},[0],tmp_path/"a",time.monotonic()+10,False)
    def report(stage,fraction):
        raise progress.Cancelled()
    with progress.reporting(report),pytest.raises(progress.Cancelled):
        video._decode_frames(path,info,[39],tmp_path/"b",time.monotonic()+10,False)


def test_image_files_use_unicode_safe_io(tmp_path):
    """cv2.imread/imwrite fail on Windows for non-ASCII paths (e.g. a Chinese user name)."""
    import re
    import numpy as np
    from ocr import imageio
    source = Path(__file__).resolve().parents[1] / "scripts" / "ocr"
    offenders = [f.name for f in source.glob("*.py")
                 if f.name != "imageio.py" and re.search(r"cv2\.(imread|imwrite)\(", f.read_text("utf-8"))]
    assert offenders == []
    image = np.arange(48, dtype=np.uint8).reshape(4, 4, 3)
    path = tmp_path / "中文 目录" / "图片.png"
    path.parent.mkdir()
    assert imageio.imwrite(path, image)
    assert np.array_equal(imageio.imread(path), image)
    assert imageio.imread(tmp_path / "缺失.png") is None
