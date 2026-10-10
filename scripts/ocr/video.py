"""Bounded local-video decoding and auditable blueprint keyframe selection.

Candidate frames are inexpensive JPEG analysis images. Only selected frames are
decoded a second time at native resolution. Scrollbar poses guide overlap and
coverage selection; the normal stitcher still validates their actual pixels.
"""
from __future__ import annotations

import math
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import time

import cv2
import numpy as np

from . import imageio, progress
from .stitch import preview_geometry, usable_mask

MAX_VIDEO_BYTES = 256 * 1024 * 1024
MAX_DURATION_SECONDS = 180
MAX_INPUT_PIXELS = 24_000_000
MAX_SELECTED_PIXELS = 120_000_000
MAX_CANDIDATES = 360
MAX_SOURCE_FRAMES = 10_800
MAX_DECODED_PIXELS = 12_000_000_000  # Both decoding passes, not just kept frames.
MAX_DECODE_SECONDS = 90
DECODER_THREAD_PIXELS = 72_000_000  # Bounds frame-thread buffers, not quality.
MAX_SELECTION_MASK_PIXELS = 64_000_000
ANALYSIS_WIDTH = 1280
TARGET_SAMPLE_FPS = 6


def _number(value, default=0.):
    try:
        result=float(value)
        return result if math.isfinite(result) else default
    except (ValueError, TypeError):
        return default


def _rate(value):
    try:
        a,b=str(value).split("/")
        return _number(a)/_number(b) if _number(b)>0 else 0.
    except ValueError:
        return _number(value)


def _decoder_pixels(width, height):
    # FFmpeg applies max_pixels to padded motion-compensation scratch buffers
    # too (e.g. MPEG-4 needs 320x280 for a displayed 160x128 frame). Include
    # bounded codec padding in both the process cap and the work estimate.
    return (math.ceil(width/64)*64+256)*(math.ceil(height/64)*64+256)


def _decoder_threads(width, height):
    # Frame-threaded H.264 decoding is bit-exact and dominates wall time for
    # high-bitrate recordings (60 fps 1440p: 8 s with 2 threads, 2.6 s with 16).
    # Each thread holds its own frames, so large frames get fewer threads.
    pixels=_decoder_pixels(width,height)
    return max(2,min(16,len(os.sched_getaffinity(0)) if hasattr(os,"sched_getaffinity") else os.cpu_count() or 2,DECODER_THREAD_PIXELS//pixels))


def decoder_backend():
    """``ffmpeg`` (CLI on PATH) or ``opencv`` (FFmpeg built into opencv-python, used by the desktop app).

    ``BLUEPRINT_VIDEO_DECODER`` forces one; by default the CLI is used when installed.
    """
    choice=os.environ.get("BLUEPRINT_VIDEO_DECODER","").strip().lower()
    cli=bool(shutil.which("ffprobe") and shutil.which("ffmpeg"))
    if choice=="ffmpeg" or (choice!="opencv" and cli):
        if not cli:
            raise ValueError("视频识别需要本机安装 ffmpeg 和 ffprobe。")
        return "ffmpeg"
    if "FFMPEG" not in {cv2.videoio_registry.getBackendName(b) for b in cv2.videoio_registry.getStreamBackends()}:
        raise ValueError("视频识别需要本机安装 ffmpeg 和 ffprobe。")
    return "opencv"


def _short_path(path):
    """Windows 8.3 alias of a non-ASCII path (ASCII-only), or None when unavailable."""
    if os.name!="nt" or str(path).isascii():
        return None
    import ctypes
    buffer=ctypes.create_unicode_buffer(32768)
    length=ctypes.windll.kernel32.GetShortPathNameW(str(path),buffer,len(buffer))
    alias=buffer.value if 0<length<len(buffer) else ""
    return alias if alias and alias.isascii() else None


def _open_capture(path, info=None):
    threads=_decoder_threads(info["width"],info["height"]) if info else 1
    path=Path(path).resolve()
    # FFmpeg normally accepts UTF-8 paths; the short alias is a fallback for
    # builds that pass the name through the ANSI code page.
    for name in dict.fromkeys(filter(None,(str(path),_short_path(path)))):
        capture=cv2.VideoCapture(name,cv2.CAP_FFMPEG,[cv2.CAP_PROP_N_THREADS,threads])
        if capture.isOpened():
            return capture
        capture.release()
    if not str(path).isascii():
        raise ValueError("无法读取视频；如果文件能正常播放，请把它放到只含英文和数字的文件夹并改成英文文件名后重试。")
    raise ValueError("无法读取视频信息；请提供完整、可播放的视频文件。")


def _probe_opencv(path, demuxer):
    capture=_open_capture(path)
    try:
        width=int(capture.get(cv2.CAP_PROP_FRAME_WIDTH));height=int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT))
        fps=_number(capture.get(cv2.CAP_PROP_FPS))
        frames=int(_number(capture.get(cv2.CAP_PROP_FRAME_COUNT)))
        fourcc=int(_number(capture.get(cv2.CAP_PROP_FOURCC)))
    finally:
        capture.release()
    codec="".join(chr((fourcc>>8*i)&255) for i in range(4)).strip("\x00 ").lower() or None
    duration=frames/fps if fps>0 else 0.
    # Matroska/WebM rarely store a frame count; OpenCV then estimates it from duration × fps.
    return width,height,duration,duration,fps,frames,demuxer=="matroska",codec,0


def probe_video(path):
    path=Path(path)
    if not path.is_file():
        raise ValueError("视频必须是本机已有的文件，不能提供网络地址。")
    if not 0<path.stat().st_size<=MAX_VIDEO_BYTES:
        raise ValueError("视频文件大小需在 256 MiB 以内。")
    demuxer={".mp4":"mov",".mov":"mov",".mkv":"matroska",".webm":"matroska"}.get(path.suffix.lower())
    if demuxer is None:
        raise ValueError("仅支持本地 MP4、MOV、MKV 和 WebM 文件。")
    backend=decoder_backend()
    probe=_probe_ffmpeg if backend=="ffmpeg" else _probe_opencv
    width,height,duration,container_duration,fps,declared_frames,estimated,codec,stream_index=probe(path,demuxer)
    if min(width,height)<128 or width*height>MAX_INPUT_PIXELS:
        raise ValueError("视频画面需至少 128px，且不超过 2400 万像素。")
    if not 0<duration<=MAX_DURATION_SECONDS or not 0<fps<=120:
        raise ValueError("视频画面需不超过 180 秒、120 FPS，并具有有效时长。")
    estimated_frames=declared_frames
    decoder_pixels=_decoder_pixels(width,height)
    if decoder_pixels>MAX_INPUT_PIXELS or estimated_frames>MAX_SOURCE_FRAMES or 2*estimated_frames*decoder_pixels>MAX_DECODED_PIXELS:
        raise ValueError("视频超过实际解码预算，请缩短录屏或降低视频分辨率。")
    return {"fileName":path.name,"fileBytes":path.stat().st_size,"width":width,"height":height,
            "durationSeconds":duration,"containerDurationSeconds":container_duration,"fps":fps,
            "sourceFrames":estimated_frames,"sourceFrameCountEstimated":estimated,"codec":codec,"streamIndex":stream_index,"demuxer":demuxer,
            "decoder":backend,"decoderPixelLimit":decoder_pixels,"decodePixelBudgetUsed":2*estimated_frames*decoder_pixels}


def _probe_ffmpeg(path, demuxer):
    import json
    command=["ffprobe","-v","error","-protocol_whitelist","file,pipe","-f",demuxer,
             "-max_pixels",str(MAX_INPUT_PIXELS),
             "-show_entries","format=format_name,duration:stream=index,codec_type,codec_name,width,height,avg_frame_rate,r_frame_rate,nb_frames,duration",
             "-of","json",str(path.resolve())]
    try:
        completed=subprocess.run(command,capture_output=True,text=True,timeout=15,check=True)
        data=json.loads(completed.stdout)
    except (subprocess.SubprocessError, ValueError) as error:
        raise ValueError("无法读取视频信息；请提供完整、可播放的视频文件。") from error
    if not set(data.get("format",{}).get("format_name","").split(","))&{"mov","mp4","matroska","webm"}:
        raise ValueError("仅支持本地 MP4、MOV、MKV 和 WebM 视频容器。")
    streams=[s for s in data.get("streams",[]) if s.get("codec_type")=="video"]
    if len(streams)!=1:
        raise ValueError("视频必须包含且仅包含一条画面轨道。")
    stream=streams[0]
    width,height=int(stream.get("width",0)),int(stream.get("height",0))
    container_duration=_number(data.get("format",{}).get("duration"))
    duration=_number(stream.get("duration"),container_duration)
    fps=_rate(stream.get("avg_frame_rate")) or _rate(stream.get("r_frame_rate"))
    declared_frames=int(_number(stream.get("nb_frames")))
    estimated_frames=declared_frames or math.ceil(duration*max(fps,_rate(stream.get("r_frame_rate"))))
    return (width,height,duration,container_duration,fps,estimated_frames,not bool(declared_frames),
            stream.get("codec_name"),stream["index"])


def candidate_indices(frame_count, fps, maximum=MAX_CANDIDATES):
    if frame_count<1 or maximum<1:
        raise ValueError("视频没有可抽取的画面。")
    count=min(maximum,frame_count,max(2,math.ceil(frame_count/fps*TARGET_SAMPLE_FPS)))
    return sorted(set(np.rint(np.linspace(0,frame_count-1,count)).astype(int).tolist()))


def _analysis_size(info):
    width=min(ANALYSIS_WIDTH,info["width"])
    return width,max(2,round(info["height"]*width/info["width"]/2)*2)


def _decode_frames(path, info, indices, destination, deadline, analysis):
    if info.get("decoder")=="opencv":
        return _decode_frames_opencv(path,info,indices,destination,deadline,analysis)
    return _decode_frames_ffmpeg(path,info,indices,destination,deadline,analysis)


def _decode_frames_opencv(path, info, indices, destination, deadline, analysis):
    """Sequential decode with OpenCV's bundled FFmpeg; only wanted frames are converted."""
    destination=Path(destination);destination.mkdir(parents=True,exist_ok=True)
    wanted=sorted(set(indices));last=min(wanted[-1],MAX_SOURCE_FRAMES-1)
    size=_analysis_size(info)
    capture=_open_capture(path,info)
    rows=[]
    try:
        position=0
        for number,index in enumerate(wanted):
            if index>last:
                break
            while position<=index:
                if time.monotonic()>=deadline:
                    raise ValueError("视频解码超时，请缩短录屏。")
                if not capture.grab():
                    break
                position+=1
                if position%16==0:
                    progress.check()
            if position<=index:
                break  # Fewer frames than declared (estimated counts).
            ok,frame=capture.retrieve()
            if not ok or frame is None:
                raise ValueError("视频画面解码失败，请检查文件是否完整。")
            if frame.shape[:2]!=(info["height"],info["width"]):
                # The work estimate assumed the probed size (ffmpeg enforces it via -max_pixels).
                raise ValueError("视频解码期间画面尺寸改变，不能混合识别。")
            timestamp=capture.get(cv2.CAP_PROP_POS_MSEC)/1000
            if analysis:
                file=destination/f"frame-{number+1:04}.jpg"
                frame=cv2.resize(frame,size,interpolation=cv2.INTER_AREA)
                imageio.imwrite(str(file),frame,[cv2.IMWRITE_JPEG_QUALITY,90])
            else:
                file=destination/f"frame-{number+1:04}.png"
                imageio.imwrite(str(file),frame,[cv2.IMWRITE_PNG_COMPRESSION,1])
            # Same precision as the timestamps printed by ffmpeg showinfo.
            rows.append((file,index,float(f"{timestamp:.6g}")))
            progress.advance((position)/(last+1))
    finally:
        capture.release()
    if not rows or (len(rows)!=len(wanted) and not (analysis and info.get("sourceFrameCountEstimated"))):
        raise ValueError("视频帧数或时间戳与解码结果不符，未使用不完整的抽帧结果。")
    return rows


def _decode_frames_ffmpeg(path, info, indices, destination, deadline, analysis):
    """Run ffmpeg with explicit local protocols, frame bounds and a wall budget."""
    destination=Path(destination);destination.mkdir(parents=True,exist_ok=True)
    expression="+".join(f"eq(n\\,{index})" for index in indices)
    filters=[f"trim=end_frame={min(info['sourceFrames'],MAX_SOURCE_FRAMES)}",f"select={expression}"]
    if analysis:
        width,height=_analysis_size(info)
        filters.append(f"scale={width}:{height}")
    filters.append("showinfo")
    extension="jpg" if analysis else "png"
    command=["ffmpeg","-hide_banner","-nostdin","-y","-loglevel","info",
             # Reject frames exceeding the budget at the decoder itself. The
             # two-pass estimate includes this padded per-frame limit; merely
             # allowing the global 24MP input maximum would break the estimate
             # if a video changed from small frames to much larger ones.
             "-protocol_whitelist","file,pipe","-f",info["demuxer"],
             "-max_pixels",str(min(MAX_INPUT_PIXELS,_decoder_pixels(info["width"],info["height"]))),
             "-threads",str(_decoder_threads(info["width"],info["height"])),"-i",str(Path(path).resolve()),
             "-map",f"0:{info['streamIndex']}","-an","-sn","-dn","-filter_threads","1",
             "-vf",",".join(filters),"-frames:v",str(len(indices)),"-fps_mode","vfr"]
    command += ["-q:v","3"] if analysis else ["-compression_level","3"]
    command.append(str(destination/f"frame-%04d.{extension}"))
    remaining=deadline-time.monotonic()
    if remaining<=0:
        raise ValueError("视频解码超时，请缩短录屏。")
    process=subprocess.Popen(command,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE,text=True)
    try:
        while True:
            try:
                # Poll so a cancelled recognition stops ffmpeg promptly.
                _,stderr=process.communicate(timeout=max(.01,min(.25,deadline-time.monotonic())))
                break
            except subprocess.TimeoutExpired:
                if time.monotonic()>=deadline:
                    raise ValueError("视频解码超时，请缩短录屏。") from None
                progress.check()
    except BaseException:
        process.kill();process.communicate()
        raise
    if process.returncode:
        raise ValueError("视频画面解码失败，请检查文件是否完整。")
    timestamps=[float(value) for value in re.findall(r"\bn:\s*\d+\s+pts:.*?\bpts_time:([\d.eE+\-]+)",stderr)]
    files=sorted(destination.glob(f"frame-*.{extension}"))
    complete=len(files)==len(indices)
    if not files or len(timestamps)!=len(files) or (not complete and not (analysis and info.get("sourceFrameCountEstimated"))):
        raise ValueError("视频帧数或时间戳与解码结果不符，未使用不完整的抽帧结果。")
    return [(file,index,timestamp) for file,index,timestamp in zip(files,indices,timestamps)]


def _analyze_frame(path,index,timestamp):
    image=imageio.imread(str(path))
    if image is None:
        raise ValueError("无法读取视频候选画面。")
    geometry=preview_geometry(image)
    mask,occlusions=usable_mask(image,geometry)
    x0,y0,x1,y1=geometry["bounds"]
    gray=cv2.cvtColor(image[y0:y1,x0:x1],cv2.COLOR_BGR2GRAY)
    valid=mask[y0:y1,x0:x1]>0
    laplacian=cv2.Laplacian(gray,cv2.CV_32F)
    gradient=cv2.Sobel(gray,cv2.CV_32F,1,0)+cv2.Sobel(gray,cv2.CV_32F,0,1)
    sharpness=float(np.var(laplacian[valid])/max(1.,np.var(gradient[valid])))
    return {"frameIndex":index,"timestampSeconds":timestamp,"analysisPath":str(path),
            "geometry":geometry,"sharpness":sharpness,"visibleFraction":float(valid.mean()),
            "occlusionCount":len(occlusions),"thumbnail":cv2.resize(gray,(160,96)),
            "visibleMask":cv2.resize(valid.astype(np.uint8),(max(1,(x1-x0)//8),max(1,(y1-y0)//8)),interpolation=cv2.INTER_AREA)>0}


_REJECTION_HINTS={
    "Cannot locate the blueprint sidebar divider":"找不到右侧信息栏左边的黄色分隔线",
    "Cannot locate the vertical scroll thumb":"找不到预览区右侧的竖向滚动条",
    "Cannot locate the horizontal scroll thumb":"找不到预览区底部的横向滚动条",
}


def _no_preview_message(rejected,info):
    """Say why every sampled frame failed instead of a bare 'not found'."""
    reasons={}
    for row in rejected:
        reasons[row["reason"]]=reasons.get(row["reason"],0)+1
    detail="；".join(f"{_REJECTION_HINTS.get(reason,reason)}（{count} 帧）"
                    for reason,count in sorted(reasons.items(),key=lambda item:-item[1])[:2])
    return (f"录屏中没有识别到完整蓝图预览界面：采样的 {len(rejected)} 帧都无法定位，{detail}。"
            f"录屏分辨率 {info['width']}×{info['height']}。请录制整个游戏画面（不要裁剪、不要带浏览器或任务栏边框），"
            "并停留在蓝图预览界面，右侧信息栏和两条滚动条都要露出来。")


def select_candidates(candidates, max_frames):
    """Greedily add clear new visible area while retaining a connected overlap."""
    if not candidates:
        raise ValueError("录屏中没有识别到完整蓝图预览界面。")
    g=candidates[0]["geometry"];x0,y0,x1,y1=g["bounds"]
    ratio=np.array([(x1-x0)/g["horizontal_thumb"][2],(y1-y0)/g["vertical_thumb"][3]])
    thumbs=np.array([[c["geometry"]["horizontal_thumb"][0],c["geometry"]["vertical_thumb"][1]] for c in candidates])
    positions=(thumbs-thumbs.min(axis=0))*ratio
    widths=np.array([c["geometry"]["bounds"][2]-c["geometry"]["bounds"][0] for c in candidates])
    heights=np.array([c["geometry"]["bounds"][3]-c["geometry"]["bounds"][1] for c in candidates])
    canvas_w=math.ceil(float((positions[:,0]+widths).max())/8)+2
    canvas_h=math.ceil(float((positions[:,1]+heights).max())/8)+2
    if canvas_w*canvas_h>2_000_000 or canvas_w*canvas_h*len(candidates)>MAX_SELECTION_MASK_PIXELS:
        raise ValueError("录屏滚动范围不可靠，无法安全确定候选帧覆盖。")
    footprints=[];deduplicated=[];duplicates=[]
    for i,(candidate,position) in enumerate(zip(candidates,positions)):
        left,top=np.rint(position/8).astype(int)
        mask=candidate["visibleMask"]
        footprint=np.zeros((canvas_h,canvas_w),bool)
        footprint[top:top+mask.shape[0],left:left+mask.shape[1]]=mask
        footprints.append(footprint)
        duplicate=None
        for j in reversed(deduplicated):
            if np.linalg.norm(positions[i]-positions[j])<6 and abs(candidate["visibleFraction"]-candidates[j]["visibleFraction"])<.003:
                difference=np.abs(candidate["thumbnail"].astype(float)-candidates[j]["thumbnail"]).mean()
                if difference<2.:
                    duplicate=j;break
        if duplicate is None:
            deduplicated.append(i)
        elif candidate["sharpness"]>candidates[duplicate]["sharpness"]:
            deduplicated.remove(duplicate);deduplicated.append(i);duplicates.append({"frameIndex":candidates[duplicate]["frameIndex"],"similarToFrame":candidate["frameIndex"]})
        else:
            duplicates.append({"frameIndex":candidate["frameIndex"],"similarToFrame":candidates[duplicate]["frameIndex"]})
    quality=np.array([c["sharpness"] for c in candidates]);normalizer=max(float(np.median(quality)),1e-6)
    quality=np.clip(quality/normalizer,.35,1.5)
    selected=[];records=[];seen=np.zeros((canvas_h,canvas_w),bool)
    remaining=set(deduplicated)
    total_visible=np.logical_or.reduce([footprints[i] for i in deduplicated])
    while remaining and len(selected)<max_frames:
        ranked=[]
        for i in remaining:
            footprint=footprints[i]
            overlap=max((float((footprint&footprints[other]).sum()/max(1,footprint.sum())) for other in selected),default=0.)
            if selected and overlap<.18:
                continue
            gain=int((footprint&~seen).sum())
            score=gain*(.75+.25*quality[i])
            ranked.append((score,quality[i],-candidates[i]["timestampSeconds"],i,gain,overlap))
        if not ranked:
            break
        _,_,_,index,gain,overlap=max(ranked)
        if selected and gain<max(3,int(total_visible.sum()*.0005)):
            break
        selected.append(index);remaining.remove(index);seen|=footprints[index]
        records.append({"frameIndex":candidates[index]["frameIndex"],"timestampSeconds":candidates[index]["timestampSeconds"],
                        "sharpness":round(candidates[index]["sharpness"],5),"visibleFraction":round(candidates[index]["visibleFraction"],5),
                        "newCoverageSamples":gain,"overlapWithSelection":round(overlap,5),
                        "reason":"clear coverage anchor" if len(selected)==1 else "new visible area with overlapping selected frames"})
    unselected_fraction=float((total_visible&~seen).sum()/max(1,total_visible.sum()))
    if unselected_fraction>.015:
        raise ValueError("录屏包含无法用当前帧预算连通覆盖的区域，请增加扫视重叠或分段录制。")
    return sorted(selected,key=lambda i:candidates[i]["frameIndex"]),{
        "selectionOrder":records,"nearDuplicateFrames":duplicates,
        "sampledAreaCovered":1-unselected_fraction,
        "overlapBasis":"scrollbar-derived viewport bounds; final pixel registration must validate",
        "coverageMeaning":"coverage of observed video views, not proof that the whole blueprint was recorded"}


def extract_keyframes(path,max_frames=16):
    if not isinstance(max_frames,int) or not 1<=max_frames<=16:
        raise ValueError("视频最多选择 1–16 张关键帧。")
    info=probe_video(path)
    budget=min(max_frames,MAX_SELECTED_PIXELS//(info["width"]*info["height"]))
    if budget<1:
        raise ValueError("视频关键帧超过总像素预算。")
    indices=candidate_indices(info["sourceFrames"],info["fps"])
    deadline=time.monotonic()+MAX_DECODE_SECONDS
    with tempfile.TemporaryDirectory(prefix="blueprint-video-") as directory:
        directory=Path(directory)
        progress.stage("解码录屏",0.,.05)
        sampled=_decode_frames(path,info,indices,directory/"candidates",deadline,analysis=True)
        progress.stage("挑选清晰的关键帧",.05,.09)
        candidates=[];rejected=[]
        for number,(file,index,timestamp) in enumerate(sampled):
            try:
                candidates.append(_analyze_frame(file,index,timestamp))
            except ValueError as error:
                rejected.append({"frameIndex":index,"timestampSeconds":timestamp,"reason":str(error)})
            progress.advance((number+1)/len(sampled))
        if not candidates:
            raise ValueError(_no_preview_message(rejected,info))
        selected,selection_report=select_candidates(candidates,budget)
        selected_indices=[candidates[i]["frameIndex"] for i in selected]
        progress.stage(f"解码选中的 {len(selected_indices)} 帧原图",.09,.14)
        decoded=_decode_frames(path,info,selected_indices,directory/"selected",deadline,analysis=False)
        images=[]
        for file,index,timestamp in decoded:
            image=imageio.imread(str(file))
            if image is None or image.shape[:2]!=(info["height"],info["width"]):
                raise ValueError("视频解码期间画面尺寸改变，不能混合识别。")
            images.append({"name":f"{Path(path).stem}-frame-{index:06}.png","image":image,
                           "timestampSeconds":timestamp,"frameIndex":index})
    report={"version":1,**info,"sampledFrames":len(sampled),"validCandidates":len(candidates),
            "selectedFrameCount":len(images),"maxSelectedFrames":budget,"rejectedCandidates":rejected,
            "decodeWallBudgetSeconds":MAX_DECODE_SECONDS,"decodeWallSeconds":round(MAX_DECODE_SECONDS-(deadline-time.monotonic()),3),
            "selectedFrames":[{k:v for k,v in row.items() if k!="image"} for row in images],**selection_report}
    return images,report
