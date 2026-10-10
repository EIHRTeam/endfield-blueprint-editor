# PyInstaller spec for the Windows desktop app. Run through desktop/build_windows.ps1, which builds
# dist-desktop/ (page + prebaked sprites) first.
# -*- mode: python ; coding: utf-8 -*-
from pathlib import Path

import re

from PyInstaller.utils.hooks import collect_data_files, collect_dynamic_libs, collect_submodules

ROOT = Path(SPECPATH).resolve().parent
VERSION = re.search(r'^VERSION = "([0-9.]+)"', (ROOT / "desktop/app.py").read_text("utf-8"), re.M).group(1)
numbers = tuple(int(n) for n in (VERSION.split(".") + ["0"] * 4)[:4])
version_file = ROOT / "build/desktop/version_info.txt"
version_file.parent.mkdir(parents=True, exist_ok=True)
strings = {"CompanyName": "Endfield Blueprint Editor", "FileDescription": "终末地蓝图编辑器",
           "FileVersion": VERSION, "InternalName": "EndfieldBlueprintEditor",
           "OriginalFilename": "EndfieldBlueprintEditor.exe", "ProductName": "终末地蓝图编辑器",
           "ProductVersion": VERSION}
version_file.write_text(f"""VSVersionInfo(
  ffi=FixedFileInfo(filevers={numbers}, prodvers={numbers}, mask=0x3f, flags=0x0, OS=0x40004,
                    fileType=0x1, subtype=0x0, date=(0, 0)),
  kids=[StringFileInfo([StringTable('080404b0', [{", ".join(f"StringStruct({k!r}, {v!r})" for k, v in strings.items())}])]),
        VarFileInfo([VarStruct('Translation', [0x0804, 1200])])]
)
""", "utf-8")
WEB = ROOT / "dist-desktop"
if not (WEB / "baked/prebaked.json").is_file():
    raise SystemExit("dist-desktop/baked/prebaked.json is missing: build the desktop page and prebake first.")

hiddenimports = ["ocr_server"] + collect_submodules("ocr") + collect_submodules("webview")
datas = collect_data_files("rapidocr_onnxruntime") + collect_data_files("webview")
datas.append((str(ROOT / "desktop/app.ico"), "."))
binaries = collect_dynamic_libs("onnxruntime")

a = Analysis(
    [str(ROOT / "desktop/app.py")],
    pathex=[str(ROOT / "scripts")],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    excludes=["tkinter", "matplotlib", "IPython", "pytest", "PyQt5", "PyQt6", "PySide2", "PySide6"],
    noarchive=False,
)
pyz = PYZ(a.pure)
exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="EndfieldBlueprintEditor",
    icon=str(ROOT / "desktop/app.ico"),
    console=False,
    upx=False,
    version=str(version_file),
)
# The page, sprites and recognition templates. Pyodide is left out: the desktop page uses the
# sprites prebaked at build time and never starts the in-browser baker.
web = Tree(str(WEB), prefix="web", excludes=["pyodide", "__pycache__", "*.map", "_headers"])
coll = COLLECT(exe, a.binaries, a.datas, web, upx=False, name="EndfieldBlueprintEditor")
