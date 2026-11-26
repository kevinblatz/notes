/**
 * Regenerates the app and tray icons from the SVG below.
 *   npm run icons
 * Runs inside Electron (no extra tooling needed) and writes:
 *   build/icon.ico, build/icon.png          application / installer icon
 *   resources/tray.ico, resources/tray.png  notification-area icon
 * The generated files are committed, so a normal build never needs this script.
 */
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')

// A charcoal sheet with three lines of writing; the first line carries the teal accent.
const svg = (detail) => `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect x="3" y="3" width="58" height="58" rx="13" fill="#2b2d32" stroke="#555962" stroke-width="${detail ? 1.5 : 3}"/>
  <rect x="15" y="${detail ? 19 : 17}" width="22" height="${detail ? 5 : 7}" rx="2.5" fill="#6cb4ae"/>
  <rect x="15" y="${detail ? 30 : 29}" width="34" height="${detail ? 5 : 7}" rx="2.5" fill="#ece6da"/>
  <rect x="15" y="${detail ? 41 : 41}" width="27" height="${detail ? 5 : 7}" rx="2.5" fill="#ece6da" opacity="${detail ? 0.55 : 0.7}"/>
</svg>`

function icoFromImages(images) {
  // images: [{ size, rgba: Uint8Array (straight alpha), png: Buffer }]
  const entries = images.map(({ size, rgba, png }) => {
    if (size >= 256) return { size, data: png }
    // Classic DIB entry (BGRA, bottom-up) followed by a 1-bit AND mask: understood by every tool.
    const header = Buffer.alloc(40)
    header.writeUInt32LE(40, 0)
    header.writeInt32LE(size, 4)
    header.writeInt32LE(size * 2, 8)
    header.writeUInt16LE(1, 12)
    header.writeUInt16LE(32, 14)
    header.writeUInt32LE(size * size * 4, 20)
    const pixels = Buffer.alloc(size * size * 4)
    const maskStride = Math.ceil(size / 32) * 4
    const mask = Buffer.alloc(maskStride * size)
    for (let y = 0; y < size; y++) {
      const dstRow = size - 1 - y
      for (let x = 0; x < size; x++) {
        const s = (y * size + x) * 4
        const d = (dstRow * size + x) * 4
        pixels[d] = rgba[s + 2]
        pixels[d + 1] = rgba[s + 1]
        pixels[d + 2] = rgba[s]
        pixels[d + 3] = rgba[s + 3]
        if (rgba[s + 3] === 0) mask[dstRow * maskStride + (x >> 3)] |= 0x80 >> (x & 7)
      }
    }
    return { size, data: Buffer.concat([header, pixels, mask]) }
  })
  const dir = Buffer.alloc(6 + entries.length * 16)
  dir.writeUInt16LE(0, 0)
  dir.writeUInt16LE(1, 2)
  dir.writeUInt16LE(entries.length, 4)
  let offset = dir.length
  entries.forEach((entry, i) => {
    const at = 6 + i * 16
    dir[at] = entry.size >= 256 ? 0 : entry.size
    dir[at + 1] = entry.size >= 256 ? 0 : entry.size
    dir.writeUInt16LE(1, at + 4)
    dir.writeUInt16LE(32, at + 6)
    dir.writeUInt32LE(entry.data.length, at + 8)
    dir.writeUInt32LE(offset, at + 12)
    offset += entry.data.length
  })
  return Buffer.concat([dir, ...entries.map((e) => e.data)])
}

app.disableHardwareAcceleration()
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } })
  await win.loadURL('data:text/html,<canvas id="c"></canvas>')
  const render = (size) =>
    win.webContents.executeJavaScript(`(async () => {
      const svg = ${JSON.stringify(svg(true))}, small = ${JSON.stringify(svg(false))}
      const img = new Image()
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(${size} <= 24 ? small : svg)
      await img.decode()
      const c = document.getElementById('c'); c.width = c.height = ${size}
      const ctx = c.getContext('2d'); ctx.clearRect(0, 0, ${size}, ${size}); ctx.drawImage(img, 0, 0, ${size}, ${size})
      return { rgba: Array.from(ctx.getImageData(0, 0, ${size}, ${size}).data), png: c.toDataURL('image/png').split(',')[1] }
    })()`)

  const make = async (sizes) => {
    const out = []
    for (const size of sizes) {
      const { rgba, png } = await render(size)
      out.push({ size, rgba: Uint8Array.from(rgba), png: Buffer.from(png, 'base64') })
    }
    return out
  }

  const appImages = await make([16, 20, 24, 32, 40, 48, 64, 128, 256])
  const trayImages = await make([16, 20, 24, 32, 40, 48])
  const [big] = await make([512])
  const [tray32] = await make([32])

  fs.mkdirSync(path.join(root, 'build'), { recursive: true })
  fs.mkdirSync(path.join(root, 'resources'), { recursive: true })
  fs.writeFileSync(path.join(root, 'build/icon.ico'), icoFromImages(appImages))
  fs.writeFileSync(path.join(root, 'build/icon.png'), big.png)
  fs.writeFileSync(path.join(root, 'resources/icon.png'), appImages[appImages.length - 1].png)
  fs.writeFileSync(path.join(root, 'resources/tray.ico'), icoFromImages(trayImages))
  fs.writeFileSync(path.join(root, 'resources/tray.png'), tray32.png)
  console.log('icons written')
  app.quit()
})
