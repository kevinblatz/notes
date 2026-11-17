<#
  Native window checks for Trading Notes on real Windows.

  What it proves (things a browser preview or a Linux test run cannot):
    - the notes window is a real top-level window with the always-on-top flag
    - it opens on the right half of the work area, clear of the taskbar
    - clicking another app (Chrome, as a stand-in for the chart) gives that app the keyboard
      focus, while the notes window stays visible, in place, the same size, and on top
    - the notes window never takes focus back on its own
    - typing goes to the app that was clicked
    - the notes window stays above a maximized Chrome window
    - clicking the notes window does give it focus (it is not click-through)
    - the global shortcut hides and shows the same single window
    - clicking the tray icon hides and shows it (reported for information; locating the
      icon depends on the Windows version)
    - launching the app a second time does not create a second window
    - Alt+F4 hides to the tray instead of quitting

  Usage (PowerShell, from the repository root, after `npm run package:win`):
      pwsh scripts/windows-native-check.ps1
      pwsh scripts/windows-native-check.ps1 -AppExe "C:\path\to\Trading Notes.exe"

  It uses a throwaway notes folder, so it never touches your real notes. It moves the mouse
  and types for about a minute; leave the machine alone while it runs.
#>
param(
  [string]$AppExe = "release\win-unpacked\Trading Notes.exe",
  [string]$OutDir = "native-check",
  [string]$Shortcut = "ctrl+shift+space"
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class Native {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] public static extern IntPtr GetWindowLongPtr(IntPtr hWnd, int index);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT point);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hWnd, uint flags);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc callback, IntPtr lParam);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int max);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int command);
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr hWnd, int x, int y, int w, int h, bool repaint);
}
"@
[void][Native]::SetProcessDPIAware()

$results = New-Object System.Collections.Generic.List[object]
$failed = 0
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$log = Join-Path $OutDir "native-check.log"
"" | Set-Content $log

function Say([string]$text) { Write-Host $text; Add-Content -Path $log -Value $text }
function Check([string]$name, [bool]$ok, [string]$detail = "", [bool]$required = $true) {
  $status = if ($ok) { "PASS" } elseif ($required) { "FAIL" } else { "INFO" }
  if (-not $ok -and $required) { $script:failed++ }
  $results.Add([pscustomobject]@{ check = $name; status = $status; detail = $detail })
  Say ("[{0}] {1}{2}" -f $status, $name, $(if ($detail) { "  ($detail)" } else { "" }))
}
function Shot([string]$name) {
  try {
    $bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
    $bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
    $bitmap.Save((Join-Path $OutDir "$name.png"), [System.Drawing.Imaging.ImageFormat]::Png)
    $graphics.Dispose(); $bitmap.Dispose()
  } catch { Say "  (screenshot $name failed: $_)" }
}
function Title([IntPtr]$hWnd) { $sb = New-Object System.Text.StringBuilder 512; [void][Native]::GetWindowText($hWnd, $sb, 512); $sb.ToString() }
function ProcessIdOf([IntPtr]$hWnd) { $id = 0; [void][Native]::GetWindowThreadProcessId($hWnd, [ref]$id); [int]$id }
function ProcessNameOf([IntPtr]$hWnd) { try { (Get-Process -Id (ProcessIdOf $hWnd) -ErrorAction Stop).ProcessName } catch { "" } }
function RectOf([IntPtr]$hWnd) { $r = New-Object Native+RECT; [void][Native]::GetWindowRect($hWnd, [ref]$r); $r }
function RectText($r) { "{0},{1} {2}x{3}" -f $r.Left, $r.Top, ($r.Right - $r.Left), ($r.Bottom - $r.Top) }
function IsTopmost([IntPtr]$hWnd) { ([Native]::GetWindowLongPtr($hWnd, -20).ToInt64() -band 0x8) -ne 0 }
function RootAt([int]$x, [int]$y) { $p = New-Object Native+POINT; $p.X = $x; $p.Y = $y; [Native]::GetAncestor([Native]::WindowFromPoint($p), 2) }

# Every visible top-level window whose title matches, optionally limited to one process name.
function FindWindows([string]$titlePattern, [string]$processName = "", [bool]$visibleOnly = $true) {
  $found = New-Object System.Collections.Generic.List[IntPtr]
  $callback = [Native+EnumProc] {
    param($hWnd, $lParam)
    if ($visibleOnly -and -not [Native]::IsWindowVisible($hWnd)) { return $true }
    if ((Title $hWnd) -notmatch $titlePattern) { return $true }
    if ($processName -and (ProcessNameOf $hWnd) -ne $processName) { return $true }
    $found.Add($hWnd); return $true
  }
  [void][Native]::EnumWindows($callback, [IntPtr]::Zero)
  return ,$found
}
function WaitFor([scriptblock]$condition, [int]$timeoutMs = 15000) {
  $deadline = (Get-Date).AddMilliseconds($timeoutMs)
  while ((Get-Date) -lt $deadline) { $value = & $condition; if ($value) { return $value }; Start-Sleep -Milliseconds 150 }
  return $null
}
function Click([int]$x, [int]$y) {
  [void][Native]::SetCursorPos($x, $y); Start-Sleep -Milliseconds 120
  [Native]::mouse_event(0x2, 0, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 40
  [Native]::mouse_event(0x4, 0, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 350
}
$VK = @{ ctrl = 0x11; shift = 0x10; alt = 0x12; win = 0x5B; space = 0x20; f4 = 0x73; f11 = 0x7A }
function Chord([string]$combo) {
  $keys = $combo.ToLower().Split("+") | ForEach-Object { if ($VK.ContainsKey($_)) { [byte]$VK[$_] } else { [byte][char]$_.ToUpper() } }
  foreach ($key in $keys) { [Native]::keybd_event($key, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 30 }
  [array]::Reverse($keys)
  foreach ($key in $keys) { [Native]::keybd_event($key, 0, 0x2, [UIntPtr]::Zero); Start-Sleep -Milliseconds 30 }
  Start-Sleep -Milliseconds 500
}
function TypeText([string]$text) {
  foreach ($ch in $text.ToUpper().ToCharArray()) { [Native]::keybd_event([byte][char]$ch, 0, 0, [UIntPtr]::Zero); [Native]::keybd_event([byte][char]$ch, 0, 0x2, [UIntPtr]::Zero); Start-Sleep -Milliseconds 40 }
  Start-Sleep -Milliseconds 400
}

# Locate the app's notification-area (tray) icon with UI Automation. Returns its screen
# rectangle, or $null. Tray icons belong to explorer.exe and are named after their tooltip.
# Looks at what is visible first, then opens the "Show hidden icons" flyout and looks again.
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
function FindTrayIcon([string]$tooltip) {
  $automation = [System.Windows.Automation.AutomationElement]
  $scope = [System.Windows.Automation.TreeScope]
  $shellIds = @(Get-Process -Name explorer, ShellExperienceHost -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
  $search = {
    foreach ($top in $automation::RootElement.FindAll($scope::Children, [System.Windows.Automation.Condition]::TrueCondition)) {
      try {
        if ($shellIds -notcontains $top.Current.ProcessId) { continue }
        foreach ($element in $top.FindAll($scope::Descendants, [System.Windows.Automation.Condition]::TrueCondition)) {
          $name = $element.Current.Name
          if ($name -and $name.StartsWith($tooltip) -and -not $element.Current.BoundingRectangle.IsEmpty) { return $element.Current.BoundingRectangle }
        }
      } catch { }
    }
    return $null
  }
  $rect = & $search
  if ($rect) { return $rect }
  $tray = $automation::RootElement.FindFirst($scope::Children, (New-Object System.Windows.Automation.PropertyCondition($automation::ClassNameProperty, "Shell_TrayWnd")))
  if (-not $tray) { Say "  (tray search: taskbar window not found)"; return $null }
  $names = New-Object System.Collections.Generic.List[string]
  foreach ($element in $tray.FindAll($scope::Descendants, [System.Windows.Automation.Condition]::TrueCondition)) {
    $current = $element.Current
    if ($current.Name) { $names.Add(("{0} [{1}/{2}]" -f $current.Name, $current.ControlType.ProgrammaticName.Replace("ControlType.", ""), $current.AutomationId)) }
    if ($current.Name -match "hidden icons|Notification Chevron|overflow" -or $current.AutomationId -match "NotifyChevron|ShowHiddenIcons|OverflowButton") {
      $b = $current.BoundingRectangle
      if (-not $b.IsEmpty) {
        Click ([int]($b.X + $b.Width / 2)) ([int]($b.Y + $b.Height / 2))
        Start-Sleep -Milliseconds 1200
        $rect = & $search
        if ($rect) { return $rect }
      }
    }
  }
  Say ("  (tray search: taskbar elements seen: " + (($names | Select-Object -First 40) -join "; ") + ")")
  return $null
}

$AppExe = (Resolve-Path $AppExe).Path
$appName = [System.IO.Path]::GetFileNameWithoutExtension($AppExe)
$dataDir = Join-Path ([System.IO.Path]::GetTempPath()) ("tn-native-" + [guid]::NewGuid().ToString("N"))
$chromeProfile = Join-Path ([System.IO.Path]::GetTempPath()) ("tn-chrome-" + [guid]::NewGuid().ToString("N"))
$env:TRADING_NOTES_DATA_DIR = $dataDir
$diagnostics = Join-Path (Resolve-Path $OutDir).Path "app-diagnostics.json"
$env:TRADING_NOTES_DIAGNOSTICS = $diagnostics
$work = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
$screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
Say "Screen $($screen.Width)x$($screen.Height), work area $($work.X),$($work.Y) $($work.Width)x$($work.Height)"
Say "App: $AppExe"

$chrome = $null
try {
  # ---------------------------------------------------------------- launch
  Start-Process -FilePath $AppExe | Out-Null
  $notes = WaitFor { $w = FindWindows "^Trading Notes$" $appName; if ($w.Count -gt 0) { $w[0] } } 30000
  Check "Notes window appears" ($null -ne $notes)
  if ($null -eq $notes) { throw "The notes window never appeared." }
  Start-Sleep -Seconds 2
  Shot "01-launched"

  # What the app itself reports about its tray icon and shortcut.
  $report = $null
  if (Test-Path $diagnostics) { $report = Get-Content $diagnostics -Raw | ConvertFrom-Json }
  Check "App reports its start-up state" ($null -ne $report)
  if ($report) {
    Say ("  version {0}, packaged {1}, Electron {2}" -f $report.version, $report.packaged, $report.electron)
    Check "Tray icon was created" ([bool]$report.tray.created)
    Check "Tray icon image loaded from the packaged app" ([bool]$report.tray.iconLoaded)
    Check "Global shortcut registered with Windows" ([bool]$report.shortcut.registered) ("{0} {1}" -f $report.shortcut.accelerator, $report.shortcut.error)
  }

  $rect = RectOf $notes
  Check "Notes window is always-on-top (WS_EX_TOPMOST)" (IsTopmost $notes)
  $expectedLeft = $work.X + [math]::Ceiling($work.Width / 2)
  $tolerance = 16
  $docked = ([math]::Abs($rect.Left - $expectedLeft) -le $tolerance) -and ([math]::Abs($rect.Top - $work.Y) -le $tolerance) -and
            ([math]::Abs($rect.Right - ($work.X + $work.Width)) -le $tolerance) -and ([math]::Abs($rect.Bottom - ($work.Y + $work.Height)) -le $tolerance)
  Check "Opens on the right half of the work area, clear of the taskbar" $docked ("window " + (RectText $rect))
  Check "Does not cover the taskbar" ($rect.Bottom -le ($work.Y + $work.Height + $tolerance)) ("bottom $($rect.Bottom), work area bottom $($work.Y + $work.Height)")

  # ---------------------------------------------------------------- a stand-in for the chart
  $chromeExe = @("$env:ProgramFiles\Google\Chrome\Application\chrome.exe", "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe", "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe",
                 "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe", "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
  if (-not $chromeExe) { throw "Neither Chrome nor Edge was found to act as the chart window." }
  $browserName = [System.IO.Path]::GetFileNameWithoutExtension($chromeExe)
  $page = "data:text/html,<title>chartwindow</title><body style='margin:0;background:%23131722'><textarea id='t' autofocus style='width:100%25;height:100vh;background:%23131722;color:white;font-size:28px;border:0' oninput='document.title=this.value'></textarea>"
  $halfWidth = [math]::Floor($work.Width / 2)
  Start-Process -FilePath $chromeExe -ArgumentList @("--user-data-dir=`"$chromeProfile`"", "--no-first-run", "--no-default-browser-check", "--disable-sync", "--new-window",
    "--window-position=$($work.X),$($work.Y)", "--window-size=$halfWidth,$($work.Height)", "`"$page`"") | Out-Null
  $chrome = WaitFor { $w = FindWindows "chartwindow" $browserName; if ($w.Count -gt 0) { $w[0] } } 30000
  Check "Stand-in chart window ($browserName) opens on the left half" ($null -ne $chrome)
  if ($null -eq $chrome) { throw "The browser window never appeared." }
  [void][Native]::MoveWindow($chrome, $work.X, $work.Y, $halfWidth, $work.Height, $true)
  Start-Sleep -Seconds 2
  Shot "02-side-by-side"

  # ---------------------------------------------------------------- click the chart repeatedly
  $before = RectOf $notes
  $cr = RectOf $chrome
  $allForeground = $true; $allVisible = $true; $allSameRect = $true; $allTopmost = $true; $neverStolen = $true
  for ($i = 0; $i -lt 6; $i++) {
    $x = $cr.Left + [int](($cr.Right - $cr.Left) * (0.25 + 0.1 * $i))
    $y = $cr.Top + [int](($cr.Bottom - $cr.Top) * (0.35 + 0.08 * $i))
    Click $x $y
    $fg = [Native]::GetForegroundWindow()
    if ((ProcessNameOf $fg) -ne $browserName) { $allForeground = $false; Say "  click $i : foreground is '$(Title $fg)' [$(ProcessNameOf $fg)]" }
    if (-not [Native]::IsWindowVisible($notes) -or [Native]::IsIconic($notes)) { $allVisible = $false }
    $now = RectOf $notes
    if ($now.Left -ne $before.Left -or $now.Top -ne $before.Top -or $now.Right -ne $before.Right -or $now.Bottom -ne $before.Bottom) { $allSameRect = $false }
    if (-not (IsTopmost $notes)) { $allTopmost = $false }
    # Hold still and make sure the notes window does not take the focus back.
    Start-Sleep -Milliseconds 1200
    if ([Native]::GetForegroundWindow() -eq $notes) { $neverStolen = $false }
  }
  Check "Clicking the chart gives the chart the keyboard focus (6 clicks)" $allForeground
  Check "Notes window stays visible while the chart is clicked" $allVisible
  Check "Notes window keeps its exact position and size" $allSameRect ((RectText $before) + " -> " + (RectText (RectOf $notes)))
  Check "Notes window stays always-on-top" $allTopmost
  Check "Notes window never takes focus back by itself" $neverStolen

  Click ($cr.Left + [int](($cr.Right - $cr.Left) / 2)) ($cr.Top + [int](($cr.Bottom - $cr.Top) / 2))
  TypeText "abc"
  $typed = WaitFor { if ((Title $chrome) -match "^abc") { $true } } 4000
  Check "Typing goes to the chart window, not to the notes" ([bool]$typed) ("chart window title: '" + (Title $chrome) + "'")
  Shot "03-chart-has-focus"

  # ---------------------------------------------------------------- overlap: notes stay on top
  [void][Native]::ShowWindow($chrome, 3)   # maximize the chart over the notes
  Start-Sleep -Seconds 1
  $nr = RectOf $notes
  Click ($work.X + 200) ($work.Y + [int]($work.Height / 2))
  $centerX = [int](($nr.Left + $nr.Right) / 2); $centerY = [int](($nr.Top + $nr.Bottom) / 2)
  Check "Chart keeps focus when maximized under the notes" ((ProcessNameOf ([Native]::GetForegroundWindow())) -eq $browserName)
  Check "Notes window is drawn above a maximized chart" ((RootAt $centerX $centerY) -eq $notes) ("window at notes centre: '" + (Title (RootAt $centerX $centerY)) + "'")
  Shot "04-chart-maximized-under-notes"

  # Browser fullscreen (F11): informational, because Windows treats fullscreen apps specially.
  Chord "f11"; Start-Sleep -Seconds 2
  Check "Notes window stays above the chart in browser fullscreen (F11)" ((RootAt $centerX $centerY) -eq $notes) "" $false
  Shot "05-chart-fullscreen"
  Chord "f11"; Start-Sleep -Seconds 1
  [void][Native]::ShowWindow($chrome, 9)   # restore
  [void][Native]::MoveWindow($chrome, $work.X, $work.Y, $halfWidth, $work.Height, $true)
  Start-Sleep -Seconds 1

  # ---------------------------------------------------------------- the notes can take focus when asked
  Click $centerX ($nr.Top + [int](($nr.Bottom - $nr.Top) * 0.75))
  Check "Clicking the notes window gives it focus" ([Native]::GetForegroundWindow() -eq $notes)
  # That click on empty board space opened a draft; type into it, then go back to the chart.
  TypeText "draft"
  $cr = RectOf $chrome
  Click ($cr.Left + 150) ($cr.Top + [int](($cr.Bottom - $cr.Top) / 2))
  Check "Clicking the chart again takes focus away from the notes" ((ProcessNameOf ([Native]::GetForegroundWindow())) -eq $browserName)
  Check "Notes window still visible with a draft open" ([Native]::IsWindowVisible($notes))
  Shot "06-draft-open-chart-focused"

  # ---------------------------------------------------------------- global shortcut
  Chord $Shortcut
  $hidden = WaitFor { if (-not [Native]::IsWindowVisible($notes)) { $true } } 4000
  Check "Global shortcut hides the notes" ([bool]$hidden)
  Check "Chart still has focus after the notes hide" ((ProcessNameOf ([Native]::GetForegroundWindow())) -eq $browserName) "" $false
  Shot "07-hidden"
  Chord $Shortcut
  $shown = WaitFor { if ([Native]::IsWindowVisible($notes)) { $true } } 4000
  Check "Global shortcut shows the same notes window again" ([bool]$shown)
  Start-Sleep -Milliseconds 600
  Check "Showing with the shortcut focuses the notes (ready to type)" ([Native]::GetForegroundWindow() -eq $notes)
  $after = RectOf $notes
  Check "Shown again at the same position and size" ($after.Left -eq $before.Left -and $after.Top -eq $before.Top -and $after.Right -eq $before.Right -and $after.Bottom -eq $before.Bottom) (RectText $after)
  Check "Still always-on-top after hide and show" (IsTopmost $notes)
  Check "Exactly one notes window exists" ((FindWindows "^Trading Notes$" $appName).Count -eq 1)
  Shot "08-shown-again"

  # ---------------------------------------------------------------- tray icon
  # Informational: finding another app's tray icon depends on the Windows version and on
  # whether the icon sits in the overflow area.
  try {
    $icon = FindTrayIcon "Trading Notes"
    if ($icon) {
      $ix = [int]($icon.X + $icon.Width / 2); $iy = [int]($icon.Y + $icon.Height / 2)
      Click $ix $iy
      $trayHid = WaitFor { if (-not [Native]::IsWindowVisible($notes)) { $true } } 4000
      Check "Clicking the tray icon hides the notes" ([bool]$trayHid) "" $false
      Shot "08b-hidden-by-tray"
      $icon = FindTrayIcon "Trading Notes"
      if ($icon) { Click ([int]($icon.X + $icon.Width / 2)) ([int]($icon.Y + $icon.Height / 2)) }
      $trayShown = WaitFor { if ([Native]::IsWindowVisible($notes)) { $true } } 4000
      Check "Clicking the tray icon shows the same notes window again" ([bool]$trayShown) "" $false
      Check "Still exactly one notes window after tray clicks" ((FindWindows "^Trading Notes$" $appName).Count -eq 1) "" $false
    } else {
      Check "Tray icon located for a click test" $false "the icon could not be found through UI Automation on this Windows version" $false
    }
  } catch { Check "Tray icon click test" $false "$_" $false }
  if (-not [Native]::IsWindowVisible($notes)) { Chord $Shortcut; Start-Sleep -Milliseconds 800 }

  # ---------------------------------------------------------------- second launch, close button
  $second = Start-Process -FilePath $AppExe -PassThru
  $exited = $second.WaitForExit(15000)
  Start-Sleep -Seconds 1
  Check "Launching the app again exits instead of opening a second copy" $exited
  Check "Still exactly one notes window" ((FindWindows "^Trading Notes$" $appName).Count -eq 1)

  Click $centerX ($nr.Top + 12)
  Chord "alt+f4"
  $hiddenByClose = WaitFor { if (-not [Native]::IsWindowVisible($notes)) { $true } } 4000
  Check "Alt+F4 hides the window" ([bool]$hiddenByClose)
  Check "The app keeps running in the tray after the window is closed" (@(Get-Process -Name $appName -ErrorAction SilentlyContinue).Count -gt 0)
  Chord $Shortcut
  Check "The shortcut brings it back after closing" ([bool](WaitFor { if ([Native]::IsWindowVisible($notes)) { $true } } 4000))
  Shot "09-final"
}
catch {
  Say "ERROR: $_"
  $failed++
  Shot "error"
}
finally {
  Get-Process -Name $appName -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  if ($chrome) { try { Stop-Process -Id (ProcessIdOf $chrome) -Force -ErrorAction SilentlyContinue } catch {} }
  Start-Sleep -Seconds 1
  Remove-Item -Recurse -Force $dataDir, $chromeProfile -ErrorAction SilentlyContinue
  $results | ConvertTo-Json | Set-Content (Join-Path $OutDir "native-check.json")
}

Say ""
Say ("{0} checks, {1} failed. Lines marked INFO are reported but do not fail the run." -f $results.Count, $failed)
if ($failed -gt 0) { exit 1 }
