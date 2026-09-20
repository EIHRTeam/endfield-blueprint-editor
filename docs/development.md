# 开发与发布说明

## 目录与构建过程

```text
src/                 Canvas 前端、图片合成与 HTML 打包源码
assets/              原始图片、字体及 UI 元数据
data/                配置、精简名称表、回退映射及输入哈希
examples/            三份可导入的示例 JSON
docs/                使用说明、显示边界及 README 预览图
scripts/             构建、校验、预览、测试、示例与发布入口
tests/               10 组逻辑和浏览器测试
.github/workflows/   CI 构建、测试与打包
dist/                离线 HTML 与中间 PNG（不提交）
reports/             构建报告、测试截图和日志（不提交）
release/             便携包、源码包与校验文件（不提交）
research/            本地逆向记录（不提交、不参与构建）
```

`scripts/build.py` 调用 `src/build_editor.py`，合成图片和展示数据，再将前端模板打包为 `dist/blueprint_editor.html`。前端由 `editor_core.js`、`editor_app.js`、`editor_presentation.js` 及两份 HTML 模板组成，无前端运行时依赖。

## 安装与命令

可先运行 `python -m venv .venv` 创建虚拟环境。Windows PowerShell 使用 `.venv\Scripts\Activate.ps1` 激活，macOS / Linux 使用 `source .venv/bin/activate`。

```sh
python -m pip install -r requirements.txt
python scripts/verify_inputs.py
python scripts/build.py
```

开发测试推荐 Node.js 24。若尚未安装 pnpm，可在安装 Node.js 后执行 `npm install --global pnpm@11.19.0`，再运行 `pnpm install --frozen-lockfile --ignore-scripts`。测试使用已安装的 Google Chrome；CI 使用 `pnpm exec playwright install --with-deps chrome` 安装浏览器和系统依赖。

| 命令 | 用途 |
| --- | --- |
| `pnpm build` | 从原始输入重新生成离线 HTML |
| `pnpm start` | 打开本地预览，仅监听 127.0.0.1 |
| `pnpm verify-inputs` | 验证输入素材和配置的 SHA-256 |
| `pnpm test` | 构建后运行 80 项检查 |
| `pnpm smoke` | 临时启动服务，运行 7 阶段完整 UI 流程并关闭服务 |
| `pnpm example` | 重新生成环境 / 接口示例 JSON 和截图 |
| `pnpm release` | 校验输入、重新构建并打包便携版 |

这些命令是 `package.json` 中的脚本别名，也可直接运行对应 Python / Node 文件。测试报告位于 `reports/test-results.json`、`reports/test-artifacts/` 和 `reports/live-workflow/`。示例生成器更新 `examples/environment_ports.json`，截图只写入 `reports/test-artifacts/`；README 图片需要挑选后手动更新。

若需检查已运行的预览，使用 `node scripts/smoke_live.cjs http://127.0.0.1:8769/blueprint_editor.html`，同样使用隔离的浏览器草稿。

## 素材与格式维护

- 素材更新后，只修改 `data/input_checksums.json` 中主动更新的文件哈希。Git 属性保留 `assets/`、`data/` 原始字节，避免换行转换破坏校验。
- `I18nTextTable_CN.json` 只保留建筑、物品与标签表引用的名称；新增表项时需一并加入其名称文本。
- 图标缺失与明确回退在 `data/icon_audit.json` 和 `data/building_item_fallbacks.json` 中记录，不用相邻编号图片代替缺图。
- JSON 的 `schemaVersion` 为 2，`presentation` 保存详情和取景。接口、环境条与物品状态都是手动显示设置，字段含义见[项目说明](project-notes.md)。
- 修改显示逻辑后重新构建、运行测试；端口检查使用独立 Pillow 合成器对照四向结果，完整 UI 流程核对 JSON 重新导入前后的 PNG 字节一致。

## 生成发布包

```sh
python scripts/build.py
pnpm test
pnpm smoke
python scripts/package_release.py --no-build
```

`--no-build` 使用刚刚验证过的 HTML；修改源码后应先重新构建。输出位于 `release/`：`endfield-blueprint-editor-版本号-portable.zip` 包含离线 HTML、使用与许可说明，`SHA256SUMS.txt` 保存本次生成 ZIP 的校验值。

如需额外的源码快照，确保 Git 已暂存需要发布的文件，再执行：

```sh
git add .
python scripts/package_release.py --no-build --source
```

源码包按当前项目的 Git 文件清单读取工作区内容，保留 `.github/` 等隐藏配置，不含 Git 历史、依赖、研究记录和生成物。更改版本时更新 `package.json` 的 `version`。打包脚本不创建远程仓库、不提交、不推送，也不自动发布 Release。

## 上传 GitHub

以本项目目录作为仓库根目录。提交源码和必要构建输入，便携 ZIP 可作为 GitHub Release 附件。GitHub 自动生成的 Source code ZIP 需要先构建。

新建空的 GitHub 仓库后，在本项目目录操作，将 `YOUR_NAME` 替换为实际账号：

```sh
git status
git add .
git diff --cached --stat
git commit -m "Initial blueprint editor"
git remote add origin https://github.com/YOUR_NAME/endfield-blueprint-editor.git
git push -u origin main
```

若已绑定 remote，使用现有地址。素材和字体的独立归属保留在 [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)；当前没有为项目自身代码选择开源许可证。

CI 使用官方 [checkout](https://github.com/actions/checkout)、[setup-python](https://github.com/actions/setup-python) 和 [pnpm/setup](https://github.com/pnpm/setup)。推送和 PR 触发验证；工作流不部署站点或发布 Release。
