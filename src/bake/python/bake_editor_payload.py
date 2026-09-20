"""Runtime baking entry point.

This is the browser-side replacement for the build-time `build_editor.py`. It composes every sprite
the editor needs, turns them into PNG bytes, and hands them to the host, which decodes them into
`ImageBitmap`s. Nothing is base64-encoded and nothing is fetched from the network: the worker has
already written the source PNGs, tables and `.py` modules into Pyodide's MEMFS.

Two properties keep the payload small and the bake fast:

* Images are content addressed. The key is the digest of the encoded bytes, and a key that has already
  been emitted is never encoded or transferred twice. The game reuses a great deal of artwork across
  devices, so this removes a large fraction of the work on its own.
* Variants the renderer never draws are not composed. Each building emits its four normal faces plus
  the port-free bases and edge decoration only for the devices whose ports are individually editable.
"""
import hashlib
import io
import json
from pathlib import Path

from PIL import Image

import bake_blueprint_sprites as sprites_module
from bake_blueprint_sprites import ROOT, RESAMPLE, BlueprintBaker, center
from build_presentation_payload import build_presentation
from audit_display_effects import audit_effects

# The host namespace is injected by the worker onto the JS global object (see worker.ts).
from js import __endfieldHost as host  # noqa: E402

# Keys already emitted this session; the digest is the content address, so a repeat is a no-op.
_emitted = {}


def _encode(image, palette=False):
    """Encode an image and emit it once, returning its content-addressed key.

    The digest is computed over the *gamma-corrected RGB* bytes plus the alpha channel so that two
    visually identical images share a key regardless of the mode Pillow happened to use.
    """
    image = image.convert('RGBA')
    if palette:
        image.thumbnail((96, 96), RESAMPLE)
    digest = hashlib.sha256(image.tobytes()).hexdigest()[:24]
    key = digest
    if key in _emitted:
        return key

    buffer = io.BytesIO()
    image.save(buffer, 'WEBP' if palette else 'PNG',
               **({'quality': 85} if palette else {'optimize': True}))
    raw = buffer.getvalue()
    extension = 'webp' if palette else 'png'
    host.emitImage(key, extension, raw)
    _emitted[key] = (image.width, image.height, extension, len(raw))
    return key


# Set by `bake()` so the lazy entry points can reuse the warm baker.
_baker = None


def bake_cover(item_id):
    """Compose one cover image on demand and return its asset key.

    Covers are the single largest group of composed images, and a preview draws at most a handful of
    them, so they are composed the first time they are actually needed instead of up front.
    """
    baker = _baker
    if baker is None:
        raise RuntimeError('bake_cover called before bake()')
    if item_id.startswith('[gas]'):
        icon = baker.sprite('gas/icon_gas_env_' + item_id[5:])
    else:
        item = baker.items.get(item_id, {})
        path = ROOT / 'assets/item' / ((item.get('iconId') or baker.icon_overrides.get(item_id) or item_id) + '.png')
        if not path.exists():
            return None
        icon = Image.open(path).convert('RGBA')
    icon.thumbnail((192, 192), RESAMPLE)
    content_id = baker.container_contents.get(item_id)
    if content_id:
        content = baker.items[content_id]
        inner = Image.open(ROOT / 'assets/item' / (content['iconId'] + '.png')).convert('RGBA')
        inner.thumbnail((round(icon.width * 80 / 180),) * 2, RESAMPLE)
        center(icon, inner)
    return _encode(icon)


def _preload_sprite_cache(baker):
    """Warm the baker's sprite cache so the composition loop never re-decodes a source PNG.

    `BlueprintBaker.sprite` is memoized, but the cache is bounded and the full index is only 316
    entries, so loading it up front is both cheap and makes the rest of the bake deterministic.
    """
    for key in baker.index:
        baker.sprite(key)


def bake():
    """Compose the whole editor payload. Returns a JSON string."""
    global _baker
    baker = BlueprintBaker(ROOT)
    _baker = baker
    report = {'stages': []}

    def stage(name):
        report['stages'].append(name)
        host.report(name)

    stage('building-table')
    buildings = baker.buildings
    items = baker.items
    i18n = baker.table('I18nTextTable_CN')

    def label(ref, fallback):
        value = i18n.get(str((ref or {}).get('id', 0)))
        return value.strip() if isinstance(value, str) and value.strip() else fallback

    _preload_sprite_cache(baker)

    stage('recipes')
    recipes = {}
    for recipe in baker.table('FactoryMachineCraftTable').values():
        bucket = recipes.setdefault(recipe['machineId'], set())
        for outcome in recipe.get('outcomes', []):
            bucket.update(item['id'] for item in outcome.get('group', []))
    for bid, entry in baker.table('FactoryMinerTable').items():
        recipes.setdefault(bid, set()).update(v['miningItemId'] for v in entry.get('mineable', []))
    for bid, entry in baker.table('FactoryGasMinerTable').items():
        recipes.setdefault(bid, set()).update(v['miningItemId'] for v in entry.get('mineable', []))
    for bid, entry in baker.table('FactoryFluidPumpInTable').items():
        recipes.setdefault(bid, set()).update(entry['enableLiquidIds'])
    for bid, entry in baker.table('FactorySewageTreatExportTable').items():
        recipes.setdefault(bid, set()).add(entry['productItemId'])

    hub_products = {v['id'] for r in baker.table('FactoryHubCraftTable').values() for v in r['outcomes']}
    for bid, entry in buildings.items():
        if entry['type'] in (1, 22):
            recipes.setdefault(bid, set()).update(hub_products)

    factory_items = baker.table('FactoryItemTable')
    gases = {'Inactive': '惰性环境', 'Humidity': '潮湿环境', 'Acid': '酸性环境',
             'Xiranite': '息壤环境', 'Stable': '稳定环境'}

    stage('gas-and-line-items')
    line_items = {}
    for kind, iid in [('item', 'item_log_belt_01'), ('fluid', 'item_log_pipe_01')]:
        item = items[iid]
        line_items[kind] = {'id': iid, 'name': label(item['name'], iid),
                            'palette': _encode(Image.open(ROOT / 'assets/item' / (item['iconId'] + '.png')), palette=True),
                            'rarityColor': '#' + baker.rarity_colors.get(str(item['rarity']), {}).get('color', '9B9B9B')}

    stage('product-badges')
    products = {}
    audit_path = ROOT / 'data/icon_audit.json'
    icon_audit = {r['id']: r for r in json.loads(audit_path.read_text('utf-8'))['items']} if audit_path.exists() else {}

    wanted = set().union(*recipes.values()) if recipes else set()
    wanted.update(iid for iid in factory_items if iid in items)
    # Also preserve non-recipe custom product icons that are present in the project.
    wanted.update(iid for iid, item in items.items() if not iid.startswith('item_port_')
                  and (ROOT / 'assets/item' / (item.get('iconId', iid) + '.png')).exists())

    for iid in sorted(wanted):
        item = items.get(iid, {})
        try:
            badge = _encode(baker.product_badge(iid))
        except (FileNotFoundError, ValueError):
            badge = None
        fi = factory_items.get(iid, {})
        products[iid] = {'name': label(item.get('name'), iid), 'badge': badge, 'rarity': item.get('rarity', 1),
                         'factory': bool(fi), 'phase': fi.get('phaseType', 0), 'unloader': fi.get('showInUnloader', False),
                         'iconStatus': icon_audit.get(iid, {}).get('status', 'available' if badge else 'missing')}
        if iid in baker.container_contents:
            content_id = baker.container_contents[iid]
            products[iid]['contentId'] = content_id
            products[iid]['name'] += ' · ' + label(items[content_id].get('name'), content_id)

    for env, name in gases.items():
        iid = '[gas]' + env
        products[iid.lower()] = {'name': name, 'badge': _encode(baker.product_badge(iid)), 'gas': True}
    recipes.setdefault('vaporizer_1', set()).update('[gas]' + name for name in gases if name != 'Stable')

    stage('building-faces')
    fallbacks = json.loads((ROOT / 'data/building_item_fallbacks.json').read_text('utf-8'))
    building_items = baker.table('FactoryBuildingItemReverseTable')
    output = []
    for bid, b in buildings.items():
        w, d = b['range']['width'], b['range']['depth']
        pipe_ports = any(p['isPipe'] for field in ('inputPorts', 'outputPorts') for p in b[field])

        faces = [_encode(baker.body(bid, face)) for face in range(4)]
        # Pipe-capable devices show a body without pipe stubs in item-interface mode; everything else
        # reuses its normal faces.
        normal = [_encode(baker.body(bid, face, formula_mode='normal')) for face in range(4)] if pipe_ports else faces

        symbol = _encode(baker.icon(bid))
        item_id = building_items.get(bid, {}).get('itemId') or fallbacks.get(bid, '')
        item_icon = items.get(item_id, {}).get('iconId') or baker.icon_overrides.get(item_id) or item_id
        icon_path = ROOT / 'assets/item' / (item_icon + '.png')
        palette = _encode(Image.open(icon_path), palette=True) if item_icon and icon_path.exists() else symbol
        rarity = items.get(item_id, {}).get('rarity', 1)
        rarity_color = '#' + baker.rarity_colors.get(str(rarity), {}).get('color', '9B9B9B')

        # Port insets are measured from the composed alpha channel, exactly as at build time.
        alpha = baker.body(bid, 0).getchannel('A')
        editable = not baker.special_bg(bid)
        ports = []
        for is_input, field in ((True, 'inputPorts'), (False, 'outputPorts')):
            for p in b[field]:
                pos = p['trans']['position']
                face = (p['trans']['rotation']['y'] // 90 + (2 if is_input else 0)) % 4
                port = {'n': p['index'], 'input': is_input, 'pipe': p['isPipe'],
                        'x': pos['x'], 'z': d - 1 - pos['z'], 'dir': (face + 3) % 4}
                candidates = [0, 2, 1, 3] if face % 2 == 0 else [1, 3, 0, 2]
                edge = next((f for f in candidates if {0: pos['z'] == d - 1, 1: pos['x'] == w - 1,
                                                       2: pos['z'] == 0, 3: pos['x'] == 0}[f]), face)
                port.update(id=('input:' if is_input else 'output:') + str(p['index']),
                            edge=edge, along=pos['x'] if edge % 2 == 0 else pos['z'])
                px = min(alpha.width - 1, max(0, round((port['x'] + .5) * 128)))
                pz = min(alpha.height - 1, max(0, round((port['z'] + .5) * 128)))
                distance = 0
                for distance in range(33):
                    xy = {0: (alpha.width - 1 - distance, pz), 1: (px, alpha.height - 1 - distance),
                          2: (distance, pz), 3: (px, distance)}[port['dir']]
                    if alpha.getpixel(xy) >= 200:
                        break
                port['inset'] = (distance + 1) / 128
                ports.append(port)

        entry = {'id': bid, 'name': label(b['name'], bid), 'w': w, 'd': d,
                 'faces': faces, 'normalFaces': normal, 'symbol': symbol, 'palette': palette,
                 'itemId': item_id, 'rarity': rarity, 'rarityColor': rarity_color,
                 'ports': ports, 'products': sorted(recipes.get(bid, ())),
                 'editablePorts': editable,
                 # Only devices with individually editable ports need the extra bases.
                 'bareFaces': [_encode(baker.editable_base(bid, f)) for f in range(4)] if editable else [],
                 'waistFaces': [_encode(baker.editable_base(bid, f, True)) for f in range(4)] if editable else [],
                 'edgeDecoration': _encode(baker.scaled(
                     'blueprint/deco_edge_' + ('big' if w >= 3 and d >= 3 else 'small'),
                     (w * 128, 140 if w >= 3 and d >= 3 else 40), True)) if editable else None,
                 'underground': bid.startswith('udpipe_'),
                 'canModify': baker.icon_table.get(bid, {}).get('canModify', False)}
        output.append(entry)

    stage('logistics')
    for bid, entry in baker.logistics.items():
        faces = [_encode(baker.body(bid, face)) for face in range(4)]
        item = items[entry['itemId']]
        path = ROOT / 'assets/item' / (item.get('iconId', entry['itemId']) + '.png')
        palette = _encode(Image.open(path), palette=True) if path.exists() else faces[0]
        output.append({'id': bid, 'name': label(entry['name'], bid), 'w': 1, 'd': 1,
                       'faces': faces, 'normalFaces': faces, 'symbol': None, 'palette': palette,
                       'itemId': entry['itemId'], 'rarity': item.get('rarity', 1),
                       'rarityColor': '#' + baker.rarity_colors.get(str(item.get('rarity', 1)), {}).get('color', '9B9B9B'),
                       'ports': [], 'products': [], 'canModify': False, 'logistic': True})
    output.sort(key=lambda b: (b['name'] == b['id'], b['name']))

    stage('shared-sprites')
    sprites = {name: _encode(baker.sprite('blueprint/' + name)) for name in
               ['icon_belt_grid', 'icon_belt_corner_1', 'icon_belt_corner_2',
                'icon_pipe_grid', 'icon_pipe_corner_1', 'icon_pipe_corner_2']}
    for key in baker.index:
        if key.startswith(('blueprint/port_in_', 'blueprint/port_out_', 'blueprint/pipe_port_in_', 'blueprint/pipe_port_out_')):
            sprites[key.split('/')[-1]] = _encode(baker.sprite(key))
    for env in gases:
        sprites['env_effect_' + env.lower()] = _encode(baker.sprite('gas/icon_gas_env_effected_' + env.lower()))
    sprites['badge_bg'] = _encode(baker.scaled(baker.component('/NodeCell/IconNode/ItemNode/BG')['sprite'], (120, 120)))
    sprites['change_hint'] = _encode(baker.sprite(baker.component('/NodeCell/IconNode/ChangeHint')['sprite']))

    sprite_borders = {}
    for name, suffix in [('grid', '/GridImg'), ('udpipe_line', '/Content/PipeConnectionLine'),
                         ('selection_frame', '/NodeCell/SelectedNode'), ('hover_frame', '/HoverHint/Img')]:
        component = baker.component(suffix)
        sprites[name] = _encode(baker.sprite(component['sprite']))
        sprite_borders[name] = baker.index[component['sprite']]['border']

    status_layers = {}
    for status, suffixes in {
        'locked': ['LockedNode/BgImage', 'LockedNode/IconImage'],
        'expired': ['TimeLimitedExpiredNode/IconImage'],
        'limited': ['TimeLimitedActiveNode/TimeLimitedColorTag', 'TimeLimitedActiveNode/TimeLimitedColorTag/Icon2Image'],
    }.items():
        layers = []
        for suffix in suffixes:
            comp = baker.component('/NodeCell/IconNode/ItemNode/' + suffix)
            tr = comp['transform']
            size = tr['m_SizeDelta']
            pos = tr['m_AnchoredPosition']
            x, y = pos['x'] - size['x'] * tr['m_Pivot']['x'], -pos['y'] - size['y'] * (1 - tr['m_Pivot']['y'])
            if tr['m_AnchorMin']['x'] == 0:
                x -= 60
                y -= 60
            if suffix.endswith('/Icon2Image'):
                x += -5
                y += -3.6
            color = [round(comp['color'][k] * 255) for k in ('r', 'g', 'b', 'a')]
            theme = suffix.endswith('/TimeLimitedColorTag')
            image = baker.scaled(comp['sprite'], (size['x'], size['y']), rgba=None if theme else color)
            key = 'status_' + suffix.replace('/', '_')
            sprites[key] = _encode(image)
            layers.append({'asset': sprites[key], 'x': x, 'y': y, 'w': size['x'], 'h': size['y'], 'theme': theme})
        status_layers[status] = layers

    stage('underground-ui')

    def ui_component(suffix, size=None):
        comp = baker.component('/NodeCell/UdpipeState/NonScaledNode/' + suffix)
        delta = comp['transform']['m_SizeDelta']
        return baker.scaled(comp['sprite'], size or (delta['x'], delta['y']),
                            use_slice=comp['imageType'] == 1,
                            rgba=[round(comp['color'][k] * 255) for k in ('r', 'g', 'b', 'a')])

    for state, key in [('NotSelected', 'udpipe_show'), ('Selected', 'udpipe_hide')]:
        image = ui_component(state)
        child = baker.component('/NodeCell/UdpipeState/NonScaledNode/' + state + '/Icon')['transform']['m_AnchoredPosition']
        icon = ui_component(state + '/Icon')
        image.alpha_composite(icon, (round((image.width - icon.width) / 2 + child['x']),
                                     round((image.height - icon.height) / 2 - child['y'])))
        sprites[key] = _encode(image)

    disconnected = Image.new('RGBA', (148, 42))
    disconnected.alpha_composite(ui_component('NotConnect'), (0, 5))
    disconnected.alpha_composite(ui_component('NotConnect/Icon'), (53, 0))
    sprites['udpipe_disconnected'] = _encode(disconnected)

    for b in output:
        if not b.get('underground'):
            continue
        # Connection frames depend only on the footprint, which for a 1-cell underground pipe is the
        # same 128x124 box for every device, so content addressing collapses them to one image.
        size = (b['w'] * 128 - 4, b['d'] * 128 - 4)
        b['connectionFrames'] = [_encode(baker.scaled('blueprint/icon_concealed_frame_inactive', size, use_slice=True))
                                 for _ in range(4)]
        b['activeConnectionFrames'] = [_encode(baker.active_connection_frame(size)) for _ in range(4)]

    stage('presentation')
    presentation = build_presentation(baker, products, output, line_items, _encode, label)

    stage('reports')
    report.update({
        'productRecords': len(products),
        'availableBadges': sum(bool(p['badge']) for p in products.values()),
        'missingBadges': [iid for iid, p in products.items() if not p['badge']],
        'factoryRowsWithoutItemMetadata': [iid for iid in factory_items if iid not in items],
        'gameEditableBuildings': [b['id'] for b in output if b['canModify']],
        'imagesEmitted': len(_emitted),
        'encodedBytes': sum(entry[3] for entry in _emitted.values()),
        'displayImplemented': ['product icon + rarity', 'gas icon', 'change hint', 'underground paired/unpaired hint',
                               'logistic product icon', 'manual environment effect banner', 'per-port visibility',
                               'manual locked/limited/expired item overlays', 'embedded HarmonyOS Sans SC',
                               'native grid tile', 'native selected and hovered outline',
                               'native underground activated pulse snapshot and exportable cyan connection'],
        'outOfScope': ['game runtime simulation', 'runtime admission rules', 'account unlocks'],
        'notImplementedDisplay': ['game floating hover tooltip', 'travelling shader glow animation',
                                  'interactive inventory card flash/selection animations'],
        'canvasApproximations': ['scrollbar decoration', 'tag capsules and name brackets', 'inventory card/count shadows'],
        'staticAnimationSnapshots': ['underground active frame pulse sampled at 0.5 seconds'],
        'knownAssetGaps': {'productIcons': [iid for iid, p in products.items() if not p['badge']],
                           'buildingWatermarks': sorted(baker.issues)},
        'excludedGameHud': ['account UID and ping', 'controller prompts', 'hover-only tooltips and cursor',
                            'runtime counters and unlock rules'],
        'manualDisplayOnly': ['environment effect (no coverage simulation)', 'port visibility (no recipe rules)',
                              'item status and limited-time theme color (no unlock or time checks)'],
    })
    host.emitJson('display_coverage.json', json.dumps(report, ensure_ascii=False, indent=2))
    audit_effects(ROOT, host)

    demo = json.loads((ROOT / 'examples/demo_blueprint.json').read_text('utf-8'))
    payload = {'buildings': output, 'products': products, 'sprites': sprites, 'spriteBorders': sprite_borders,
               'lineItems': line_items, 'statusLayers': status_layers, 'presentation': presentation, 'demo': demo}
    stage('done')
    return json.dumps(payload, ensure_ascii=False)
