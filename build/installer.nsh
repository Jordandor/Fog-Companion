; A per-user installation normally needs no elevation. If the user deliberately
; chooses a protected folder, elevate only a small helper once. The helper creates
; that exact directory and grants the installing user Modify access, allowing all
; future in-app updates to remain silent and unelevated.

; Keep the directory selected during the visible first installation. Existing
; installs without the marker continue to use electron-builder's registered
; installation directory; the marker becomes authoritative after this install.
!macro customInit
  ${If} ${Silent}
    StrCpy $R9 ""
    ClearErrors
    FileOpen $R8 "$APPDATA\fog-companion\install-location.txt" r
    ${IfNot} ${Errors}
      FileRead $R8 $R9
      FileClose $R8
    ${EndIf}

    ${If} $R9 != ""
      StrCpy $INSTDIR "$R9"
      DetailPrint "Restored Fog Companion installation directory: $INSTDIR"
    ${EndIf}

    ; Some early builds registered an AppData installation as all-users. Do not
    ; request elevation for that stale registry mode: AppData belongs to the
    ; current user and is intentionally the chosen installation directory.
    StrLen $R8 "$APPDATA"
    StrCpy $R7 "$INSTDIR" $R8
    StrLen $R6 "$LOCALAPPDATA"
    StrCpy $R5 "$INSTDIR" $R6
    ${If} $R7 == "$APPDATA"
    ${OrIf} $R5 == "$LOCALAPPDATA"
      StrCpy $hasPerMachineInstallation "0"
      StrCpy $hasPerUserInstallation "1"
      StrCpy $installMode CurrentUser
      SetShellVarContext current
      DetailPrint "Using the existing per-user Fog Companion installation: $INSTDIR"
    ${EndIf}
  ${EndIf}
!macroend

!macro customInstall
  CreateDirectory "$APPDATA\fog-companion"
  ClearErrors
  FileOpen $R8 "$APPDATA\fog-companion\install-location.txt" w
  ${IfNot} ${Errors}
    FileWrite $R8 "$INSTDIR"
    FileClose $R8
  ${EndIf}
!macroend

!macro ensureInstallDirectoryWritable
  !ifndef BUILD_UNINSTALLER
    CreateDirectory "$INSTDIR"
    ClearErrors
    FileOpen $R8 "$INSTDIR\.fog-companion-write-test" w
    ${IfNot} ${Errors}
      FileClose $R8
      Delete "$INSTDIR\.fog-companion-write-test"
    ${Else}
      ${If} ${Silent}
        DetailPrint "The selected installation directory is not writable."
        SetErrorLevel 6
        Quit
      ${Else}
        File /oname=$PLUGINSDIR\prepare-install-dir.ps1 "${BUILD_RESOURCES_DIR}\prepare-install-dir.ps1"
        System::Call 'Kernel32::SetEnvironmentVariable(t, t)i ("FOG_COMPANION_INSTALL_DIR", "$INSTDIR").r0'
        System::Call 'Kernel32::SetEnvironmentVariable(t, t)i ("FOG_COMPANION_PREPARE_SCRIPT", "$PLUGINSDIR\prepare-install-dir.ps1").r0'

        DetailPrint "Requesting permission to prepare the selected installation directory..."
        nsExec::ExecToStack `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "try { $$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; [Environment]::SetEnvironmentVariable('FOG_COMPANION_INSTALL_USER_SID',$$sid,'Process'); $$process=Start-Process -FilePath '$SYSDIR\WindowsPowerShell\v1.0\powershell.exe' -Verb RunAs -WindowStyle Hidden -Wait -PassThru -ArgumentList '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command \"& $$env:FOG_COMPANION_PREPARE_SCRIPT\"'; exit $$process.ExitCode } catch { exit 1223 }"`
        Pop $R8
        Pop $R9

        System::Call 'Kernel32::SetEnvironmentVariable(t, t)i ("FOG_COMPANION_INSTALL_DIR", "").r0'
        System::Call 'Kernel32::SetEnvironmentVariable(t, t)i ("FOG_COMPANION_PREPARE_SCRIPT", "").r0'

        CreateDirectory "$INSTDIR"
        ClearErrors
        FileOpen $R8 "$INSTDIR\.fog-companion-write-test" w
        ${IfNot} ${Errors}
          FileClose $R8
          Delete "$INSTDIR\.fog-companion-write-test"
        ${Else}
          MessageBox MB_OK|MB_ICONSTOP "Не удалось получить доступ к выбранной папке. Разрешите запрос Windows или выберите папку внутри своего профиля пользователя."
          SetErrorLevel 6
          Quit
        ${EndIf}
      ${EndIf}
    ${EndIf}
  !endif
!macroend

; Fog Companion can keep running in the tray after its main window is closed.
; Use exact executable paths here: electron-builder's generic process check can
; miss a Win32_Process when only ExecutablePath (not Path) is populated.
!macro customCheckAppRunning
  !insertmacro ensureInstallDirectoryWritable
  DetailPrint "Closing Fog Companion before installation..."
  nsExec::ExecToStack `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$$targets=@('$INSTDIR\${APP_EXECUTABLE_FILENAME}','$INSTDIR\Uninstall Fog Companion.exe'); Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $$p=$$_.ExecutablePath; $$p -and ($$targets | Where-Object { [string]::Equals($$_,$$p,[System.StringComparison]::OrdinalIgnoreCase) }) } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue }; $$deadline=(Get-Date).AddSeconds(12); do { $$alive=Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $$p=$$_.ExecutablePath; $$p -and ($$targets | Where-Object { [string]::Equals($$_,$$p,[System.StringComparison]::OrdinalIgnoreCase) }) }; if(-not $$alive){exit 0}; Start-Sleep -Milliseconds 250 } while((Get-Date)-lt $$deadline); exit 1"`
  Pop $0
  Pop $1
  ${If} $0 != 0
    ${If} ${Silent}
      SetErrorLevel 5
      Quit
    ${Else}
      MessageBox MB_OK|MB_ICONEXCLAMATION "Fog Companion или его деинсталлятор всё ещё запущен. Полностью закройте его через трей и запустите установщик ещё раз."
      Quit
    ${EndIf}
  ${EndIf}
!macroend
