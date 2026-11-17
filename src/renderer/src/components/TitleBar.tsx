/**
 * The slim strip at the top: a drag region, the settings gear (the only permanent toolbar
 * button) and the two essential window controls.
 */
import { Archive, EyeOff, Minus, Pin, Power, Search, Settings, SlidersHorizontal, Trash2, X } from 'lucide-react'
import { useRef } from 'react'
import { formatAccelerator } from '@shared/accelerator'
import { api } from '../lib/api'
import { flushAll, openPanel, setGearOpen } from '../state/actions'
import { useStore } from '../state/store'
import { IconButton, MenuList, Popover, type MenuEntry } from './ui'

export function TitleBar() {
  const gearOpen = useStore((s) => s.gearOpen)
  const trashCount = useStore((s) => s.trashCount)
  const pinCount = useStore((s) => s.pins.length)
  const shortcut = useStore((s) => s.shortcut)
  const gear = useRef<HTMLButtonElement>(null)

  const hide = (): void => {
    void flushAll().finally(() => void api.windowAction('hide'))
  }

  const entries: MenuEntry[] = [
    { label: 'Settings', icon: <SlidersHorizontal size={15} />, onSelect: () => openPanel('settings') },
    { label: 'Find notes', icon: <Search size={15} />, hint: 'Ctrl+K', onSelect: () => openPanel('find') },
    { label: pinCount > 0 ? `Pinned notes (${pinCount})` : 'Pinned notes', icon: <Pin size={15} />, onSelect: () => openPanel('pins') },
    { label: 'Backup and import', icon: <Archive size={15} />, onSelect: () => openPanel('backup') },
    { label: trashCount > 0 ? `Trash (${trashCount})` : 'Trash', icon: <Trash2 size={15} />, onSelect: () => openPanel('trash') },
    { kind: 'separator' },
    { label: 'Hide to tray', icon: <EyeOff size={15} />, hint: shortcut.registered ? formatAccelerator(shortcut.accelerator) : undefined, onSelect: hide },
    { label: 'Quit Trading Notes', icon: <Power size={15} />, onSelect: () => void api.windowAction('quit') }
  ]

  return (
    <header className="titlebar">
      <div className="titlebar-drag" onDoubleClick={() => void api.windowAction('toggle-maximize')} />
      <div className="titlebar-controls">
        <IconButton ref={gear} label="Menu" aria-haspopup="menu" aria-expanded={gearOpen} onClick={() => setGearOpen(!gearOpen)} data-testid="gear">
          <Settings size={16} />
        </IconButton>
        <Popover anchor={gear.current} open={gearOpen} onClose={() => setGearOpen(false)} align="end" role="menu" label="Menu">
          <MenuList entries={entries} onDone={() => setGearOpen(false)} />
        </Popover>
        <IconButton label="Minimize" className="window-control" onClick={() => void api.windowAction('minimize')}>
          <Minus size={16} />
        </IconButton>
        <IconButton label="Hide to tray" className="window-control" onClick={hide} data-testid="hide-window">
          <X size={16} />
        </IconButton>
      </div>
    </header>
  )
}
