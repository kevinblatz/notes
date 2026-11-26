/**
 * The Edit menu that right-click (or the menu key, or Shift+F10) opens on text: in a note, its
 * title, image captions, the tag field and the quick note strip. A misspelled word under it
 * gets its suggestions first and Add to dictionary.
 */
import { BookPlus, ClipboardPaste, Copy, Scissors, TextSelect, Type } from 'lucide-react'
import { MAX_USER_WORDS } from '@shared/preferences'
import { api } from '../lib/api'
import { announce, toast, updatePreferences } from '../state/actions'
import { getState } from '../state/store'
import type { MenuEntry } from './ui'

/** A misspelled word the menu was opened on, with what it could be instead. */
export interface SpellingChoice {
  word: string
  suggestions: string[]
}

/** Add a word to the user's dictionary, or say why it cannot be added. */
export function addToDictionary(word: string): void {
  const words = getState().prefs.spellingWords
  if (words.some((known) => known.toLowerCase() === word.toLowerCase())) {
    announce(`${word} is already in your dictionary.`)
    return
  }
  if (words.length >= MAX_USER_WORDS) {
    const message = `Your dictionary is full (${MAX_USER_WORDS} words). Remove some in Settings → Spelling to add ${word}.`
    toast(message, { kind: 'error', duration: 8000 })
    announce(message)
    return
  }
  void updatePreferences({ spellingWords: [...words, word] })
  announce(`Added ${word} to your dictionary.`)
}

/** Suggestions first (or "No suggestions"), then Add to dictionary and a separator. Empty without a misspelled word. */
export function spellingEntries(spelling: SpellingChoice | null, replace: (replacement: string) => void): MenuEntry[] {
  if (!spelling) return []
  return [
    ...(spelling.suggestions.length > 0
      ? spelling.suggestions.map((suggestion): MenuEntry => ({ label: suggestion, strong: true, onSelect: () => replace(suggestion) }))
      : [{ kind: 'label', label: 'No suggestions' } as const]),
    { label: 'Add to dictionary', icon: <BookPlus size={15} />, onSelect: () => addToDictionary(spelling.word) },
    { kind: 'separator' }
  ]
}

/**
 * Cut, Copy, Paste, Paste as plain text and Select all. They act on whatever has the keyboard,
 * so `refocus` first gives it back to the text (a menu opened from the keyboard has it).
 */
export function editEntries(hasSelection: boolean, refocus: () => void): MenuEntry[] {
  const run = (command: Parameters<typeof api.edit>[0]) => (): void => {
    refocus()
    void api.edit(command)
  }
  return [
    { label: 'Cut', icon: <Scissors size={15} />, hint: 'Ctrl+X', disabled: !hasSelection, onSelect: run('cut') },
    { label: 'Copy', icon: <Copy size={15} />, hint: 'Ctrl+C', disabled: !hasSelection, onSelect: run('copy') },
    { label: 'Paste', icon: <ClipboardPaste size={15} />, hint: 'Ctrl+V', onSelect: run('paste') },
    { label: 'Paste as plain text', icon: <Type size={15} />, hint: 'Ctrl+Shift+V', onSelect: run('pastePlain') },
    { kind: 'separator' },
    { label: 'Select all', icon: <TextSelect size={15} />, hint: 'Ctrl+A', onSelect: run('selectAll') }
  ]
}

/** The menu was opened from the keyboard (the menu key or Shift+F10), not by a right-click. */
export function openedFromKeyboard(event: { button: number }): boolean {
  return event.button !== 2
}
