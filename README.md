# Trading Notes

A quiet, spacious notepad for Windows that stays visible beside your chart. Click anywhere to
write, paste a screenshot, and go back to an organised board of notes. Everything is stored on
your computer: no account, no subscription, no network, no AI service.

## Install

**From a build** (no tools needed): take one of the two files produced by the build
(`release/` locally, or the *Trading-Notes-Windows* artifact of the *Build and test* workflow
on GitHub).

| File | Use it when |
| --- | --- |
| `Trading-Notes-Setup-x.y.z.exe` | You want a normal install with Start menu and desktop shortcuts and an uninstaller. Installs for your user only; no administrator rights needed. |
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
| Click the tray icon | Show or hide the notes. Right-click for dock side, always-on-top and Quit. |
| Close button, or Alt + F4 | Hide to the tray. Your notes are saved first. |
| Gear, then **Quit Trading Notes** | Actually exit. |

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
| Bar under the note | Paragraph style, font, size, lists, checklists, link, add image, undo and redo. |
| Click an image, drag its corner | Resize it (the proportions are kept). Type under it to add a caption. |
| **Ctrl + click** a link while editing | Open it in your browser. On the board a plain click opens it. |

Notes save themselves as you type. *Log note* is just the way back to the board; it is not the
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

When the window is narrow, a side-by-side pair is shown stacked; it goes back to side by side
when the window is wide enough again.

**Finding**

| Do this | To |
| --- | --- |
| **Ctrl + K**, or gear then *Find notes* | Search titles, text, image captions and tags. Enter shows the note on the board; Ctrl + Enter opens it. |
| Hover a note, click the pin | Pin it. Pinning adds it to the pinned list; the note does not move. |
| Gear then *Pinned notes* | Jump to a pinned note, or drag to reorder the list. |

Search looks at the words you typed. It does not read text inside screenshots.

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

**What "saved" means.** While you type, a note is written about half a second after you pause,
and immediately when you log it, hide the window or quit. If the app or Windows stops
unexpectedly, the next start opens the note you were writing as it was last saved; at most the
last moment of typing before the stop can be missing. If a save fails (for example the disk is
full), the note stays open with a "Not saved" message and a *Try again* button, and it never
claims to be saved.

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
Every dependency is bundled at build time, so the packaged app contains no `node_modules` and
no native module that needs compiling.

**Growing into a trading journal.** A note has a `kind` (only `note` today) and a free-form
`extra` field, and the database has a schema version with a migration list
(`src/main/store/db.ts`). Trade fields can be added as a new kind plus a migration without
touching how notes are stored, arranged, pinned or searched.
