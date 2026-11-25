# Trading Notes

A quiet, spacious notepad for Windows that stays visible beside your chart. Click anywhere to
write, paste a screenshot, and go back to an organised board of notes. Everything is stored on
your computer: no account, no subscription, no network, no AI service.

## Install

**From a build** (no tools needed): download one of the two files from the repository's
*Releases* page on GitHub. (Every run of the *Build and test* workflow also attaches them as
the *Trading-Notes-Windows* artifact.)

| File | Use it when |
| --- | --- |
| `Trading-Notes-Setup-x.y.z.exe` | You want a normal install with Start menu and desktop shortcuts and an uninstaller. The installer asks whether to install just for you (the default, no administrator rights needed) or for everyone on the computer. |
| `Trading-Notes-Portable-x.y.z.exe` | You want a single file you can run from anywhere without installing. |

The app is not code-signed, so the first time you run it Windows SmartScreen may show
"Windows protected your PC". Choose **More info**, then **Run anyway**.

**From source** (Windows, Node.js 22 or newer):

```bash
npm ci
```

```bash
npm run package:win
```

The installer and the portable app are written to `release/`.

## Keeping Chrome beside the notepad

Trading Notes opens on the **right half** of the screen your mouse is on, and stays on top of
other windows. It never moves or resizes Chrome for you. To give the chart the other half:

1. Click the Chrome window.
2. Press **Win + Left arrow**. Chrome snaps to the left half.

The whole chart is now visible next to your notes. (If you prefer notes on the left, choose
*Left half* in Settings and snap Chrome with **Win + Right arrow**.)

Clicking the chart gives Chrome the keyboard, as usual. The notes stay where they are, the same
size, with any half-written note still open; they only take the keyboard when you click them or
ask for them with the shortcut.

## Everyday controls

**Opening and hiding**

| Do this | To |
| --- | --- |
| **Ctrl + Shift + Space** (from any app) | Show or hide the notes. Change it in Settings. |
| Click the tray icon | Show or hide the notes. Right-click for a quick note, a chart snapshot, dock side, always-on-top, opacity and Quit. |
| Close button, or Alt + F4 | Hide to the tray. Your notes are saved first. |

Hiding the notes (any of these ways) gives the keyboard back to the app you came from, so you
can keep typing in Chrome without clicking it first.
| Gear, then **Quit Trading Notes** | Actually exit. |
| **Ctrl + ,** | Open Settings: hotkeys, dock side, always on top, opacity, start with Windows, candle chime, risk calculator defaults, theme, font and size. |

**Hotkeys for trading**

These work from any app, including while Chrome and your chart have the keyboard. They use
Ctrl + Alt because Chrome already uses Ctrl + Shift + N, T, R and O, and a global hotkey would
take those away from Chrome. Each one can be given another combination, or switched off, in
Settings (**Ctrl + ,**) → *Hotkeys*.

| Press | To |
| --- | --- |
| **Ctrl + Alt + N** | **Quick note.** A slim one-line strip opens at the top of the notes. Type and press **Enter**: the line goes into today's session log as `10:32:14 — your text` (your local time, 24-hour). **Esc** cancels and writes nothing. Either way the keyboard goes back to where it was: hidden notes hide again, and if Chrome had the keyboard, Chrome gets it back. A note you were writing stays exactly as it was, with the caret where you left it. |
| **Ctrl + Alt + S** | **Snapshot the chart.** The Chrome window showing your TradingView chart is captured at full size and added to today's log as a picture, captioned with the time and the symbol and price from the tab title (`10:32:14 · ES1! 6,123.25`; just the time if the title does not show them). The notes do not take the keyboard. Without a TradingView window, the screen under the pointer is captured instead, minus the notes when they are docked beside the chart. A short message confirms it (or, while the notes are hidden, the tray icon's tooltip shows *Last chart snapshot*); if capturing is not possible, the message says so. |
| **Ctrl + Alt + R** | **Risk calculator.** Pick MES, ES, MNQ or NQ, type the dollars you are willing to lose and the stop distance in points (or ticks: the *pts / ticks* toggle), or type an entry and a stop price to fill the distance. It shows the number of contracts (risk ÷ (stop × point value), rounded down), what that size really risks, and the risk per contract; if not even one contract fits it says *Stop too wide for this risk*. A stop between ticks is rounded up to the next tick. **Enter** copies the contract count to the clipboard and closes; **Esc** closes. The keyboard goes back as for a quick note. The dollar risk, the unit and the instrument are remembered. It only does the arithmetic: it never places or suggests an order. |
| **Ctrl + Alt + T** | **Candle timer.** Shows or hides a small countdown in the title bar to the next candle close, for example `5m 2:13`. Click it to choose 1, 5 or 15 minutes or 1 hour (remembered; 5 minutes at first), to turn the chime off, or to hide it. Candles close on the minute boundaries of your computer's clock (1-hour candles on the hour). The last 10 seconds show in teal; at the close there is a short soft chime and a brief pulse (no pulse with Reduced motion). It keeps time while the notes are hidden or minimised. Off at first; nothing runs while it is off. |
| **Ctrl + Alt + O** | **See-through on/off.** Switch between solid and the see-through opacity you chose last (70 % until you choose one). The keyboard stays where it is. |
| **Ctrl + Alt + L** | **Open today's log.** Shows the notes, ready to type at the end of today's session log. If the quick note strip is open with text in it, that line is added to the log first. |

*Today's session log* is one ordinary note per day, titled like *Session log · Wed 25 Nov* and
placed at the top of the board the first time you use it that day. Its lines are normal
paragraphs: searchable, editable and movable like any note. Delete it and the next quick note
starts a new one. If the log is open in the editor when a quick note or snapshot arrives, it is
added right there, below what you are typing.

On some keyboard layouts (German, French, Polish and others) **Ctrl + Alt** is the same as
**AltGr**, so Ctrl + Alt + a letter may be a key you type characters with. If a hotkey types a
character instead of doing its job, or takes a character you need, give it another combination
in Settings. When Windows or another app already owns a combination, Settings says so and the
hotkey keeps the combination it had.

**Writing**

| Do this | To |
| --- | --- |
| Click empty space on the board | Start a note right there: between two notes, beside one, or at the end. |
| **Ctrl + N** | Start a note at the end without the mouse. |
| Click a note | Open it for editing, with the caret where you clicked. |
| **Enter** | New paragraph. |
| **Ctrl + Enter**, *Log note*, *Back*, or **Esc** | Return to the board. The note is kept either way. |
| **Ctrl + V** | Paste text, or a screenshot you just took (Win + Shift + S). |
| **Ctrl + Shift + V** | Paste as plain text. |
| Drag an image file in | Onto empty board space: a new image note there. Into an open note: at that spot. |
| Select text | A small bar appears for bold, italic, underline, strikethrough, colour, highlight and links. |
| Bar under the note | Paragraph style, font, size, Draw, lists, checklists, link, add image, undo and redo. The small arrow on its edge folds it away. |
| Click an image, drag its corner | Resize it (the proportions are kept). Type under it to add a caption. |
| **Ctrl + click** a link while editing | Open it in your browser. On the board a plain click opens it. |
| *Add tag*, under the note | Label the note (Rules, Setups and Journal are suggested; any word works). Find can filter by tag. |

Notes save themselves as you type (within about half a second). *Log note* is just the way back to the board; it is not the
only thing that saves. A new note you leave completely empty is thrown away; a note with only a
screenshot is kept.

**Arranging**

| Do this | To |
| --- | --- |
| Hover a note, drag the grip handle | Move it. The other notes move aside and show where it will land before you let go. |
| Drop in the middle of a row | Place it above or below that row. |
| Drop at the left or right edge | Put two notes side by side. A row holds at most two: if it is already full, the note that no longer fits moves to its own row next to the pair. Nothing is ever replaced or merged. |
| **Alt + Arrow keys** on a focused note | The same moves from the keyboard (Tab reaches each note). |
| **Ctrl + Z** on the board, or *Undo* in the message | Undo the last move or delete. |
| **Delete** on a focused note | Move it to Trash. |
| Gear, then **Trash** | Get a deleted note back (*Restore* puts it where it was), or delete it for good. Nothing leaves Trash by itself. |

When the window is narrow, a side-by-side pair is shown stacked; it goes back to side by side
when the window is wide enough again.

**Finding**

| Do this | To |
| --- | --- |
| **Ctrl + K**, or gear then *Find notes* | Search titles, text, image captions and tags. Enter shows the note on the board; Ctrl + Enter opens it. |
| Hover a note, click the pin | Pin it. Pinning adds it to the pinned list; the note does not move. |
| Gear then *Pinned notes* | Jump to a pinned note, or drag to reorder the list. |

Search looks at the words you typed. It does not read text inside screenshots.

**Drawing**

| Do this | To |
| --- | --- |
| **Draw** (the brush beside Font and Size in the bar under the note), or **Ctrl + Shift + D** | Open a blank drawing sheet that covers the whole window below the title bar. The shortcut works from the text, the title or a caption, and also while the formatting bar is hidden. |
| Draw with the mouse, a pen or a finger | Get smooth ink with slightly tapered ends that follows the pointer. A tap leaves a dot. A pen's pressure changes how thick the line is, and the pen's eraser end erases. The pointer shows as a dot the size and colour of the brush (a ring when erasing). |
| Colour dots | Pick the ink colour: the note's text colour, then muted, red, orange, amber, green, teal, blue, violet and pink. When the dots have the keyboard, the arrow keys move between them. |
| *Fine*, *Medium*, *Bold*, or **1**, **2**, **3** | Set the brush size. The eraser uses it too. |
| *Eraser*, or **E** | Rub out ink. Press it again, or pick a colour, to go back to drawing. |
| **Ctrl + Z**, then **Ctrl + Y** or **Ctrl + Shift + Z** (or *Undo* and *Redo*) | Undo and redo strokes. |
| *Clear* | Start over. *Undo* brings it all back. |
| **Done**, or **Ctrl + Enter** | Put the drawing in the note at the caret, the same way a pasted screenshot goes in. It is cropped to what you drew and scaled to the note: a drawing that used the whole width of the sheet fills the note's width, and a smaller sketch keeps its size relative to the sheet. Like any image it can be resized, captioned and opened larger. In the note, one **Ctrl + Z** takes it out again. If nothing was drawn, Done just closes. While the sheet is open, Ctrl + Enter finishes the drawing and does not log the note. |
| **Cancel**, or **Esc** | Close without adding anything. If you drew something it asks *Discard this drawing?* first, with *Keep drawing* and *Discard*. Pressing Esc again keeps drawing. |
| Point at a drawing in a note, then the pencil (**Edit drawing**) | Reopen it at the size it was drawn and keep drawing on top; the eraser works on it too. It opens on the sheet and in the colours of the theme it was drawn in, even if you have changed theme since, so it stays readable. Done replaces it in place and keeps its width and caption. Cancel leaves it as it was. If you clear it and press Done, it is removed from the note, and Ctrl + Z brings it back. |

Resizing the window while the sheet is open never loses or stretches anything you drew. While the sheet is open, the title bar can still move, minimise or hide the window, and the drawing is still there when the window comes back. The menu, Find (Ctrl + K) and Settings (Ctrl + ,) wait until you are done, and Tab moves only between the sheet's own controls.

**Folding away the formatting bar**

| Do this | To |
| --- | --- |
| The small arrow tab on the top-right edge of the bar under a note (*Hide formatting*) | Fold the bar away so the note gets the room. A small tab stays at the bottom-right edge; click it (*Show formatting*) to bring the bar back. Your choice is remembered for every note and after a restart. Every keyboard shortcut, the selection bar and Ctrl + Shift + D keep working while the bar is hidden. |

**See-through notes**

If the notes cover something you need to see, such as a chart or a video you are taking notes on, make them see-through. They stay see-through while you write in them.

| Do this | To |
| --- | --- |
| Click the drop icon next to the gear | Open the opacity control: a slider from 30 % to 100 % (the window changes as you drag it), quick choices for 50 %, 70 %, 85 % and 100 %, and a *Solid while I use it* switch. The drop shows the current state at a glance: it is full when the notes are solid, and it drains and turns teal as they become see-through. |
| Arrow keys on the slider | Change it by 5 % per press. Page Up / Page Down change it by 10 %. Home goes to 30 %, End to 100 %. |
| Scroll the mouse wheel over the drop | Change it by 5 % per notch (scroll up for more solid). A small readout under the drop shows the new value. You don't need to click the notes first. |
| **Ctrl + Shift + Minus** / **Ctrl + Shift + Plus** (the = key) | Make the notes 5 % more see-through or more solid, from anywhere in the notes window. The shortcut is shown in the drop's tooltip. |
| Right-click the tray icon, then **Opacity** | Choose 100 %, 85 %, 70 % or 50 %. A value you set in between is listed too, with a check mark. |
| Settings (**Ctrl + ,**), *Window* section | The same slider and *Solid while I use it* switch. |

The value is saved when you stop adjusting and is kept across restarts. See-through notes open see-through, without flashing solid first. The lowest setting is 30 %, so the notes never get lost on the screen.

*Solid while I use it* is off by default. Turn it on if you want the notes see-through only while you are not using them. They then turn fully solid while the pointer is over them or you are typing in them, and fade back to your chosen opacity shortly after the pointer leaves and you click back into another window. Brushing past the edge of the window does not make them flicker. While you adjust the opacity, the notes show exactly the value you are choosing, even with this switch on.

Changing the opacity never takes the keyboard away from your chart and never changes which window is on top. With Reduced motion the change is instant; otherwise it is a short fade.

**Under the pointer**

The green line that used to follow the pointer over empty board space is gone, and nothing replaces it. The pointer itself now shows what a click will do. These pointers are the app's own, drawn to match the theme (Charcoal, Midnight or Paper) and sharp at 100 to 200 % display scaling. Window edges keep the normal Windows resize pointers, and the title bar and scrollbars show the normal Windows arrow.

| Pointer | Where | Means |
| --- | --- | --- |
| Pen nib (teal) | Empty board space | Click to start a note right there: between two notes, beside one, or at the end. |
| Nib with a drop of ink | While the mouse button is held down on empty space | The pen is touching the page. Move away more than a few pixels before letting go and nothing is written. |
| Pointing hand | A note's sheet, its title and tags; buttons and links | Click to open or press. |
| I-beam | A note's text on the board; the note text, title and other text fields in the editor | Click to put the caret exactly there. |
| Open hand / closed hand | A note's grip handle / while carrying a note (anywhere on screen) | Drag to move the note. |
| Magnifier + / − | Images in notes and in the image preview | Zoom in or out. When zoomed in, the open and closed hand pan the image. |
| Arrow | Everywhere else | |

The app's pointers are always the standard size. If you have made the Windows mouse pointer larger or changed its colour (Settings → Accessibility → Mouse pointer and touch), that setting applies only to the window edges, the title bar and the scrollbars.

**Small touches** (all turn off with Settings (**Ctrl + ,**) → *Motion* → *Reduced*; *Follow Windows* uses the Windows animation setting):

- Clicking empty space leaves a quick drop of ink where you clicked, and the new note opens outward from that point.
- Buttons give slightly when pressed and spring back when you let go. A press that starts right at the edge of a button still counts.
- Ticking a checklist item makes the box spring and a small ring spread around it; the item's text fades and a line fades in through it. Items that are not done carry no strike, so copying a checklist into another app keeps them plain.
- Pinning a note gives the pin a small "pushed in" pop. Unpinning doesn't.

Nothing keeps moving afterwards: each effect stops by itself within about half a second.

## Backup and import

Gear, then **Backup and import**.

- **Export backup** writes one `.tnbackup` file containing every note (including Trash), every
  screenshot at full resolution, your arrangement, pins and settings. Keep a copy somewhere
  other than this computer.
- **Import** first shows what the chosen file contains. Then you choose:
  - **Add to my notes** keeps everything you have and adds the backup's notes at the bottom of
    the board. Notes you already have are skipped; if the wording differs, the backup's version
    is added as a separate copy. Nothing is overwritten.
  - **Replace my notes with this backup** restores exactly what the backup holds. It asks for
    confirmation, and first saves what you have now to an automatic safety backup in the
    `backups` folder inside the notes folder.

A `.tnbackup` file is an ordinary zip (`manifest.json`, `data.json`, `attachments/`).

## Where your notes live

`%APPDATA%\Trading Notes\library\`

| Item | Contents |
| --- | --- |
| `notes.db` | Notes, arrangement, pins and settings (SQLite). |
| `attachments\` | Your screenshots: the original file plus a smaller preview for large ones. |
| `backups\` | Automatic safety copies (before a restore, before a data format upgrade). |

Settings shows this folder and can open it. Uninstalling the app does not delete it.

To keep notes somewhere else, set the environment variable `TRADING_NOTES_DATA_DIR` to a folder
before starting the app.

Screenshots that no note uses any more are kept for 14 days before the app tidies them away,
so an image you cut from one note can still be pasted into another later.

**What "saved" means.** While you type, a note is written about half a second after you pause,
at least every second and a half if you keep typing without a pause, and immediately when you
log it, hide the window or quit. If the app or Windows stops
unexpectedly, the next start opens the note you were writing as it was last saved; at most the
last moment of typing before the stop can be missing. If a save fails (for example the disk is
full), the note stays open with a "Not saved" message and a *Try again* button, and it never
claims to be saved. If you choose Quit while a save is failing, the app asks before closing
instead of dropping the text.

## What has been verified, and what has not

Every push builds the app on a real Windows machine and runs three things there
(`.github/workflows/build.yml`):

| Check | What it covers |
| --- | --- |
| Unit tests | Layout rules (no note is ever lost or overwritten), storage, stale-save rejection, Trash, backup round trip and import validation, search, window placement on made-up monitor arrangements. |
| Desktop tests | The real app driven through the acceptance checks: writing and autosave, screenshots by paste, drop and file picker, formatting surviving a restart, rearranging, narrow and wide layouts, pins, search, Trash, backup and import, docking, hide and show, drafts surviving hide, quit and a crash, a failed save, an unavailable shortcut, a window left off screen, and performance with 300 notes and 80 screenshots. |
| Native window check | `scripts/windows-native-check.ps1`, with real mouse and keyboard input against a real Chrome window: the notes are always-on-top and stay put; every click on Chrome gives Chrome the keyboard; the notes never take focus back; typing lands in Chrome; the notes stay above a maximized and a fullscreen Chrome; the global shortcut hides and shows the one window, and hiding gives the keyboard back to Chrome; a second launch does not open a second window; Alt+F4 hides to the tray and gives Chrome the keyboard; the tray icon exists; the trading hotkeys with real key presses (quick note and risk calculator give the keyboard back to Chrome, also from hidden notes; snapshot and see-through never take it; what was typed is in today's log). |

Not verified by automation, so worth a look on your own machine:

- **Clicking the tray icon.** The check confirms the icon is created, but could not locate it
  in the hidden-icons flyout to click it. It runs the same code as the shortcut.
- **More than one monitor, and scaling other than 100%.** The placement rules are unit-tested
  with multi-monitor and scaled arrangements, and the interface was reviewed at 125% and 150%,
  but the CI machine has a single 1920x1080 screen at 100%. To check: move the notes to a
  second monitor, quit, start again (they should reopen there); then unplug that monitor
  (they should move to the main screen).
- **Start with Windows.** The setting is wired to the Windows login items but was not
  exercised by a real sign-in.
- **Drawing with a real pen or touch screen.** Pen pressure, the pen's eraser end and touch are
  handled in code; the tests draw with a mouse.
- **See-through notes with *Solid while I use it* switched on.** How Windows reports the pointer
  over the title bar strip and window edges was not exercised automatically. With the switch off
  (the default) this does not come into play.
- **The new pointers at 125% and 150% display scaling on a real screen.** They were checked at
  those scales on Linux, not on Windows hardware.
- **Windows shutting down while you type.** Handled in code (pending text is written, and the
  next start is honest about anything that was not), not exercised by a real shutdown.

Known limitations: the app is not code-signed (SmartScreen asks once); search does not read
text inside screenshots; there is no sync between computers (use Backup and import).

## Development

```bash
npm ci
```

| Command | What it does |
| --- | --- |
| `npm run dev` | Run the app with live reload. Uses a separate "Trading Notes (dev)" data folder. |
| `npm run typecheck` | Type-check main process, window and tests. |
| `npm test` | Unit tests: layout rules, storage, backup, search, window placement. |
| `npm run build` | Production build into `out/`. |
| `npm run test:e2e` | Build, then drive the real app through the acceptance checks (Playwright). On Linux run it under `xvfb-run -a`. |
| `npm run package:win` | Build the Windows installer and portable app into `release/`. |
| `npm run icons` | Regenerate the icons from the SVG in `scripts/make-icons.cjs`. |
| `pwsh scripts/windows-native-check.ps1` | On Windows, after packaging: verify always-on-top, focus and shortcut behaviour against a real Chrome window. |

Layout of the source:

| Path | Role |
| --- | --- |
| `src/shared/` | Pure logic used everywhere: data model, board layout rules, click and drag targeting, content sanitising, search, window placement. |
| `src/main/` | Electron main process: the window, tray, global shortcut, startup entry, IPC handlers. |
| `src/main/store/` | Persistence: SQLite (Electron's built-in `node:sqlite`), managed image files, backup and import. No Electron imports, so it is unit-tested directly. |
| `src/preload/` | The only bridge to the window (`window.tn`). The page has no Node or file access. |
| `src/renderer/` | The React interface: board, editor (Tiptap), find and pins, settings, backup, trash. |
| `tests/unit/`, `tests/e2e/` | Unit tests and desktop tests. |

The stack is Electron, React, TypeScript, Tiptap (free extensions only), dnd-kit and SQLite.
Every dependency is bundled at build time except one: [koffi](https://koffi.dev/), which lets
the app ask Windows which window has the keyboard and give it back to that window (Electron
cannot do either). It is shipped as its prebuilt Windows module, so nothing needs compiling.
If it ever fails to load, the notes still let go of the keyboard in a way that hands it to the
app below them.

**Growing into a trading journal.** A note has a `kind` (only `note` today) and a free-form
`extra` field, and the database has a schema version with a migration list
(`src/main/store/db.ts`). Trade fields can be added as a new kind plus a migration without
touching how notes are stored, arranged, pinned or searched.
