/** Bootstrap progress and failure screens. */
export function LoadingScreen({ message, ratio }: { message: string; ratio: number }) {
  return (
    <div id="loading-screen" role="status" aria-live="polite">
      <div className="loading-card">
        <h1>终末地 · 蓝图编辑器</h1>
        <p>{message}</p>
        <div className="loading-bar" aria-hidden="true">
          <span style={{ width: `${Math.round(Math.max(0.02, ratio) * 100)}%` }} />
        </div>
        <p className="muted">首次打开需要用 WebAssembly 中的 Pillow 合成素材，请保持页面打开。</p>
      </div>
    </div>
  );
}

export function BakeError({ message }: { message: string }) {
  return (
    <div id="loading-screen" role="alert">
      <div className="loading-card">
        <h1>素材准备失败</h1>
        <p className="error">{message}</p>
        <p className="muted">请确认页面是通过 HTTP 提供的（不能用 file:// 直接打开），然后刷新重试。</p>
      </div>
    </div>
  );
}
