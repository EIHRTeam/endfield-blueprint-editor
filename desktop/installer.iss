; Inno Setup 6 script for the Windows desktop app. Compiled by desktop/build_windows.ps1:
;   ISCC.exe /DAppVersion=1.0.0 /DSourceDir=<PyInstaller output> /DOutputDir=<release> desktop\installer.iss

#ifndef AppVersion
  #define AppVersion "1.0.0"
#endif
#ifndef SourceDir
  #define SourceDir "..\build\desktop\dist\EndfieldBlueprintEditor"
#endif
#ifndef OutputDir
  #define OutputDir "..\release"
#endif
#define AppName "终末地蓝图编辑器"
#define AppExe "EndfieldBlueprintEditor.exe"

[Setup]
; Keep this id: upgrades replace the previous installation in place.
AppId={{6F0E3C1A-8F7B-4B52-9A3D-5D2C7E1B4A90}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher={#AppName}
DefaultDirName={autopf}\EndfieldBlueprintEditor
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
; Installs for the current user without administrator rights; the user may choose "all users".
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
OutputDir={#OutputDir}
OutputBaseFilename=EndfieldBlueprintEditor-{#AppVersion}-setup
SetupIconFile=app.ico
UninstallDisplayIcon={app}\{#AppExe}
UninstallDisplayName={#AppName}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
CloseApplications=yes
RestartApplications=no

[Languages]
#if FileExists(AddBackslash(CompilerPath) + "Languages\ChineseSimplified.isl")
Name: "chs"; MessagesFile: "compiler:Languages\ChineseSimplified.isl"
#else
Name: "en"; MessagesFile: "compiler:Default.isl"
#endif

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"

[InstallDelete]
; Remove files of the previous version (renamed hashed bundles, old sprites) before copying.
Type: filesandordirs; Name: "{app}\_internal"

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\{#AppName}"; Filename: "{app}\{#AppExe}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExe}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#AppExe}"; Description: "{cm:LaunchProgram,{#AppName}}"; Flags: nowait postinstall skipifsilent

; Layouts autosaved in the editor live in %LOCALAPPDATA%\EndfieldBlueprintEditor and are kept on
; uninstall, so reinstalling or upgrading never loses work.
