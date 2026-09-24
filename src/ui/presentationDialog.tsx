/**
 * The blueprint preview dialog.
 *
 * A transcription of the original project's `src/editor_presentation.html`, one element at a time and in
 * the original order — the same contract as `shell.tsx`. The dialog's own `<style>` block was hoisted
 * into the document head by the build and now lives in `src/styles.css`.
 *
 * `#presentationColors` and `#tagSuggestions` are the two containers the original filled from
 * JavaScript; they receive their children here as props.
 */

export function PresentationDialog() {
  return (
    <dialog id="presentationDialog" aria-labelledby="presentationTitle">
      <div className="presentation-head">
        <h2 id="presentationTitle">蓝图预览 · 编辑右侧详情</h2>
        <select id="presentationResolution" aria-label="完整预览分辨率" defaultValue="2560">
          <option value="1920">1920 px 宽</option>
          <option value="2560">2560 px 宽</option>
          <option value="3840">3840 px 宽</option>
        </select>
        <button id="btnExportPresentation">导出完整预览 PNG</button>
        <button id="btnApplyPresentation">应用并返回画布</button>
      </div>
      <div className="presentation-body">
        <div className="presentation-settings">
          <label>
            蓝图名称
            <input id="presentationName" maxLength={120} autoComplete="off" />
          </label>
          <label>
            创作者 ID
            <input id="presentationCreator" maxLength={40} placeholder="填写要展示的 ID" autoComplete="off" />
          </label>
          <label>
            标签
            <input id="presentationTags" placeholder="例如：装备，武陵" autoComplete="off" />
            <span className="muted">用逗号分隔，最多 6 个。</span>
          </label>
          <div id="tagSuggestions" aria-label="原版常用标签" />
          <label>
            蓝图描述（选填）
            <textarea id="presentationDescription" maxLength={400} placeholder="留空时不占用预览空间" />
          </label>
          <label>蓝图封面</label>
          <button id="btnChooseCover" className="presentation-cover">
            <img id="presentationCoverThumb" alt="封面物品" />
            <span>
              <b id="presentationCoverName" />
              <small>搜索 / 更换封面图标</small>
            </span>
          </button>
          <div id="coverPicker" hidden>
            <input id="coverSearch" type="search" aria-label="搜索封面图标" placeholder="搜索物品或设备名称 / ID" />
            <select id="coverScope" aria-label="封面图标分类" defaultValue="all">
              <option value="all">全部原图</option>
              <option value="device">设备</option>
              <option value="product">物品</option>
            </select>
            <div id="coverResults" className="cover-grid" />
            <button id="btnMoreCovers">显示更多</button>
          </div>
          <label>封面图纸底色</label>
          <div id="presentationColors" className="presentation-colors" aria-label="封面图纸底色" />
          <div className="presentation-auto">
            <b>图片尺寸</b>
            <p className="muted">按内容导出会完整显示布局，图片宽高随格数调整。</p>
          </div>
          <label>
            导出比例
            <select id="presentationSizing" defaultValue="content">
              <option value="content">按内容尺寸</option>
              <option value="fixed">固定画幅与取景</option>
            </select>
          </label>
          <label>
            每格像素
            <input id="presentationCell" type="number" min={8} max={256} step={1} defaultValue={64} />
          </label>
          <label>
            内容边距（格）
            <input id="presentationMargin" type="number" min={0} max={20} step={1} defaultValue={1} />
          </label>
          <div className="presentation-auto">
            <b>固定画幅取景</b>
            <p className="muted">选择固定画幅后，可在预览内滚轮缩放、拖动平移。</p>
          </div>
          <label>
            缩放 <span id="presentationZoomLabel">100%</span>
            <input id="presentationZoom" type="range" min={100} max={400} step={1} defaultValue={100} />
          </label>
          <label>
            水平位置
            <input id="presentationPanX" type="range" min={0} max={100} step={0.1} defaultValue={50} />
          </label>
          <label>
            垂直位置
            <input id="presentationPanY" type="range" min={0} max={100} step={0.1} defaultValue={50} />
          </label>
          <button id="btnResetViewport">完整显示布局</button>
          <label className="check">
            <input id="presentationChangeHints" type="checkbox" />
            显示更换图标角标
          </label>
          <label>
            暗管连接示意
            <select id="presentationConnectionPair" defaultValue="">
              <option value="">不显示连接光带</option>
            </select>
            <span className="muted">在画布中配对暗管后，可选择一对连接随图片导出。</span>
          </label>
          <div className="presentation-auto">
            <b>随布局自动生成</b>
            <div id="presentationAuto" />
            <div className="muted">设备清单按原版顺序排列。物流图标按原版隐藏数量。</div>
          </div>
        </div>
        <div className="presentation-stage">
          <canvas id="presentationCanvas" aria-label="包含右侧详情的完整蓝图预览" />
        </div>
      </div>
      <div className="presentation-foot">
        <span id="presentationMessage">修改会实时预览；应用后随蓝图 JSON 和本机草稿保存。</span>
        <span id="presentationError" role="alert" />
        <button id="btnCancelPresentation">取消修改</button>
      </div>
    </dialog>
  );
}
