/**
 * Formatting controls. They exist only while a note is being edited: a slim bar under the
 * editor, plus a small bubble that appears beside selected text.
 */
import type { Editor } from '@tiptap/core'
import { useEditorState } from '@tiptap/react'
import { BubbleMenu } from '@tiptap/react/menus'
import {
  Baseline,
  Bold,
  ChevronDown,
  ExternalLink,
  Highlighter,
  ImagePlus,
  Italic,
  Link as LinkIcon,
  List,
  ListChecks,
  ListOrdered,
  Redo2,
  Strikethrough,
  Underline,
  Undo2,
  Unlink
} from 'lucide-react'
import { useRef, useState, type MouseEvent, type ReactNode } from 'react'
import { FONT_KEYS, FONT_LABELS, FONT_SIZES, fontVar, HIGHLIGHT_COLORS, highlightVar, INK_COLORS, inkVar, safeLinkHref } from '@shared/content'
import { api } from '../../lib/api'
import { IconButton, MenuList, Popover, type MenuEntry } from '../ui'

/** Keep the text selection when a control is pressed with the mouse. */
const keepSelection = (event: MouseEvent): void => event.preventDefault()

function useFormatState(editor: Editor) {
  return useEditorState({
    editor,
    selector: ({ editor: e }) => {
      const style = e.getAttributes('textStyle') as { color?: string | null; fontFamily?: string | null; fontSize?: string | null }
      return {
        bold: e.isActive('bold'),
        italic: e.isActive('italic'),
        underline: e.isActive('underline'),
        strike: e.isActive('strike'),
        bullet: e.isActive('bulletList'),
        ordered: e.isActive('orderedList'),
        task: e.isActive('taskList'),
        heading: e.isActive('heading', { level: 1 }) ? 1 : e.isActive('heading', { level: 2 }) ? 2 : e.isActive('heading', { level: 3 }) ? 3 : 0,
        link: e.isActive('link') ? String(e.getAttributes('link').href ?? '') : null,
        color: style.color ?? null,
        fontFamily: style.fontFamily ?? null,
        fontSize: style.fontSize ?? null,
        highlight: e.isActive('highlight') ? String(e.getAttributes('highlight').color ?? highlightVar('amber')) : null,
        canUndo: e.can().undo(),
        canRedo: e.can().redo()
      }
    }
  })
}

function Swatches({ kind, current, onPick }: { kind: 'ink' | 'highlight'; current: string | null; onPick: (value: string | null) => void }) {
  const values = kind === 'ink' ? INK_COLORS.map((name) => ({ name, value: inkVar(name) })) : HIGHLIGHT_COLORS.map((name) => ({ name, value: highlightVar(name) }))
  return (
    <div className="swatches" role="group" aria-label={kind === 'ink' ? 'Text color' : 'Highlight color'}>
      <button type="button" className={`swatch swatch-none${current === null ? ' is-current' : ''}`} onMouseDown={keepSelection} onClick={() => onPick(null)} aria-label={kind === 'ink' ? 'Default text color' : 'No highlight'} title={kind === 'ink' ? 'Default' : 'None'} />
      {values.map(({ name, value }) => (
        <button
          key={name}
          type="button"
          className={`swatch swatch-${kind}${current === value ? ' is-current' : ''}`}
          style={{ ['--swatch' as string]: value }}
          onMouseDown={keepSelection}
          onClick={() => onPick(value)}
          aria-label={name}
          title={name[0]!.toUpperCase() + name.slice(1)}
        />
      ))}
    </div>
  )
}

function applyLink(editor: Editor, raw: string): boolean {
  const trimmed = raw.trim()
  if (!trimmed) {
    editor.chain().focus().extendMarkRange('link').unsetLink().run()
    return true
  }
  const href = safeLinkHref(/^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`)
  if (!href) return false
  const { empty } = editor.state.selection
  if (empty && !editor.isActive('link')) {
    // No selection: insert the address itself as the link text.
    editor.chain().focus().insertContent({ type: 'text', text: trimmed, marks: [{ type: 'link', attrs: { href } }] }).run()
  } else {
    editor.chain().focus().extendMarkRange('link').setLink({ href }).run()
  }
  return true
}

function LinkForm({ editor, current, onDone }: { editor: Editor; current: string | null; onDone: () => void }) {
  const [value, setValue] = useState(current ?? '')
  const [invalid, setInvalid] = useState(false)
  const submit = (): void => {
    if (applyLink(editor, value)) onDone()
    else setInvalid(true)
  }
  return (
    <form
      className="link-form"
      onSubmit={(event) => {
        event.preventDefault()
        submit()
      }}
    >
      <input
        data-autofocus
        type="text"
        value={value}
        placeholder="https://"
        aria-label="Link address"
        aria-invalid={invalid}
        spellCheck={false}
        onChange={(event) => {
          setValue(event.target.value)
          setInvalid(false)
        }}
      />
      <button type="submit" className="small-button">
        {current ? 'Update' : 'Add link'}
      </button>
      {current ? (
        <>
          <IconButton label="Open link in browser" onClick={() => void api.openExternal(current)}>
            <ExternalLink size={15} />
          </IconButton>
          <IconButton
            label="Remove link"
            onClick={() => {
              applyLink(editor, '')
              onDone()
            }}
          >
            <Unlink size={15} />
          </IconButton>
        </>
      ) : null}
      {invalid ? <p className="form-error">Enter a web address starting with http:// or https://</p> : null}
    </form>
  )
}

function Dropdown({ label, text, entries, width }: { label: string; text: ReactNode; entries: MenuEntry[]; width?: number }) {
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLButtonElement>(null)
  return (
    <>
      <button ref={anchor} type="button" className="bar-dropdown" style={width ? { minWidth: width } : undefined} aria-label={label} title={label} aria-haspopup="menu" aria-expanded={open} onMouseDown={keepSelection} onClick={() => setOpen((v) => !v)}>
        <span>{text}</span>
        <ChevronDown size={13} />
      </button>
      <Popover anchor={anchor.current} open={open} onClose={() => setOpen(false)} placement="top" role="menu" label={label}>
        <MenuList entries={entries} onDone={() => setOpen(false)} />
      </Popover>
    </>
  )
}

function ColorControl({ editor, kind, current }: { editor: Editor; kind: 'ink' | 'highlight'; current: string | null }) {
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLButtonElement>(null)
  const pick = (value: string | null): void => {
    const chain = editor.chain().focus()
    if (kind === 'ink') (value ? chain.setColor(value) : chain.unsetColor()).run()
    else (value ? chain.setHighlight({ color: value }) : chain.unsetHighlight()).run()
    setOpen(false)
  }
  return (
    <>
      <IconButton ref={anchor} label={kind === 'ink' ? 'Text color' : 'Highlight'} active={current !== null} aria-haspopup="dialog" aria-expanded={open} onMouseDown={keepSelection} onClick={() => setOpen((v) => !v)}>
        {kind === 'ink' ? <Baseline size={16} style={current ? { color: current } : undefined} /> : <Highlighter size={16} />}
        {kind === 'highlight' && current ? <span className="color-dot" style={{ background: current }} /> : null}
      </IconButton>
      <Popover anchor={anchor.current} open={open} onClose={() => setOpen(false)} placement="top" align="center" keepFocus label={kind === 'ink' ? 'Text color' : 'Highlight color'}>
        <Swatches kind={kind} current={current} onPick={pick} />
      </Popover>
    </>
  )
}

export function FormatBar({ editor, onAddImage }: { editor: Editor; onAddImage: () => void }) {
  const state = useFormatState(editor)
  const [linkOpen, setLinkOpen] = useState(false)
  const linkAnchor = useRef<HTMLButtonElement>(null)
  const run = (fn: (chain: ReturnType<Editor['chain']>) => ReturnType<Editor['chain']>) => (): void => {
    fn(editor.chain().focus()).run()
  }

  const styleEntries: MenuEntry[] = [
    { label: 'Text', checked: state.heading === 0, onSelect: run((c) => c.setParagraph()) },
    { label: 'Heading 1', checked: state.heading === 1, onSelect: run((c) => c.setHeading({ level: 1 })) },
    { label: 'Heading 2', checked: state.heading === 2, onSelect: run((c) => c.setHeading({ level: 2 })) },
    { label: 'Heading 3', checked: state.heading === 3, onSelect: run((c) => c.setHeading({ level: 3 })) }
  ]
  const fontEntries: MenuEntry[] = [
    { label: 'Default font', checked: state.fontFamily === null, onSelect: run((c) => c.unsetFontFamily()) },
    ...FONT_KEYS.map((key) => ({ label: FONT_LABELS[key], checked: state.fontFamily === fontVar(key), onSelect: run((c) => c.setFontFamily(fontVar(key))) }))
  ]
  const sizeEntries: MenuEntry[] = [
    { label: 'Default size', checked: state.fontSize === null, onSelect: run((c) => c.unsetFontSize()) },
    ...FONT_SIZES.map((size) => ({ label: `${size}`, checked: state.fontSize === `${size}px`, onSelect: run((c) => c.setFontSize(`${size}px`)) }))
  ]
  const fontLabel = FONT_KEYS.find((key) => state.fontFamily === fontVar(key))
  const headingLabel = state.heading === 0 ? 'Text' : `Heading ${state.heading}`

  return (
    <div className="format-bar" role="toolbar" aria-label="Formatting">
      <div className="bar-group">
        <Dropdown label="Paragraph style" text={headingLabel} entries={styleEntries} width={92} />
        <Dropdown label="Font" text={fontLabel ? FONT_LABELS[fontLabel] : 'Font'} entries={fontEntries} width={76} />
        <Dropdown label="Text size" text={state.fontSize ? state.fontSize.replace('px', '') : 'Size'} entries={sizeEntries} width={56} />
      </div>
      <div className="bar-group">
        <IconButton label="Bold" hint="Ctrl+B" active={state.bold} onMouseDown={keepSelection} onClick={run((c) => c.toggleBold())}><Bold size={16} /></IconButton>
        <IconButton label="Italic" hint="Ctrl+I" active={state.italic} onMouseDown={keepSelection} onClick={run((c) => c.toggleItalic())}><Italic size={16} /></IconButton>
        <IconButton label="Underline" hint="Ctrl+U" active={state.underline} onMouseDown={keepSelection} onClick={run((c) => c.toggleUnderline())}><Underline size={16} /></IconButton>
        <IconButton label="Strikethrough" hint="Ctrl+Shift+S" active={state.strike} onMouseDown={keepSelection} onClick={run((c) => c.toggleStrike())}><Strikethrough size={16} /></IconButton>
        <ColorControl editor={editor} kind="ink" current={state.color} />
        <ColorControl editor={editor} kind="highlight" current={state.highlight} />
      </div>
      <div className="bar-group">
        <IconButton label="Bulleted list" active={state.bullet} onMouseDown={keepSelection} onClick={run((c) => c.toggleBulletList())}><List size={16} /></IconButton>
        <IconButton label="Numbered list" active={state.ordered} onMouseDown={keepSelection} onClick={run((c) => c.toggleOrderedList())}><ListOrdered size={16} /></IconButton>
        <IconButton label="Checklist" active={state.task} onMouseDown={keepSelection} onClick={run((c) => c.toggleTaskList())}><ListChecks size={16} /></IconButton>
      </div>
      <div className="bar-group">
        <IconButton ref={linkAnchor} label="Link" active={state.link !== null} aria-haspopup="dialog" aria-expanded={linkOpen} onMouseDown={keepSelection} onClick={() => setLinkOpen((v) => !v)}><LinkIcon size={16} /></IconButton>
        <Popover anchor={linkAnchor.current} open={linkOpen} onClose={() => setLinkOpen(false)} placement="top" align="center" label="Link">
          <LinkForm editor={editor} current={state.link} onDone={() => setLinkOpen(false)} />
        </Popover>
        <IconButton label="Add image" onMouseDown={keepSelection} onClick={onAddImage}><ImagePlus size={16} /></IconButton>
      </div>
      <div className="bar-group">
        <IconButton label="Undo" hint="Ctrl+Z" disabled={!state.canUndo} onMouseDown={keepSelection} onClick={run((c) => c.undo())}><Undo2 size={16} /></IconButton>
        <IconButton label="Redo" hint="Ctrl+Y" disabled={!state.canRedo} onMouseDown={keepSelection} onClick={run((c) => c.redo())}><Redo2 size={16} /></IconButton>
      </div>
    </div>
  )
}

/** Controls that appear beside selected text. */
export function SelectionBubble({ editor }: { editor: Editor }) {
  const state = useFormatState(editor)
  const [row, setRow] = useState<'ink' | 'highlight' | 'link' | null>(null)
  const toggle = (next: 'ink' | 'highlight' | 'link') => (): void => setRow((current) => (current === next ? null : next))
  const run = (fn: (chain: ReturnType<Editor['chain']>) => ReturnType<Editor['chain']>) => (): void => {
    fn(editor.chain().focus()).run()
  }
  return (
    <BubbleMenu
      editor={editor}
      options={{ placement: 'top', offset: 8, flip: true, shift: { padding: 8 } }}
      shouldShow={({ editor: e, state: s }) => {
        if (!e.isEditable || s.selection.empty) return false
        // Not for a selected image block; that has its own controls.
        return !('node' in s.selection)
      }}
    >
      <div className="bubble" role="toolbar" aria-label="Selection formatting">
        <div className="bubble-row">
          <IconButton label="Bold" active={state.bold} onMouseDown={keepSelection} onClick={run((c) => c.toggleBold())}><Bold size={15} /></IconButton>
          <IconButton label="Italic" active={state.italic} onMouseDown={keepSelection} onClick={run((c) => c.toggleItalic())}><Italic size={15} /></IconButton>
          <IconButton label="Underline" active={state.underline} onMouseDown={keepSelection} onClick={run((c) => c.toggleUnderline())}><Underline size={15} /></IconButton>
          <IconButton label="Strikethrough" active={state.strike} onMouseDown={keepSelection} onClick={run((c) => c.toggleStrike())}><Strikethrough size={15} /></IconButton>
          <span className="bubble-divider" />
          <IconButton label="Text color" active={row === 'ink' || state.color !== null} onMouseDown={keepSelection} onClick={toggle('ink')}><Baseline size={15} style={state.color ? { color: state.color } : undefined} /></IconButton>
          <IconButton label="Highlight" active={row === 'highlight' || state.highlight !== null} onMouseDown={keepSelection} onClick={toggle('highlight')}><Highlighter size={15} /></IconButton>
          <IconButton label="Link" active={row === 'link' || state.link !== null} onMouseDown={keepSelection} onClick={toggle('link')}><LinkIcon size={15} /></IconButton>
        </div>
        {row === 'ink' ? <Swatches kind="ink" current={state.color} onPick={(value) => { (value ? editor.chain().focus().setColor(value) : editor.chain().focus().unsetColor()).run(); setRow(null) }} /> : null}
        {row === 'highlight' ? <Swatches kind="highlight" current={state.highlight} onPick={(value) => { (value ? editor.chain().focus().setHighlight({ color: value }) : editor.chain().focus().unsetHighlight()).run(); setRow(null) }} /> : null}
        {row === 'link' ? <LinkForm editor={editor} current={state.link} onDone={() => setRow(null)} /> : null}
      </div>
    </BubbleMenu>
  )
}
