/**
 * tn-attachment:// serves images from the managed attachments folder to the window.
 * Requests name an attachment ID, never a path: the file location comes from the database
 * row, so nothing outside the attachments folder can be read through this scheme.
 */
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'
import { protocol } from 'electron'
import { isValidId } from '@shared/content'
import { ATTACHMENT_SCHEME } from '@shared/types'
import type { Library } from './store/library'

const MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' }

/** Must run before the app is ready. */
export function registerAttachmentScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: ATTACHMENT_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }
  ])
}

export function handleAttachmentRequests(library: Library): void {
  protocol.handle(ATTACHMENT_SCHEME, async (request) => {
    try {
      const url = new URL(request.url)
      const id = decodeURIComponent(url.pathname.replace(/^\/+/, ''))
      if (url.hostname !== 'file' || !isValidId(id)) return new Response('Bad request', { status: 400 })
      const row = library.getAttachment(id)
      if (!row) return new Response('Not found', { status: 404 })
      const path = url.searchParams.get('v') === 'full' ? library.attachments.originalPath(row) : library.attachments.previewPath(row)
      if (!existsSync(path)) return new Response('Not found', { status: 404 })
      const body = await readFile(path)
      return new Response(new Uint8Array(body), {
        status: 200,
        headers: {
          'content-type': MIME[extname(path).toLowerCase()] ?? 'application/octet-stream',
          'x-content-type-options': 'nosniff',
          // Attachment files never change once written, so the window can cache them freely.
          'cache-control': 'private, max-age=31536000, immutable',
          'access-control-allow-origin': '*'
        }
      })
    } catch {
      return new Response('Error', { status: 500 })
    }
  })
}
