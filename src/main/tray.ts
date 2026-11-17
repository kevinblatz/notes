/** Notification-area icon: left click shows or hides the notes, right click opens a small menu. */
import { Menu, nativeImage, Tray } from 'electron'
import type { DockSide } from '@shared/types'

export interface TrayActions {
  toggle: () => void
  isShown: () => boolean
  dock: (side: DockSide) => void
  isAlwaysOnTop: () => boolean
  setAlwaysOnTop: (flag: boolean) => void
  quit: () => void
}

export class TrayController {
  private tray: Tray | null = null
  private iconLoaded = false

  constructor(
    private readonly iconPath: string,
    private readonly actions: TrayActions
  ) {}

  create(): void {
    if (this.tray) return
    const image = nativeImage.createFromPath(this.iconPath)
    this.iconLoaded = !image.isEmpty()
    this.tray = new Tray(image)
    this.tray.setToolTip('Trading Notes')
    this.tray.on('click', () => this.actions.toggle())
    this.refresh()
  }

  /** Rebuild the menu so its labels and check marks match the window. */
  refresh(): void {
    if (!this.tray) return
    const menu = Menu.buildFromTemplate([
      { label: this.actions.isShown() ? 'Hide notes' : 'Show notes', click: () => this.actions.toggle() },
      { type: 'separator' },
      { label: 'Dock to right half', click: () => this.actions.dock('right') },
      { label: 'Dock to left half', click: () => this.actions.dock('left') },
      {
        label: 'Always on top',
        type: 'checkbox',
        checked: this.actions.isAlwaysOnTop(),
        click: (item) => this.actions.setAlwaysOnTop(item.checked)
      },
      { type: 'separator' },
      { label: 'Quit Trading Notes', click: () => this.actions.quit() }
    ])
    this.tray.setContextMenu(menu)
  }

  /** For start-up diagnostics: whether the icon exists and its image file was readable. */
  state(): { created: boolean; iconLoaded: boolean } {
    return { created: this.tray !== null && !this.tray.isDestroyed(), iconLoaded: this.iconLoaded }
  }

  destroy(): void {
    this.tray?.destroy()
    this.tray = null
  }
}
