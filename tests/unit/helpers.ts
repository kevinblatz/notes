import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'
import { fontVar, highlightVar, inkVar } from '@shared/content'
import type { RichDoc } from '@shared/types'

const created: string[] = []

export function tempDir(prefix = 'tn-test-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  created.push(dir)
  return dir
}

export function cleanupTempDirs(): void {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
}

function crc32(bytes: Uint8Array): number {
  let crc = ~0
  for (const byte of bytes) {
    crc ^= byte
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return ~crc >>> 0
}

function chunk(type: string, data: Uint8Array): Buffer {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'ascii')
  const body = Buffer.concat([head.subarray(4), data])
  const tail = Buffer.alloc(4)
  tail.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([head.subarray(0, 4), body, tail])
}

/** A real, decodable PNG of a solid colour. Different colours give different bytes. */
export function makePng(width: number, height: number, rgb: [number, number, number]): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  const row = Buffer.alloc(1 + width * 3)
  for (let x = 0; x < width; x++) row.set(rgb, 1 + x * 3)
  const raw = Buffer.concat(Array.from({ length: height }, () => row))
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', new Uint8Array())
  ])
}

export const text = (value: string): RichDoc => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: value }] }] })

/** A note that uses every supported kind of formatting plus two images. */
export function richDoc(imageA: string, imageB: string): RichDoc {
  return {
    type: 'doc',
    content: [
      { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Session plan' }] },
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'Bold', marks: [{ type: 'bold' }] },
          { type: 'text', text: ' italic', marks: [{ type: 'italic' }] },
          { type: 'text', text: ' underline', marks: [{ type: 'underline' }] },
          { type: 'text', text: ' strike', marks: [{ type: 'strike' }] },
          { type: 'text', text: ' red serif 22', marks: [{ type: 'textStyle', attrs: { color: inkVar('red'), fontFamily: fontVar('serif'), fontSize: '22px' } }] },
          { type: 'text', text: ' highlighted', marks: [{ type: 'highlight', attrs: { color: highlightVar('teal') } }] },
          { type: 'text', text: ' link', marks: [{ type: 'link', attrs: { href: 'https://www.tradingview.com/' } }] }
        ]
      },
      { type: 'noteImage', attrs: { attachmentId: imageA, width: 70, caption: 'Entry on the retest', naturalWidth: 8, naturalHeight: 6 } },
      { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'bullet' }] }] }] },
      { type: 'orderedList', attrs: { start: 1 }, content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'numbered' }] }] }] },
      {
        type: 'taskList',
        content: [
          { type: 'taskItem', attrs: { checked: true }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'checked' }] }] },
          { type: 'taskItem', attrs: { checked: false }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'open' }] }] }
        ]
      },
      { type: 'noteImage', attrs: { attachmentId: imageB, width: 100, caption: '', naturalWidth: 4, naturalHeight: 4 } },
      { type: 'paragraph', content: [{ type: 'text', text: 'Text below the screenshots.' }] }
    ]
  }
}
