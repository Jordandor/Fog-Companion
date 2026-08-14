param(
  [int]$TargetX = -1,
  [int]$TargetY = -1,
  [Parameter(Mandatory=$true)][int]$SearchX,
  [Parameter(Mandatory=$true)][int]$SearchY,
  [Parameter(Mandatory=$true)][int]$ResultX,
  [Parameter(Mandatory=$true)][int]$ResultY,
  [int]$ClearX = -1,
  [int]$ClearY = -1,
  [string]$SelectionsBase64 = "",
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
if ($SelectionsBase64 -or $NamesBase64) {
  if ($SelectionsBase64) {
    $selectionsJson = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($SelectionsBase64))
    $selections = @($selectionsJson | ConvertFrom-Json)
    # Windows PowerShell 5.1 can preserve a JSON array as one nested Object[].
    # Flatten it before sorting so diagnostics stay clean and slot order is exact.
    if ($selections.Count -eq 1 -and $selections[0] -is [System.Array]) {
      $selections = @($selections[0])
    }
    $selections = @($selections | Sort-Object { [int]$_.slot })
  } else {
    # Compatibility with helpers launched by older builds.
    $namesJson = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($NamesBase64))
    $names = @($namesJson | ConvertFrom-Json)
    $slots = @(
      @($Slot1X,$Slot1Y), @($Slot2X,$Slot2Y),
      @($Slot3X,$Slot3Y), @($Slot4X,$Slot4Y)
    )
    $selections = for ($index = 0; $index -lt [Math]::Min($names.Count,4); $index++) {
      [pscustomobject]@{ slot = $index + 1; name = [string]$names[$index]; x = $slots[$index][0]; y = $slots[$index][1] }
    }
  }

  foreach ($selection in $selections) {
    $slot = [int]$selection.slot
    $name = ([string]$selection.name).Replace([char]0x0451,[char]0x0435).Replace([char]0x0401,[char]0x0415)
    Write-Output "slot=$slot stage=slot"
    Set-Clipboard -Value $name
    [FogInput]::Click([int]$selection.x,[int]$selection.y)
    Start-Sleep -Milliseconds 130
    Write-Output "slot=$slot stage=search"
    [FogInput]::Click($SearchX,$SearchY)
    Start-Sleep -Milliseconds 70
    Write-Output "slot=$slot stage=input"
    [FogInput]::PasteReplace()
    # DBD updates the filtered perk grid asynchronously. Clicking after the old
    # 110 ms delay often hit an empty result and the following clear click made
    # the sequence look as if the query had simply been deleted.
    Start-Sleep -Milliseconds 480
    Write-Output "slot=$slot stage=result"
    [FogInput]::Click($ResultX,$ResultY)
    Start-Sleep -Milliseconds 240
    if ($ClearX -ge 0 -and $ClearY -ge 0) {
      Write-Output "slot=$slot stage=clear"
      [FogInput]::Click($ClearX,$ClearY)
      Start-Sleep -Milliseconds 130
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
