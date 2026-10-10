# 终末地蓝图编辑器 · Windows 桌面版

桌面版是一个本地程序，包含编辑器、截图识别和录屏识别。网页版只有编辑器：可以打开桌面版导出的识别 JSON，但不提供识别功能。

- 双击即可使用，不需要安装 Python、不需要运行命令，也不用填写服务地址。
- 截图和录屏只在本机处理，不会上传。
- 识别时可以切到其他窗口。关掉窗口前如果识别还没完成，程序会先询问。
- 编辑内容自动保存在 `%LOCALAPPDATA%\EndfieldBlueprintEditor`。卸载或升级时会保留这个文件夹；想彻底清除，手动删除它即可。

## 系统要求

- Windows 10 或 11，64 位
- Microsoft Edge WebView2 运行时：Windows 11 和更新过的 Windows 10 都已自带。如果缺少，程序会提示并打开微软的下载页面。
- 建议 8 GB 以上内存。在 8 核电脑上识别一段 10 秒的录屏约需 1 分钟，识别期间内存占用约 2 GB。

## 自己打包

需要在一台 Windows 电脑上打包。

### 1. 安装工具（只需一次）

| 工具 | 用途 | 下载 |
|---|---|---|
| Node.js 22.12 或更新版本 | 构建页面；自带的 corepack 会自动准备 pnpm | https://nodejs.org/ |
| Python 3.12（64 位） | 识别程序和打包。安装时勾选 “py launcher” | https://www.python.org/downloads/windows/ |
| Inno Setup 6 | 生成安装包；不装也可以，但只会生成免安装 ZIP | https://jrsoftware.org/isdl.php |

### 2. 运行打包脚本

在项目根目录打开 PowerShell，运行：

```powershell
powershell -ExecutionPolicy Bypass -File desktop\build_windows.ps1
```

第一次运行要下载依赖，大约需要 10–20 分钟；之后再打包约 5 分钟。脚本会依次：

1. 在 `.venv-desktop` 中创建独立的 Python 环境，并安装 [requirements.txt](requirements.txt) 中固定版本的依赖；
2. 构建桌面版页面（`dist-desktop`），并预先合成编辑器素材，所以程序打开时不需要再等素材；
3. 用 PyInstaller 打包；
4. 自检：启动打包好的程序，检查页面、识别素材、多进程、文字识别模型和视频解码都能用；
5. 在 `release\` 中生成：
   - `EndfieldBlueprintEditor-<版本>-setup.exe`：安装包。默认只为当前用户安装，不需要管理员权限；
   - `EndfieldBlueprintEditor-<版本>-portable.zip`：免安装版，解压后运行 `EndfieldBlueprintEditor.exe`。

可选参数：

- `-SkipInstaller`：只生成 ZIP；
- `-Clean`：删除打包环境后从头开始，依赖出问题时使用；
- `-Python "C:\Python312\python.exe"`：指定 Python，默认使用 `py -3.12`。

预计安装包约 150 MB，安装后约 350 MB。体积主要来自 OpenCV、文字识别模型和识别用的素材。

### 3. 发布新版本

修改 [app.py](app.py) 中的 `VERSION`，再重新打包。安装包会直接覆盖旧版本，编辑内容不受影响。

## 排查问题

- 程序日志：`%LOCALAPPDATA%\EndfieldBlueprintEditor\logs\app.log`。
- 检查识别组件：`EndfieldBlueprintEditor.exe --self-test 报告.json`，结果写入报告文件。
- 开发者工具：`EndfieldBlueprintEditor.exe --debug`，可以打开 WebView2 开发者工具。
- 不打开窗口、只启动服务：`EndfieldBlueprintEditor.exe --serve`，然后用浏览器访问 http://127.0.0.1:47615 。
- 程序固定使用 47615 端口，编辑内容和这个地址绑定。如果端口被其他软件占用，程序会改用 47616–47624；改用其他端口后，看不到之前自动保存的内容，关掉占用端口的软件再重新打开即可。
- 再次双击图标不会打开第二个程序，只会把已经打开的窗口切到前台。

## 开发时直接运行

不打包也可以运行，Linux 和 macOS 上同样可用于调试：

```bash
pnpm build:desktop                          # 构建 dist-desktop 并预合成素材
python desktop/app.py --serve               # 浏览器访问 http://127.0.0.1:47615
python desktop/app.py                       # 打开窗口（需要 pip install pywebview）
```
