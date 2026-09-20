"""Bake the game's 2D blueprint UI from extracted sprites into transparent PNGs.

Rules: BlueprintPreview / FacConst; see docs/project-notes.md for provenance.
Layout / colors: current blueprintpreview.prefab, exported as prefab_images.json.
Default: all table ports visible, matching an entry with no formula mode selected.
No 3D renderer is involved. Central symbols remain upright on all four faces.

Runs inside Pyodide on a MEMFS tree that the worker pre-populated from the deployed static files,
so the read paths below are unchanged from the original build-time implementation. Unlike the
original, nothing here writes to disk: files that the browser needs are emitted through the host
callback and transferred as binary data, never as base64.
"""
from collections import defaultdict
from functools import lru_cache
import json
from pathlib import Path
from PIL import Image, ImageChops

UNIT = 128
RESAMPLE = Image.Resampling.LANCZOS

# Filled in by boot.py before this module is imported.
ROOT = Path('/kernel')


def tint(image, rgba):
    return ImageChops.multiply(image, Image.new('RGBA', image.size, tuple(rgba)))


def center(canvas, image):
    canvas.alpha_composite(image, (round((canvas.width - image.width) / 2),
                                   round((canvas.height - image.height) / 2)))


def sliced(image, size, border):
    """Unity Image.Type.Sliced, preserving pixel borders rather than scaling lines."""
    w, h = map(round, size)
    if w <= 0 or h <= 0:
        return Image.new('RGBA', (max(1, w), max(1, h)))
    left, bottom, right, top = map(round, border)
    if not any(border):
        return image.resize((w, h), RESAMPLE)
    sx, sy = [0, left, image.width - right, image.width], [0, top, image.height - bottom, image.height]
    kx, ky = min(1, w / max(1, left + right)), min(1, h / max(1, top + bottom))
    dx, dy = [0, round(left * kx), w - round(right * kx), w], [0, round(top * ky), h - round(bottom * ky), h]
    out = Image.new('RGBA', (w, h))
    for j in range(3):
        for i in range(3):
            tw, th = dx[i + 1] - dx[i], dy[j + 1] - dy[j]
            if tw > 0 and th > 0 and sx[i + 1] > sx[i] and sy[j + 1] > sy[j]:
                piece = image.crop((sx[i], sy[j], sx[i + 1], sy[j + 1])).resize((tw, th), RESAMPLE)
                out.paste(piece, (dx[i], dy[j]))
    return out


class BlueprintBaker:
    def __init__(self, kit=None):
        self.kit = Path(kit) if kit is not None else ROOT
        self.source = self.kit / 'assets/blueprint_source'
        self.index = json.loads((self.source / 'index.json').read_text('utf-8'))
        self.prefab = json.loads((self.source / 'prefab_images.json').read_text('utf-8'))
        self.buildings = self.table('FactoryBuildingTable')
        self.items = self.table('ItemTable')
        self.logistics = {}
        for item_id, mapping in self.table('FactoryItem2LogisticIdTable').items():
            bid = mapping['logisticId']
            key = 'blueprint/bg_logistic_' + bid
            if key in self.index:
                self.logistics[bid] = {'id': bid, 'itemId': item_id, 'sprite': key,
                                       'range': {'width': 1, 'depth': 1}, 'name': self.items[item_id]['name']}
        self.entities = {**self.buildings, **self.logistics}
        self.icon_table = self.table('FactoryBlueprintMachineIconTable')
        self.rarity_colors = self.table('RarityColorTable')
        self.container_contents = {}
        for name, field in [('FullBottleTable', 'liquidId'), ('FullGasJarTable', 'gasId')]:
            if (self.kit / f'data/tables/{name}.json').exists():
                self.container_contents.update({iid: row[field] for iid, row in self.table(name).items()})
        audit = self.kit / 'data/icon_audit.json'
        self.icon_overrides = {r['id']: r['recoveredIcon'] for r in json.loads(audit.read_text('utf-8'))['items']
                               if r['status'] == 'same_id_original_sprite'} if audit.exists() else {}
        self.issues = set()
        self._connection_frames = {}

    def table(self, name):
        return json.loads((self.kit / f'data/tables/{name}.json').read_text('utf-8'))

    def component(self, suffix):
        return next(value for path, value in self.prefab.items() if path.endswith(suffix))

    @lru_cache(maxsize=512)
    def sprite(self, key):
        return Image.open(self.source / self.index[key]['file']).convert('RGBA')

    def scaled(self, key, size, use_slice=False, rgba=None):
        image = self.sprite(key)
        size = tuple(map(round, size))
        image = sliced(image, size, self.index[key]['border']) if use_slice else image.resize(size, RESAMPLE)
        return tint(image, rgba) if rgba else image

    def special_bg(self, bid):
        # FacConst template overrides take precedence over FacBuildingType overrides.
        if bid in ('udpipe_loader_1', 'udpipe_loader_2', 'udpipe_unloader_1', 'udpipe_unloader_2'):
            return 'blueprint/bg_machine_' + bid
        return {2: 'blueprint/bg_machine_power', 23: 'blueprint/bg_machine_power',
                10: 'blueprint/bg_machine_loader', 11: 'blueprint/bg_machine_unloader'}.get(self.buildings[bid]['type'])

    def port_groups(self, bid, formula_mode=None, closed_ports=()):
        b = self.buildings[bid]
        w, d = b['range']['width'], b['range']['depth']
        groups = defaultdict(list)
        for is_input, field in ((True, 'inputPorts'), (False, 'outputPorts')):
            for port in b[field]:
                if (field, port['index']) in closed_ports or (formula_mode == 'normal' and port['isPipe']):
                    continue
                p = port['trans']['position']
                side = (port['trans']['rotation']['y'] // 90 + (2 if is_input else 0)) % 4
                # ResolveDefaultBuildingPortEdge: prefer the axis matching the side.
                candidates = ([0, 2, 1, 3] if side % 2 == 0 else [1, 3, 0, 2])
                edge = next((f for f in candidates if {0: p['z'] == d - 1, 1: p['x'] == w - 1,
                                                       2: p['z'] == 0, 3: p['x'] == 0}[f]), side)
                pos = p['x'] if edge % 2 == 0 else p['z']
                groups[edge, bool(port['isPipe']), is_input].append(pos)
        return groups

    @staticmethod
    def put_edge(canvas, piece, face, along):
        # UI image pivot (0.5, 1): the top of each port is exactly on the building edge.
        if face == 0:
            xy = (round(along - piece.width / 2), 0)
        elif face == 1:
            piece = piece.transpose(Image.Transpose.ROTATE_270)
            xy = (canvas.width - piece.width, round(canvas.height - along - piece.height / 2))
        elif face == 2:
            piece = piece.transpose(Image.Transpose.ROTATE_180)
            xy = (round(along - piece.width / 2), canvas.height - piece.height)
        else:
            piece = piece.transpose(Image.Transpose.ROTATE_90)
            xy = (0, round(canvas.height - along - piece.height / 2))
        canvas.alpha_composite(piece, xy)

    def body(self, bid, direction=0, formula_mode=None, closed_ports=()):
        if bid in self.logistics:
            return self.scaled(self.logistics[bid]['sprite'], (UNIT, UNIT), True).rotate(-90 * (direction % 4))
        b = self.buildings[bid]
        w, d = b['range']['width'], b['range']['depth']
        size = (w * UNIT, d * UNIT)
        special = self.special_bg(bid)
        out = self.scaled(special or 'blueprint/bg_machine_default', size, use_slice=True)
        edges = Image.new('RGBA', size)
        big = not special and w >= 3 and d >= 3
        if not special:
            groups = self.port_groups(bid, formula_mode, closed_ports)
            has = {face for face, pipe, inp in groups}
            if 1 not in has and 3 not in has and size[1] > 170:
                center(out, self.scaled('blueprint/deco_waist', (size[0] - 24, size[1] - 170), True))
            for (face, pipe, inp), positions in sorted(groups.items(), key=lambda p: (p[0][0], p[0][1], not p[0][2])):
                positions = sorted(positions)
                prefix = 'blueprint/' + ('pipe_' if pipe else '') + ('port_in_' if inp else 'port_out_')
                count = len(positions)
                key = prefix + str(count)
                if count == max(positions) - min(positions) + 1 and key in self.index:
                    self.put_edge(edges, self.sprite(key), face, (min(positions) + max(positions) + 1) / 2 * UNIT)
                else:
                    # Current ALT_SUPPORT maps are empty: place original unit sprites at actual positions.
                    for pos in positions:
                        self.put_edge(edges, self.sprite(prefix + '1'), face, (pos + 0.5) * UNIT)
            for face in (0, 2):
                if face not in has:
                    key = 'blueprint/deco_edge_' + ('big' if big else 'small')
                    self.put_edge(edges, self.scaled(key, (size[0], 140 if big else 40), True), face, size[0] / 2)
        turn = [None, Image.Transpose.ROTATE_270, Image.Transpose.ROTATE_180, Image.Transpose.ROTATE_90][direction % 4]
        if turn is not None:
            out, edges = out.transpose(turn), edges.transpose(turn)
        if big:
            key = 'machine_big/' + b['iconOnPanel']
            if key in self.index:
                center(out, self.scaled(key, (220, 220), rgba=(73, 73, 73, 76)))
            else:
                self.issues.add(f'{bid}: no original BuildingPanelIconBig/{b["iconOnPanel"]}; watermark omitted')
        out.alpha_composite(edges)
        return out

    def editable_base(self, bid, direction=0, waist=False):
        """Port-free body for browser composition; watermark stays upright."""
        b = self.buildings[bid]
        w, d = b['range']['width'], b['range']['depth']
        size = (w * UNIT, d * UNIT)
        size = (w * UNIT, d * UNIT)
        out = self.scaled('blueprint/bg_machine_default', size, use_slice=True)
        if waist and size[1] > 170:
            center(out, self.scaled('blueprint/deco_waist', (size[0] - 24, size[1] - 170), True))
        out = out.rotate(-90 * direction, expand=True)
        key = 'machine_big/' + b['iconOnPanel']
        if w >= 3 and d >= 3 and key in self.index:
            center(out, self.scaled(key, (220, 220), rgba=(73, 73, 73, 76)))
        return out

    def icon(self, bid):
        return self.scaled('machine_icon/' + self.buildings[bid]['iconOnPanel'], (126, 126), rgba=(73, 73, 73, 255))

    def active_connection_frame(self, size):
        """Freeze the original two-ring selection pulse at 0.5 s for stable PNGs.

        Memoized because every underground device repeats the same footprint: the curve sampling and
        the two nine-slice inner rings are pure functions of `size`.
        """
        cached = self._connection_frames.get(tuple(size))
        if cached is not None:
            return cached
        frame = self._active_connection_frame(size)
        self._connection_frames[tuple(size)] = frame
        return frame

    def _active_connection_frame(self, size):
        animation = json.loads((self.source / 'udpipe_effect_animation.json').read_text('utf-8'))

        def sample(path, attribute):
            curve = next(c for c in animation['curves'] if c['path'] == path and c['attribute'] == attribute)
            keys = curve['curve']['m_Curve']
            time = animation['sampleTime']
            if time <= keys[0]['time']:
                return keys[0]['value']
            for a, b in zip(keys, keys[1:]):
                if time <= b['time']:
                    duration = b['time'] - a['time']
                    t = (time - a['time']) / duration
                    return ((2 * t ** 3 - 3 * t ** 2 + 1) * a['value'] + (t ** 3 - 2 * t ** 2 + t) * duration * a['outSlope']
                            + (-2 * t ** 3 + 3 * t ** 2) * b['value'] + (t ** 3 - t ** 2) * duration * b['inSlope'])
            return keys[-1]['value']

        key = self.component('/NodeCell/UdpipeState/SelectedFrame')['sprite']
        out = self.scaled(key, size, use_slice=True)
        for path in ['SelectedFrame1', 'SelectedFrame2']:
            inner_size = tuple(size[i] + sample(path, 'm_SizeDelta.' + axis) for i, axis in enumerate('xy'))
            center(out, self.scaled(key, inner_size, use_slice=True,
                                    rgba=(255, 255, 255, round(sample(path, 'm_Color.a') * 255))))
        return out

    def building(self, bid, direction=0, product=None, formula_mode=None):
        out = self.body(bid, direction, formula_mode)
        if product or bid not in self.logistics:
            center(out, self.product_badge(product) if product else self.icon(bid))
        return out

    def product_badge(self, iid):
        key = self.component('/NodeCell/IconNode/ItemNode/BG')['sprite']
        out = self.scaled(key, (120, 120))
        if iid.startswith('[gas]'):
            gas_key = 'gas/icon_gas_env_' + iid[5:].lower()
            if gas_key not in self.index:
                raise ValueError(f'Unknown gas environment: {iid}')
            center(out, self.scaled(gas_key, (120, 120)))
            return out
        if iid not in self.items:
            raise ValueError(f'Unknown product item: {iid}')
        item = self.items[iid]
        color = self.rarity_colors.get(str(item.get('rarity', 1)), {}).get('color', '9B9B9B')
        rgba = tuple(int(color[i:i + 2], 16) for i in (0, 2, 4)) + (255,)
        rarity_key = self.component('/NodeCell/IconNode/ItemNode/RarityIcon')['sprite']
        out.alpha_composite(self.scaled(rarity_key, (120, 120), rgba=rgba))
        icon_id = item.get('iconId') or self.icon_overrides.get(iid, '')
        path = self.kit / 'assets/item' / (icon_id + '.png')
        if not path.exists():
            raise FileNotFoundError(f'Missing product icon {iid}: {path}')
        icon = Image.open(path).convert('RGBA')
        icon.thumbnail((120, 120), RESAMPLE)
        center(out, icon)
        # ItemIcon._UpdateLiquidOrGasIcon: centered overlay, 80 / 180 of icon width.
        content_id = self.container_contents.get(iid)
        if content_id:
            content = self.items[content_id]
            liquid = Image.open(self.kit / 'assets/item' / (content['iconId'] + '.png')).convert('RGBA')
            liquid.thumbnail((round(120 * 80 / 180),) * 2, RESAMPLE)
            center(out, liquid)
        # The rarity ring belongs to the dynamic badge, never the reusable building body.
        return out
