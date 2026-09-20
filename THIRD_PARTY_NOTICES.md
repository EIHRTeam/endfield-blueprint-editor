# 第三方内容说明

本项目是非官方的《明日方舟：终末地》蓝图制图工具，不代表游戏开发商或发行商。

## 游戏图片与配置

`assets/` 中的游戏图片、Sprite / prefab 元数据及 `data/` 中的游戏配置与名称来自本地游戏资源。资源内保留的游戏路径、对象 ID 和名称用于追溯来源，不是构建时访问的本机路径。相关权利归原权利人所有；本项目没有为这些内容授予额外许可。

离线站点会**按原始文件分发**这些图片与配置，并由浏览器在运行时读取。它们不会被内联为 base64，也不会被打进 JavaScript；项目自身代码的许可状态不改变第三方内容的权利归属。原始游戏脚本与逆向缓存不包含在源码仓库或发布包中。

## HarmonyOS Sans SC

- 字体分片：`assets/fonts/HarmonyOS_Sans_SC/*.woff2`（由 `cn-font-split` 按 unicode-range 切分，共 383 个分片）
- 样式表：`assets/fonts/HarmonyOS_Sans_SC/result.css`，构建时剥离其中的 `src:local(...)`，确保实际使用的是随包分片
- 原始许可：[LICENSE-update.txt](assets/fonts/LICENSE-update.txt)

字体及原始许可归各自权利人所有，使用条款以随附许可为准。网页底栏可以查看字体许可；发布包另附原始许可文件。字体文件未做裁剪或字形修改，仅做等价的格式切分。

## Pillow（WebAssembly）

- 文件：`pillow-<version>-cp<py>-cp<py>-pyemscripten_<abi>_wasm32.whl`
- 来源：Pyodide 官方包索引，通过 `pnpm vendor:pyodide` 下载
- 使用方式：不随源码仓库提交；`postinstall` 下载后与 `pyodide-lock.json` 中的 SHA-256 比对

## Pyodide

- 文件：`pyodide.mjs`、`pyodide.asm.mjs`、`pyodide.asm.wasm`、`python_stdlib.zip`、`pyodide-lock.json`
- 来源：npm 包 `pyodide`，版本由 `pnpm-lock.yaml` 锁定
- 使用方式：构建时复制到 `dist/pyodide/`，由浏览器在工作线程中加载

## 开发依赖

Vite、TypeScript、React、React Compiler、Playwright 等通过包管理器安装，不复制到源码仓库。各依赖适用其发行包随附的许可。

## 项目自身代码

当前尚未指定开源许可证，`package.json` 标记为 `UNLICENSED`。公开仓库本身不额外授予使用许可。后续若增加代码许可证，游戏资源和字体仍按以上说明单独处理。
