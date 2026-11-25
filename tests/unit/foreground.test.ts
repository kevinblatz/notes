import { describe, expect, it } from 'vitest'
import { foregroundApi, foregroundStatus, handleFromBuffer, previousWindowFromActivate } from '../../src/main/foreground'

function pointer(value: number): Buffer {
  const buffer = Buffer.alloc(8)
  buffer.writeBigUInt64LE(BigInt(value))
  return buffer
}

describe('window handles from Electron buffers', () => {
  it('reads 64-bit and 32-bit handles', () => {
    expect(handleFromBuffer(pointer(0x1a2b3c))).toBe(0x1a2b3c)
    const small = Buffer.alloc(4)
    small.writeUInt32LE(0x00450a2e)
    expect(handleFromBuffer(small)).toBe(0x00450a2e)
    expect(handleFromBuffer(Buffer.alloc(0))).toBe(0)
  })
})

describe('the window active before the notes, from WM_ACTIVATE', () => {
  const own = 0x5000
  it('names the deactivated window when the notes are activated or click-activated', () => {
    expect(previousWindowFromActivate(pointer(1), pointer(0x7000), own)).toBe(0x7000) // WA_ACTIVE
    expect(previousWindowFromActivate(pointer(2), pointer(0x7000), own)).toBe(0x7000) // WA_CLICKACTIVE
    // The high word of wParam carries the minimized state; only the low word is the kind.
    expect(previousWindowFromActivate(pointer(0x0001_0001), pointer(0x7000), own)).toBe(0x7000)
  })
  it('names nothing when the notes are deactivated, or no other window is named', () => {
    expect(previousWindowFromActivate(pointer(0), pointer(0x7000), own)).toBeNull() // WA_INACTIVE
    expect(previousWindowFromActivate(pointer(1), pointer(0), own)).toBeNull()
    expect(previousWindowFromActivate(pointer(1), pointer(own), own)).toBeNull()
    expect(previousWindowFromActivate(Buffer.alloc(0), pointer(0x7000), own)).toBeNull()
  })
})

describe('user32 access', () => {
  it('is only loaded on Windows', () => {
    if (process.platform === 'win32') {
      expect(foregroundStatus()).toEqual({ available: true, error: null })
      const api = foregroundApi()!
      expect(typeof api.current()).toBe('number')
      expect(api.usable(0)).toBe(false)
    } else {
      expect(foregroundApi()).toBeNull()
      expect(foregroundStatus()).toEqual({ available: false, error: null })
    }
  })
})
