param(
  [Parameter(Mandatory=$true)][int]$OpenX,
  [Parameter(Mandatory=$true)][int]$OpenY,
  [Parameter(Mandatory=$true)][int]$SearchX,
  [Parameter(Mandatory=$true)][int]$SearchY,
  [Parameter(Mandatory=$true)][int]$ResultX,
  [Parameter(Mandatory=$true)][int]$ResultY
)

$signature = @"
using System;
using System.Runtime.InteropServices;
public static class FogInput {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extraInfo);
  [DllImport("user32.dll")] public static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extraInfo);
  public static void Click(int x, int y) {
    SetCursorPos(x, y); System.Threading.Thread.Sleep(18);
    mouse_event(0x0002,0,0,0,UIntPtr.Zero); mouse_event(0x0004,0,0,0,UIntPtr.Zero);
  }
  public static void PasteReplace() {
    keybd_event(0x11,0,0,UIntPtr.Zero); keybd_event(0x41,0,0,UIntPtr.Zero);
    keybd_event(0x41,0,2,UIntPtr.Zero); keybd_event(0x56,0,0,UIntPtr.Zero);
    keybd_event(0x56,0,2,UIntPtr.Zero); keybd_event(0x11,0,2,UIntPtr.Zero);
  }
}
"@

Add-Type -TypeDefinition $signature
$game = Get-Process -ErrorAction SilentlyContinue |
  Where-Object { $_.ProcessName -match 'DeadByDaylight' -and $_.MainWindowHandle -ne 0 } |
  Select-Object -First 1
if (-not $game) { Write-Error "Окно Dead by Daylight не найдено."; exit 2 }
[FogInput]::ShowWindow($game.MainWindowHandle,9) | Out-Null
[FogInput]::SetForegroundWindow($game.MainWindowHandle) | Out-Null
Start-Sleep -Milliseconds 90
[FogInput]::Click($OpenX,$OpenY)
Start-Sleep -Milliseconds 180
[FogInput]::Click($SearchX,$SearchY)
Start-Sleep -Milliseconds 35
[FogInput]::PasteReplace()
Start-Sleep -Milliseconds 160
[FogInput]::Click($ResultX,$ResultY)
exit 0
