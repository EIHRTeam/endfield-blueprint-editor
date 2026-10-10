/** Screenshot recognition is optional; importing a saved result also works on a static host. */
export function RecognitionDialog() {
  return (
    <dialog id="recognitionDialog" aria-labelledby="recognitionTitle">
      <div className="library-head">
        <div>
          <h2 id="recognitionTitle">截图 / 录屏识别 · 蓝图还原</h2>
          <p className="muted">
            选择同一张蓝图的截图或录屏，保留相邻画面的重叠区域。识别完成后导入编辑器，可对照原图直接修改。
          </p>
        </div>
        <button id="btnCloseRecognition">关闭</button>
      </div>
      <div className="recognition-scroll">
        <div className="fields recognition-source">
          <button id="btnChooseRecognitionFiles" hidden>
            选择截图或录屏…
          </button>
          <p id="recognitionDropHint" className="muted" hidden>
            也可以把截图、ZIP 或录屏文件直接拖到这个窗口里。最多 16 张图片或 1 个 ZIP（共 64 MiB），或单个录屏（最多 256
            MiB）。
          </p>
          <label id="recognitionFilesLabel">
            蓝图截图或录屏（最多 16 张图片 / 1 个 ZIP，共 64 MiB；或单个视频，最多 256 MiB）
            <input
              id="recognitionFiles"
              type="file"
              accept=".png,.jpg,.jpeg,.webp,.zip,.mp4,.mov,.webm,.mkv"
              multiple
            />
          </label>
          <p id="recognitionFileList" className="muted">
            尚未选择截图或录屏
          </p>
          <div className="row">
            <label>
              蓝图宽度（可选）
              <input id="recognitionWidth" type="number" min={1} max={50} step={1} placeholder="自动识别" />
            </label>
            <label>
              蓝图高度（可选）
              <input id="recognitionHeight" type="number" min={1} max={50} step={1} placeholder="自动识别" />
            </label>
          </div>
          <div id="recognitionService" className="fields">
            <label>
              本地识别服务地址
              <input id="recognitionEndpoint" type="url" defaultValue="http://127.0.0.1:8765" />
            </label>
            <p className="muted">
              在项目目录运行 <code>python scripts/ocr_server.py</code>，再开始识别。文件会发送到上方服务地址。
              也可通过命令行识别后，打开生成的 JSON 文件。
            </p>
          </div>
          <div className="recognition-actions">
            <button id="btnRecognize" disabled>
              开始识别
            </button>
            <button id="btnCancelRecognition" hidden>
              停止等待
            </button>
            <button id="btnOpenRecognitionJson">打开识别 JSON</button>
          </div>
          <div id="recognitionProgress" className="recognition-progress" hidden>
            <progress id="recognitionProgressBar" max={1} value={0} aria-labelledby="recognitionProgressText" />
            <span id="recognitionProgressText" className="muted" />
          </div>
          <p id="recognitionStatus" role="status" aria-live="polite">
            等待选择截图、录屏或识别 JSON
          </p>
        </div>
        <section id="recognitionResult" hidden>
          <h3>识别结果</h3>
          <p id="recognitionSummary" />
          <p className="muted">截图中被遮挡的细节可能无法确定。请结合原图核对设备、方向、物品图标与线路。</p>
          <div id="recognitionWarnings" hidden>
            <h3>识别得不太确定的地方</h3>
            <ul id="recognitionWarningList" />
          </div>
          <img id="recognitionPreview" alt="识别服务生成的蓝图拼接预览" hidden />
          <figure id="recognitionCoverage" hidden>
            <figcaption>画面覆盖范围</figcaption>
            <img id="recognitionCoveragePreview" alt="画面覆盖图：绿色已覆盖，黄色部分缺失，红色基本未拍到" />
            <CoverageLegend />
          </figure>
        </section>
      </div>
      <div className="recognition-actions recognition-foot">
        <button id="btnImportRecognition" disabled>
          导入编辑器（可撤销）
        </button>
        <button id="btnSaveRecognition" disabled>
          下载识别结果 JSON
        </button>
      </div>
      <label id="recognitionReplaceWarning" className="check recognition-replace" hidden>
        <input id="recognitionReplace" type="checkbox" />
        替换当前布局（可撤销）；请先保存需要保留的修改。
      </label>
      <input id="recognitionJsonFile" type="file" accept=".json,application/json" hidden />
    </dialog>
  );
}

/** Lives beside the editable canvas so comparing never traps the user inside a modal. */
export function RecognitionReviewPanel() {
  return (
    <section id="recognitionReviewPanel" hidden>
      <div className="review-heading">
        <h2>识别对照</h2>
        <button id="btnReviewClose" title="关闭对照：去掉原图和提示，只保留布局（可撤销）">
          关闭对照
        </button>
      </div>
      <p id="reviewProgress" role="status" aria-live="polite" />
      <label>
        对照方式
        <select id="reviewOverlayMode" defaultValue="overlay">
          <option value="overlay">叠加原图</option>
          <option value="reference">查看原图</option>
          <option value="layout">查看蓝图</option>
          <option value="coverage">查看覆盖范围</option>
        </select>
      </label>
      <label>
        原图透明度
        <input id="reviewOpacity" type="range" min={0} max={100} step={5} defaultValue={40} />
      </label>
      <p id="reviewImageStatus" className="muted">
        没有对照图；可选择识别输出中的 mosaic.png。
      </p>
      <div id="reviewCoverageLegend" hidden>
        <CoverageLegend />
      </div>
      <button id="btnReviewImage">选择拼接对照图</button>
      <input id="reviewImageFile" type="file" accept=".png,.jpg,.jpeg,.webp" hidden />
      <div id="reviewIssues" />
      <p id="reviewCurrent" className="muted" />
      <button id="btnReviewNext">下一处</button>
      <button id="btnSaveReview">另存识别结果（含原图）</button>
      <p id="reviewMessage" role="status" aria-live="polite" />
    </section>
  );
}

function CoverageLegend() {
  return (
    <div className="recognition-coverage-legend">
      <span>
        <i className="coverage-complete" />
        绿色：覆盖 ≥98%
      </span>
      <span>
        <i className="coverage-partial" />
        黄色：覆盖 10%–98%
      </span>
      <span>
        <i className="coverage-missing" />
        红色：覆盖 &lt;10%
      </span>
      <p>缺失画面不能视为空地。请补拍对应区域，或对照游戏手动补齐；右侧列表可定位缺失区域。</p>
    </div>
  );
}
