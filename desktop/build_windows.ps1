<#
.SYNOPSIS
  打包终末地蓝图编辑器 Windows 桌面版：安装包 + 免安装 ZIP。

.DESCRIPTION
  在你自己的 Windows 10/11 x64 电脑上，于项目根目录运行：

      powershell -ExecutionPolicy Bypass -File desktop\build_windows.ps1

  需要：Node.js 22.12+（自带 corepack，用来启用 pnpm）、Python 3.12（64 位，python.org 安装版带 py 启动器）、
  Inno Setup 6（只有生成安装包时需要；没装会跳过安装包，只生成 ZIP）。
  产物在 release\ 目录。

.PARAMETER Python
  用来创建打包环境的 Python，默认 "py -3.12"。

.PARAMETER SkipInstaller
  只生成免安装 ZIP，不调用 Inno Setup。

.PARAMETER Clean
  删除打包用虚拟环境 .venv-desktop 和 build\desktop 后重新开始。
#>
param(
  [string]$Python = "py -3.12",
  [switch]$SkipInstaller,
  [switch]$Clean
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

function Step($text) { Write-Host "`n==> $text" -ForegroundColor Cyan }
function Fail($text) { Write-Host "`n打包失败：$text" -ForegroundColor Red; exit 1 }
function Run($exe, [string[]]$arguments) {
  & $exe @arguments
  if ($LASTEXITCODE -ne 0) { Fail "$exe $($arguments -join ' ') 退出码 $LASTEXITCODE" }
}

$Version = (Select-String -Path desktop\app.py -Pattern '^VERSION = "([0-9.]+)"').Matches[0].Groups[1].Value
$Venv = Join-Path $Root ".venv-desktop"
$VenvPython = Join-Path $Venv "Scripts\python.exe"
$Work = Join-Path $Root "build\desktop"
$AppDir = Join-Path $Work "dist\EndfieldBlueprintEditor"
$Release = Join-Path $Root "release"
Write-Host "终末地蓝图编辑器 桌面版 $Version" -ForegroundColor Green

if ($Clean) {
  Step "清理旧的打包环境"
  Remove-Item -Recurse -Force $Venv, $Work -ErrorAction SilentlyContinue
}

Step "检查工具"
if (-not [Environment]::Is64BitOperatingSystem) { Fail "需要 64 位 Windows。" }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Fail "找不到 Node.js，请安装 22.12 或更新版本：https://nodejs.org/" }
$nodeVersion = [version]((node --version).TrimStart("v"))
if ($nodeVersion -lt [version]"22.12") { Fail "Node.js 版本是 $nodeVersion，需要 22.12 或更新。" }
$pyParts = $Python -split " "
$pyExe = $pyParts[0]
$pyArgs = @($pyParts | Select-Object -Skip 1)
if (-not (Get-Command $pyExe -ErrorAction SilentlyContinue)) {
  Fail "找不到 $Python。请从 https://www.python.org/ 安装 Python 3.12（64 位），或用 -Python 指定，例如 -Python C:\Python312\python.exe"
}
$pyInfo = & $pyExe @pyArgs -c "import sys, struct; print('%d.%d %d' % (sys.version_info[0], sys.version_info[1], struct.calcsize('P') * 8))"
if ($LASTEXITCODE -ne 0) { Fail "无法运行 $Python。" }
Write-Host "Node.js $nodeVersion · Python $pyInfo"
if ($pyInfo -notmatch " 64$") { Fail "需要 64 位 Python。" }

$Iscc = $null
if (-not $SkipInstaller) {
  $candidates = @(
    (Get-Command ISCC.exe -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source),
    "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe",
    "$env:ProgramFiles\Inno Setup 6\ISCC.exe",
    "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe"
  ) | Where-Object { $_ -and (Test-Path $_) }
  $Iscc = $candidates | Select-Object -First 1
  if (-not $Iscc) {
    Write-Host "没有找到 Inno Setup 6，这次只生成免安装 ZIP。需要安装包请装 https://jrsoftware.org/isdl.php 后重新运行。" -ForegroundColor Yellow
  }
}

Step "准备 Python 打包环境（.venv-desktop）"
if (-not (Test-Path $VenvPython)) { Run $pyExe ($pyArgs + @("-m", "venv", $Venv)) }
Run $VenvPython @("-m", "pip", "install", "--disable-pip-version-check", "-q", "--upgrade", "pip")
Run $VenvPython @("-m", "pip", "install", "--disable-pip-version-check", "-q", "-r", "desktop\requirements.txt")

Step "安装前端依赖"
$env:COREPACK_ENABLE_DOWNLOAD_PROMPT = "0"
$pnpm = Get-Command pnpm -ErrorAction SilentlyContinue
if ($pnpm) { $pnpmExe = "pnpm"; $pnpmPrefix = @() } else { $pnpmExe = "corepack"; $pnpmPrefix = @("pnpm") }
Run $pnpmExe ($pnpmPrefix + @("install", "--frozen-lockfile"))

Step "构建桌面版页面（dist-desktop）"
Run $pnpmExe ($pnpmPrefix + @("exec", "vite", "build", "--mode", "desktop"))

Step "预先合成编辑器素材（约 1 分钟）"
Run $VenvPython @("scripts\prebake_desktop.py", "dist-desktop")

Step "打包程序（PyInstaller）"
Run $VenvPython @("-m", "PyInstaller", "--noconfirm", "--clean", "--log-level", "WARN",
  "--distpath", (Join-Path $Work "dist"), "--workpath", (Join-Path $Work "work"), "desktop\app.spec")
$Exe = Join-Path $AppDir "EndfieldBlueprintEditor.exe"
if (-not (Test-Path $Exe)) { Fail "PyInstaller 没有生成 $Exe" }

Step "自检：启动打包后的程序并读取页面"
$port = 47690
$smokeData = Join-Path $Work "smoke-data"
$env:BLUEPRINT_DESKTOP_DATA = $smokeData
$proc = Start-Process -FilePath $Exe -ArgumentList @("--serve", "--port", "$port") -PassThru -WindowStyle Hidden
Remove-Item Env:\BLUEPRINT_DESKTOP_DATA
try {
  $health = $null
  for ($i = 0; $i -lt 60 -and -not $health; $i++) {
    Start-Sleep -Milliseconds 500
    try { $health = Invoke-RestMethod -Uri "http://127.0.0.1:$port/health" -TimeoutSec 2 } catch { }
    if ($proc.HasExited) { break }
  }
  if (-not $health -or -not $health.desktop) {
    $log = Join-Path $smokeData "logs\app.log"
    if (Test-Path $log) { Get-Content $log -Tail 30 }
    Fail "打包后的程序没有正常启动。"
  }
  $page = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$port/" -TimeoutSec 5
  $baked = Invoke-WebRequest -UseBasicParsing -Method Head -Uri "http://127.0.0.1:$port/baked/prebaked.bin" -TimeoutSec 5
  if ($page.StatusCode -ne 200 -or $baked.StatusCode -ne 200) { Fail "页面或预合成素材读取失败。" }
  Write-Host "页面服务正常，版本 $($health.version)。"
} finally {
  if (-not $proc.HasExited) { Stop-Process -Id $proc.Id -Force }
}

Step "自检：识别组件（素材、多进程、文字识别模型、视频解码）"
$report = Join-Path $Work "self-test.json"
Remove-Item -Force $report -ErrorAction SilentlyContinue
$env:BLUEPRINT_DESKTOP_DATA = $smokeData
$test = Start-Process -FilePath $Exe -ArgumentList @("--self-test", "`"$report`"") -PassThru -Wait -WindowStyle Hidden
Remove-Item Env:\BLUEPRINT_DESKTOP_DATA
if (-not (Test-Path $report)) {
  $log = Join-Path $smokeData "logs\app.log"
  if (Test-Path $log) { Get-Content $log -Tail 30 }
  Fail "识别组件自检没有生成报告（退出码 $($test.ExitCode)）。"
}
$result = Get-Content -Raw -Encoding UTF8 $report | ConvertFrom-Json
if (-not $result.ok) { Write-Host $result.traceback; Fail "识别组件自检失败：$($result.error)" }
Write-Host ("识别组件正常：{0} 个工作进程，视频解码 {1}，用时 {2} 秒。" -f `
  $result.checks.sprites.workers, $result.checks.video.backend, $result.seconds)
Remove-Item -Recurse -Force $smokeData -ErrorAction SilentlyContinue

Step "生成免安装 ZIP"
New-Item -ItemType Directory -Force $Release | Out-Null
$Zip = Join-Path $Release "EndfieldBlueprintEditor-$Version-portable.zip"
Remove-Item -Force $Zip -ErrorAction SilentlyContinue
Compress-Archive -Path $AppDir -DestinationPath $Zip -CompressionLevel Optimal

if ($Iscc) {
  Step "生成安装包（Inno Setup）"
  Run $Iscc @("/Q", "/DAppVersion=$Version", "/DSourceDir=$AppDir", "/DOutputDir=$Release", "desktop\installer.iss")
}

Step "完成"
Get-ChildItem $Release -Filter "EndfieldBlueprintEditor-$Version-*" | ForEach-Object {
  "{0}  {1:N0} MB" -f $_.FullName, ($_.Length / 1MB)
}
$installed = (Get-ChildItem $AppDir -Recurse -File | Measure-Object Length -Sum).Sum
"安装后占用约 {0:N0} MB。" -f ($installed / 1MB)
