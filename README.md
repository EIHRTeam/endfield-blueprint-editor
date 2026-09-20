# 终末地蓝图编辑器

离线的《明日方舟：终末地》蓝图制图工具。摆放设备、连接传送带和管道、标记物品，并导出带自动设备清单的蓝图预览图片。

![蓝图预览示例](docs/images/preview.png)

这是非官方的静态制图工具，不模拟生产、过滤、供电或账号解锁。保存的 JSON 是本工具的布局文件，不是游戏分享码。

## 运行方式

这是一个纯前端应用，部署到 Cloudflare Pages，也可以完全在本机运行。**它必须通过 HTTP 打开，不能双击 `index.html`**：应用以多 chunk 的 ES module 分发，并在浏览器内加载 WebAssembly 运行时，`file://` 协议下模块加载与数据请求都会被浏览器拒绝。

```sh
pnpm install     # 同时会下载并校验 Pyodide 运行时与 Pillow wheel
pnpm dev         # 开发服务器
pnpm build       # 类型检查 + 构建 + 部署形态检查
pnpm preview     # 预览构建产物
```

### 首次打开需要合成素材

游戏原始素材是 PNG 与配置表，编辑器需要的设备贴图、物品徽标和界面精灵由 **Pyodide 中的 Pillow（WebAssembly）在浏览器里实时合成**。因此：

- 首次打开需要几十秒到几分钟（取决于机器），页面会显示进度；
- 合成结果会写入 IndexedDB 缓存，之后再次打开会很快；
- 素材或合成逻辑变化时缓存键会改变，会自动重新合成；
- 不再需要 Python、构建期图片脚本或游戏安装。

## 部署到 Cloudflare Pages

仓库已包含 `wrangler.jsonc` 与 `public/_headers`：

| 配置项    | 值           |
| --------- | ------------ |
| 构建命令  | `pnpm build` |
| 输出目录  | `dist`       |
| Node 版本 | 22.12 或更高 |

产物约 1,570 个文件、最大单文件 9.15 MiB（`pyodide.asm.wasm`），满足 Cloudflare Pages 每站点 20,000 文件与单文件 25 MiB 的上限。`pnpm build` 末尾的 `pnpm verify:dist` 会强制校验这些限制，以及「多 chunk」与「无任何内联资产」两条硬性约束。

发布包也可以用 `node scripts/package_release.mjs` 生成到 `release/`。

## 命令

| 命令                  | 用途                                                     |
| --------------------- | -------------------------------------------------------- |
| `pnpm dev`            | 开发服务器，静态素材由中间件直接从仓库提供               |
| `pnpm build`          | 类型检查、构建，并校验 chunk 形态、内联情况与 Pages 限额 |
| `pnpm test`           | 逻辑回归与浏览器验收套件                                 |
| `pnpm typecheck`      | 只做类型检查                                             |
| `pnpm verify:inputs`  | 校验 `assets/` 与 `data/` 的 1531 项输入哈希             |
| `pnpm verify:dist`    | 只跑部署形态检查                                         |
| `pnpm vendor:pyodide` | 重新下载并校验 Pyodide 运行时与 Pillow wheel             |
| `pnpm release`        | 构建并打包发布包                                         |

## 项目结构

```text
index.html          Vite 入口
src/
  core/             纯布局逻辑，无 DOM、无 React；可由 Node 直接测试
  render/           Canvas 绘制：编辑器与 PNG 导出共用同一套绘制代码
  bake/             Pyodide worker、JS↔Python 桥接、协议类型
    python/         运行时加载的 .py 合成逻辑（不参与打包）
  features/         编辑器、物品图标库、蓝图预览（后两者是懒加载 chunk）
  app/              状态、引导流程、字体、缓存、公共 API
assets/ data/       游戏原始素材与配置表（构建时按原路径复制）
examples/           可导入的示例 JSON
scripts/            构建插件、Pyodide 供应商脚本、部署校验、测试运行器与打包
tests/              逻辑回归、浏览器验收、构建形态三套测试
vendor/             下载并校验后的 Pyodide 与 Pillow（不入库）
dist/               构建产物（不入库）
```

设计要点：

- **编辑器与导出共用 `paintScene`**，所以画布所见即 PNG 所得。
- **`src/core/` 与 `src/render/` 不依赖 React**，因此可以在 Node 里直接做回归测试。
- **图片、JSON、`.wasm`、`.py` 一律外置为独立文件**，禁止 base64 内联或把数据打进 JavaScript；`pnpm verify:dist` 会扫描全部脚本与样式来拦截回归。
- **React Compiler 已开启**，UI 组件自动记忆化；命令式的 Canvas 代码不在其编译范围内。
- **静态检查是构建门禁**：oxlint 与 oxfmt 必须无报错才能通过 `pnpm build`。

## 功能与操作

- 112 个建筑表条目、8 类物流节点；四向建筑图片按原始部件合成。
- 864 条可搜索的物品 / 环境记录；支持设备、仓库口、物品准入口和管道准入口的手动标注。
- 传送带、管道、逐口显示、地下管道配对及静态连接效果。
- 5 种环境生效条，以及锁定、限时有效、过期等手动状态标记。
- 自动生成右侧四列设备清单，支持编辑详情、缩放取景、PNG 导出及 JSON 往返保存。
- 原始 UI 图片与 HarmonyOS Sans SC 字体分片；导出前会等待字体加载完成。

| 操作               | 用法                                    |
| ------------------ | --------------------------------------- |
| 选择、移动         | V；点击或拖动已有设备                   |
| 旋转               | R；拖动期间也可旋转                     |
| 传送带、管道       | B / L；拖动铺设，Shift 切换转弯顺序     |
| 物品标记           | 选中设备，在物品库搜索名称或 ID；或按 I |
| 环境条、状态与接口 | 选中设备，在右侧属性中设置              |
| 完整预览           | 顶部「蓝图预览」；滚轮缩放、拖动取景    |
| 撤销、重做         | Ctrl+Z / Ctrl+Y                         |
| 保存布局           | Ctrl+S 或「保存 JSON」                  |
| 编辑画布平移、缩放 | 空格拖动 / 中键；滚轮                   |

可导入的示例：基础布局 [demo_blueprint.json](examples/demo_blueprint.json)、环境条与接口 [environment_ports.json](examples/environment_ports.json)、暗管效果 [native_effects.json](examples/native_effects.json)。

仍有 29 条物品缺图、20 个特殊设备缺少大号底纹；部分装饰由 Canvas 近似绘制，动态 shader 效果没有完整复刻。详细边界见[显示层复核](docs/display-audit.md)与[缺图记录](docs/missing-icons.md)。
