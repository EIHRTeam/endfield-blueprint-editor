/**
 * Item icon library.
 *
 * A lazy chunk: the 864 product records and their badge thumbnails are only needed when the user
 * actually opens the picker, so none of this ships in the initial bundle.
 */
import { useMemo, useState } from 'react';
import type { Product } from '../../core/types';
import { productKey } from '../../render/paintScene';
import { useEditorStore } from '../../app/store';
import { useScene } from '../../app/SceneContext';

const PAGE_SIZE = 80;

/** Why a product record has no drawable icon; the reason is shown on the card. */
function reasonFor(product: Product): string {
  return product.iconStatus === 'empty_icon_configuration' ? '游戏表未配置图标' : '当前安装资源中无此图标';
}

export interface ItemLibraryProps {
  /** Device index to annotate, or -1 to arm the icon brush. */
  target: number;
  onClose: () => void;
}

export default function ItemLibrary({ target, onClose }: ItemLibraryProps) {
  const store = useEditorStore();
  const scene = useScene();
  const [term, setTerm] = useState('');
  const [scope, setScope] = useState('all');
  const [availability, setAvailability] = useState('available');
  const [limit, setLimit] = useState(PAGE_SIZE);

  const node = store.data.nodes[target] ?? null;
  const building = node ? store.buildings[node.templateId] : null;

  const options = useMemo(() => {
    const needle = term.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const source =
      scope === 'recommended'
        ? (building?.products ?? []).map(id => productKey(id) ?? id)
        : Object.keys(scene.products);
    return [...new Set(source)]
      .filter(id => {
        const product = scene.products[id];
        if (!product) return false;
        if (!needle.every(part => `${id} ${product.name}`.toLowerCase().includes(part))) return false;
        if ((availability === 'available' && !product.badge) || (availability === 'missing' && product.badge))
          return false;
        if (scope === 'solid' && product.phase !== 1) return false;
        if (scope === 'liquid' && product.phase !== 2) return false;
        if (scope === 'gas' && product.phase !== 4) return false;
        if (scope === 'environment' && !product.gas) return false;
        return true;
      })
      .toSorted((a, b) => scene.products[a]!.name.localeCompare(scene.products[b]!.name, 'zh-CN'));
  }, [term, scope, availability, building, scene.products]);

  const choose = (id: string | null) => {
    onClose();
    if (target >= 0) {
      store.transact(draft => {
        draft.nodes[target]!.productIcon = id;
      }, '设备属性已更新');
      return;
    }
    store.setIconBrush(id);
    store.setTool('icon');
    store.setStatus(`已选择 ${id ? scene.products[productKey(id) ?? '']?.name : '设备符号'}，点击设备标注`);
  };

  return (
    <dialog id="itemLibrary" aria-labelledby="libraryTitle" open>
      <div className="library-head">
        <div>
          <h2 id="libraryTitle">物品图标库</h2>
          <p id="libraryTarget" className="muted">
            {building ? `为「${building.name}」选择展示物品` : '浏览全部图标，选图后点击画布上的设备标注。'}
          </p>
        </div>
        <button id="btnCloseLibrary" aria-label="关闭物品图标库" onClick={onClose}>
          关闭 ×
        </button>
      </div>
      <div className="library-search">
        <input
          id="productSearch"
          type="search"
          aria-label="搜索物品图标"
          placeholder="搜索名称或 ID，例如：铁、铜、清水"
          value={term}
          autoFocus
          onChange={event => {
            setTerm(event.target.value);
            setLimit(PAGE_SIZE);
          }}
        />
        <select
          id="productScope"
          aria-label="物品分类"
          value={scope}
          onChange={event => {
            setScope(event.target.value);
            setLimit(PAGE_SIZE);
          }}
        >
          <option value="all">全部物品</option>
          <option value="recommended" disabled={!building}>
            当前设备产物
          </option>
          <option value="solid">固体物品</option>
          <option value="liquid">液体</option>
          <option value="gas">气体</option>
          <option value="environment">环境标记</option>
        </select>
        <select
          id="productAvailability"
          aria-label="图标状态"
          value={availability}
          onChange={event => {
            setAvailability(event.target.value);
            setLimit(PAGE_SIZE);
          }}
        >
          <option value="available">可用图标</option>
          <option value="missing">缺图记录</option>
          <option value="all">全部记录</option>
        </select>
      </div>
      <div className="library-bar">
        <span id="productCount" className="muted" role="status">
          找到 {options.length} 个 · 已显示 {Math.min(limit, options.length)}
        </span>
        <button id="btnClearProduct" onClick={() => choose(null)}>
          恢复设备符号
        </button>
      </div>
      <div id="productResults" className="product-grid" aria-label="物品搜索结果">
        {options.slice(0, limit).map(id => {
          const product = scene.products[id]!;
          const active = productKey(node?.productIcon) === id;
          return (
            <button
              key={id}
              className={`product-card${product.badge ? '' : ' missing'}`}
              data-product={id}
              style={active ? { borderColor: '#75c7df' } : undefined}
              title={`${product.name}\n${id}${
                product.badge
                  ? product.iconStatus === 'same_id_original_sprite'
                    ? '\n使用同名原图（表内未指定）'
                    : ''
                  : `\n${reasonFor(product)}`
              }`}
              disabled={!product.badge}
              onClick={() => choose(id)}
            >
              {product.badge ? (
                <img src={scene.assets.urlsFor(product.badge)} alt="" />
              ) : (
                <span className="missing-thumb">?</span>
              )}
              <span>{product.name}</span>
              {!product.badge && <small>{reasonFor(product)}</small>}
            </button>
          );
        })}
      </div>
      {!options.length && (
        <p id="productEmpty" className="muted">
          没有匹配的物品，试试缩短名称或切换到“全部物品”。
        </p>
      )}
      <button
        id="btnMoreProducts"
        hidden={options.length <= limit}
        onClick={() => setLimit(value => value + PAGE_SIZE)}
      >
        显示更多
      </button>
      <div className="library-foot muted">
        点击图片即可应用。未选中设备时，选图后在画布上点击设备标注。缺图记录可查看原因。
      </div>
    </dialog>
  );
}
