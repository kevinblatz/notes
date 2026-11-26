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
    - the trading hotkeys: Ctrl+Alt+N (quick note) takes the keyboard only while typing and then
      gives it back to the chart for good (checked again a second later), or hides the notes
      again when they were hidden, and the line typed is in today's session log in the notes
      database; Ctrl+Alt+R (risk calculator) copies the contract count and gives the keyboard
      back the same way; Ctrl+Alt+S (snapshot) never takes the keyboard from the chart and
      stores one more image, of the browser window with only the web page kept (the stored
      picture is shorter than the browser window by at least its tab strip and toolbar, and its
      top corners are the page's background, not the browser's); Ctrl+Alt+O (see-through)
      changes the window's layered alpha and back (reported for information). The database is
      read with Node's built-in node:sqlite, read-only; without Node on PATH those database
      checks are reported for information.
    - clicking the tray icon hides and shows it (reported for information; locating the
      icon depends on the Windows version)
    - launching the app a second time does not create a second window
    - Alt+F4 hides to the tray instead of quitting
  It also prints the browser window's child windows (class, shown or hidden, rectangle) right
  after it opens and again before the snapshot, to show where the browser keeps the web page.

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
  [DllImport("user32.dll")] public static extern bool GetLayeredWindowAttributes(IntPtr hWnd, out uint colorKey, out byte alpha, out uint flags);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr parent, EnumProc callback, IntPtr lParam);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder name, int max);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hWnd, int attribute, out RECT value, int size);
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
# Layered alpha, 0-255. Electron makes the window layered (WS_EX_LAYERED, LWA_ALPHA) the first
# time it is see-through; a window that is not layered, or has no alpha set, is solid.
function AlphaOf([IntPtr]$hWnd) {
  if (([Native]::GetWindowLongPtr($hWnd, -20).ToInt64() -band 0x80000) -eq 0) { return 255 }
  [uint32]$key = 0; [byte]$alpha = 255; [uint32]$flags = 0
  if (-not [Native]::GetLayeredWindowAttributes($hWnd, [ref]$key, [ref]$alpha, [ref]$flags) -or ($flags -band 0x2) -eq 0) { return 255 }
  return [int]$alpha
}
function RootAt([int]$x, [int]$y) { $p = New-Object Native+POINT; $p.X = $x; $p.Y = $y; [Native]::GetAncestor([Native]::WindowFromPoint($p), 2) }
function ClassOf([IntPtr]$hWnd) { $sb = New-Object System.Text.StringBuilder 256; [void][Native]::GetClassName($hWnd, $sb, 256); $sb.ToString() }
# The visible frame, as the desktop window manager draws it (DWMWA_EXTENDED_FRAME_BOUNDS): what
# a window capture pictures. GetWindowRect also counts the invisible resize borders.
function FrameOf([IntPtr]$hWnd) { $r = New-Object Native+RECT; if ([Native]::DwmGetWindowAttribute($hWnd, 9, [ref]$r, 16) -ne 0) { return (RectOf $hWnd) }; $r }
# Every child window, at any depth: class, shown or hidden, rectangle. Window geometry only:
# nothing is sent to the browser, and its accessibility support is not switched on.
function ChildWindows([IntPtr]$hWnd) {
  $found = New-Object System.Collections.Generic.List[object]
  $callback = [Native+EnumProc] {
    param($child, $lParam)
    $found.Add([pscustomobject]@{ hwnd = $child; class = (ClassOf $child); visible = [Native]::IsWindowVisible($child); rect = (RectOf $child) }); return $true
  }
  [void][Native]::EnumChildWindows($hWnd, $callback, [IntPtr]::Zero)
  return ,$found
}
# Where Chromium shows the web page: the largest visible Chrome_RenderWidgetHostHWND child
# (the "Chrome Legacy Window"), or $null.
function PageWindowOf([IntPtr]$hWnd) {
  $best = $null; $bestArea = 0
  foreach ($child in (ChildWindows $hWnd)) {
    if ($child.class -ne "Chrome_RenderWidgetHostHWND" -or -not $child.visible) { continue }
    $area = [int64]($child.rect.Right - $child.rect.Left) * [int64]($child.rect.Bottom - $child.rect.Top)
    if ($area -gt $bestArea) { $best = $child.rect; $bestArea = $area }
  }
  return $best
}
function ReportChildWindows([IntPtr]$hWnd, [string]$when) {
  $children = ChildWindows $hWnd
  Say ("  browser window {0}: window {1}, visible frame {2}, {3} child window(s)" -f $when, (RectText (RectOf $hWnd)), (RectText (FrameOf $hWnd)), $children.Count)
  foreach ($child in ($children | Select-Object -First 40)) {
    Say ("    {0} [{1}] {2}" -f $child.class, $(if ($child.visible) { "shown" } else { "hidden" }), (RectText $child.rect))
  }
}

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
$VK = @{ ctrl = 0x11; shift = 0x10; alt = 0x12; win = 0x5B; space = 0x20; f4 = 0x73; f11 = 0x7A; enter = 0x0D; esc = 0x1B; tab = 0x09 }
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
# Lowercase letters only, so TypeText can type them and the notes database can be searched for them.
function RandomLetters([int]$count) { -join (1..$count | ForEach-Object { [char](Get-Random -Minimum 97 -Maximum 123) }) }

# Locate the app's notification-area (tray) icon with UI Automation. Returns its screen
# rectangle, or $null. Tray icons belong to explorer.exe and are named after their tooltip.
# Looks at what is visible first, then opens the "Show hidden icons" flyout and looks again.
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
function FindTrayIcon([string]$tooltip) {
  $automation = [System.Windows.Automation.AutomationElement]
  $scope = [System.Windows.Automation.TreeScope]
  # The icon lives in a Windows shell window (which one depends on the Windows version), so
  # every top-level window is searched except the app's own, which carries the same name.
  $appIds = @(Get-Process -Name $appName -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
  # Nor the browser's: searching inside them with UI Automation would switch on the browser's
  # accessibility support (the app itself never does), and the snapshot check below must see
  # the browser as a user's browser is.
  if ($browserName) { $appIds += @(Get-Process -Name $browserName -ErrorAction SilentlyContinue | ForEach-Object { $_.Id }) }
  $search = {
    foreach ($top in $automation::RootElement.FindAll($scope::Children, [System.Windows.Automation.Condition]::TrueCondition)) {
      try {
        if ($appIds -contains $top.Current.ProcessId) { continue }
        foreach ($element in $top.FindAll($scope::Descendants, [System.Windows.Automation.Condition]::TrueCondition)) {
          $name = $element.Current.Name
          # Exact match only: the taskbar button of the same app is named "<title> - 1 running window".
          if ($name -eq $tooltip -and -not $element.Current.BoundingRectangle.IsEmpty) { return $element.Current.BoundingRectangle }
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
        Start-Sleep -Milliseconds 1800
        $rect = & $search
        if ($rect) { return $rect }
        $classes = @($automation::RootElement.FindAll($scope::Children, [System.Windows.Automation.Condition]::TrueCondition) | ForEach-Object { try { $_.Current.ClassName + "(" + $_.Current.Name + ")" } catch { } })
        Say ("  (tray search: top-level windows after opening hidden icons: " + (($classes | Select-Object -First 40) -join "; ") + ")")
      }
    }
  }
  Say ("  (tray search: taskbar elements seen: " + (($names | Select-Object -First 40) -join "; ") + ")")
  return $null
}

# The notes database, read the way the app stores it (src/main/store/db.ts): Node's built-in
# SQLite, opened read-only, in a separate process without a window and with a time limit. The
# probe prints one line of JSON: counts, and whether a word is in today's session log.
$probeSource = @'
// Written and run by scripts/windows-native-check.ps1, then deleted. Opens the Trading Notes
// database read-only with Node's built-in SQLite and prints one line of JSON. Never writes.
'use strict'
let out
try {
  const { DatabaseSync } = require('node:sqlite')
  const db = new DatabaseSync(process.env.TN_PROBE_DB, { readOnly: true })
  try {
    db.exec('PRAGMA busy_timeout = 3000')
    const word = (process.env.TN_PROBE_WORD || '').toLowerCase()
    const has = (text) => word !== '' && String(text || '').toLowerCase().includes(word)
    const parse = (text) => {
      try {
        return JSON.parse(text)
      } catch {
        return null
      }
    }
    // Images are "noteImage" nodes anywhere in a note's document (src/shared/content.ts).
    const images = (node) => {
      if (!node || typeof node !== 'object') return 0
      const children = Array.isArray(node.content) ? node.content : []
      return (node.type === 'noteImage' ? 1 : 0) + children.reduce((sum, child) => sum + images(child), 0)
    }
    // A session log carries its local date in extra_json.sessionLog (src/main/store/library.ts).
    const isLog = (note) => {
      const extra = parse(note.extra_json)
      return !!extra && typeof extra.sessionLog === 'string'
    }
    const notes = db.prepare('SELECT plain_text, content_json, extra_json FROM notes WHERE deleted_at IS NULL').all()
    const logs = notes.filter(isLog)
    const others = notes.filter((note) => !isLog(note))
    out = {
      ok: true,
      notes: notes.length,
      attachments: Number(db.prepare('SELECT COUNT(*) AS n FROM attachments').get().n),
      logNotes: logs.length,
      logImages: logs.reduce((sum, note) => sum + images(parse(note.content_json)), 0),
      inLogText: logs.some((note) => has(note.plain_text)),
      inOtherText: others.filter((note) => has(note.plain_text)).length,
      // The picture stored last, as the app recorded it (its file is in attachments/ beside the database).
      latest: (() => {
        const row = db.prepare('SELECT file_name, width, height FROM attachments ORDER BY created_at DESC LIMIT 1').get()
        return row ? { file: String(row.file_name), width: Number(row.width), height: Number(row.height) } : null
      })()
    }
  } finally {
    db.close()
  }
} catch (error) {
  out = { ok: false, code: String((error && error.code) || ''), error: String((error && error.message) || error) }
}
process.stdout.write(JSON.stringify(out) + '\n')
'@
function RunProbe([string]$word) {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $nodeExe
  $psi.Arguments = "$script:nodeFlags `"$dbProbe`""
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.EnvironmentVariables["TN_PROBE_DB"] = $dbFile
  $psi.EnvironmentVariables["TN_PROBE_WORD"] = $word
  $proc = [System.Diagnostics.Process]::Start($psi)
  try {
    $stdout = $proc.StandardOutput.ReadToEndAsync(); $stderr = $proc.StandardError.ReadToEndAsync()
    if (-not $proc.WaitForExit(10000)) { try { $proc.Kill() } catch { }; throw "node did not answer within 10 s" }
    [void]$stdout.Wait(3000); [void]$stderr.Wait(3000)
    $text = if ($stdout.IsCompleted) { $stdout.Result.Trim() } else { "" }
    if (-not $text) { throw ("node printed nothing (exit {0}): {1}" -f $proc.ExitCode, $(if ($stderr.IsCompleted) { $stderr.Result.Trim() } else { "" })) }
    return ($text | ConvertFrom-Json)
  } finally { $proc.Dispose() }
}
# The probe's answer, or $null when the database could not be read ($probeProblem says why).
function DbProbe([string]$word = "") {
  $problem = ""; $answer = $null
  try {
    if (-not $nodeExe) { throw "node.exe was not found on PATH" }
    $answer = RunProbe $word
    # Node 22 before 22.13 has node:sqlite only behind a flag.
    if (-not $answer.ok -and $answer.code -eq "ERR_UNKNOWN_BUILTIN_MODULE" -and $script:nodeFlags -notmatch "experimental-sqlite") {
      $script:nodeFlags = "$script:nodeFlags --experimental-sqlite"
      $answer = RunProbe $word
    }
    if (-not $answer.ok) { throw ("{0} {1}" -f $answer.code, $answer.error) }
  } catch { $problem = "$_"; $answer = $null }
  if ($problem -and $problem -ne $script:probeProblem) { Say "  (notes database probe: $problem)" }
  $script:probeProblem = $problem
  return $answer
}
function ProbeText($answer, [string]$word = "") {
  if (-not $answer) { return ("the notes database could not be read: " + $script:probeProblem) }
  $text = "{0} notes, {1} session log(s), {2} attachment(s), {3} image(s) in the log" -f $answer.notes, $answer.logNotes, $answer.attachments, $answer.logImages
  if ($word) { $text = ("'{0}' in today's log: {1}, in other notes: {2}; " -f $word, $answer.inLogText, $answer.inOtherText) + $text }
  return $text
}
# Required when the database can be read, reported otherwise: the line typed with this word is
# in today's session log, and in no other note (so it never went into a note open underneath).
function LogLineCheck([string]$name, [string]$word) {
  if (-not $dbReadable) { Check $name $false (ProbeText $null) $false; return }
  $found = WaitFor { $answer = DbProbe $word; if ($answer -and $answer.inLogText) { $answer } } 8000
  $last = if ($found) { $found } else { DbProbe $word }
  Check $name ([bool]$found -and $found.inOtherText -eq 0) (ProbeText $last $word)
}

$AppExe = (Resolve-Path $AppExe).Path
$appName = [System.IO.Path]::GetFileNameWithoutExtension($AppExe)
$dataDir = Join-Path ([System.IO.Path]::GetTempPath()) ("tn-native-" + [guid]::NewGuid().ToString("N"))
$chromeProfile = Join-Path ([System.IO.Path]::GetTempPath()) ("tn-chrome-" + [guid]::NewGuid().ToString("N"))
$env:TRADING_NOTES_DATA_DIR = $dataDir
$diagnostics = Join-Path (Resolve-Path $OutDir).Path "app-diagnostics.json"
$env:TRADING_NOTES_DIAGNOSTICS = $diagnostics
Remove-Item $diagnostics, "$diagnostics.keyboard.log", "$diagnostics.snapshot.log" -ErrorAction SilentlyContinue
$work = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
$screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
Say "Screen $($screen.Width)x$($screen.Height), work area $($work.X),$($work.Y) $($work.Width)x$($work.Height)"
Say "App: $AppExe"
# The notes database for the hotkey checks (the start-up report names the exact folder).
$dbFile = Join-Path (Join-Path $dataDir "library") "notes.db"
$dbProbe = Join-Path ([System.IO.Path]::GetTempPath()) ("tn-dbprobe-" + [guid]::NewGuid().ToString("N") + ".cjs")
$dbReadable = $false
$probeProblem = ""
$nodeFlags = "--no-warnings"
$nodeCommand = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
$nodeExe = if ($nodeCommand) { $nodeCommand.Path } else { $null }
try { [System.IO.File]::WriteAllText($dbProbe, $probeSource) } catch { Say "  (could not write the database probe: $_)"; $nodeExe = $null }
Say ("Node: " + $(if ($nodeExe) { $nodeExe } else { "not found; the notes database checks are reported for information only" }))

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
    # Every hotkey is in the report (show/hide and the six trading hotkeys), each registered.
    $expectedHotkeys = @("toggle", "quickNote", "snapshot", "risk", "candleTimer", "seeThrough", "openLog")
    $hotkeyReport = if ($report.PSObject.Properties["hotkeys"]) { $report.hotkeys } else { $null }
    $unreported = @($expectedHotkeys | Where-Object { -not $hotkeyReport -or -not $hotkeyReport.PSObject.Properties[$_] })
    Check "App reports all $($expectedHotkeys.Count) hotkeys" ($unreported.Count -eq 0) ($(if ($unreported.Count -gt 0) { "not reported: " + ($unreported -join ", ") } else { "" }))
    if ($hotkeyReport) {
      $missing = @($hotkeyReport.PSObject.Properties | Where-Object { -not $_.Value.registered } | ForEach-Object { "{0} {1} {2}" -f $_.Name, $_.Value.accelerator, $_.Value.error })
      Check "Trading hotkeys registered with Windows" ($missing.Count -eq 0) ($missing -join "; ")
    }
    if ($report.PSObject.Properties["dataDir"] -and $report.dataDir) { $dbFile = Join-Path $report.dataDir "notes.db" }
    # user32 through koffi, a native module shipped in the package: without it the notes can only
    # let go of the keyboard, not give it to the exact window that had it.
    $keyboardReturn = if ($report.PSObject.Properties["keyboardReturn"]) { $report.keyboardReturn } else { $null }
    Check "App can give the keyboard back to the exact window that had it (user32 through koffi)" ($keyboardReturn -and [bool]$keyboardReturn.available) ($(if ($keyboardReturn -and $keyboardReturn.error) { $keyboardReturn.error } elseif (-not $keyboardReturn) { "not reported" } else { "" }))
    # The same for reading where the page is in a browser window (user32 and dwmapi), for the snapshot.
    $snapshotPage = if ($report.PSObject.Properties["snapshotPage"]) { $report.snapshotPage } else { $null }
    Check "App can read browser window geometry for the snapshot (user32 and dwmapi through koffi)" ($snapshotPage -and [bool]$snapshotPage.available) ($(if ($snapshotPage -and $snapshotPage.error) { $snapshotPage.error } elseif (-not $snapshotPage) { "not reported" } else { "" }))
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
  # Its whole page is TradingView's dark background (#131722), with no focus ring or scroll bar
  # at its edges, so that the snapshot check can tell the page from the browser's own bars.
  $pageColour = [System.Drawing.Color]::FromArgb(0x13, 0x17, 0x22)
  $page = "data:text/html,<title>chartwindow</title><body style='margin:0;overflow:hidden;background:%23131722'><textarea id='t' autofocus style='display:block;box-sizing:border-box;width:100%25;height:100vh;margin:0;background:%23131722;color:white;font-size:28px;border:0;outline:none;resize:none' oninput='document.title=this.value'></textarea>"
  $halfWidth = [math]::Floor($work.Width / 2)
  Start-Process -FilePath $chromeExe -ArgumentList @("--user-data-dir=`"$chromeProfile`"", "--no-first-run", "--no-default-browser-check", "--disable-sync", "--new-window",
    "--window-position=$($work.X),$($work.Y)", "--window-size=$halfWidth,$($work.Height)", "`"$page`"") | Out-Null
  $chrome = WaitFor { $w = FindWindows "chartwindow" $browserName; if ($w.Count -gt 0) { $w[0] } } 30000
  Check "Stand-in chart window ($browserName) opens on the left half" ($null -ne $chrome)
  if ($null -eq $chrome) { throw "The browser window never appeared." }
  [void][Native]::MoveWindow($chrome, $work.X, $work.Y, $halfWidth, $work.Height, $true)
  Start-Sleep -Seconds 2
  Shot "02-side-by-side"
  # Before anything here could switch on the browser's accessibility support.
  ReportChildWindows $chrome "right after it opened"
  $earlyPage = PageWindowOf $chrome
  Check "The browser shows the web page in a page window of its own (Chrome_RenderWidgetHostHWND), without accessibility switched on" ($null -ne $earlyPage) ($(if ($earlyPage) { "page window " + (RectText $earlyPage) } else { "no shown Chrome_RenderWidgetHostHWND child window" })) $false

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
  # Hidden while they have the keyboard, the notes give it back (a hidden window must never
  # keep it: typing would go into notes that cannot be seen).
  Chord $Shortcut
  $hiddenAgain = WaitFor { if (-not [Native]::IsWindowVisible($notes)) { $true } } 4000
  $chartAgain = WaitFor { if ((ProcessNameOf ([Native]::GetForegroundWindow())) -eq $browserName) { $true } } 3000
  $fg = [Native]::GetForegroundWindow()
  Check "Hiding the notes with the shortcut gives the keyboard back to the chart" ([bool]$hiddenAgain -and [bool]$chartAgain) ("foreground: '" + (Title $fg) + "' [" + (ProcessNameOf $fg) + "]")
  Chord $Shortcut
  Check "The shortcut shows the notes again" ([bool](WaitFor { if ([Native]::IsWindowVisible($notes)) { $true } } 4000))
  Start-Sleep -Milliseconds 600

  # ---------------------------------------------------------------- tray icon
  # Informational: finding another app's tray icon depends on the Windows version and on
  # whether the icon sits in the overflow area.
  try {
    $icon = FindTrayIcon "Trading Notes"
    if ($icon) {
      $ix = [int]($icon.X + $icon.Width / 2); $iy = [int]($icon.Y + $icon.Height / 2)
      Click $ix $iy
      $trayHid = WaitFor { if (-not [Native]::IsWindowVisible($notes)) { $true } } 4000
      Check "Clicking the tray icon hides the notes" ([bool]$trayHid) ("clicked at $ix,$iy; minimized: " + [Native]::IsIconic($notes)) $false
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

  # ---------------------------------------------------------------- trading hotkeys
  # The notes take the keyboard only while a typing hotkey is open, then give it back to the
  # window that had it (WindowManager.releaseKeyboard). The app's keyboard log, printed at the
  # end, says how each hand-back was done.
  # Each quick note carries a word of its own, so the notes database can be searched for it.
  $firstProbe = DbProbe
  $dbReadable = $null -ne $firstProbe
  Check "Notes database readable with Node's node:sqlite (for the hotkey checks)" $dbReadable ($(if ($dbReadable) { "$dbFile; " + (ProbeText $firstProbe) } else { ProbeText $null })) $false
  $quickWord = "tnq" + (RandomLetters 8)
  $hiddenWord = "tnh" + (RandomLetters 8)
  $cr = RectOf $chrome
  $chartPoint = @(($cr.Left + 150), ($cr.Top + [int](($cr.Bottom - $cr.Top) / 2)))
  Click $chartPoint[0] $chartPoint[1]
  Check "Chart has the keyboard before the hotkeys" ((ProcessNameOf ([Native]::GetForegroundWindow())) -eq $browserName)
  Chord "ctrl+alt+n"
  $took = WaitFor { if ([Native]::GetForegroundWindow() -eq $notes) { $true } } 4000
  Check "Quick note (Ctrl+Alt+N) brings the keyboard to the notes" ([bool]$took)
  Shot "10-quick-note-open"
  TypeText "native $quickWord"
  Chord "enter"
  $back = WaitFor { if ((ProcessNameOf ([Native]::GetForegroundWindow())) -eq $browserName) { $true } } 4000
  $fg = [Native]::GetForegroundWindow()
  Check "Quick note gives the keyboard back to the chart" ([bool]$back) ("foreground: '" + (Title $fg) + "' [" + (ProcessNameOf $fg) + "]")
  Check "Notes stay visible and on top after a quick note" ([Native]::IsWindowVisible($notes) -and (IsTopmost $notes))
  # Not just for a moment: the notes do not take the keyboard back, and they stay on screen.
  Start-Sleep -Milliseconds 1000
  $fg = [Native]::GetForegroundWindow()
  Check "A second after the quick note the chart still has the keyboard and the notes are visible" (((ProcessNameOf $fg) -eq $browserName) -and [Native]::IsWindowVisible($notes) -and -not [Native]::IsIconic($notes)) ("foreground: '" + (Title $fg) + "' [" + (ProcessNameOf $fg) + "]")
  Check "The quick note's typing went to the notes, not to the chart" ((Title $chrome) -notmatch $quickWord) ("chart window title: '" + (Title $chrome) + "'")
  Shot "11-quick-note-done"
  LogLineCheck "The quick note is stored in today's session log (notes database)" $quickWord

  # From hidden notes: they show for the quick note and hide again afterwards.
  Chord $Shortcut
  $hiddenFirst = WaitFor { if (-not [Native]::IsWindowVisible($notes)) { $true } } 4000
  Check "The shortcut hides the notes before the hidden quick note" ([bool]$hiddenFirst)
  Click $chartPoint[0] $chartPoint[1]
  Chord "ctrl+alt+n"
  $shownForNote = WaitFor { if ([Native]::IsWindowVisible($notes) -and [Native]::GetForegroundWindow() -eq $notes) { $true } } 4000
  Check "Quick note shows hidden notes with the keyboard" ([bool]$shownForNote)
  Shot "11b-quick-note-from-hidden"
  TypeText "from hidden $hiddenWord"
  Chord "enter"
  $rehidden = WaitFor { if (-not [Native]::IsWindowVisible($notes)) { $true } } 4000
  Check "Quick note hides the notes again when they were hidden" ([bool]$rehidden)
  $hiddenBack = WaitFor { if ((ProcessNameOf ([Native]::GetForegroundWindow())) -eq $browserName) { $true } } 4000
  Check "The chart has the keyboard after the hidden quick note" ([bool]$hiddenBack) ("foreground: '" + (Title ([Native]::GetForegroundWindow())) + "'")
  Start-Sleep -Milliseconds 1000
  $fg = [Native]::GetForegroundWindow()
  Check "A second later the notes are still hidden and the chart still has the keyboard" ((-not [Native]::IsWindowVisible($notes)) -and ((ProcessNameOf $fg) -eq $browserName)) ("foreground: '" + (Title $fg) + "' [" + (ProcessNameOf $fg) + "]")
  Check "The hidden quick note's typing went to the notes, not to the chart" ((Title $chrome) -notmatch $hiddenWord) ("chart window title: '" + (Title $chrome) + "'")
  LogLineCheck "The quick note typed from hidden notes is stored in today's session log" $hiddenWord
  Chord $Shortcut
  [void](WaitFor { if ([Native]::IsWindowVisible($notes)) { $true } } 4000)
  Click $chartPoint[0] $chartPoint[1]

  # Risk calculator: $100 with an 8-point stop on MES is 2 contracts ($40 each).
  Set-Clipboard -Value "before"
  Chord "ctrl+alt+r"
  [void](WaitFor { if ([Native]::GetForegroundWindow() -eq $notes) { $true } } 4000)
  TypeText "100"
  Chord "tab"
  TypeText "8"
  Shot "12-risk-calculator"
  Chord "enter"
  $copied = WaitFor { if ((Get-Clipboard) -eq "2") { $true } } 4000
  Check "Risk calculator (Ctrl+Alt+R) copies the contract count" ([bool]$copied) ("clipboard: '" + (Get-Clipboard) + "'")
  $riskBack = WaitFor { if ((ProcessNameOf ([Native]::GetForegroundWindow())) -eq $browserName) { $true } } 4000
  Check "Risk calculator gives the keyboard back to the chart" ([bool]$riskBack) ("foreground: '" + (Title ([Native]::GetForegroundWindow())) + "'")

  # Snapshot: captured without the notes ever taking the keyboard, and stored like a pasted
  # screenshot: one more attachment in the database, and an image in today's log.
  # Checked on its own: if a hand-back above failed, the chart is given the keyboard again first.
  if ((ProcessNameOf ([Native]::GetForegroundWindow())) -ne $browserName) {
    Say "  (the chart did not have the keyboard before the snapshot; clicking it so the snapshot is checked on its own)"
    Click $chartPoint[0] $chartPoint[1]
  }
  # A TradingView-like title for the stand-in page, so that the snapshot takes the browser window
  # rather than the display under the pointer: typed into the page's text box, which sets the
  # page title. (Only this stand-in page is typed into; the app never sends keys to a browser.)
  TypeText " tradingview"
  $tvTitle = WaitFor { if ((Title $chrome) -match "tradingview") { $true } } 4000
  Check "The stand-in chart page has a TradingView-like title, so the snapshot takes the browser window" ([bool]$tvTitle) ("chart window title: '" + (Title $chrome) + "'")
  ReportChildWindows $chrome "before the snapshot"
  $snapFrame = FrameOf $chrome
  $snapPage = PageWindowOf $chrome
  $snapLogFile = "$diagnostics.snapshot.log"
  $snapLogBefore = if (Test-Path $snapLogFile) { @(Get-Content $snapLogFile).Count } else { 0 }
  $snapBefore = if ($dbReadable) { DbProbe } else { $null }
  $stolen = $false
  Chord "ctrl+alt+s"
  for ($i = 0; $i -lt 15; $i++) { if ([Native]::GetForegroundWindow() -eq $notes) { $stolen = $true }; Start-Sleep -Milliseconds 100 }
  Check "Snapshot (Ctrl+Alt+S) leaves the keyboard with the chart" ((-not $stolen) -and ((ProcessNameOf ([Native]::GetForegroundWindow())) -eq $browserName))
  Shot "13-after-snapshot"
  if ($snapBefore) {
    $snapStored = WaitFor { $answer = DbProbe; if ($answer -and ($answer.attachments -gt $snapBefore.attachments -or $answer.logImages -gt $snapBefore.logImages)) { $answer } } 10000
    $snapAfter = if ($snapStored) { $snapStored } else { DbProbe }
    Check "Snapshot is stored in the notes database (one more image)" ($null -ne $snapStored) ("before: " + (ProbeText $snapBefore) + "; after: " + (ProbeText $snapAfter))
    if ($snapStored) {
      $snapLogged = WaitFor { $answer = DbProbe; if ($answer -and $answer.logImages -gt $snapBefore.logImages) { $answer } } 6000
      Check "Snapshot appears in today's session log" ($null -ne $snapLogged) (ProbeText $(if ($snapLogged) { $snapLogged } else { DbProbe })) $false
      # What the app says it captured and kept (its snapshot report, one line per snapshot).
      $snapReport = $null
      if (Test-Path $snapLogFile) {
        $lines = @(Get-Content $snapLogFile)
        if ($lines.Count -gt $snapLogBefore) { try { $snapReport = $lines[-1] | ConvertFrom-Json } catch { } ; Say ("  app's snapshot report: " + $lines[-1]) }
      }
      if (-not $snapReport) { Say "  (the app wrote no snapshot report)" }
      Check "Snapshot takes the browser window, not the display" ($snapReport -and $snapReport.from -eq "window") ($(if ($snapReport) { "from: $($snapReport.from)" } else { "no report" }))
      # The stored picture itself: of the browser window only the web page is kept.
      $latest = $snapStored.latest
      $picture = $null
      if ($latest) {
        $pictureFile = Join-Path (Join-Path (Split-Path $dbFile -Parent) "attachments") $latest.file
        try { $picture = New-Object System.Drawing.Bitmap $pictureFile } catch { Say "  (the stored snapshot could not be opened: $_)" }
      }
      if ($picture) {
        try {
          $frameW = $snapFrame.Right - $snapFrame.Left; $frameH = $snapFrame.Bottom - $snapFrame.Top
          # Chrome's tab strip and toolbar together are well over 40 pixels high at any scale.
          $browserBar = 40
          $sizeText = "picture {0}x{1}, browser window frame {2}x{3}, page window {4}" -f $picture.Width, $picture.Height, $frameW, $frameH, $(if ($snapPage) { "{0}x{1}" -f ($snapPage.Right - $snapPage.Left), ($snapPage.Bottom - $snapPage.Top) } else { "not found" })
          Check "Snapshot of the browser window is shorter than the window by at least its tab strip and toolbar" ($picture.Height -le ($frameH - $browserBar) -and $picture.Width -le $frameW) $sizeText
          if ($snapPage) {
            $pageW = $snapPage.Right - $snapPage.Left; $pageH = $snapPage.Bottom - $snapPage.Top
            Check "Snapshot is the size of the browser's page window" ([math]::Abs($picture.Width - $pageW) -le 2 -and [math]::Abs($picture.Height - $pageH) -le 2) $sizeText $false
          }
          # Its top corners (and the middle of its top row) are the page's background, not the browser's bars.
          $near = { param($c) [math]::Abs($c.R - $pageColour.R) -le 8 -and [math]::Abs($c.G - $pageColour.G) -le 8 -and [math]::Abs($c.B - $pageColour.B) -le 8 }
          $corners = @(@(0, 0), @([int][math]::Floor($picture.Width / 2), 0), @(($picture.Width - 1), 0)) | ForEach-Object { $picture.GetPixel($_[0], $_[1]) }
          $cornerText = ($corners | ForEach-Object { "#{0:x2}{1:x2}{2:x2}" -f $_.R, $_.G, $_.B }) -join " "
          Check "Snapshot's top-left and top-right pixels are the page background (#131722), not the browser's tab strip" (@($corners | Where-Object { -not (& $near $_) }).Count -eq 0) ("top row left, middle, right: $cornerText")
        } finally { $picture.Dispose() }
      } else {
        Check "Snapshot of the browser window is shorter than the window by at least its tab strip and toolbar" $false "the stored picture could not be found or opened"
      }
    }
  } else {
    Check "Snapshot is stored in the notes database (one more image)" $false (ProbeText $null) $false
  }
  $fg = [Native]::GetForegroundWindow()
  Check "The chart still has the keyboard once the snapshot is stored" ((ProcessNameOf $fg) -eq $browserName) ("foreground: '" + (Title $fg) + "' [" + (ProcessNameOf $fg) + "]")
  # See-through on and off again, also without taking the keyboard. Reported only, as the
  # alpha is read from Windows' layered-window state, which Electron owns.
  if ((ProcessNameOf ([Native]::GetForegroundWindow())) -ne $browserName) {
    Say "  (the chart did not have the keyboard before see-through; clicking it so see-through is checked on its own)"
    Click $chartPoint[0] $chartPoint[1]
  }
  $alphaBefore = AlphaOf $notes
  Chord "ctrl+alt+o"
  $wentSeeThrough = WaitFor { if ((AlphaOf $notes) -lt 255) { $true } } 3000
  Start-Sleep -Milliseconds 300
  $alphaSeeThrough = AlphaOf $notes
  $keptAfterFirst = (ProcessNameOf ([Native]::GetForegroundWindow())) -eq $browserName
  Shot "14-see-through"
  Chord "ctrl+alt+o"
  $solidAgain = WaitFor { if ((AlphaOf $notes) -ge 255) { $true } } 3000
  $alphaAfter = AlphaOf $notes
  Check "See-through (Ctrl+Alt+O) changes the notes' opacity, and pressing it again makes them solid" ([bool]$wentSeeThrough -and [bool]$solidAgain) ("layered alpha $alphaBefore -> $alphaSeeThrough -> $alphaAfter") $false
  # Leave the notes solid for the steps below, whichever press did not arrive.
  if (-not $solidAgain) { Chord "ctrl+alt+o"; [void](WaitFor { if ((AlphaOf $notes) -ge 255) { $true } } 3000) }
  Check "See-through (Ctrl+Alt+O) leaves the keyboard with the chart" ($keptAfterFirst -and ((ProcessNameOf ([Native]::GetForegroundWindow())) -eq $browserName))
  Check "Still exactly one notes window after the hotkeys" ((FindWindows "^Trading Notes$" $appName).Count -eq 1)

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
  # The second launch above brought the notes forward with the keyboard, so the window noted
  # then (the chart) is the one that gets it back.
  $closedBack = WaitFor { if ((ProcessNameOf ([Native]::GetForegroundWindow())) -eq $browserName) { $true } } 3000
  $fg = [Native]::GetForegroundWindow()
  Check "Closing the notes gives the keyboard back to the chart" ([bool]$closedBack) ("foreground: '" + (Title $fg) + "' [" + (ProcessNameOf $fg) + "]")
  Check "The app keeps running in the tray after the window is closed" (@(Get-Process -Name $appName -ErrorAction SilentlyContinue).Count -gt 0)
  Chord $Shortcut
  Check "The shortcut brings it back after closing" ([bool](WaitFor { if ([Native]::IsWindowVisible($notes)) { $true } } 4000))
  # Clicked into rather than brought forward: no window was noted, so the keyboard goes to the
  # app used last (the top ordinary window below the notes).
  Start-Sleep -Milliseconds 600
  Click $chartPoint[0] $chartPoint[1]
  $nr = RectOf $notes
  Click $centerX ($nr.Top + 12)
  $clickedIn = WaitFor { if ([Native]::GetForegroundWindow() -eq $notes) { $true } } 3000
  Chord $Shortcut
  $hiddenAfterClick = WaitFor { if (-not [Native]::IsWindowVisible($notes)) { $true } } 4000
  $backAfterClick = WaitFor { if ((ProcessNameOf ([Native]::GetForegroundWindow())) -eq $browserName) { $true } } 3000
  $fg = [Native]::GetForegroundWindow()
  Check "Clicking into the notes and hiding them gives the keyboard back to the chart" ([bool]$clickedIn -and [bool]$hiddenAfterClick -and [bool]$backAfterClick) ("clicked in: $([bool]$clickedIn); foreground: '" + (Title $fg) + "' [" + (ProcessNameOf $fg) + "]")
  Shot "09-final"
  # How each hand-back of the keyboard was done, as the app recorded it: 'returned' (to the
  # window noted when a hotkey or the shortcut took the keyboard), 'returned-below' (to the app
  # used last, when none was noted), 'blur-below' (let go below the always-on-top band).
  $keyboardLog = "$diagnostics.keyboard.log"
  if (Test-Path $keyboardLog) {
    $hows = @(Get-Content $keyboardLog | ForEach-Object { try { ($_ | ConvertFrom-Json).how } catch { "?" } })
    Say ("  keyboard hand-backs recorded by the app: " + ($hows -join ", "))
  } else {
    Say "  (the app recorded no keyboard hand-backs)"
  }
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
  Remove-Item -Recurse -Force $dataDir, $chromeProfile, $dbProbe -ErrorAction SilentlyContinue
  $results | ConvertTo-Json | Set-Content (Join-Path $OutDir "native-check.json")
}

Say ""
Say ("{0} checks, {1} failed. Lines marked INFO are reported but do not fail the run." -f $results.Count, $failed)
if ($failed -gt 0) { exit 1 }
