"""Account for each recovered BlueprintPreview image layer, including exclusions.

Ported from the build-time implementation. The report is now emitted through the host instead of
being written to a `reports/` directory, because baking happens in the browser.
"""
from collections import Counter
import json


def audit_effects(root, host):
    source = json.loads((root / 'assets/blueprint_source/prefab_images.json').read_text('utf-8'))
    rows = []
    for path, layer in sorted(source.items()):
        if '/PipeConnectionLine/GlowToRight' in path:
            state, reason = 'not_implemented_motion', 'Shader-driven travelling glow is not reproduced; the original static cyan line is rendered.'
        elif '/PipeConnectionLine' in path:
            state, reason = 'native_static', 'Original sliced line, ordered from loader to unloader; optional saved export annotation.'
        elif '/UdpipeState/SelectedFrame/' in path:
            state, reason = 'sampled_animation', 'Original size and alpha curves sampled at 0.5 seconds, with both inner pulse layers.'
        elif '/NodeCell/SelectedNode' in path or '/HoverHint/Img' in path:
            state, reason = 'native_editor_only', 'Original nine-slice selection/hover artwork; transient editor interaction is not exported.'
        elif '/HoverTipsCanvas/' in path:
            state, reason = 'not_implemented_tooltip', 'The game floating name/rarity/connection tooltip is not reproduced.'
        elif '/Scrollbar' in path:
            state, reason = 'canvas_approximation', 'Working viewport scroll position is drawn with Canvas; native track/cap/glow decoration is not exact.'
        elif '/ChangeIconNode/' in path:
            state, reason = 'custom_editor_ui', 'Searchable HTML item picker replaces the game popup; item-status sprites are reused on the canvas.'
        elif '/LeftBottomNode/' in path or '/ControllerMouse' in path:
            state, reason = 'excluded_game_controls', 'Game controller/cursor/key-hint HUD is outside the static drawing export.'
        elif '/NodeCell/IconNode/ItemNode/ItemIcon/' in path:
            state, reason = 'dynamic_image_slot', 'Runtime item sprite replaced by the chosen original item image; liquid/gas container contents are composed.'
        elif '/NodeCell/' in path or '/ConveyorCell/' in path or path.endswith('/GridImg'):
            state, reason = 'native_static', 'Recovered sprite used in building/port/icon/status/environment/connection/grid composition.'
        elif path.endswith('/MaskBtn'):
            state, reason = 'interaction_surface', 'Transparent game hit surface replaced by Canvas pointer handling.'
        else:
            state, reason = 'unreviewed', 'Requires explicit review.'
        rows.append({'path': path, 'sprite': layer.get('sprite'), 'status': state, 'reason': reason})

    report = {
        'scope': 'All 85 image components recovered from BlueprintPreview; static export and editor interaction are distinguished.',
        'source': 'assets/blueprint_source/prefab_images.json',
        'layers': len(rows),
        'counts': dict(Counter(row['status'] for row in rows)),
        'rows': rows,
        'rightPanelReview': {
            'sources': ['docs/project-notes.md (BlueprintContent provenance)',
                        'assets/blueprint_presentation/prefab_components.json'],
            'implemented': ['cover and paper', 'name/creator/size/tags/description', 'inventory grouping and sorting',
                            'item artwork, rarity and count', 'native frame and gradient artwork'],
            'approximated': ['card shadow and count text shadow', 'tag capsules and empty-tag outline',
                             'name brackets and ellipsis', 'scrollbar decoration'],
            'notReproduced': ['interactive card selection/flash animations',
                              'game inventory shortage, technology, unlock, expiry warning panels',
                              'controller hints and share/review actions'],
        },
    }
    host.emitJson('effect-layer-audit.json', json.dumps(report, ensure_ascii=False, indent=2))
    if report['counts'].get('unreviewed'):
        raise ValueError('Unreviewed preview layers; see effect-layer-audit.json')
    return report
