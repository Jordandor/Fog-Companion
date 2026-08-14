; Fog Companion can keep running in the tray after its main window is closed.
; Use exact executable paths here: electron-builder's generic process check can
; miss a Win32_Process when only ExecutablePath (not Path) is populated.
!macro customCheckAppRunning
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
