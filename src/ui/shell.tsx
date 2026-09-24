/**
 * The editor shell.
 *
 * This is a transcription of the original project's `src/editor_shell.html`, one element at a time and
 * in the original order. The markup is the specification: element names, `id`s, `class`es, attributes,
 * child order follow the template; editing and export controls extend that original shell.
 *
 * The only differences from the template are the ones a framework migration forces, and none of them
 * change what is rendered:
 *
 *   - `hidden` is expressed as a React boolean prop rather than a hand-toggled attribute, so the DOM
 *     attribute (empty string when true) is written by React instead of by `$('…').hidden = …`.
 *   - `<option selected>` is expressed as the `<select>`'s `defaultValue`, which is the React idiom for
 *     an uncontrolled select's initial selection, and produces the same `selected` attribute.
 *   - Dynamic containers (`#buildingList`, `#summaryList`, `#productResults`, `#portVisibility`,
 *     `#tagSuggestions`, `#presentationColors`) are rendered empty here and filled by their own
 *     components; the originals filled them with `replaceChildren()`.
 */
import type { ReactNode } from 'react';
import { PresentationDialog } from './presentationDialog';

/** Wraps a list of `<option>` elements in a select, keeping the template's option order. */
function Select(props: {
  id: string;
  ariaLabel?: string;
  defaultValue?: string;
  disabled?: boolean;
  value?: string;
  onChange?: (value: string) => void;
  children?: ReactNode;
}) {
  const { id, ariaLabel, children, value, onChange, ...rest } = props;
  return (
    <select
      id={id}
      {...(ariaLabel === undefined ? {} : { 'aria-label': ariaLabel })}
      {...(value === undefined ? {} : { value })}
      {...(onChange ? { onChange: event => onChange(event.target.value) } : {})}
      {...rest}
    >
      {children}
    </select>
  );
}

export interface ShellProps {
  /** Font licence text, shown verbatim in `#fontLicenseText`. */
  licence: string;
  /** `#loading` is hidden once the scene is prepared, exactly as the original did. */
  loadingHidden: boolean;
  /** Failure text the original wrote into `#loading` on a boot error. */
  loadingText?: string;
}

export function Shell({ licence, loadingHidden, loadingText }: ShellProps) {
  return (
    <>
      <header>
        <strong>终末地 · 蓝图</strong>
        <input id="bpName" aria-label="蓝图名称" defaultValue="未命名蓝图" maxLength={120} />
        <button id="btnUndo" title="Ctrl+Z">
          撤销
        </button>
        <button id="btnRedo" title="Ctrl+Y / Ctrl+Shift+Z">
          重做
        </button>
        <span className="grow" />
        <button id="btnDemo">示例</button>
        <button id="btnImport" title="打开 JSON，替换当前布局；可撤销">
          导入 JSON
        </button>
        <button id="btnMerge" title="将另一张蓝图放入当前布局">
          拼接蓝图
        </button>
        <button id="btnJson">保存 JSON</button>
        <button id="btnGamePreview">蓝图预览</button>
        <button id="btnPng">导出画布 PNG</button>
      </header>

      <main>
        <aside>
          <div className="sidehead">
            <input id="search" aria-label="搜索设备" placeholder="搜索设备名称或 ID" />
            <button id="btnItemLibrary">物品图标库 · 搜索 / 选择</button>
            <span className="muted" id="buildingCount" />
          </div>
          <div id="buildingList" />
          <div className="tools">
            <button data-tool="select" className="active">
              选择 / 移动 V
            </button>
            <button data-tool="region">框选区域 M</button>
            <button id="btnCopy" title="Ctrl+C / ⌘C">
              复制选区
            </button>
            <button id="btnPaste" title="Ctrl+V / ⌘V">
              粘贴选区
            </button>
            <button data-tool="place">放置设备 P</button>
            <button data-tool="item">传送带 B</button>
            <button data-tool="fluid">流体管 L</button>
            <button data-tool="erase">删除 E</button>
            <button id="btnClear" className="danger">
              清空布局
            </button>
          </div>
          <div className="help">
            <kbd>R</kbd> 旋转 · <kbd>Delete</kbd> 删除选中
            <br />
            拖动铺线 · <kbd>Shift</kbd> 切换转弯顺序
            <br />
            滚轮缩放 · 空格拖动 / 中键平移
            <br />
            框选后 <kbd>Ctrl+C</kbd> / <kbd>Ctrl+V</kbd>
            <br />
            连续点击粘贴 · <kbd>Esc</kbd> 结束
          </div>
        </aside>

        <section id="wrap">
          <canvas id="cv" tabIndex={0} aria-label="蓝图编辑画布" />
          <div id="viewTools">
            <button id="btnFit">适应布局 F</button>
            <button id="btnGrid">网格：开</button>
            <button id="btnPorts">端口标记：关</button>
            <button id="btnHints" title="显示原版更换图标按钮、暗管连接提示；同样用于 PNG">
              原版提示：开
            </button>
            <button id="btnInspector">设备属性</button>
          </div>
          <div id="canvasHint">从左侧选择设备，或导入布局开始编辑</div>
          <div id="loading" hidden={loadingHidden}>
            {loadingText ?? '正在准备蓝图素材…'}
          </div>
        </section>

        <aside id="properties">
          <button id="btnCloseInspector">收起属性</button>
          <h2>设备属性</h2>
          <div id="emptySelection" className="muted">
            点击设备查看属性，拖动可以移动位置。
          </div>
          <div id="selectionFields" className="fields" hidden>
            <div className="preview">
              <img id="selectedPreview" alt="选中设备" />
            </div>
            <div>
              <b id="selectedName" />
              <div id="selectedId" className="muted" />
              <div id="selectedSize" className="muted" />
            </div>
            <div className="row">
              <label>
                X 坐标
                <input id="nodeX" type="number" min={0} step={1} />
              </label>
              <label>
                Z 坐标
                <input id="nodeZ" type="number" min={0} step={1} />
              </label>
            </div>
            <label>
              朝向
              <Select id="nodeDirection" defaultValue="0">
                <option value="0">0°</option>
                <option value="1">90°</option>
                <option value="2">180°</option>
                <option value="3">270°</option>
              </Select>
            </label>
            <div className="fields">
              <span id="productLabel">展示物品</span>
              <button id="btnChooseProduct" className="item-choice">
                <img id="selectedProductImage" alt="" />
                <span>
                  <b id="selectedProductName">设备符号</b>
                  <small>搜索 / 更换物品图标</small>
                </span>
              </button>
              <div id="productHelp" className="muted">
                图标会随蓝图和 PNG 一起保存。
              </div>
            </div>
            <div id="undergroundFields" className="fields" hidden>
              <label>
                暗管配对
                <Select id="undergroundPeer" ariaLabel="暗管配对" />
              </label>
              <button id="btnConnection">查看连接</button>
              <div className="muted">连接线用于标注暗管的配对关系。</div>
            </div>
            <label>
              接口显示
              <Select id="nodePorts" defaultValue="all">
                <option value="all">全部接口</option>
                <option value="normal">仅物品接口</option>
              </Select>
            </label>
            <label>
              环境生效标记
              <Select id="nodeEnvironment" defaultValue="">
                <option value="">无标记</option>
                <option value="stable">稳定环境 · 蓝色</option>
                <option value="xiranite">息壤环境 · 绿色</option>
                <option value="acid">酸性环境 · 黄色</option>
                <option value="humidity">潮湿环境 · 白色</option>
                <option value="inactive">未生效 · 橙色</option>
              </Select>
            </label>
            <label>
              物品状态标记
              <Select id="nodeItemStatus" defaultValue="normal">
                <option value="normal">无状态角标</option>
                <option value="locked">锁定</option>
                <option value="limited">限时有效</option>
                <option value="expired">限时过期</option>
              </Select>
            </label>
            <label id="itemStatusColorField" hidden>
              限时角标颜色
              <input id="nodeItemStatusColor" type="color" defaultValue="#00ffff" />
            </label>
            <details id="portVisibilityFields">
              <summary>逐个设置接口</summary>
              <div id="portVisibility" className="fields" style={{ gap: '7px', padding: '10px 0' }} />
              <button id="btnResetPorts">恢复全部接口</button>
              <p className="muted">取消勾选可隐藏该接口；旋转时设置随设备保留。</p>
            </details>
            <div id="nodeWarning" className="muted" />
            <button id="btnDeleteNode" className="danger">
              删除选中设备
            </button>
          </div>
          <section id="summary">
            <h2>
              设备一览 <span id="nodeCount" className="muted" />
            </h2>
            <div id="summaryList" />
          </section>
          <section id="materials">
            <h2>建造材料</h2>
            <p className="muted">按设备直接制造配方汇总，未扣除已有库存。</p>
            <div id="materialsList" />
            <p id="materialsWarning" className="muted" />
            <button id="btnCopyMaterials">复制材料清单</button>
          </section>
        </aside>
      </main>

      <dialog id="itemLibrary" aria-labelledby="libraryTitle">
        <div className="library-head">
          <div>
            <h2 id="libraryTitle">物品图标库</h2>
            <p id="libraryTarget" className="muted" />
          </div>
          <button id="btnCloseLibrary" aria-label="关闭物品图标库">
            关闭 ×
          </button>
        </div>
        <div className="library-search">
          <input
            id="productSearch"
            type="search"
            aria-label="搜索物品图标"
            placeholder="搜索名称或 ID，例如：铁、铜、清水"
          />
          <Select id="productScope" ariaLabel="物品分类" defaultValue="all">
            <option value="all">全部物品</option>
            <option value="recommended">当前设备产物</option>
            <option value="solid">固体物品</option>
            <option value="liquid">液体</option>
            <option value="gas">气体</option>
            <option value="environment">环境标记</option>
          </Select>
          <Select id="productAvailability" ariaLabel="图标状态" defaultValue="available">
            <option value="available">可用图标</option>
            <option value="missing">缺图记录</option>
            <option value="all">全部记录</option>
          </Select>
        </div>
        <div className="library-bar">
          <span id="productCount" className="muted" role="status" />
          <button id="btnClearProduct">恢复设备符号</button>
        </div>
        <div id="productResults" className="product-grid" aria-label="物品搜索结果" />
        <p id="productEmpty" className="muted" hidden>
          没有匹配的物品，试试缩短名称或切换到“全部物品”。
        </p>
        <button id="btnMoreProducts" hidden>
          显示更多
        </button>
        <div className="library-foot muted">
          点击图片即可应用。未选中设备时，选图后在画布上点击设备标注。缺图记录可查看原因。
        </div>
      </dialog>

      <dialog id="fontLicenseDialog" aria-labelledby="fontLicenseTitle">
        <div className="library-head">
          <h2 id="fontLicenseTitle">HarmonyOS Sans 字体许可</h2>
          <button id="btnCloseFontLicense">关闭</button>
        </div>
        <pre id="fontLicenseText">{licence}</pre>
      </dialog>

      <PresentationDialog />

      <dialog id="canvasExportDialog" aria-labelledby="canvasExportTitle">
        <div className="library-head">
          <h2 id="canvasExportTitle">导出画布 PNG</h2>
          <button id="btnCloseCanvasExport">关闭</button>
        </div>
        <div className="fields" id="exportOptions">
          <label>
            导出范围
            <Select id="exportRange" defaultValue="content">
              <option value="content">内容范围</option>
              <option value="canvas">整个蓝图画布</option>
            </Select>
          </label>
          <div className="row">
            <label>
              每格像素
              <input id="exportScale" type="number" min={8} max={256} step={1} defaultValue="64" />
            </label>
            <label>
              内容边距（格）
              <input id="exportMargin" type="number" min={0} max={20} step={1} defaultValue="1" />
            </label>
          </div>
          <label className="check">
            <input id="transparent" type="checkbox" />
            透明背景（不含标题）
          </label>
          <p className="muted">图片比例随内容格数变化；边距设为 0 可紧贴设备与线路范围。</p>
          <p id="canvasExportError" className="error" role="status" />
          <button id="btnConfirmCanvasExport">下载 PNG</button>
        </div>
      </dialog>

      <footer>
        <span id="status" role="status" aria-live="polite">
          就绪
        </span>
        <span id="zoom" />
        <button id="btnFontLicense">HarmonyOS Sans · 字体许可</button>
        <span id="saveStatus">本地自动保存</span>
      </footer>

      <input id="fileIn" type="file" accept=".json,application/json" />
      <input id="mergeFileIn" type="file" accept=".json,application/json" hidden />
    </>
  );
}
