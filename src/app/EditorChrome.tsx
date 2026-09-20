/**
 * Header, sidebar, inspector, summary, footer and dialog wiring.
 *
 * Kept in one module because these panels share a large amount of small state (the item library
 * target, the presentation dialog, the export options) and splitting them would mean threading that
 * state through several providers for no benefit.
 */
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { bounds, clone, dims, hit, footprint, pairUnderground, undergroundPeer, validate } from '../core';
import type { Product } from '../core/types';
import { useEditorStore } from './store';
import { useScene } from './SceneContext';
import { productKey } from '../render/paintScene';
import { exportCanvas } from './export';
import { usePublicApi } from './publicApi';
import { useGlobalShortcuts } from './shortcuts';

/** The presentation dialog and the item library are separate chunks. */
const PresentationDialog = lazy(() => import('../features/presentation/PresentationDialog'));
const ItemLibrary = lazy(() => import('../features/library/ItemLibrary'));
const exportPreviewLazy = () => import('../features/presentation/export');

export interface EditorChromeProps {
  libraryTarget: number | null;
  setLibraryTarget: (index: number | null) => void;
  presentationOpen: boolean;
  setPresentationOpen: (open: boolean) => void;
}

export function EditorChrome({
  libraryTarget,
  setLibraryTarget,
  presentationOpen,
  setPresentationOpen,
}: EditorChromeProps) {
  const store = useEditorStore();
  const scene = useScene();
  const [licenseOpen, setLicenseOpen] = useState(false);

  usePublicApi();
  useGlobalShortcuts({
    openPresentation: () => setPresentationOpen(true),
    closeLibrary: () => setLibraryTarget(null),
    openLibrary: () => setLibraryTarget(-1),
  });

  const openLibraryFor = useCallback((index: number | null) => setLibraryTarget(index ?? -1), [setLibraryTarget]);

  return (
    <>
      <Header onOpenLicense={() => setLicenseOpen(true)} />
      <main>
        <BuildingSidebar />
        <section className="canvas-column">
          <CanvasStage />
          <div id="viewTools">
            <button id="btnFit" onClick={() => scene.viewport()?.fit()}>
              适应布局 F
            </button>
            <button id="btnGrid" onClick={() => store.setShowGrid(!store.showGrid)}>
              网格：{store.showGrid ? '开' : '关'}
            </button>
            <button id="btnPorts" onClick={() => store.setShowPorts(!store.showPorts)}>
              端口标记：{store.showPorts ? '开' : '关'}
            </button>
            <button id="btnHints" onClick={() => store.setShowHints(!store.showHints)}>
              原版提示：{store.showHints ? '开' : '关'}
            </button>
            <button id="btnInspector" onClick={() => document.body.classList.toggle('inspect-open')}>
              设备属性
            </button>
          </div>
          <CanvasHint />
        </section>
        <InspectorPanel onOpenLibrary={() => openLibraryFor(store.selectedIndex)} />
      </main>
      <SummaryPanel />
      <Footer onOpenLicense={() => setLicenseOpen(true)} />
      <input
        id="fileIn"
        type="file"
        accept=".json,application/json"
        onChange={event => void handleImport(event, store)}
      />

      <Suspense fallback={null}>
        {presentationOpen && (
          <PresentationDialog
            onClose={() => setPresentationOpen(false)}
            onExport={async resolution => (await exportPreviewLazy()).default(scene, store.data, resolution)}
          />
        )}
        {libraryTarget !== null && (
          <ItemLibrary
            target={libraryTarget >= 0 ? libraryTarget : store.selectedIndex}
            onClose={() => setLibraryTarget(null)}
          />
        )}
      </Suspense>

      {licenseOpen && (
        <div className="license-overlay" role="dialog" aria-label="HarmonyOS Sans 字体许可">
          <div className="license-card">
            <div className="library-head">
              <h2>HarmonyOS Sans 字体许可</h2>
              <button id="btnCloseFontLicense" onClick={() => setLicenseOpen(false)}>
                关闭
              </button>
            </div>
            <pre id="fontLicenseText">{scene.license}</pre>
          </div>
        </div>
      )}
    </>
  );
}

/** The canvas gets its own import site so the editor chunk graph stays obvious. */
import { CanvasStage } from '../features/editor/CanvasStage';

function CanvasHint() {
  const store = useEditorStore();
  const scene = useScene();
  const text = useMemo(
    () =>
      ({
        select: '点击选中 · 拖动移动 · R 旋转 · Delete 删除',
        place: '点击放置 · R 旋转 · Esc 返回选择',
        item: '沿拖动方向铺设传送带 · 端点吸附接口 · Shift 切换转弯顺序',
        fluid: '拖动铺设流体管 · 端点吸附流体口 · 可与传送带分层交叉',
        erase: '点击删除设备或当前格线路 · 可撤销',
        icon: `图标画笔：${scene.products[productKey(store.iconBrush) ?? '']?.name || '设备符号'} · 点击设备标注 · Esc 退出`,
      })[store.tool],
    [store.tool, store.iconBrush, scene.products],
  );

  return <div id="canvasHint">{text}</div>;
}

function Header({ onOpenLicense }: { onOpenLicense: () => void }) {
  const store = useEditorStore();
  const [name, setName] = useState(store.data.name);
  const [busy, setBusy] = useState(false);
  // Export options live in React state rather than being read back out of the DOM, which keeps the
  // export callback free of hidden DOM dependencies.
  const [exportScale, setExportScale] = useState(64);
  const [transparent, setTransparent] = useState(false);
  const scene = useScene();

  const commitName = useCallback(() => {
    const next = name.trim() || '未命名蓝图';
    if (next !== store.data.name)
      store.transact(draft => {
        draft.name = next;
      }, '名称已更新');
  }, [name, store]);

  const saveJson = useCallback(() => {
    commitName();
    const safe = fileStem(store.data.name);
    download(new Blob([JSON.stringify(store.data, null, 2)], { type: 'application/json' }), `${safe}.json`);
    store.setStatus('JSON 已导出');
  }, [commitName, store]);

  const exportPng = useCallback(async () => {
    commitName();
    setBusy(true);
    store.setStatus('正在生成 PNG…');
    try {
      const canvas = await exportCanvas(scene, store.data, {
        cell: exportScale,
        transparent,
        hints: store.showHints,
      });
      const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'));
      if (!blob) throw Error('PNG 编码失败');
      const safe = fileStem(store.data.name);
      download(blob, `${safe}.png`);
      store.setStatus(`PNG 已导出：${canvas.width}×${canvas.height}`);
    } catch (error) {
      store.setStatus((error as Error).message, true);
    } finally {
      setBusy(false);
    }
  }, [commitName, scene, store, exportScale, transparent]);

  return (
    <header>
      <strong>终末地 · 蓝图</strong>
      <input
        id="bpName"
        aria-label="蓝图名称"
        value={name}
        maxLength={120}
        onChange={event => setName(event.target.value)}
        onBlur={commitName}
      />
      <button id="btnUndo" title="Ctrl+Z" disabled={!store.canUndo} onClick={store.undo}>
        撤销
      </button>
      <button id="btnRedo" title="Ctrl+Y / Ctrl+Shift+Z" disabled={!store.canRedo} onClick={store.redo}>
        重做
      </button>
      <span className="grow" />
      <button
        id="btnDemo"
        onClick={() => {
          // Commits through history, so loading the sample is undoable like any other import.
          try {
            const next = validate(clone(scene.payload.demo), store.buildings);
            store.commitExternal(
              store.data,
              next,
              `已导入示例：${next.nodes.length} 个设备 / ${next.conveyors.length} 段线路`,
            );
            scene.viewport()?.fit();
          } catch (error) {
            store.setStatus(`示例导入失败：${(error as Error).message}`, true);
          }
        }}
      >
        示例
      </button>
      <button id="btnImport" onClick={() => document.getElementById('fileIn')?.click()}>
        导入 JSON
      </button>
      <button id="btnJson" onClick={saveJson}>
        保存 JSON
      </button>
      <div id="exportOptions">
        <select
          id="exportScale"
          aria-label="PNG 每格像素"
          value={exportScale}
          onChange={event => setExportScale(Number(event.target.value))}
        >
          <option value="40">40 px/格</option>
          <option value="64">64 px/格</option>
          <option value="128">128 px/格</option>
        </select>
        <label className="check">
          <input
            id="transparent"
            type="checkbox"
            checked={transparent}
            onChange={event => setTransparent(event.target.checked)}
          />
          透明背景
        </label>
      </div>
      <button id="btnGamePreview" onClick={scene.openPresentation}>
        蓝图预览
      </button>
      <button id="btnPng" disabled={busy} onClick={() => void exportPng()}>
        导出画布 PNG
      </button>
      <button id="btnFontLicense" onClick={onOpenLicense} className="sr-only">
        字体许可
      </button>
    </header>
  );
}

function BuildingSidebar() {
  const store = useEditorStore();
  const scene = useScene();
  const [term, setTerm] = useState('');

  const buildings = useMemo(() => {
    const needle = term.trim().toLowerCase();
    return scene.payload.buildings.filter(
      building => !needle || `${building.name} ${building.id}`.toLowerCase().includes(needle),
    );
  }, [scene.payload.buildings, term]);

  return (
    <aside>
      <div className="sidehead">
        <input
          id="search"
          aria-label="搜索设备"
          placeholder="搜索设备名称或 ID"
          value={term}
          onChange={event => setTerm(event.target.value)}
        />
        <button id="btnItemLibrary" onClick={() => scene.openLibrary(null)}>
          物品图标库 · 搜索 / 选择
        </button>
        <span className="muted" id="buildingCount">
          {buildings.length} / {scene.payload.buildings.length} 个设备条目
        </span>
      </div>
      <div id="buildingList">
        {buildings.map(building => (
          <button
            key={building.id}
            className={`building${store.tool === 'place' && store.chosen === building.id ? ' active' : ''}`}
            data-id={building.id}
            aria-label={`放置 ${building.name}`}
            onClick={() => {
              store.setChosen(building.id);
              store.setTool('place');
              store.setStatus(`已选 ${building.name}，点击画布放置`);
            }}
          >
            <img src={scene.assets.urlsFor(building.palette)} alt="" loading="lazy" />
            <span>
              <b>{building.name}</b>
              <small>
                {building.w}×{building.d} · {building.id}
              </small>
            </span>
          </button>
        ))}
      </div>
      <div className="tools">
        {(
          [
            ['select', '选择 / 移动 V'],
            ['place', '放置设备 P'],
            ['item', '传送带 B'],
            ['fluid', '流体管 L'],
            ['erase', '删除 E'],
          ] as const
        ).map(([tool, label]) => (
          <button
            key={tool}
            data-tool={tool}
            className={store.tool === tool ? 'active' : undefined}
            onClick={() => store.setTool(tool)}
          >
            {label}
          </button>
        ))}
        <button
          id="btnClear"
          className="danger"
          onClick={() => {
            store.setSelectedIndex(-1);
            store.transact(draft => {
              draft.nodes = [];
              draft.conveyors = [];
            }, '布局已清空，可撤销');
          }}
        >
          清空布局
        </button>
      </div>
      <div className="help">
        <kbd>R</kbd> 旋转 · <kbd>Delete</kbd> 删除选中
        <br />
        拖动铺线 · <kbd>Shift</kbd> 切换转弯顺序
        <br />
        滚轮缩放 · 空格拖动 / 中键平移
      </div>
    </aside>
  );
}

function InspectorPanel({ onOpenLibrary }: { onOpenLibrary: () => void }) {
  const store = useEditorStore();
  const scene = useScene();
  const node = store.data.nodes[store.selectedIndex];
  const building = node ? store.buildings[node.templateId] : undefined;
  const previewRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!node || !building || !previewRef.current) return;
    void import('../render/inspectorPreview').then(({ paintInspectorPreview }) => {
      paintInspectorPreview(previewRef.current!, scene, store.data, store.selectedIndex);
    });
  }, [node, building, scene, store.data, store.selectedIndex]);

  if (!node || !building) {
    return (
      <aside id="properties">
        <button id="btnCloseInspector" onClick={() => document.body.classList.remove('inspect-open')}>
          收起属性
        </button>
        <h2>设备属性</h2>
        <div id="emptySelection" className="muted">
          点击设备查看属性，拖动可以移动位置。
        </div>
      </aside>
    );
  }

  const size = dims(building, node.direction);
  const peer = undergroundPeer(store.data.nodes, node);
  const update = (operation: (draft: typeof node) => void, message = '设备属性已更新') => {
    store.transact(draft => {
      operation(draft.nodes[store.selectedIndex]!);
    }, message);
  };
  const currentProduct = scene.products[productKey(node.productIcon) ?? ''];

  return (
    <aside id="properties">
      <button id="btnCloseInspector" onClick={() => document.body.classList.remove('inspect-open')}>
        收起属性
      </button>
      <h2>设备属性</h2>
      <div id="selectionFields" className="fields">
        <div className="preview">
          <canvas id="selectedPreview" ref={previewRef} aria-label="选中设备" />
        </div>
        <div>
          <b id="selectedName">{building.name}</b>
          <div id="selectedId" className="muted">
            {building.id}
          </div>
          <div id="selectedSize" className="muted">
            占地 {size.w}×{size.d}
            {building.logistic ? ' · 物流节点' : ` · ${building.ports.length} 个原始端口`}
          </div>
        </div>
        <div className="row">
          <label>
            X 坐标
            <input
              id="nodeX"
              type="number"
              min="0"
              step="1"
              value={node.position.x}
              onChange={event =>
                update(draft => {
                  draft.position.x = event.target.valueAsNumber;
                })
              }
            />
          </label>
          <label>
            Z 坐标
            <input
              id="nodeZ"
              type="number"
              min="0"
              step="1"
              value={node.position.z}
              onChange={event =>
                update(draft => {
                  draft.position.z = event.target.valueAsNumber;
                })
              }
            />
          </label>
        </div>
        <label>
          朝向
          <select
            id="nodeDirection"
            value={node.direction}
            onChange={event =>
              update(draft => {
                draft.direction = Number(event.target.value) as 0 | 1 | 2 | 3;
              })
            }
          >
            <option value="0">0°</option>
            <option value="1">90°</option>
            <option value="2">180°</option>
            <option value="3">270°</option>
          </select>
        </label>
        <div className="fields">
          <span id="productLabel">
            {node.templateId.includes('conditioner')
              ? '准入物品图标'
              : node.templateId === 'unloader_1'
                ? '取货物品图标'
                : '展示物品'}
          </span>
          <button id="btnChooseProduct" className="item-choice" aria-label="选择展示物品" onClick={onOpenLibrary}>
            <img
              id="selectedProductImage"
              alt=""
              src={scene.assets.urlsFor(currentProduct?.badge || building.symbol || building.faces[0]!)}
            />
            <span>
              <b id="selectedProductName">{node.productIcon ? currentProduct?.name || node.productIcon : '设备符号'}</b>
              <small>搜索 / 更换物品图标</small>
            </span>
          </button>
          <div id="productHelp" className="muted">
            图标会随蓝图和 PNG 一起保存。
          </div>
        </div>
        {building.underground && (
          <div id="undergroundFields" className="fields">
            <label>
              暗管配对
              <select
                id="undergroundPeer"
                value={peer ? String(store.data.nodes.indexOf(peer)) : '-1'}
                onChange={event =>
                  store.transact(
                    draft => pairUnderground(draft.nodes, store.selectedIndex, Number(event.target.value)),
                    '暗管配对已更新',
                  )
                }
              >
                <option value="-1">未连接</option>
                {store.data.nodes.map((candidate, index) =>
                  candidate.templateId !== node.templateId ? null : (
                    // Position is unique per device, so it is a stable key that survives reordering.
                    <option key={`${candidate.position.x},${candidate.position.z}`} value={String(index)}>
                      {store.buildings[candidate.templateId]!.name} ({candidate.position.x}, {candidate.position.z})
                    </option>
                  ),
                )}
              </select>
            </label>
            <button
              id="btnConnection"
              disabled={!peer}
              onClick={() =>
                store.setActivePair(store.activePair === node.undergroundPair ? null : (node.undergroundPair ?? null))
              }
            >
              {peer && store.activePair === node.undergroundPair ? '收起连接' : '查看连接'}
            </button>
            <div className="muted">连接线用于标注暗管的配对关系。</div>
          </div>
        )}
        <label>
          接口显示
          <select
            id="nodePorts"
            value={node.formulaMode === 'normal' ? 'normal' : 'all'}
            onChange={event =>
              update(draft => {
                if (event.target.value === 'normal') draft.formulaMode = 'normal';
                else delete draft.formulaMode;
              }, '已切换接口显示模式')
            }
          >
            <option value="all">全部接口</option>
            <option value="normal">仅物品接口</option>
          </select>
        </label>
        <label>
          环境生效标记
          <select
            id="nodeEnvironment"
            value={node.environmentEffect ?? ''}
            onChange={event =>
              update(draft => {
                if (event.target.value) draft.environmentEffect = event.target.value as typeof draft.environmentEffect;
                else delete draft.environmentEffect;
              })
            }
          >
            <option value="">无标记</option>
            <option value="stable">稳定环境 · 蓝色</option>
            <option value="xiranite">息壤环境 · 绿色</option>
            <option value="acid">酸性环境 · 黄色</option>
            <option value="humidity">潮湿环境 · 白色</option>
            <option value="inactive">未生效 · 橙色</option>
          </select>
        </label>
        <label>
          物品状态标记
          <select
            id="nodeItemStatus"
            value={node.itemStatus ?? 'normal'}
            onChange={event =>
              update(draft => {
                if (event.target.value === 'normal') delete draft.itemStatus;
                else draft.itemStatus = event.target.value as typeof draft.itemStatus;
              })
            }
          >
            <option value="normal">无状态角标</option>
            <option value="locked">锁定</option>
            <option value="limited">限时有效</option>
            <option value="expired">限时过期</option>
          </select>
        </label>
        {node.itemStatus === 'limited' && node.productIcon && (
          <label id="itemStatusColorField">
            限时角标颜色
            <input
              id="nodeItemStatusColor"
              type="color"
              value={node.itemStatusColor ?? '#00ffff'}
              onChange={event =>
                update(draft => {
                  draft.itemStatusColor = event.target.value;
                })
              }
            />
          </label>
        )}
        {building.editablePorts && building.ports.length > 0 && (
          <details id="portVisibilityFields" open>
            <summary>逐个设置接口</summary>
            <div id="portVisibility">
              {building.ports.map(port => (
                <label key={port.id} className="check">
                  <input
                    type="checkbox"
                    checked={!node.closedPorts?.includes(port.id)}
                    disabled={node.formulaMode === 'normal' && port.pipe}
                    onChange={event =>
                      update(draft => {
                        const closed = new Set(draft.closedPorts ?? []);
                        if (event.target.checked) closed.delete(port.id);
                        else closed.add(port.id);
                        if (closed.size) draft.closedPorts = [...closed];
                        else delete draft.closedPorts;
                      })
                    }
                  />
                  {['右', '下', '左', '上'][(port.dir + node.direction) % 4]} · {port.pipe ? '管道' : '物品'}
                  {port.input ? '入口' : '出口'} {port.n + 1}
                </label>
              ))}
            </div>
            <button
              id="btnResetPorts"
              onClick={() =>
                update(draft => {
                  delete draft.closedPorts;
                  delete draft.formulaMode;
                })
              }
            >
              恢复全部接口
            </button>
          </details>
        )}
        <button
          id="btnDeleteNode"
          className="danger"
          onClick={() => {
            const index = store.selectedIndex;
            store.setSelectedIndex(-1);
            store.transact(draft => draft.nodes.splice(index, 1), '已删除设备，可撤销');
          }}
        >
          删除设备
        </button>
        <div id="nodeWarning" className="muted">
          {node.productIcon && !currentProduct?.badge ? `未找到 ${node.productIcon} 的图片；导入值会原样保存。` : ''}
        </div>
      </div>
    </aside>
  );
}

function SummaryPanel() {
  const store = useEditorStore();
  const scene = useScene();

  const counts = useMemo(() => {
    const groups = new Map<string, { buildingId: string; indices: number[] }>();
    store.data.nodes.forEach((node, index) => {
      const building = store.buildings[node.templateId]!;
      const key = building.itemId || building.id;
      if (!groups.has(key)) groups.set(key, { buildingId: building.id, indices: [] });
      groups.get(key)!.indices.push(index);
    });
    return [...groups.entries()];
  }, [store.data.nodes, store.buildings]);

  const occupied = useMemo(() => {
    const cells = new Set<string>();
    for (const node of store.data.nodes) {
      const building = store.buildings[node.templateId]!;
      if (building.logistic) continue;
      const f = footprint(node, store.buildings);
      for (let z = f.z0; z < f.z0 + f.d; z++) for (let x = f.x0; x < f.x0 + f.w; x++) cells.add(`${x},${z}`);
    }
    return cells;
  }, [store.data.nodes, store.buildings]);

  const focus = (index: number) => {
    store.setTool('select', { keepSelection: true });
    store.setSelectedIndex(index);
    const node = store.data.nodes[index]!;
    const f = footprint(node, store.buildings);
    const handle = scene.viewport();
    if (handle && !handle.isVisible(f.x0 + f.w / 2, f.z0 + f.d / 2))
      handle.centerOn(f.x0 + f.w / 2 - 0.5, f.z0 + f.d / 2 - 0.5);
    store.setStatus(`已定位 ${store.buildings[node.templateId]!.name} (${node.position.x}, ${node.position.z})`);
  };

  return (
    <section id="summary">
      <button id="btnPresentationDetails" onClick={scene.openPresentation}>
        蓝图详情 · 编辑 / 预览
      </button>
      <div className="summary-head">
        <span>设备一览</span>
        <span id="nodeCount">{store.data.nodes.length} / 160</span>
      </div>
      <div id="summaryList">
        {counts.map(([key, group]) => {
          const building = store.buildings[group.buildingId]!;
          return (
            <button
              key={key}
              className="summary-card"
              style={{ ['--rarity' as string]: building.rarityColor || '#9b9b9b' }}
              title={`${building.name} × ${group.indices.length} · 点击定位`}
              onClick={() =>
                focus(group.indices[(group.indices.indexOf(store.selectedIndex) + 1) % group.indices.length]!)
              }
            >
              <img src={scene.assets.urlsFor(building.palette)} alt="" />
              <b>{group.indices.length}</b>
            </button>
          );
        })}
        {Object.entries(scene.lineItems).map(([kind, item]) => {
          const count = store.data.conveyors.filter(
            belt => belt.kind === kind && !occupied.has(`${belt.x},${belt.z}`),
          ).length;
          if (!count) return null;
          return (
            <button
              key={kind}
              className="summary-card"
              style={{ ['--rarity' as string]: item.rarityColor || '#9b9b9b' }}
              title={`${item.name} · ${count} 格 · 点击继续铺设`}
              onClick={() => store.setTool(kind === 'fluid' ? 'fluid' : 'item')}
            >
              <img src={scene.assets.urlsFor(item.palette)} alt="" />
              <b>{count}</b>
            </button>
          );
        })}
      </div>
    </section>
  );
}

function Footer({ onOpenLicense }: { onOpenLicense: () => void }) {
  const store = useEditorStore();
  const scene = useScene();
  const [zoom, setZoom] = useState('');
  const [saveStatus, setSaveStatus] = useState('本地自动保存');

  useEffect(() => {
    const update = () => {
      const handle = scene.viewport();
      const view = handle?.view();
      const size = handle?.size();
      if (view && size) setZoom(`${Math.round((view.s / 40) * 100)}% · ${store.data.size.x}×${store.data.size.z}`);
    };
    update();
    const timer = setInterval(update, 200);
    return () => clearInterval(timer);
  }, [scene, store.data.size]);

  useEffect(() => {
    const timer = setTimeout(() => {
      let next: string;
      try {
        localStorage.setItem('endfield.blueprint.editor.v2', JSON.stringify(store.data));
        next = '已保存到本机';
      } catch {
        next = '自动保存不可用，请保存 JSON';
      }
      // Written from the timer callback rather than synchronously in the effect body.
      setSaveStatus(next);
    }, 300);
    return () => clearTimeout(timer);
  }, [store.data]);

  return (
    <footer>
      <span id="status" role="status" aria-live="polite" className={store.status.error ? 'error' : undefined}>
        {store.status.message}
      </span>
      <span id="zoom">{zoom}</span>
      <button id="btnFontLicense" onClick={onOpenLicense}>
        HarmonyOS Sans · 字体许可
      </button>
      <span id="saveStatus">{saveStatus}</span>
    </footer>
  );
}

/** Triggers a browser download for a generated blob. */
function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Sanitises a document name into a filesystem-safe stem. */
function fileStem(name: string): string {
  return (name || 'blueprint').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_');
}

async function handleImport(event: { target: HTMLInputElement }, store: ReturnType<typeof useEditorStore>) {
  const file = event.target.files?.[0];
  event.target.value = '';
  if (!file) return;
  try {
    if (file.size > 10 * 1024 * 1024) throw Error('JSON 文件过大');
    const parsed = JSON.parse(await file.text());
    const before = store.data;
    store.transact(
      draft => {
        const next = clone(parsed) as typeof before;
        draft.name = next.name;
        draft.size = next.size;
        draft.nodes = next.nodes;
        draft.conveyors = next.conveyors;
        draft.presentation = next.presentation;
      },
      `已导入 ${parsed?.nodes?.length ?? 0} 个设备`,
    );
    void before;
  } catch (error) {
    store.setStatus(`导入失败：${(error as Error).message}`, true);
  }
}

/** Re-exported so the public API module can share the same bounds helper without a cycle. */
export { bounds, hit };
export type { Product };
