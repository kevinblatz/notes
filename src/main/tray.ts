/** Notification-area icon: left click shows or hides the notes, right click opens a small menu. */
import { Menu, nativeImage, Tray, type MenuItem, type MenuItemConstructorOptions } from 'electron'
import { formatOpacity, opacityMenuChoices } from '@shared/preferences'
import type { DockSide } from '@shared/types'

export interface TrayActions {
  toggle: () => void
  isShown: () => boolean
  /** The quick note strip, as its hotkey opens it. */
  quickNote: () => void
  /** Capture the chart into today's log, as its hotkey does. */
  snapshot: () => void
  dock: (side: DockSide) => void
  isAlwaysOnTop: () => boolean
  setAlwaysOnTop: (flag: boolean) => void
  /** The chosen window opacity (the stored preference). */
  opacity: () => number
  setOpacity: (value: number) => void
  quit: () => void
}

/** A menu entry as the automated desktop tests read it. */
export interface TestMenuEntry {
  label: string
  checked: boolean
  submenu?: TestMenuEntry[]
}

function describe(items: MenuItem[]): TestMenuEntry[] {
  return items
    .filter((item) => item.type !== 'separator')
    .map((item) => (item.submenu ? { label: item.label, checked: item.checked, submenu: describe(item.submenu.items) } : { label: item.label, checked: item.checked }))
}

export class TrayController {
  private tray: Tray | null = null
  private menu: Menu | null = null
  private iconLoaded = false
  private status: string | null = null

  constructor(
    private readonly iconPath: string,
    private readonly actions: TrayActions
  ) {}

  create(): void {
    if (this.tray) return
    const image = nativeImage.createFromPath(this.iconPath)
    this.iconLoaded = !image.isEmpty()
    this.tray = new Tray(image)
    this.tray.setToolTip(this.tooltip())
    this.tray.on('click', () => this.actions.toggle())
    this.refresh()
  }

  /** Rebuild the menu so its labels and check marks match the window. */
  refresh(): void {
    if (!this.tray) return
    const opacity = this.actions.opacity()
    // The presets, and the current value too when it was set to something in between.
    const opacityItems: MenuItemConstructorOptions[] = opacityMenuChoices(opacity).map((value) => ({
      label: formatOpacity(value),
      type: 'radio',
      checked: value === opacity,
      click: () => this.actions.setOpacity(value)
    }))
    const menu = Menu.buildFromTemplate([
      { label: this.actions.isShown() ? 'Hide notes' : 'Show notes', click: () => this.actions.toggle() },
      { label: 'Quick note', click: () => this.actions.quickNote() },
      { label: 'Snapshot chart', click: () => this.actions.snapshot() },
      { type: 'separator' },
      { label: 'Dock to right half', click: () => this.actions.dock('right') },
      { label: 'Dock to left half', click: () => this.actions.dock('left') },
      {
        label: 'Always on top',
        type: 'checkbox',
        checked: this.actions.isAlwaysOnTop(),
        click: (item) => this.actions.setAlwaysOnTop(item.checked)
      },
      { label: 'Opacity', submenu: opacityItems },
      { type: 'separator' },
      { label: 'Quit Trading Notes', click: () => this.actions.quit() }
    ])
    this.menu = menu
    this.tray.setContextMenu(menu)
  }

  private tooltip(): string {
    return this.status ? `Trading Notes\n${this.status}` : 'Trading Notes'
  }

  /**
   * A quiet line under the name in the icon's tooltip ("Last chart snapshot 10:32:14"): the
   * feedback for a hotkey used while the notes are hidden. No balloon, no window.
   */
  setStatus(text: string | null): void {
    this.status = text
    this.tray?.setToolTip(this.tooltip())
  }

  /** For the automated desktop tests: the tooltip as it reads now. */
  testTooltip(): string {
    return this.tooltip()
  }

  /** For start-up diagnostics: whether the icon exists and its image file was readable. */
  state(): { created: boolean; iconLoaded: boolean } {
    return { created: this.tray !== null && !this.tray.isDestroyed(), iconLoaded: this.iconLoaded }
  }

  /** For the automated desktop tests: do exactly what a click on the icon does. */
  testClick(): void {
    this.tray?.emit('click')
  }

  /** For the automated desktop tests: the menu as it currently reads, submenus included. */
  testMenu(): TestMenuEntry[] {
    return describe(this.menu?.items ?? [])
  }

  /**
   * For the automated desktop tests: choose a menu entry by its label, as a click on it would.
   * An entry in a submenu is named by the path to it: testChoose('Opacity', '70%').
   */
  testChoose(...path: string[]): boolean {
    let items: MenuItem[] = this.menu?.items ?? []
    let item: MenuItem | undefined
    for (const [index, label] of path.entries()) {
      item = items.find((entry) => entry.label === label)
      if (!item) return false
      if (index < path.length - 1) {
        if (!item.submenu) return false
        items = item.submenu.items
      }
    }
    if (!item || item.submenu) return false
    item.click()
    return true
  }

  destroy(): void {
    this.tray?.destroy()
    this.tray = null
    this.menu = null
  }
}
