; Harbor Windows installer (NSIS).
;
; Compiled with native `makensis` (works on Linux, no wine), turning the
; packaged release/win-unpacked app into a per-user Setup.exe with Start Menu /
; Desktop shortcuts and an uninstaller. Pass SRCDIR, OUTFILE, VERSION with -D.
Unicode true

!include "MUI2.nsh"

!ifndef SRCDIR
  !define SRCDIR "..\release\win-unpacked"
!endif
!ifndef OUTFILE
  !define OUTFILE "..\release\Harbor-Setup.exe"
!endif
!ifndef VERSION
  !define VERSION "0.1.0"
!endif
!ifndef ICONFILE
  !define ICONFILE "icon.ico"
!endif

!define APPNAME "Harbor"
!define PUBLISHER "Harbor contributors"
!define UNINSTKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APPNAME}"

Name "${APPNAME}"
OutFile "${OUTFILE}"
; Per-user install location — no administrator rights required.
InstallDir "$LOCALAPPDATA\Programs\${APPNAME}"
InstallDirRegKey HKCU "Software\${APPNAME}" "InstallDir"
RequestExecutionLevel user
SetCompressor /SOLID lzma
BrandingText "${APPNAME} ${VERSION}"

!define MUI_ABORTWARNING
!define MUI_ICON "${ICONFILE}"
!define MUI_UNICON "${ICONFILE}"
!define MUI_FINISHPAGE_RUN "$INSTDIR\${APPNAME}.exe"
!define MUI_FINISHPAGE_RUN_TEXT "Launch Harbor"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "English"

Section "Harbor" SecMain
  SetOutPath "$INSTDIR"
  ; Remove a previous install's files first so stale assets don't linger.
  RMDir /r "$INSTDIR\resources"
  RMDir /r "$INSTDIR\locales"
  ; Forward slashes: this glob is resolved by the host (Linux) makensis.
  File /r "${SRCDIR}/*"
  ; Bundle the icon so shortcuts and Add/Remove Programs can reference it
  ; (the app exe itself keeps the default icon unless built with rcedit).
  File "/oname=icon.ico" "${ICONFILE}"

  WriteRegStr HKCU "Software\${APPNAME}" "InstallDir" "$INSTDIR"

  ; Add/Remove Programs entry (per-user).
  WriteRegStr HKCU "${UNINSTKEY}" "DisplayName" "${APPNAME}"
  WriteRegStr HKCU "${UNINSTKEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${UNINSTKEY}" "Publisher" "${PUBLISHER}"
  WriteRegStr HKCU "${UNINSTKEY}" "DisplayIcon" "$INSTDIR\icon.ico"
  WriteRegStr HKCU "${UNINSTKEY}" "UninstallString" "$INSTDIR\Uninstall.exe"
  WriteRegStr HKCU "${UNINSTKEY}" "InstallLocation" "$INSTDIR"
  WriteRegDWORD HKCU "${UNINSTKEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINSTKEY}" "NoRepair" 1

  ; Shortcuts (icon comes from the bundled icon.ico so they look branded even
  ; though the exe carries the default icon).
  CreateShortCut "$DESKTOP\${APPNAME}.lnk" "$INSTDIR\${APPNAME}.exe" "" "$INSTDIR\icon.ico" 0
  CreateDirectory "$SMPROGRAMS\${APPNAME}"
  CreateShortCut "$SMPROGRAMS\${APPNAME}\${APPNAME}.lnk" "$INSTDIR\${APPNAME}.exe" "" "$INSTDIR\icon.ico" 0
  CreateShortCut "$SMPROGRAMS\${APPNAME}\Uninstall ${APPNAME}.lnk" "$INSTDIR\Uninstall.exe"

  WriteUninstaller "$INSTDIR\Uninstall.exe"
SectionEnd

Section "Uninstall"
  Delete "$DESKTOP\${APPNAME}.lnk"
  RMDir /r "$SMPROGRAMS\${APPNAME}"
  RMDir /r "$INSTDIR"
  DeleteRegKey HKCU "Software\${APPNAME}"
  DeleteRegKey HKCU "${UNINSTKEY}"
SectionEnd
