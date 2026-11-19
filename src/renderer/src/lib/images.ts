/**
 * Image intake. The window decodes the picture (so any format Chromium can read works),
 * builds a smaller preview, and hands both to the main process, which copies them into the
 * managed attachments folder. Nothing is uploaded anywhere and the clipboard is only read at
 * the moment the user pastes.
 */
import type { AttachmentMeta } from '@shared/types'
import { api } from './api'

export const ACCEPTED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']
export const ACCEPT_ATTRIBUTE = ACCEPTED_IMAGE_TYPES.join(',')
const PREVIEW_MAX_EDGE = 1800
const PREVIEW_MIN_BYTES = 350 * 1024

export function imageFilesFrom(transfer: DataTransfer | null): File[] {
  if (!transfer) return []
  const files: File[] = []
  for (const item of Array.from(transfer.items ?? [])) {
    if (item.kind === 'file' && item.type.startsWith('image/')) {
      const file = item.getAsFile()
      if (file) files.push(file)
    }
  }
  if (files.length === 0) {
    for (const file of Array.from(transfer.files ?? [])) if (file.type.startsWith('image/')) files.push(file)
  }
  return files
}

export function hasFiles(transfer: DataTransfer | null): boolean {
  return !!transfer && Array.from(transfer.types ?? []).includes('Files')
}

export interface ImportedImage {
  attachment: AttachmentMeta
  width: number
  height: number
}

export async function importImageFile(file: File): Promise<ImportedImage> {
  const bytes = await file.arrayBuffer()
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file)
  } catch {
    throw new Error(`"${file.name || 'That file'}" is not an image this app can read.`)
  }
  const { width, height } = bitmap
  let preview: { bytes: ArrayBuffer; width: number; height: number } | null = null
  try {
    const longest = Math.max(width, height)
    const animated = file.type === 'image/gif'
    if (!animated && (longest > PREVIEW_MAX_EDGE || bytes.byteLength > PREVIEW_MIN_BYTES)) {
      const scale = Math.min(1, PREVIEW_MAX_EDGE / longest)
      const w = Math.max(1, Math.round(width * scale))
      const h = Math.max(1, Math.round(height * scale))
      const canvas = new OffscreenCanvas(w, h)
      const context = canvas.getContext('2d')
      if (context) {
        context.imageSmoothingQuality = 'high'
        context.drawImage(bitmap, 0, 0, w, h)
        const blob = await canvas.convertToBlob({ type: 'image/webp', quality: 0.86 })
        // Only keep the preview when it is actually smaller than the original.
        if (blob.size < bytes.byteLength * 0.9) preview = { bytes: await blob.arrayBuffer(), width: w, height: h }
      }
    }
  } finally {
    bitmap.close()
  }
  const attachment = await api.importImage({ bytes, name: file.name || null, width, height, preview })
  return { attachment, width, height }
}
