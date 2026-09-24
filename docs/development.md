# 开发与发布说明

## 目录与构建过程

```text
index.html           Vite 入口（无挂载节点：React 直接渲染到 body，与原版一致）
src/                 前端源码
  core/              纯布局逻辑：校验、几何、寻路、暗管配对、历史（无 DOM、无 React）
  render/            Canvas 绘制与资源缓存
  bake/              Pyodide worker、JS↔Python 桥接、消息协议
    python/          运行时由 Pyodide 加载的 .py 合成逻辑（不参与打包）
  ui/                原版前端的逐行转写
    shell.tsx          editor_shell.html 的标记转写
    presentationDialog.tsx  editor_presentation.html 的标记转写
    editor.ts          editor_app.js 的状态与方法
    dom.ts             editor_app.js 各 refresh*/build* 函数的 DOM 写回
    wiring.ts          editor_app.js 底部的事件注册
    presentation.ts / presentationPaint.ts  editor_presentation.js 的逻辑与绘制
    api.ts             window.BlueprintEditor / BlueprintPresentation
  app/               引导、字体、IndexedDB 缓存
assets/              原始图片、字体分片及 UI 元数据
data/                配置、精简名称表、回退映射及输入哈希
examples/            三份可导入的示例 JSON
public/_headers      Cloudflare Pages 缓存与安全响应头
docs/                使用说明、显示边界及 README 预览图
scripts/             构建插件、Pyodide 供应商脚本、部署校验、测试运行器与打包
tests/               逻辑回归、浏览器验收、构建形态三套测试
.github/workflows/   CI 构建、测试与打包
vendor/              下载并校验后的 Pyodide 与 Pillow wheel（不提交）
dist/                构建产物（不提交）
reports/             测试截图、报告与中间产物（不提交）
release/             站点包、源码包与校验文件（不提交）
research/            本地逆向记录（不提交、不参与构建）
```

构建分两步：

1. `scripts/vendor_pyodide.mjs`（`postinstall`）从 `node_modules/pyodide` 复制 Pyodide 运行时，
   从 Pyodide 包索引下载 Pillow wheel，并逐文件与 `pyodide-lock.json` 中的 SHA-256 比对。
2. `vite build` 产出多 chunk 的 ES module 应用；构建插件
   （`scripts/static_assets_plugin.mjs`、`scripts/manifest_plugin.mjs`）把素材、`.py` 与
   Pyodide 运行时复制进 `dist/`，同时剥离字体 CSS 中的 `src:local(...)` 并生成
   `assets-manifest.json`。

**精灵合成不在构建期发生。** 浏览器启动时，Pyodide 中的 Pillow 读取原始素材合成设备贴图、
物品徽标与界面精灵，结果写入 IndexedDB 缓存；缓存键由 Pyodide 版本、`.py` 源码摘要与素材清单
共同决定，任一变化都会触发重新合成。

## 安装与命令

需要 Node.js 22.12 或更高（Vite 8 的要求），推荐 Node 24。若尚未安装 pnpm，可执行
`npm install --global pnpm@11.19.0`。

```sh
pnpm install          # 同时下载并校验 Pyodide 与 Pillow
pnpm typecheck
pnpm lint
pnpm format:check
pnpm build
pnpm dev              # 开发服务器；静态素材由中间件直接从仓库提供
```

| 命令                  | 用途                                                         |
| --------------------- | ------------------------------------------------------------ |
| `pnpm dev`            | 开发服务器                                                   |
| `pnpm build`          | 类型检查、构建，并校验 chunk 形态、内联情况与 Pages 限额     |
| `pnpm test`           | 运行三套测试：`core-logic`、`bundle-shape`、`editor-browser` |
| `pnpm typecheck`      | 只做类型检查（应用与 Vite 配置两个 project）                 |
| `pnpm verify:inputs`  | 校验 1532 项素材与配置文件的 SHA-256                         |
| `pnpm verify:dist`    | 只跑部署形态检查                                             |
| `pnpm vendor:pyodide` | 重新下载并校验 Pyodide 运行时与 Pillow wheel                 |
| `pnpm release`        | 构建并打包站点包（可选源码包）                               |

测试使用已安装的 Google Chrome；CI 使用 `pnpm exec playwright install --with-deps chrome` 安装浏览器。

### 静态检查门禁

`pnpm build` 依次执行四个门禁，任一失败即中止：**TypeScript 类型检查 → oxlint → oxfmt 格式检查 →
构建与部署形态校验**。CI 直接跑 `pnpm build`，因此四道门禁都会生效。

`oxlint` 配置见 `.oxlintrc.json`：

- 开启 `correctness`、`suspicious`、`perf` 三个类别，以及 react / import / jsx-a11y / unicorn /
  typescript / oxc 插件。
- `scripts/` 与 `tests/` 作为 Node CLI 放宽：允许 `console` 与顺序 `await`，这两者正是命令行工具的
  职责。
- 少量规则被显式关闭，原因写在配置注释里（例如 `unicorn/prefer-add-event-listener`：IDBRequest 与
  `Image` 的 `onX` 属性是这些 API 的惯用写法，没有事件目标可绑定）。
- `react/immutability` 降为 warn：React Compiler 无法对命令式画布建模，`CanvasStage` 会有 4 条提示，
  属于预期。

`oxfmt` 配置见 `.oxfmtrc.json`，与既有代码风格对齐（单引号、120 列、`arrowParens: "avoid"`）。
两个工具自身的配置文件不参与格式化，避免 `pnpm format` 反复改写它们。

### DOM 保真门禁（`dom-parity`）

界面基于原版迁移，后续功能已加入框选、拼接、材料统计与内容范围导出。
`tests/dom-parity.test.mjs` 比较构建后稳定 DOM 与已审阅的 `tests/fixtures/dom-baseline.json`，
同时检查关键布局、原生对话框与静态属性。原始模板推导逻辑仍保留用于历史迁移审计。

主动修改界面后先检查布局及交互，再更新当前基准：

```sh
pnpm build
node scripts/build_dom_baseline.mjs --current
pnpm test
```

测试默认使用 Chrome。也可设置 `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` 指向已有 Chromium。
纯逻辑测试覆盖几何、寻路、配对、历史、选区复制、拼接、导出尺寸和材料汇总；浏览器测试覆盖实际
画布操作、PNG 生成、保存往返与 IndexedDB 缓存。新增功能必须有行为断言，不能仅依赖 DOM 快照。

## 素材与格式维护

- 素材更新后，只修改 `data/input_checksums.json` 中主动更新的文件哈希。Git 属性保留 `assets/`、
  `data/` 原始字节，避免换行转换破坏校验。
- `I18nTextTable_CN.json` 只保留建筑、物品与标签表引用的名称；新增表项时需一并加入其名称文本。
- 图标缺失与明确回退在 `data/icon_audit.json` 和 `data/building_item_fallbacks.json` 中记录，
  不用相邻编号图片代替缺图。
- JSON 的 `schemaVersion` 为 2，`presentation` 保存详情和取景。接口、环境条与物品状态都是手动
  显示设置，字段含义见[项目说明](project-notes.md)。
- 修改显示逻辑后重新构建并运行测试；浏览器套件会对照固定素材验证导出尺寸与文档往返一致性。

### 硬性约束

以下几条由构建与测试强制，不要绕过：

- **禁止内联**：图片、字体、JSON、`.wasm`、`.py` 一律作为独立文件分发。`assetsInlineLimit` 为
  `0`，并且 `verify:dist` 会扫描所有脚本与样式，出现 `data:` 载荷即构建失败。
- **禁止单文件构建**：产物必须多于一个 JS chunk，且每个 chunk 小于 450 kB。
- **字体 `src:local` 必须剥离**：否则装有 HarmonyOS Sans 的机器会改用系统字体，静默改变预览与
  导出结果。
- **`.py` 不得被打包**：它们经 `assets-manifest.json` 由 worker 以独立文件写入 Pyodide 的
  内存文件系统。
- **oxlint 与 oxfmt 必须无报错**：两者都是 `pnpm build` 的一部分。新增规则抑制时请在配置注释里写明
  理由，不要在源码里堆散落的 disable。
- **界面变更需明确更新快照**：保留既有操作和布局一致性，审阅新增界面后更新 DOM 基准并验证行为。

## 部署到 Cloudflare Pages

仓库已包含 `wrangler.jsonc`（构建命令 `pnpm build`，输出目录 `dist`）与 `public/_headers`。
`pnpm build` 末尾的 `pnpm verify:dist` 会预先校验 Pages 限额：

- 每站点 20,000 个文件（当前约 1,570 个）
- 单个文件 25 MiB（当前最大 9.15 MiB，即 `pyodide.asm.wasm`）

因此 `assets/fonts/HarmonyOS_Sans_SC.ttf`（19.66 MiB）不参与分发，字体以 383 个 woff2 分片提供。

`.wasm` 必须由托管方返回 `Content-Type: application/wasm`。若缺失，`WebAssembly.instantiateStreaming`
会失败并静默回退到 `ArrayBuffer` 实例化（更慢但不报错）。Cloudflare Pages 默认按扩展名推断，部署后
可用 `curl -I` 抽查：

```sh
curl -sI https://<your-site>/pyodide/pyodide.asm.wasm | grep -i content-type
```

本地预览站点包：

```sh
node scripts/package_release.mjs --no-build
cd /tmp && unzip -q <project>/release/endfield-blueprint-editor-<version>-site.zip -d site
cd site && python -m http.server 8769
```

## 生成发布包

```sh
pnpm build
pnpm test
node scripts/package_release.mjs --no-build
```

输出位于 `release/`：`endfield-blueprint-editor-版本号-site.zip` 含完整站点与使用说明，
`SHA256SUMS.txt` 保存本次生成 ZIP 的校验值。ZIP 使用固定时间戳，相同输入可产生一致字节。

如需额外的源码快照，确保 Git 已暂存需要发布的文件，再执行：

```sh
git add .
node scripts/package_release.mjs --no-build --source
```

源码包按 Git 文件清单读取工作区，保留 `.github/` 等隐藏配置，不含 Git 历史、依赖、生成物与
`vendor/`。更改版本时更新 `package.json` 的 `version`。打包脚本不创建远程仓库、不提交、不推送，
也不自动发布 Release。

## 上传 GitHub

以本项目目录作为仓库根目录。

```sh
git status
git add .
git diff --cached --stat
git commit -m "Refactor to a pure frontend Pyodide app"
git remote add origin https://github.com/YOUR_NAME/endfield-blueprint-editor.git
git push -u origin main
```

素材和字体的独立归属保留在 [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)；当前没有为项目
自身代码选择开源许可证。

CI 使用官方 [checkout](https://github.com/actions/checkout) 与 [pnpm/setup](https://github.com/actions/setup)。
工作流不部署站点或发布 Release，也不安装 Python：烘焙已完全移入浏览器。
