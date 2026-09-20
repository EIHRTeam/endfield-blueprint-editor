"""Package native cover artwork, detail-panel decorations and inventory sorting.

Ported from the build-time implementation. `embed` is now the host's image sink: it receives a PIL
image and returns the asset key the browser should draw. Reads come from the MEMFS tree the worker
populated from the deployed static files.
"""
import json
from PIL import Image
from bake_blueprint_sprites import ROOT, center, tint

RESAMPLE = Image.Resampling.LANCZOS


def build_presentation(baker, products, buildings, line_items, embed, label):
    root = ROOT / 'assets/blueprint_presentation'
    sprites = {}
    wanted = ['blueprint_default_icon', 'deco_fac_blueprint_5', 'deco_fac_blueprint_6',
              'deco_fac_blueprint_24', 'deco_fac_blueprint_25', 'deco_fac_blueprint_size',
              'deco_fac_blueprint_16', 'deco_assembly07_new', 'deco_item_dot',
              'close_btn_bg_shadeless', 'bg_fac_blueprint_more', 'icon_fac_blueprint_edit', 'bg_item_small_black']
    wanted += ['icon_fac_blueprint_bg_' + color for color in ['blue', 'cyan', 'gray', 'green', 'orange', 'purple', 'yellow']]
    for name in wanted:
        image = Image.open(root / (name + '.png')).convert('RGBA')
        if name in ('deco_fac_blueprint_5', 'deco_fac_blueprint_6'):
            image = tint(image, (68, 68, 68, 255))
        if name == 'deco_assembly07_new':
            image = tint(image, (0, 0, 0, 51))
        if name == 'close_btn_bg_shadeless':
            image = tint(image, (68, 68, 68, 255))
        sprites[name] = embed(image)

    frame = ROOT / 'assets/preview_frame'
    for name in ['deco_fac_blueprint_28', 'deco_fac_blueprint_29', 'deco_fac_blueprint_30',
                 'deco_fac_blueprint_light', 'icon_fac_blueprint_save_big']:
        image = Image.open(frame / (name + '.png')).convert('RGBA')
        if name == 'deco_fac_blueprint_28':
            image = tint(image, (0, 0, 0, 51))
        sprites[name] = embed(image)

    rarity_layers = {}
    for rarity, row in baker.rarity_colors.items():
        rgba = tuple(int(row['color'][i:i + 2], 16) for i in (0, 2, 4)) + (255,)
        rarity_layers['#' + row['color']] = embed(tint(Image.open(root / 'bg_item_rarity_bar_common.png').convert('RGBA'), rgba))

    # Cover artwork is only drawn for the currently selected cover, plus the inventory cards. There
    # are ~860 candidate covers but a preview shows a handful, so they are composed lazily: this map
    # carries names and kinds, and the worker bakes an `asset` on demand (see `bake_cover`).
    covers = {'': {'name': '默认蓝图封面', 'asset': sprites['blueprint_default_icon'], 'kind': 'default',
                   'itemId': ''}}
    ids = set(products) | {b['itemId'] for b in buildings if b['itemId']} | {v['id'] for v in line_items.values()}
    for iid in sorted(ids):
        if iid.startswith('[gas]'):
            available = ('gas/icon_gas_env_' + iid[5:]) in baker.index
        else:
            item = baker.items.get(iid, {})
            path = ROOT / 'assets/item' / ((item.get('iconId') or baker.icon_overrides.get(iid) or iid) + '.png')
            available = path.exists()
        if not available:
            continue
        covers[iid] = {'name': products.get(iid, {}).get('name') or label(baker.items.get(iid, {}).get('name'), iid),
                       'kind': 'device' if iid.startswith(('item_port_', 'item_log_')) else 'product',
                       'itemId': iid}

    for b in [*buildings, *line_items.values()]:
        item = baker.items.get(b.get('itemId', b['id']), {})
        b['sortId1'], b['sortId2'] = item.get('sortId1', 0), item.get('sortId2', 0)

    tables = ROOT / 'data/tables'
    tags = json.loads((tables / 'FactoryBlueprintTagTable.json').read_text('utf-8'))
    suggestions = list(dict.fromkeys(label(t['name'], str(t['id'])) for t in sorted(tags.values(), key=lambda t: t['sortId'])))
    return {'sprites': sprites, 'covers': covers, 'tags': suggestions, 'rarityLayers': rarity_layers}
