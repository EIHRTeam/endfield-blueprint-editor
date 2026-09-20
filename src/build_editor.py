"""Build a self-contained offline editor using the recovered blueprint sprites."""
import base64
from collections import defaultdict
import hashlib
import html as html_utils
import io
import json
from pathlib import Path
from PIL import Image
from bake_blueprint_sprites import BlueprintBaker, KIT
from build_presentation_payload import build_presentation
from audit_display_effects import audit_effects


def build():
    (KIT / 'dist').mkdir(exist_ok=True)
    (KIT / 'reports').mkdir(exist_ok=True)
    baker = BlueprintBaker()
    baker.bake_all(KIT / 'dist/baked/buildings')
    buildings, items = baker.buildings, baker.items
    i18n = baker.table('I18nTextTable_CN')
    def label(ref, fallback):
        value = i18n.get(str((ref or {}).get('id', 0)))
        return value.strip() if isinstance(value, str) and value.strip() else fallback
    assets = {}
    def embed(image, palette=False):
        image = image.convert('RGBA')
        if palette:
            image.thumbnail((96, 96), Image.Resampling.LANCZOS)
        buffer = io.BytesIO()
        image.save(buffer, 'WEBP' if palette else 'PNG', **({'quality': 85} if palette else {'optimize': True}))
        raw = buffer.getvalue()
        key = hashlib.sha256(raw).hexdigest()[:24]
        assets.setdefault(key, f'data:image/{"webp" if palette else "png"};base64,' + base64.b64encode(raw).decode())
        return key

    recipes = defaultdict(set)
    for recipe in baker.table('FactoryMachineCraftTable').values():
        for outcome in recipe.get('outcomes', []):
            recipes[recipe['machineId']].update(item['id'] for item in outcome.get('group', []))
    for bid, entry in baker.table('FactoryMinerTable').items():
        recipes[bid].update(v['miningItemId'] for v in entry.get('mineable', []))
    for bid, entry in baker.table('FactoryGasMinerTable').items():
        recipes[bid].update(v['miningItemId'] for v in entry.get('mineable', []))
    for bid, entry in baker.table('FactoryFluidPumpInTable').items():
        recipes[bid].update(entry['enableLiquidIds'])
    for bid, entry in baker.table('FactorySewageTreatExportTable').items():
        recipes[bid].add(entry['productItemId'])
    hub_products = {v['id'] for r in baker.table('FactoryHubCraftTable').values() for v in r['outcomes']}
    for bid, entry in buildings.items():
        if entry['type'] in (1, 22):
            recipes[bid].update(hub_products)
    factory_items = baker.table('FactoryItemTable')
    gases = {'Inactive': '惰性环境', 'Humidity': '潮湿环境', 'Acid': '酸性环境', 'Xiranite': '息壤环境', 'Stable': '稳定环境'}
    products = {}
    audit_path = KIT / 'data/icon_audit.json'
    icon_audit = {r['id']: r for r in json.loads(audit_path.read_text('utf-8'))['items']} if audit_path.exists() else {}
    badge_dir = KIT / 'dist/baked/badges'
    badge_dir.mkdir(parents=True, exist_ok=True)
    badge_files = {}
    wanted = set().union(*recipes.values())
    wanted.update(iid for iid in factory_items if iid in items)
    # Also preserve non-recipe custom product icons that are present in the toolkit.
    wanted.update(iid for iid, item in items.items() if not iid.startswith('item_port_')
                  and (KIT / 'assets/item' / (item.get('iconId', iid) + '.png')).exists())
    for iid in sorted(wanted):
        item = items.get(iid, {})
        try:
            image = baker.product_badge(iid)
            badge = embed(image)
            image.save(badge_dir / (iid + '.png'))
            badge_files[iid] = iid + '.png'
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
        image = baker.product_badge(iid)
        image.save(badge_dir / ('gas_' + env.lower() + '.png'))
        badge_files[iid] = 'gas_' + env.lower() + '.png'
        products[iid.lower()] = {'name': name, 'badge': embed(image), 'gas': True}
    (badge_dir / 'index.json').write_text(json.dumps(badge_files, indent=2), encoding='utf-8')
    recipes['vaporizer_1'].update('[gas]' + name for name in gases if name != 'Stable')

    fallbacks = json.loads((KIT / 'data/building_item_fallbacks.json').read_text('utf-8'))
    building_items = baker.table('FactoryBuildingItemReverseTable')
    output = []
    for bid, b in buildings.items():
        w, d = b['range']['width'], b['range']['depth']
        directory = KIT / 'dist/baked/buildings' / bid
        faces = [embed(Image.open(directory / f'd{face}_body.png')) for face in range(4)]
        pipe_ports = any(p['isPipe'] for field in ('inputPorts', 'outputPorts') for p in b[field])
        normal = [embed(baker.body(bid, face, 'normal')) for face in range(4)] if pipe_ports else faces
        symbol = embed(baker.icon(bid))
        item_id = building_items.get(bid, {}).get('itemId') or fallbacks.get(bid, '')
        item_icon = items.get(item_id, {}).get('iconId') or baker.icon_overrides.get(item_id) or item_id
        icon_path = KIT / 'assets/item' / (item_icon + '.png')
        palette = embed(Image.open(icon_path), palette=True) if item_icon and icon_path.exists() else symbol
        rarity = items.get(item_id, {}).get('rarity', 1)
        rarity_color = '#' + baker.rarity_colors.get(str(rarity), {}).get('color', '9B9B9B')
        ports = []
        editable = not baker.special_bg(bid)
        alpha = Image.open(directory / 'd0_body.png').convert('RGBA').getchannel('A')
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
                for distance in range(33):
                    xy = {0: (alpha.width - 1 - distance, pz), 1: (px, alpha.height - 1 - distance),
                          2: (distance, pz), 3: (px, distance)}[port['dir']]
                    if alpha.getpixel(xy) >= 200:
                        break
                port['inset'] = (distance + 1) / 128
                ports.append(port)
        output.append({'id': bid, 'name': label(b['name'], bid), 'w': w, 'd': d,
                       'faces': faces, 'normalFaces': normal, 'symbol': symbol, 'palette': palette,
                       'itemId': item_id, 'rarity': rarity, 'rarityColor': rarity_color,
                       'ports': ports, 'products': sorted(recipes[bid]),
                       'editablePorts': editable,
                       'bareFaces': [embed(baker.editable_base(bid, f)) for f in range(4)] if editable else [],
                       'waistFaces': [embed(baker.editable_base(bid, f, True)) for f in range(4)] if editable else [],
                       'edgeDecoration': embed(baker.scaled('blueprint/deco_edge_' + ('big' if w >= 3 and d >= 3 else 'small'),
                           (w * 128, 140 if w >= 3 and d >= 3 else 40), True)) if editable else None,
                       'underground': bid.startswith('udpipe_'),
                       'canModify': baker.icon_table.get(bid, {}).get('canModify', False)})
    baker.bake_logistics()
    for bid, entry in baker.logistics.items():
        faces = [embed(baker.body(bid, face)) for face in range(4)]
        item = items[entry['itemId']]
        path = KIT / 'assets/item' / (item.get('iconId', entry['itemId']) + '.png')
        palette = embed(Image.open(path), palette=True) if path.exists() else faces[0]
        output.append({'id': bid, 'name': label(entry['name'], bid), 'w': 1, 'd': 1,
                       'faces': faces, 'normalFaces': faces, 'symbol': None, 'palette': palette,
                       'itemId': entry['itemId'], 'rarity': item.get('rarity', 1),
                       'rarityColor': '#' + baker.rarity_colors.get(str(item.get('rarity', 1)), {}).get('color', '9B9B9B'),
                       'ports': [], 'products': [], 'canModify': False, 'logistic': True})
    output.sort(key=lambda b: (b['name'] == b['id'], b['name']))
    sprites = {name: embed(baker.sprite('blueprint/' + name)) for name in
               ['icon_belt_grid', 'icon_belt_corner_1', 'icon_belt_corner_2',
                'icon_pipe_grid', 'icon_pipe_corner_1', 'icon_pipe_corner_2']}
    for key in baker.index:
        if key.startswith(('blueprint/port_in_', 'blueprint/port_out_', 'blueprint/pipe_port_in_', 'blueprint/pipe_port_out_')):
            sprites[key.split('/')[-1]] = embed(baker.sprite(key))
    for env in gases:
        sprites['env_effect_' + env.lower()] = embed(baker.sprite('gas/icon_gas_env_effected_' + env.lower()))
    sprites['badge_bg'] = embed(baker.scaled(baker.component('/NodeCell/IconNode/ItemNode/BG')['sprite'], (120, 120)))
    sprites['change_hint'] = embed(baker.sprite(baker.component('/NodeCell/IconNode/ChangeHint')['sprite']))
    sprite_borders = {}
    for name, suffix in [('grid', '/GridImg'), ('udpipe_line', '/Content/PipeConnectionLine'),
                         ('selection_frame', '/NodeCell/SelectedNode'), ('hover_frame', '/HoverHint/Img')]:
        component = baker.component(suffix)
        sprites[name] = embed(baker.sprite(component['sprite']))
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
            tr = comp['transform']; size = tr['m_SizeDelta']; pos = tr['m_AnchoredPosition']
            x, y = pos['x'] - size['x'] * tr['m_Pivot']['x'], -pos['y'] - size['y'] * (1 - tr['m_Pivot']['y'])
            if tr['m_AnchorMin']['x'] == 0:
                x -= 60; y -= 60
            if suffix.endswith('/Icon2Image'):
                x += -5; y += -3.6
            color = [round(comp['color'][k] * 255) for k in ('r', 'g', 'b', 'a')]
            theme = suffix.endswith('/TimeLimitedColorTag')
            im = baker.scaled(comp['sprite'], (size['x'], size['y']), rgba=None if theme else color)
            key = 'status_' + suffix.replace('/', '_')
            sprites[key] = embed(im)
            layers.append({'asset': sprites[key], 'x': x, 'y': y, 'w': size['x'], 'h': size['y'], 'theme': theme})
        status_layers[status] = layers
    # Bake the original prefab button layers, including their offsets and tints.
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
        sprites[key] = embed(image)
    disconnected = Image.new('RGBA', (148, 42))
    disconnected.alpha_composite(ui_component('NotConnect'), (0, 5))
    disconnected.alpha_composite(ui_component('NotConnect/Icon'), (53, 0))
    sprites['udpipe_disconnected'] = embed(disconnected)
    overlay_dir = KIT / 'dist/baked/overlays'
    overlay_dir.mkdir(parents=True, exist_ok=True)
    for key in ['change_hint', 'udpipe_show', 'udpipe_hide', 'udpipe_disconnected', *('env_effect_' + env.lower() for env in gases), *(k for k in sprites if k.startswith('status_'))]:
        (overlay_dir / (key + '.png')).write_bytes(base64.b64decode(assets[sprites[key]].split(',', 1)[1]))
    for b in output:
        if b.get('underground'):
            b['connectionFrames'] = [embed(baker.scaled('blueprint/icon_concealed_frame_inactive',
                ((b['d'] if d % 2 else b['w']) * 128 - 4, (b['w'] if d % 2 else b['d']) * 128 - 4), use_slice=True)) for d in range(4)]
            b['activeConnectionFrames'] = [embed(baker.active_connection_frame(
                ((b['d'] if d % 2 else b['w']) * 128 - 4, (b['w'] if d % 2 else b['d']) * 128 - 4))) for d in range(4)]
            for direction, key in enumerate(b['activeConnectionFrames']):
                (overlay_dir / f'{b["id"]}_d{direction}_active_frame.png').write_bytes(base64.b64decode(assets[key].split(',', 1)[1]))
    report = {'productRecords': len(products), 'availableBadges': sum(bool(p['badge']) for p in products.values()),
              'missingBadges': [iid for iid, p in products.items() if not p['badge']],
              'factoryRowsWithoutItemMetadata': [iid for iid in factory_items if iid not in items],
              'gameEditableBuildings': [b['id'] for b in output if b['canModify']],
              'displayImplemented': ['product icon + rarity', 'gas icon', 'change hint', 'underground paired/unpaired hint', 'logistic product icon', 'manual environment effect banner', 'per-port visibility', 'manual locked/limited/expired item overlays', 'embedded HarmonyOS Sans SC', 'native grid tile', 'native selected and hovered outline', 'native underground activated pulse snapshot and exportable cyan connection'],
              'outOfScope': ['game runtime simulation', 'runtime admission rules', 'account unlocks'],
              'notImplementedDisplay': ['game floating hover tooltip', 'travelling shader glow animation', 'interactive inventory card flash/selection animations'],
              'canvasApproximations': ['scrollbar decoration', 'tag capsules and name brackets', 'inventory card/count shadows'],
              'staticAnimationSnapshots': ['underground active frame pulse sampled at 0.5 seconds'],
              'knownAssetGaps': {'productIcons': [iid for iid, p in products.items() if not p['badge']], 'buildingWatermarks': sorted(baker.issues)},
              'excludedGameHud': ['account UID and ping', 'controller prompts', 'hover-only tooltips and cursor', 'runtime counters and unlock rules'],
              'manualDisplayOnly': ['environment effect (no coverage simulation)', 'port visibility (no recipe rules)', 'item status and limited-time theme color (no unlock or time checks)']}
    (KIT / 'reports/display_coverage.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    audit_effects(KIT)
    line_items = {}
    for kind, iid in [('item', 'item_log_belt_01'), ('fluid', 'item_log_pipe_01')]:
        item = items[iid]
        line_items[kind] = {'id': iid, 'name': label(item['name'], iid),
                            'palette': embed(Image.open(KIT / 'assets/item' / (item['iconId'] + '.png')), palette=True),
                            'rarityColor': '#' + baker.rarity_colors.get(str(item['rarity']), {}).get('color', '9B9B9B')}
    payload = {'buildings': output, 'products': products, 'assets': assets, 'sprites': sprites, 'spriteBorders': sprite_borders, 'lineItems': line_items, 'statusLayers': status_layers,
               'demo': json.loads((KIT / 'examples/demo_blueprint.json').read_text('utf-8'))}
    payload['presentation'] = build_presentation(baker, products, output, line_items, embed, label)
    template = (KIT / 'src/editor_shell.html').read_text('utf-8')
    font = base64.b64encode((KIT / 'assets/fonts/HarmonyOS_Sans_SC.ttf').read_bytes()).decode()
    font_css = '@font-face{font-family:"HarmonyOS Sans SC";src:url(data:font/ttf;base64,' + font + ') format("truetype");font-weight:40 900;font-style:normal;font-display:block}'
    template = template.replace('__FONT_CSS__', font_css)
    license_text = (KIT / 'assets/fonts/LICENSE-update.txt').read_text('utf-8').rstrip('\x00')
    template = template.replace('__FONT_LICENSE__', html_utils.escape(license_text))
    template = template.replace('<button id="btnPng">导出 PNG</button>', '<button id="btnGamePreview">蓝图预览</button><button id="btnPng">导出画布 PNG</button>')
    template = template.replace('<footer>', (KIT / 'src/editor_presentation.html').read_text('utf-8') + '\n<footer>')
    html = template.replace('__DATA__', json.dumps(payload, ensure_ascii=False, separators=(',', ':')).replace('<', '\\u003c'))
    html = html.replace('__CORE__', (KIT / 'src/editor_core.js').read_text('utf-8'))
    html = html.replace('__APP__', (KIT / 'src/editor_app.js').read_text('utf-8'))
    html = html.replace('</body>', '<script>' + (KIT / 'src/editor_presentation.js').read_text('utf-8') + '</script>\n</body>')
    dest = KIT / 'dist/blueprint_editor.html'
    dest.write_text(html, encoding='utf-8')
    print(f'Built {len(output)} buildings, {len(products)} product records, {len(assets)} embedded assets, {dest.stat().st_size / 1048576:.2f} MiB')
    return dest


if __name__ == '__main__':
    build()
