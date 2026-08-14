param(
  [int]$TargetX = -1,
  [int]$TargetY = -1,
  [Parameter(Mandatory=$true)][int]$SearchX,
  [Parameter(Mandatory=$true)][int]$SearchY,
  [Parameter(Mandatory=$true)][int]$ResultX,
  [Parameter(Mandatory=$true)][int]$ResultY,
  [int]$ClearX = -1,
  [int]$ClearY = -1,
  [string]$NamesBase64 = "",
  [int]$Slot1X = -1, [int]$Slot1Y = -1,
  [int]$Slot2X = -1, [int]$Slot2Y = -1,
  [int]$Slot3X = -1, [int]$Slot3Y = -1,
  [int]$Slot4X = -1, [int]$Slot4Y = -1
)

$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8

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
Start-Sleep -Milliseconds 70
if ($NamesBase64) {
  $namesJson = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($NamesBase64))
  $names = @($namesJson | ConvertFrom-Json)
  $slots = @(
    @($Slot1X,$Slot1Y), @($Slot2X,$Slot2Y),
    @($Slot3X,$Slot3Y), @($Slot4X,$Slot4Y)
  )
  for ($index = 0; $index -lt [Math]::Min($names.Count,4); $index++) {
    Set-Clipboard -Value ([string]$names[$index])
    [FogInput]::Click($slots[$index][0],$slots[$index][1])
    Start-Sleep -Milliseconds 75
    [FogInput]::Click($SearchX,$SearchY)
    Start-Sleep -Milliseconds 25
    [FogInput]::PasteReplace()
    Start-Sleep -Milliseconds 110
    [FogInput]::Click($ResultX,$ResultY)
    Start-Sleep -Milliseconds 70
    if ($ClearX -ge 0 -and $ClearY -ge 0) {
      [FogInput]::Click($ClearX,$ClearY)
      Start-Sleep -Milliseconds 65
    }
  }
  exit 0
}
if ($TargetX -ge 0 -and $TargetY -ge 0) {
  [FogInput]::Click($TargetX,$TargetY)
  Start-Sleep -Milliseconds 75
}
[FogInput]::Click($SearchX,$SearchY)
Start-Sleep -Milliseconds 25
[FogInput]::PasteReplace()
Start-Sleep -Milliseconds 110
[FogInput]::Click($ResultX,$ResultY)
exit 0
