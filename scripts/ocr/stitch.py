"""Register overlapping Endfield blueprint screenshots without mistaking repeats.

The preview's scroll thumbs provide a coarse position prior; SIFT then measures
the actual displacement. A robust pose graph checks all overlapping image pairs.
The scroll prior is important: identical production cells otherwise produce very
convincing but incorrect SIFT homographies. Coordinates are always pixel corners.
"""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path

import cv2
import numpy as np

try:
    from . import imageio, progress
except ImportError:  # run as a standalone script
    import imageio
    import progress

MAX_NORMALIZED_PIXELS = 120_000_000
KNN_WORKERS = 4
SIFT_WORKERS = 2


def _cpus():
    if hasattr(os, "sched_getaffinity"):
        return len(os.sched_getaffinity(0)) or 1
    return os.cpu_count() or 1


def _workers():
    configured = os.environ.get("BLUEPRINT_OCR_THREADS")
    return max(1, int(configured)) if configured else max(1, min(16, _cpus()))


def _components(binary, kernel):
    opened = cv2.morphologyEx(binary.astype(np.uint8), cv2.MORPH_OPEN, kernel)
    return cv2.connectedComponentsWithStats(opened)[2][1:]


def preview_geometry(image):
    """Locate the sidebar divider and scroll thumbs, using relative UI bands."""
    h, w = image.shape[:2]
    hsv = cv2.cvtColor(image, cv2.COLOR_BGR2HSV)
    # The game uses a bright yellow/cyan divider immediately before its sidebar.
    band = hsv[int(h * .075):int(h * .28)]
    saturated = (band[:, :, 1] > 180) & (band[:, :, 2] > 180)
    columns = saturated.sum(axis=0).astype(float)
    columns[:int(w * .60)] = 0
    columns[int(w * .90):] = 0
    divider = int(columns.argmax())
    if columns[divider] < band.shape[0] * .35:
        raise ValueError("Cannot locate the blueprint sidebar divider")
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    dark = (gray < 100).astype(np.uint8)
    vm = np.zeros_like(dark)
    vm[int(h * .08):int(h * .94), divider-int(w*.023):divider-5] = 1
    candidates = _components(dark * vm, np.ones((int(h*.10), 1), np.uint8))
    vertical = [r for r in candidates if 2 <= r[2] <= w*.007 and r[3] > h*.10]
    vertical = max(vertical, key=lambda r: (r[0], r[3])) if vertical else None
    hm = np.zeros_like(dark)
    hm[int(h*.925):int(h*.965), int(w*.014):divider] = 1
    candidates = _components(dark * hm, np.ones((1, int(w*.20)), np.uint8))
    horizontal = [r for r in candidates if 2 <= r[3] <= h*.010]
    horizontal = max(horizontal, key=lambda r: r[2]) if horizontal else None
    scrolls = [horizontal is not None, vertical is not None]
    if not any(scrolls):
        raise ValueError("Cannot locate either preview scroll thumb")
    # The game draws no scrollbar (not even its track) along an axis where the
    # whole blueprint already fits. Use the usual bar position (measured at
    # 2560x1440: vertical x = divider-21, horizontal y = 1355) and a thumb that
    # spans the whole view: zero scroll offset, view/content ratio 1.
    right = int(vertical[0]) if vertical is not None else divider - round(w * 21 / 2560)
    bottom = int(horizontal[1]) if horizontal is not None else round(h * 1355 / 1440)
    # Scrollbars sit just outside the useful preview. A small inset removes the
    # edge fade, while enough of the first/last cell remains for footprint fits.
    bounds = [int(w*.016), int(h*.107), right-8, bottom-13]
    if vertical is None:
        vertical = [right, bounds[1], 8, bounds[3]-bounds[1]]
    if horizontal is None:
        horizontal = [bounds[0], bottom, bounds[2]-bounds[0], 8]
    return {
        "bounds": bounds,
        "vertical_thumb": [int(x) for x in vertical[:4]],
        "horizontal_thumb": [int(x) for x in horizontal[:4]],
        "sidebar_x": divider,
        # False when that axis cannot scroll and its thumb was synthesized.
        "scrolls": scrolls,
    }


def usable_mask(image, geometry):
    h, w = image.shape[:2]
    x0, y0, x1, y1 = geometry["bounds"]
    mask = np.zeros((h, w), np.uint8)
    mask[y0:y1, x0:x1] = 255
    # Fixed preview caption.
    mask[y0:int(h*.120), x0:int(w*.117)] = 0
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    # Tooltip boxes are solid dark rectangles with text holes. Closing fills
    # those holes without confusing them with thin machine borders or pipes.
    dark = ((gray < 65) & (mask > 0)).astype(np.uint8)
    close_size = max(3, int(round(15*w/2560)) | 1)
    open_size = max(3, int(round(17*w/2560)) | 1)
    closed = cv2.morphologyEx(dark, cv2.MORPH_CLOSE, np.ones((close_size, close_size), np.uint8))
    closed = cv2.morphologyEx(closed, cv2.MORPH_OPEN, np.ones((open_size, open_size), np.uint8))
    stats = cv2.connectedComponentsWithStats(closed)[2][1:]
    occlusions = []
    for x, y, ww, hh, area in stats:
        candidates = [(int(x), int(y), int(ww), int(hh))]
        split_routes = ww > w*.08 and hh >= h*.18
        if split_routes:
            # A tooltip can touch a dark route and become one component that
            # spans the whole viewport. Remove the thin connecting routes
            # before testing the solid tooltip bodies. Both kernel dimensions
            # scale with the screenshot, including video analysis thumbnails.
            patch = closed[y:y+hh, x:x+ww]
            bodies = cv2.morphologyEx(patch, cv2.MORPH_OPEN, np.ones(
                (max(3, int(h*.025) | 1), max(3, int(w*.065) | 1)), np.uint8))
            candidates = [(int(x+bx), int(y+by), int(bw), int(bh))
                          for bx, by, bw, bh, _ in cv2.connectedComponentsWithStats(bodies)[2][1:]]
        for x, y, ww, hh in candidates:
            if not (ww > w*.08 and h*.025 < hh < h*.18):
                continue
            if split_routes:
                # The broad opening already established a solid tooltip.
                # Its attached product icon may widen only the middle rows;
                # testing the original component's whole width would trim
                # the top of the real tooltip and leave black pixels behind.
                pad=max(3,int(w*.002))
                box=[max(0,x-pad),max(0,y-pad),min(w,x+ww+pad),min(h,y+hh+pad)]
                mask[box[1]:box[3],box[0]:box[2]]=0
                occlusions.append(box)
                continue
            # Product icons may touch the tooltip above/below it. Keep only
            # wide, solid rows, so the remaining icon evidence is preserved.
            row_coverage=closed[y:y+hh,x:x+ww].mean(axis=1)
            wide=(row_coverage>.75).astype(np.uint8)
            spans=cv2.connectedComponentsWithStats(wide[:,None])[2][1:]
            for span in spans:
                start,length=int(span[1]),int(span[3])
                if length<h*.025:
                    continue
                pad=max(3,int(w*.002))
                box=[max(0,int(x)-pad),max(0,int(y+start)-pad),min(w,int(x+ww)+pad),min(h,int(y+start+length)+pad)]
                mask[box[1]:box[3],box[0]:box[2]]=0
                occlusions.append(box)
    return mask, occlusions


def infer_grid(image, bounds, size, geometry):
    """Fit faint grid lines, excluding colored routes and dark device borders."""
    x0, y0, x1, y1 = bounds
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    # Thumb extent gives a broad physical scale prior, avoiding grid harmonics.
    prior_x = (x1-x0)**2 / geometry["horizontal_thumb"][2] / size[0]
    prior_y = (y1-y0)**2 / geometry["vertical_thumb"][3] / size[1]
    # A non-scrolling axis may show empty space beside a narrow blueprint, so
    # its synthesized full-view thumb says nothing about the cell size.
    scrolls = geometry.get("scrolls", [True, True])
    priors = [value for value, real in zip((prior_x, prior_y), scrolls) if real]
    prior = float(np.mean(priors))
    pw, ph = int(prior*7), int(prior*5)
    ink = ((gray < 195) | (image.max(2).astype(int)-image.min(2) > 25)).astype(np.float32)
    candidates = []
    for y in range(y0, max(y0+1, y1-ph), max(1,ph//3)):
        for x in range(x0, max(x0+1,x1-pw), max(1,pw//3)):
            candidates.append((float(ink[y:y+ph,x:x+pw].mean()), x, y))
    ink_fraction, px, py = min(candidates)
    patch = gray[y0:y1,x0:x1].astype(float)
    color = image[y0:y1,x0:x1]
    neutral = color.max(2).astype(int)-color.min(2)<8
    periods = np.linspace(prior*.80, prior*1.18, 2400)
    scores = np.zeros(len(periods))
    signals = []
    for axis in [0,1]:
        a = patch if axis==0 else patch.T
        neutral_axis=neutral if axis==0 else neutral.T
        response=(a[:,:-4]+a[:,4:])/2-a[:,2:-2]
        valid=(a[:,2:-2]>205)&(a[:,:-4]>220)&(a[:,4:]>220)&neutral_axis[:,2:-2]
        d=(np.maximum(response,0)*valid).mean(axis=0)
        signals.append(d)
        scores += abs(np.exp(-2j*np.pi*np.arange(len(d))[None,:]/periods[:,None]) @ d) / len(d)
    coarse_pitch = float(periods[scores.argmax()])
    # A short window biases a Fourier maximum by a pixel or more. Refine with
    # actual dark grid-line centers, whose subpixel antialiasing is measurable.
    lattices=[]
    for d,offset in zip(signals,[x0+2,y0+2]):
        maxima=np.flatnonzero((d[1:-1]>d[:-2])&(d[1:-1]>=d[2:]))+1
        maxima=maxima[d[maxima]>max(.35,np.percentile(d,96))]
        selected=[]
        for k in sorted(maxima,key=lambda k:-d[k]):
            if k>3 and k<len(d)-4 and all(abs(k-other)>coarse_pitch*.65 for other in selected):
                selected.append(int(k))
        centers=[]
        for k in sorted(selected):
            positions=np.arange(k-2,k+3)
            weight=np.maximum(d[positions],0)
            centers.append(float(np.sum(positions*weight)/weight.sum()+offset))
        if len(centers)<3:
            raise ValueError("Not enough unobscured grid lines to estimate cell size")
        centers=np.array(centers)
        ids=np.rint((centers-centers[0])/coarse_pitch)
        fit=np.polyfit(ids,centers,1)
        for _ in range(3):
            residual=centers-np.polyval(fit,ids)
            keep=np.abs(residual-np.median(residual))<2
            if keep.sum()<3:
                raise ValueError("Grid lines do not form a consistent lattice")
            centers,ids=centers[keep],ids[keep]
            fit=np.polyfit(ids,centers,1)
        lattices.append((fit,centers,ids))
    pitch=float(np.mean([x[0][0] for x in lattices]))
    phases=[float(np.mean(centers-ids*pitch)%pitch) for _,centers,ids in lattices]
    return {"cell_size": pitch,"phase_in_reference": phases,"sample_bounds":[x0,y0,x1,y1],"sample_ink_fraction":ink_fraction}


def _photometric_error(a, b, ma, mb, displacement):
    """Check real overlap, concentrating on visible edges and colored routes."""
    dx,dy=np.rint(displacement).astype(int)
    h,w=a.shape[:2]
    xa,ya=max(0,dx),max(0,dy)
    xb,yb=max(0,-dx),max(0,-dy)
    ww,hh=min(w-xa,w-xb),min(h-ya,h-yb)
    if ww<50 or hh<50:
        return 255.,0
    aa=a[ya:ya+hh:3,xa:xa+ww:3].astype(float)
    bb=b[yb:yb+hh:3,xb:xb+ww:3].astype(float)
    valid=(ma[ya:ya+hh:3,xa:xa+ww:3]>0)&(mb[yb:yb+hh:3,xb:xb+ww:3]>0)
    ink=(aa.min(2)<170)|(bb.min(2)<170)|(aa.max(2)-aa.min(2)>30)|(bb.max(2)-bb.min(2)>30)
    valid &= ink
    if valid.sum()<100:
        return 255.,int(valid.sum())
    residual=np.abs(aa-bb).mean(2)[valid]
    return float(np.minimum(residual,100).mean()),int(valid.sum())


def register(images, masks, geometries, pitch, comparison_images=None):
    n=len(images)
    if n==1:
        return np.zeros((1,2)),[]
    comparison_images=images if comparison_images is None else comparison_images
    def features(pair):
        im,mask=pair
        # SIFT objects are not documented as thread-safe; one per image.
        return cv2.SIFT_create(nfeatures=14000).detectAndCompute(im,mask)

    # OpenCV releases the GIL; images and pairs are independent, and results
    # are consumed in the original order, so the outcome matches a serial run.
    # Each SIFT scale space of a full-resolution frame takes several hundred MB.
    with ThreadPoolExecutor(min(n,_workers(),SIFT_WORKERS)) as pool:
        detected=[]
        for row in pool.map(features,zip(images,masks)):
            detected.append(row);progress.advance(.38+.3*len(detected)/n)
    points=[]; descriptors=[]
    for k,d in detected:
        if d is None:
            raise ValueError("Screenshot has no registration features")
        points.append(np.float32([q.pt for q in k]));descriptors.append(d)
    thumbs=np.array([[g["horizontal_thumb"][0],g["vertical_thumb"][1]] for g in geometries],float)
    g=geometries[0];x0,y0,x1,y1=g["bounds"]
    scroll_scale=np.array([(x1-x0)/g["horizontal_thumb"][2],(y1-y0)/g["vertical_thumb"][3]])
    priors=(thumbs-thumbs[0])*scroll_scale
    height,width=images[0].shape[:2]
    pairs=[(i,j) for i in range(n) for j in range(i+1,n)
           # A feature displacement is bounded by the frame size, so a pair whose
           # scrollbar prior is farther than that cannot pass the prior gate below.
           if np.all(np.abs(priors[j]-priors[i])<np.array([width,height])+pitch*1.6)]

    def knn(pair):
        i,j=pair
        return cv2.BFMatcher().knnMatch(descriptors[i],descriptors[j],k=2)

    # Brute-force kNN holds a full descriptor distance matrix (about 0.8 GB for
    # 14000x14000 features), so only a few pairs are matched at once.
    with ThreadPoolExecutor(min(len(pairs) or 1,_workers(),KNN_WORKERS)) as pool:
        knn_results=[]
        for row in pool.map(knn,pairs):
            knn_results.append(row);progress.advance(.68+.2*len(knn_results)/max(1,len(pairs)))
    edges=[]
    for (i,j),candidates in zip(pairs,knn_results):
            matches=[a for a,b in candidates if a.distance<.85*b.distance]
            p=np.float32([points[i][m.queryIdx] for m in matches]);q=np.float32([points[j][m.trainIdx] for m in matches])
            if len(p)<8:
                continue
            difference=p-q
            valid=np.linalg.norm(difference-(priors[j]-priors[i]),axis=1)<pitch*1.6
            if valid.sum()<8:
                continue
            model,inliers=cv2.estimateAffinePartial2D(q[valid],p[valid],method=cv2.RANSAC,ransacReprojThreshold=2.,maxIters=8000)
            if model is None or inliers.sum()<8:
                continue
            scale=float(np.hypot(model[0,0],model[1,0]))
            if abs(scale-1)>.008:
                raise ValueError("Mixed screenshot zoom is not supported; use a consistent preview zoom")
            shift=np.median(difference[valid][inliers[:,0]>0],axis=0)
            photo,overlap=_photometric_error(comparison_images[i],comparison_images[j],masks[i],masks[j],shift)
            if photo>27 or overlap<150:
                continue
            edges.append({"i":i,"j":j,"shift":shift.tolist(),"inliers":int(inliers.sum()),"estimated_scale":scale,"photometric_error":photo,"overlap_samples":overlap})
    if len(edges)<n-1:
        raise ValueError("Insufficient reliable overlap between screenshots")
    A=np.zeros((len(edges),n-1));b=np.zeros((len(edges),2));base=[]
    for k,e in enumerate(edges):
        if e["i"]:
            A[k,e["i"]-1]=-1
        if e["j"]:
            A[k,e["j"]-1]=1
        b[k]=e["shift"]
        base.append(np.sqrt(min(e["inliers"],500))/(1+e["photometric_error"]/10))
    if np.linalg.matrix_rank(A)<n-1:
        raise ValueError("Screenshot overlap graph is disconnected")
    weights=np.array(base)
    for _ in range(8):
        poses=np.linalg.lstsq(A*weights[:,None],b*weights[:,None],rcond=None)[0]
        errors=np.linalg.norm(A@poses-b,axis=1)
        weights=np.array(base)*np.minimum(1.,2./np.maximum(errors,1e-5))
    for edge,error in zip(edges,errors):
        edge["cycle_residual_px"]=float(error)
    if float(np.max(errors))>4:
        raise ValueError("Registration cycle inconsistency; add screenshots with unique overlap")
    return np.vstack(([0.,0.],poses)),edges


def _origin_candidates(low, high, phase, pitch, size):
    low=np.asarray(low,float);high=np.asarray(high,float)
    phase=np.asarray(phase,float);size=np.asarray(size,float)
    first=np.ceil((low-phase-1.)/pitch).astype(int)
    last=np.floor((high-size*pitch-phase+1.)/pitch).astype(int)
    return first,last


def content_profile(images, masks, poses, pitch, axis):
    """Stroke pixels per reference-space coordinate along ``axis``.

    Devices, belts and pipes form dark or coloured strokes at least one cell
    long; the faint grid, the mouse pointer and small labels do not survive the
    opening. Returns (offset, counts) or None when no content is visible.
    """
    rows=[]
    length=max(3,int(round(pitch)))
    for image,mask,pose in zip(images,masks,poses):
        gray=cv2.cvtColor(image,cv2.COLOR_BGR2GRAY)
        chroma=image.max(2).astype(np.int16)-image.min(2)
        ink=(((gray<110)|(chroma>60))&(mask>0)).astype(np.uint8)
        strokes=cv2.morphologyEx(ink,cv2.MORPH_OPEN,np.ones((length,1),np.uint8))|cv2.morphologyEx(ink,cv2.MORPH_OPEN,np.ones((1,length),np.uint8))
        # Per column for x, per row for y.
        rows.append((int(round(pose[axis])),strokes.sum(axis=axis).astype(np.int64)))
    offset=min(shift for shift,_ in rows)
    counts=np.zeros(max(shift+len(c) for shift,c in rows)-offset,np.int64)
    for shift,c in rows:
        counts[shift-offset:shift-offset+len(c)]+=c
    return (offset,counts) if counts.any() else None


def resolve_fixed_axes(first, last, phase, pitch, size, fixed, profile_for):
    """Pick the grid position on axes that never scroll from visible content.

    When the blueprint is narrower than the preview, the game draws neither a
    scrollbar nor a border, and the grid continues into the empty margin. A
    blueprint's size is its content's bounding box, so one candidate position
    keeps (nearly) every stroke inside; a passing tooltip may leave a little.
    """
    first=np.array(first);last=np.array(last)
    for axis in range(2):
        if first[axis]==last[axis] or not fixed[axis]:
            continue
        profile=profile_for(axis)
        if profile is None:
            continue
        offset,counts=profile
        coordinates=np.arange(len(counts))+offset
        outside=[]
        for k in range(first[axis],last[axis]+1):
            lo=phase[axis]+k*pitch-pitch*.15;hi=phase[axis]+(k+size[axis])*pitch+pitch*.15
            outside.append((int(counts[(coordinates<lo)|(coordinates>=hi)].sum()),k))
        outside.sort()
        best,second=outside[0][0],outside[1][0]
        if best<=.2*second and second>=pitch*pitch*.25:
            first[axis]=last[axis]=outside[0][1]
    return first,last


def resolve_grid_origin(low, high, phase, pitch, size, candidates=None):
    """Accept only a unique grid-aligned canvas contained in observed bounds.

    Registration gives relative poses, not an absolute blueprint position.
    Centering an incomplete capture would silently invent the missing margins.
    Requiring both canvas ends makes that ambiguity an explicit input error.
    One pixel of tolerance accounts for integer viewport bounds/antialiasing.
    """
    phase=np.asarray(phase,float)
    first,last=candidates if candidates is not None else _origin_candidates(low,high,phase,pitch,size)
    missing=[name for name,lo,hi in zip(["左右", "上下"],first,last) if lo>hi]
    if missing:
        raise ValueError(
            "截图未覆盖可确定蓝图绝对坐标的完整边界，请补拍"+"和".join(missing)+
            "两端，并与现有截图保留重叠区域；不能将局部截图自动居中当作完整布局。"
        )
    if np.any(first!=last):
        raise ValueError("蓝图边界有多个可能的网格位置，请保留预览边界并补拍两端，以确定绝对坐标。")
    return phase+first*pitch


def normalize_resolutions(images):
    """Normalize whole-screen resizes while retaining original pixel mappings.

    This deliberately does not stretch cropped screenshots or infer missing UI.
    Game-camera zoom remains subject to the registration scale check.
    """
    reference=max(images,key=lambda im:im.shape[0]*im.shape[1])
    height,width=reference.shape[:2]
    if height*width*len(images)>MAX_NORMALIZED_PIXELS:
        raise ValueError("截图统一分辨率后总像素超过 1.2 亿，请减少图片数量或降低最高分辨率。")
    normalized=[];scales=[]
    for image in images:
        source_h,source_w=image.shape[:2]
        sx,sy=width/source_w,height/source_h
        if abs(sx/sy-1)>.002:
            raise ValueError("截图宽高比不同，可能经过裁剪；请使用保留完整预览界面的截图。")
        scales.append((sx,sy))
        normalized.append(image if image.shape[:2]==(height,width) else cv2.resize(image,(width,height),interpolation=cv2.INTER_LINEAR))
    return normalized,scales


def _source_box(box, scale):
    sx,sy=scale
    return np.rint(np.asarray(box,float)/np.array([sx,sy,sx,sy])).astype(int).tolist()


def source_transform(transform, scale):
    """Compose OpenCV resize's pixel-center mapping with mosaic registration."""
    sx,sy=scale
    resize=np.array([[sx,0,(sx-1)/2],[0,sy,(sy-1)/2],[0,0,1]],float)
    return np.asarray(transform,float)@resize


def stitch(paths, output_dir, size):
    paths=[Path(p) for p in paths]
    if not paths:
        raise ValueError("At least one screenshot is required")
    if len(size)!=2 or any(int(v)!=v or v<=0 or v>50 for v in size):
        raise ValueError("Blueprint size must contain two integer dimensions between 1 and 50")
    output_dir=Path(output_dir);output_dir.mkdir(parents=True,exist_ok=True)
    source_images=[imageio.imread(str(p)) for p in paths]
    if any(im is None for im in source_images):
        raise ValueError("Cannot read one or more screenshots")
    images,resolution_scales=normalize_resolutions(source_images)
    geometries=[preview_geometry(im) for im in images]
    masks=[];occlusions=[]
    for im,g in zip(images,geometries):
        mask,occ=usable_mask(im,g);masks.append(mask);occlusions.append(occ)
    progress.advance(.08)
    grids={}
    for index,(im,g) in enumerate(zip(images,geometries)):
        try:
            grids[index]=infer_grid(im,g["bounds"],size,g)
        except ValueError:
            pass
        progress.advance(.08+.3*(index+1)/len(images))
    if not grids:
        raise ValueError("No screenshot contains enough clear grid lines")
    grid_index=min(grids,key=lambda i:grids[i]["sample_ink_fraction"])
    grid=grids[grid_index]
    pitch=grid["cell_size"]
    # Mixed resolutions change edge antialiasing even at the correct pose. A
    # small common blur compares actual structures without raising the allowed
    # mismatch threshold. Native-resolution inputs keep their original check.
    resampled=any(scale!=(1.,1.) for scale in resolution_scales)
    comparison_images=[cv2.GaussianBlur(im,(0,0),1.) for im in images] if resampled else None
    poses,edges=register(images,masks,geometries,pitch,comparison_images)
    progress.advance(.9)
    bounds=np.array([g["bounds"] for g in geometries],float)
    low=np.min(bounds[:,:2]+poses,axis=0)
    high=np.max(bounds[:,2:]+poses,axis=0)
    phase=(np.array(grid["phase_in_reference"])+poses[grid_index])%pitch
    first,last=_origin_candidates(low,high,phase,pitch,size)
    # An axis no frame could scroll shows the whole blueprint plus empty margin.
    fixed=[not any(g.get("scrolls",[True,True])[axis] for g in geometries) for axis in range(2)]
    first,last=resolve_fixed_axes(first,last,phase,pitch,size,fixed,
                                  lambda axis:content_profile(images,masks,poses,pitch,axis))
    if any(f and lo!=hi for f,lo,hi in zip(fixed,first,last)) and all(lo<=hi for lo,hi in zip(first,last)):
        raise ValueError("蓝图比预览区窄，游戏没有显示滚动条，且两侧空白无法确定蓝图从哪一格开始；"
                         "请在识别弹窗中核对蓝图宽高，或确认蓝图两端都有设备或线路。")
    origin=resolve_grid_origin(low,high,phase,pitch,size,(first,last))
    width,height=np.ceil(np.array(size)*pitch).astype(int)
    mosaic=np.full((height,width,3),232,np.uint8)
    best=np.zeros((height,width),np.float32)
    coverage=np.zeros((height,width),np.uint8)
    source=np.zeros((height,width),np.uint8)
    records=[]
    for i,(im,mask,pose,g,occ,path) in enumerate(zip(images,masks,poses,geometries,occlusions,paths)):
        transform=np.array([[1,0,pose[0]-origin[0]],[0,1,pose[1]-origin[1]]],float)
        warped=cv2.warpAffine(im,transform,(width,height),flags=cv2.INTER_LINEAR,borderValue=(232,232,232))
        valid=cv2.warpAffine(mask,transform,(width,height),flags=cv2.INTER_NEAREST)>0
        # Choose the clearest source instead of averaging screen-space grid
        # lines and selection highlights across screenshots.
        distance=cv2.distanceTransform(mask,cv2.DIST_L2,3)
        weight=cv2.warpAffine(distance,transform,(width,height))
        select=valid&(weight>best)
        mosaic[select]=warped[select];best[select]=weight[select];source[select]=i+1
        coverage += valid.astype(np.uint8)
        # All public coordinates refer to the original uploaded image. Keep the
        # index/order intact for tooltip and device evidence in the pipeline.
        sx,sy=resolution_scales[i]
        source_h,source_w=source_images[i].shape[:2]
        source_mask=mask if mask.shape==(source_h,source_w) else cv2.resize(mask,(source_w,source_h),interpolation=cv2.INTER_NEAREST)
        original_transform=source_transform(transform,(sx,sy))
        mask_name=f"usable-{i+1}.png";imageio.imwrite(str(output_dir/mask_name),source_mask)
        source_geometry={"bounds":_source_box(g["bounds"],(sx,sy)),"vertical_thumb":_source_box(g["vertical_thumb"],(sx,sy)),"horizontal_thumb":_source_box(g["horizontal_thumb"],(sx,sy)),"sidebar_x":int(round(g["sidebar_x"]/sx))}
        records.append({"path":str(path.resolve()),"source_index":i,"transform":original_transform.tolist(),"translation_in_reference":pose.tolist(),"usable_bounds":source_geometry["bounds"],"mask":mask_name,"occlusions":[_source_box(box,(sx,sy)) for box in occ],"scrollbars":source_geometry,"source_resolution":[source_w,source_h],"registration_resolution":[im.shape[1],im.shape[0]],"resolution_scale":[sx,sy]})
    cells=[]
    for y in range(size[1]):
        row=[]
        for x in range(size[0]):
            xx0,yy0=np.rint(np.array([x,y])*pitch).astype(int)
            xx1,yy1=np.rint(np.array([x+1,y+1])*pitch).astype(int)
            row.append(round(float((coverage[yy0:yy1,xx0:xx1]>0).mean()),4))
        cells.append(row)
    unknown=(np.array(cells)<.98).astype(np.uint8)
    _,labels,unknown_stats,_=cv2.connectedComponentsWithStats(unknown,connectivity=8)
    unknown_bounds=[]
    for label,(x,y,ww,hh,area) in enumerate(unknown_stats[1:],start=1):
        unknown_bounds.append({"grid_bounds":[int(x),int(y),int(x+ww),int(y+hh)],"pixel_bounds":np.rint(np.array([x,y,x+ww,y+hh])*pitch).astype(int).tolist(),"cells":int(area),"minimum_cell_coverage":float(np.array(cells)[labels==label].min())})
    result={"version":1,"method":"scrollbar-prior SIFT translation / robust pose graph / Fourier grid","grid":{"cell_size":pitch,"origin":[0.,0.],"size":list(size),"origin_in_reference":origin.tolist(),"sample_image":grid_index,"sample_bounds":_source_box(grid["sample_bounds"],resolution_scales[grid_index]),"sample_bounds_space":"source_image","reference_resolution":[images[0].shape[1],images[0].shape[0]],"sample_ink_fraction":grid["sample_ink_fraction"]},"mosaic":"mosaic.png","coverage_mask":"coverage.png","source_map":"source-map.png","images":records,"pairwise_registration":edges,"coverage":{"pixel_fraction":float((coverage>0).mean()),"cell_fractions":cells,"fully_visible_cells":int((np.array(cells)>.98).sum()),"total_cells":int(size[0]*size[1]),"unknown_bounds":unknown_bounds,"bounds_convention":"zero-based [left,top,right,bottom], right/bottom exclusive","count_semantics":"usable supplied screenshots per pixel; repeated captures are not independent evidence"}}
    imageio.imwrite(str(output_dir/"mosaic.png"),mosaic)
    imageio.imwrite(str(output_dir/"coverage.png"),coverage)
    imageio.imwrite(str(output_dir/"source-map.png"),source)
    (output_dir/"registration.json").write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding="utf-8")
    return result


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("images",nargs="+",type=Path)
    parser.add_argument("--output",type=Path,default=Path("reports/ocr"))
    parser.add_argument("--columns",type=int,required=True)
    parser.add_argument("--rows",type=int,required=True)
    args=parser.parse_args()
    result=stitch(args.images,args.output,(args.columns,args.rows))
    print(json.dumps({"grid":result["grid"],"coverage":result["coverage"]["pixel_fraction"],"images":len(result["images"])},ensure_ascii=False,indent=2))


if __name__ == "__main__":
    main()
