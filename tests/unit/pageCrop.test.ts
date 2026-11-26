import type { Display, NativeImage, SourcesOptions } from 'electron'
import { afterEach, describe, expect, it } from 'vitest'
import { captureSize, choosePage, gdiCaptureRegion, hwndFromSourceId, keepsWholePicture, letterboxSize, mapPageToPicture, pageCrop, picturedRegion, type WindowGeometry } from '@shared/pageCrop'
import type { Rect } from '@shared/windowBounds'
import { captureChart, cropToPage, type CaptureContext, type CaptureSource } from '../../src/main/snapshot'
import { foregroundApi } from '../../src/main/foreground'
import { findPageWindows, lookUpWindowGeometry, setWindowGeometryApiForTests, windowGeometryApi, windowGeometryStatus, type WindowTree } from '../../src/main/windowGeometry'

const rect = (x: number, y: number, width: number, height: number): Rect => ({ x, y, width, height })

afterEach(() => setWindowGeometryApiForTests(undefined))

describe('window handles in desktopCapturer source ids', () => {
  it('reads the HWND of "window:<HWND>:<n>"', () => {
    expect(hwndFromSourceId('window:42:0')).toBe(42)
    expect(hwndFromSourceId('window:1312470:0')).toBe(1312470)
    expect(hwndFromSourceId('window:66874:1')).toBe(66874)
    // Handles are pointer-sized and signed in Chromium's ids; a negative one is still a handle.
    expect(hwndFromSourceId('window:-1520:0')).toBe(-1520)
  })
  it('finds none in anything else', () => {
    for (const id of ['screen:0:0', 'window:0:0', 'window:42', 'window::0', 'window:abc:0', 'window:42:0:1', 'window:4.2:0', ' window:42:0', 'window:99999999999999999999:0', '']) {
      expect(hwndFromSourceId(id), id).toBeNull()
    }
  })
})

describe('the page in the window’s picture', () => {
  it('a normal window: the tabs and address bar above the page are cut away', () => {
    // Frame (DWMWA_EXTENDED_FRAME_BOUNDS) at 200,100; the page starts 87 px down.
    const frame = rect(200, 100, 1200, 900)
    expect(mapPageToPicture(frame, rect(200, 187, 1200, 813), { width: 1200, height: 900 })).toEqual({ method: 'page', rect: rect(0, 87, 1200, 813) })
    // A one-pixel window border on the left, right and bottom is cut too.
    expect(mapPageToPicture(frame, rect(201, 187, 1198, 812), { width: 1200, height: 900 })).toEqual({ method: 'page', rect: rect(1, 87, 1198, 812) })
  })

  it('a maximized window: the frame is the visible part, not the window rectangle', () => {
    // GetWindowRect would say -8,-8 1936x1056; the visible frame is the monitor's work area.
    const frame = rect(0, 0, 1920, 1040)
    expect(mapPageToPicture(frame, rect(0, 79, 1920, 961), { width: 1920, height: 1040 })).toEqual({ method: 'page', rect: rect(0, 79, 1920, 961) })
    // Windows 11, restored: the visible frame is inside the window rectangle by its invisible borders.
    const restored = rect(307, 120, 1306, 801) // window rectangle 300,120 1320x808
    expect(mapPageToPicture(restored, rect(308, 194, 1304, 726), { width: 1306, height: 801 })).toEqual({ method: 'page', rect: rect(1, 74, 1304, 726) })
  })

  it('a picture smaller than the frame (125% scale, the picture asked for smaller)', () => {
    // Physical frame 1500x1250 (1200x1000 at 125%); the picture is 1200x1000.
    const frame = rect(-1500, 0, 1500, 1250)
    expect(mapPageToPicture(frame, rect(-1500, 100, 1500, 1150), { width: 1200, height: 1000 })).toEqual({ method: 'page', rect: rect(0, 80, 1200, 920) })
  })

  it('a picture larger than the frame (150% scale): edges round inwards, never into the browser bar', () => {
    const frame = rect(0, 0, 1280, 720)
    // 95 px down at 1.5x is 142.5: the half row is the browser's, so the page starts at 143.
    expect(mapPageToPicture(frame, rect(0, 95, 1280, 625), { width: 1920, height: 1080 })).toEqual({ method: 'page', rect: rect(0, 143, 1920, 937) })
    // Fractions on every side: left 10.5 -> 11, right 1909.5 -> 1909, bottom 1078.5 -> 1078.
    expect(mapPageToPicture(frame, rect(7, 95, 1266, 624), { width: 1920, height: 1080 })).toEqual({ method: 'page', rect: rect(11, 143, 1898, 935) })
  })

  it('a full-screen page (F11) is the whole picture', () => {
    const frame = rect(0, 0, 2560, 1440)
    const crop = mapPageToPicture(frame, frame, { width: 2560, height: 1440 })
    expect(crop).toEqual({ method: 'page', rect: rect(0, 0, 2560, 1440) })
    expect(crop.method === 'page' && keepsWholePicture(crop.rect, { width: 2560, height: 1440 })).toBe(true)
    expect(pageCrop({ frame, pages: [frame] }, { width: 2560, height: 1440 })).toEqual({ method: 'page', rect: rect(0, 0, 2560, 1440), pictured: frame })
    expect(keepsWholePicture(rect(0, 1, 2560, 1439), { width: 2560, height: 1440 })).toBe(false)
  })

  it('keeps the whole picture when the picture is not the window as read', () => {
    const frame = rect(0, 0, 1000, 800)
    expect(mapPageToPicture(frame, rect(0, 80, 1000, 720), { width: 1000, height: 1000 })).toEqual({ method: 'none', reason: 'the picture does not match the browser window' })
    expect(mapPageToPicture(frame, rect(0, 80, 1000, 720), { width: 0, height: 0 }).method).toBe('none')
    expect(mapPageToPicture(rect(0, 0, 0, 0), rect(0, 80, 1000, 720), { width: 1000, height: 800 }).method).toBe('none')
    // One pixel of rounding in the picture's height is fine.
    expect(mapPageToPicture(frame, rect(0, 80, 1000, 720), { width: 1000, height: 801 }).method).toBe('page')
  })
})

describe('which part of the window the picture shows', () => {
  // A restored Chrome window on Windows 10/11 at 100 %: its rectangle includes invisible
  // resize borders, 7 px on the left, right and bottom; the visible frame is inside them.
  const window = rect(93, 50, 1014, 807)
  const frame = rect(100, 50, 1000, 800)
  const thick = 0x16cf0000 // WS_OVERLAPPEDWINDOW | WS_VISIBLE | WS_CLIPSIBLINGS | WS_CLIPCHILDREN (WS_THICKFRAME among them)
  const metrics = { sizeFrameX: 4, sizeFrameY: 4, borderY: 1 } // GetSystemMetrics at 96 DPI

  it('Electron’s window capture (webrtc’s GDI capturer) pictures the window less its resize borders as system metrics give them', () => {
    expect(gdiCaptureRegion(window, frame, thick, metrics)).toEqual(rect(97, 51, 1006, 802))
    // Maximized: the window rectangle hangs 8 px over the monitor's edges; the frame is the work area.
    expect(gdiCaptureRegion(rect(-8, -8, 1936, 1056), rect(0, 0, 1920, 1040), thick, metrics)).toEqual(rect(-4, -7, 1928, 1051))
    // At 150 % the system metrics are larger, and a monitor left of the main one has negative coordinates.
    expect(gdiCaptureRegion(rect(-1931, 100, 1462, 1211), rect(-1920, 100, 1440, 1200), thick, { sizeFrameX: 6, sizeFrameY: 6, borderY: 1 })).toEqual(rect(-1925, 101, 1450, 1204))
    // No invisible border (full screen, F11), or no resize border: the whole window rectangle.
    expect(gdiCaptureRegion(rect(0, 0, 1920, 1080), rect(0, 0, 1920, 1080), thick, metrics)).toEqual(rect(0, 0, 1920, 1080))
    expect(gdiCaptureRegion(window, frame, 0x96000000, metrics)).toEqual(window) // WS_POPUP | WS_VISIBLE | WS_CLIPSIBLINGS
  })

  it('sizes a picture as desktopCapturer does: scaled to fit the size asked for, its shape kept', () => {
    expect(letterboxSize({ width: 1006, height: 802 }, { width: 1006, height: 802 })).toEqual({ width: 1006, height: 802 })
    // The visible frame, pictured instead (Windows Graphics Capture), into a request for the GDI region's size.
    expect(letterboxSize({ width: 1006, height: 802 }, { width: 1000, height: 800 })).toEqual({ width: 1003, height: 802 })
    expect(letterboxSize({ width: 1928, height: 1051 }, { width: 1920, height: 1040 })).toEqual({ width: 1928, height: 1044 })
    expect(letterboxSize({ width: 1920, height: 1080 }, { width: 1000, height: 800 })).toEqual({ width: 1350, height: 1080 })
    // A minimized or hidden window comes as a 1x1 picture: a square.
    expect(letterboxSize({ width: 952, height: 1035 }, { width: 1, height: 1 })).toEqual({ width: 952, height: 952 })
    expect(letterboxSize({ width: 100, height: 100 }, { width: 0, height: 0 })).toEqual({ width: 0, height: 0 })
  })

  it('asks for the picture at the size of the GDI region, or of the frame when that is all that is known', () => {
    expect(captureSize({ frame, gdiRegion: rect(97, 51, 1006, 802), pages: [] })).toEqual({ width: 1006, height: 802 })
    expect(captureSize({ frame, pages: [] })).toEqual({ width: 1000, height: 800 })
  })

  it('tells the two pictures apart by their size, and refuses when it cannot', () => {
    const geometry = { frame, gdiRegion: gdiCaptureRegion(window, frame, thick, metrics), pages: [] }
    const requested = captureSize(geometry)
    expect(picturedRegion(geometry, requested, { width: 1006, height: 802 })).toEqual({ region: rect(97, 51, 1006, 802) })
    expect(picturedRegion(geometry, requested, { width: 1003, height: 802 })).toEqual({ region: frame })
    expect(picturedRegion(geometry, requested, { width: 1006, height: 1006 })).toEqual({ reason: 'the picture is not of the browser window as Windows reports it' })
    expect(picturedRegion(geometry, requested, { width: 503, height: 401 })).toEqual({ reason: 'the picture is not of the browser window as Windows reports it' })
    // Two parts of the window of the same size but in different places: which one is it?
    expect(picturedRegion({ frame, gdiRegion: rect(103, 50, 1000, 800), pages: [] }, { width: 1000, height: 800 }, { width: 1000, height: 800 })).toEqual({ reason: 'it cannot be told which part of the browser window the picture shows' })
  })

  it('a restored window pictured by GDI: the page is placed in the GDI region, not the frame, so neither border nor browser bar is kept', () => {
    const page = rect(100, 140, 760, 710)
    const geometry = { frame, gdiRegion: gdiCaptureRegion(window, frame, thick, metrics), pages: [page, rect(860, 140, 240, 710)], dpi: 96 }
    // 3 px of invisible border on the left of the picture, and the page starts 89 rows down (the region starts a row lower than the frame).
    expect(pageCrop(geometry, { width: 1006, height: 802 })).toEqual({ method: 'page', rect: rect(3, 89, 760, 710), pictured: geometry.gdiRegion })
  })

  it('a maximized window pictured by GDI: the 7 rows above the screen are not mistaken for the page', () => {
    const geometry = { frame: rect(0, 0, 1920, 1040), gdiRegion: gdiCaptureRegion(rect(-8, -8, 1936, 1056), rect(0, 0, 1920, 1040), thick, metrics), pages: [rect(0, 80, 1920, 960)], dpi: 96 }
    expect(pageCrop(geometry, { width: 1928, height: 1051 })).toEqual({ method: 'page', rect: rect(4, 87, 1920, 960), pictured: rect(-4, -7, 1928, 1051) })
  })

  it('the frame pictured instead (Windows 11 falls back to Windows Graphics Capture), scaled to the size asked for: placed in the frame, a pixel inside', () => {
    const geometry = { frame, gdiRegion: gdiCaptureRegion(window, frame, thick, metrics), pages: [rect(100, 140, 760, 710)], dpi: 96 }
    // 1003x802 for a 1000x800 frame: the page's top at 90 is 90.2 rows down, so 91, and a row more for the blending of a scaled edge.
    expect(pageCrop(geometry, { width: 1003, height: 802 })).toEqual({ method: 'page', rect: rect(1, 92, 760, 709), pictured: frame })
  })

  it('at a display scale that is not a whole multiple of 100 %, a pixel inside the page window (Chromium rounds it outwards)', () => {
    const page = rect(100, 140, 760, 710)
    const gdiRegion = gdiCaptureRegion(window, frame, thick, metrics)
    expect(pageCrop({ frame, gdiRegion, pages: [page], dpi: 120 }, { width: 1006, height: 802 })).toMatchObject({ method: 'page', rect: rect(4, 90, 758, 708) })
    expect(pageCrop({ frame, gdiRegion, pages: [page], dpi: 144 }, { width: 1006, height: 802 })).toMatchObject({ method: 'page', rect: rect(4, 90, 758, 708) })
    expect(pageCrop({ frame, gdiRegion, pages: [page], dpi: 192 }, { width: 1006, height: 802 })).toMatchObject({ method: 'page', rect: rect(3, 89, 760, 710) })
    expect(pageCrop({ frame, gdiRegion, pages: [page], dpi: null }, { width: 1006, height: 802 })).toMatchObject({ method: 'page', rect: rect(3, 89, 760, 710) })
  })

  it('keeps the whole picture when it is of neither part of the window, or the page does not fit in it', () => {
    const geometry = { frame, gdiRegion: gdiCaptureRegion(window, frame, thick, metrics), pages: [rect(100, 140, 760, 710)] }
    expect(pageCrop(geometry, { width: 1006, height: 1006 })).toEqual({ method: 'none', reason: 'the picture is not of the browser window as Windows reports it', pictured: null })
    expect(pageCrop(geometry, { width: 1000, height: 800 })).toEqual({ method: 'none', reason: 'the picture is not of the browser window as Windows reports it', pictured: null })
    expect(mapPageToPicture(frame, rect(100, 140, 2, 2), { width: 1000, height: 800 }, 1)).toEqual({ method: 'none', reason: 'the page is not in the picture' })
  })
})

describe('which page window is the chart', () => {
  const frame = rect(0, 0, 1600, 1000)
  const page = rect(0, 110, 1600, 890)

  it('the one page window', () => {
    expect(choosePage({ frame, pages: [page] })).toEqual({ page })
  })

  it('the largest, when a side panel or docked developer tools sit beside it', () => {
    const chart = rect(0, 110, 1240, 890)
    const sidePanel = rect(1240, 110, 360, 890) // 20% of the window
    expect(choosePage({ frame, pages: [sidePanel, chart] })).toEqual({ page: chart })
    expect(pageCrop({ frame, pages: [sidePanel, chart] }, { width: 1600, height: 1000 })).toEqual({ method: 'page', rect: chart, pictured: frame })
    // Vertical tabs on the left: the page window starts to the right of them.
    const vertical = rect(240, 80, 1360, 920)
    expect(pageCrop({ frame, pages: [vertical] }, { width: 1600, height: 1000 })).toEqual({ method: 'page', rect: vertical, pictured: frame })
  })

  it('a page shown over the chart page (same place) is no reason to doubt it', () => {
    const overlay = rect(0, 110, 1600, 890)
    expect(choosePage({ frame, pages: [page, overlay] })).toEqual({ page })
  })

  it('nothing is cut when two pages of their own size sit side by side (split view)', () => {
    expect(choosePage({ frame, pages: [rect(0, 110, 800, 890), rect(800, 110, 800, 890)] })).toEqual({ reason: 'two pages are side by side in the browser window' })
  })

  it('nothing is cut when there is no page window, or it is implausible', () => {
    expect(choosePage({ frame, pages: [] })).toEqual({ reason: 'no page window was found in the browser window' })
    expect(choosePage({ frame, pages: [rect(0, 0, 0, 0)] })).toEqual({ reason: 'no page window was found in the browser window' })
    // Outside the window (beyond 2 px of rounding).
    expect(choosePage({ frame, pages: [rect(0, 110, 1600, 900)] })).toEqual({ reason: 'the page window is outside the browser window' })
    expect(choosePage({ frame, pages: [rect(-40, 110, 1600, 890)] })).toEqual({ reason: 'the page window is outside the browser window' })
    expect(choosePage({ frame, pages: [rect(2000, 110, 1600, 890)] })).toEqual({ reason: 'the page window is outside the browser window' })
    // Tiny, or too small a share of the window to be the chart page.
    expect(choosePage({ frame, pages: [rect(10, 110, 90, 890)] })).toEqual({ reason: 'the page window is too small to be the chart' })
    expect(choosePage({ frame, pages: [rect(0, 110, 1600, 60)] })).toEqual({ reason: 'the page window is too small to be the chart' })
    expect(choosePage({ frame, pages: [rect(0, 110, 500, 890)] })).toEqual({ reason: 'the page window is too small to be the chart' })
    expect(choosePage({ frame: rect(0, 0, 0, 900), pages: [page] })).toEqual({ reason: 'the window has no visible frame' })
  })

  it('a page within 2 px of rounding outside the frame is kept, clamped to it', () => {
    expect(choosePage({ frame, pages: [rect(-1, 110, 1602, 892)] })).toEqual({ page: rect(0, 110, 1600, 890) })
    expect(pageCrop({ frame, pages: [rect(-2, 108, 1604, 894)] }, { width: 1600, height: 1000 })).toEqual({ method: 'page', rect: rect(0, 108, 1600, 892), pictured: frame })
  })
})

describe('finding the page windows (Windows, without callbacks)', () => {
  /** A made-up window tree: each window's class, whether it is shown, its rectangle and its children. */
  function tree(windows: Record<number, { className: string; visible?: boolean; rect?: Rect; children?: number[] }>): WindowTree & { asked: number[] } {
    const parentOf = new Map<number, number>()
    for (const [id, w] of Object.entries(windows)) for (const child of w.children ?? []) parentOf.set(child, Number(id))
    const asked: number[] = []
    const visible = (hwnd: number): boolean => windows[hwnd]?.visible !== false && (parentOf.has(hwnd) ? visible(parentOf.get(hwnd)!) : true)
    return {
      asked,
      firstChild: (hwnd) => windows[hwnd]?.children?.[0] ?? 0,
      next: (hwnd) => {
        const siblings = windows[parentOf.get(hwnd) ?? -1]?.children ?? []
        return siblings[siblings.indexOf(hwnd) + 1] ?? 0
      },
      className: (hwnd) => {
        asked.push(hwnd)
        return windows[hwnd]?.className ?? ''
      },
      visible,
      rect: (hwnd) => windows[hwnd]?.rect ?? null
    }
  }

  it('takes every visible Chrome_RenderWidgetHostHWND, at any depth, and skips hidden ones with what is inside them', () => {
    const page = rect(0, 110, 1600, 890)
    const devtools = rect(1200, 110, 400, 890)
    const t = tree({
      1: { className: 'Chrome_WidgetWin_1', children: [2, 3, 4, 5, 7] },
      2: { className: 'Intermediate D3D Window', rect: rect(0, 0, 1600, 1000) },
      3: { className: 'Chrome_RenderWidgetHostHWND', rect: page },
      // A background tab's page window is hidden.
      4: { className: 'Chrome_RenderWidgetHostHWND', visible: false, rect: rect(0, 110, 1600, 890), children: [9] },
      5: { className: 'SomeHost', children: [6] },
      6: { className: 'Chrome_RenderWidgetHostHWND', rect: devtools },
      7: { className: 'Chrome_RenderWidgetHostHWND', rect: rect(0, 0, 0, 0) },
      9: { className: 'Chrome_RenderWidgetHostHWND', rect: rect(5, 5, 50, 50) }
    })
    const found = findPageWindows(t, 1)
    expect(found.pages).toEqual(expect.arrayContaining([page, devtools]))
    expect(found.pages).toHaveLength(2)
    // The hidden tab's insides were never looked at.
    expect(t.asked).not.toContain(9)
    expect(found.walked).toBe(6)
  })

  it('stops after a few thousand windows', () => {
    const many: Record<number, { className: string; children?: number[] }> = { 1: { className: 'Chrome_WidgetWin_1', children: Array.from({ length: 10_000 }, (_, i) => i + 2) } }
    for (let i = 2; i < 10_002; i++) many[i] = { className: 'Other' }
    expect(findPageWindows(tree(many), 1).walked).toBeLessThanOrEqual(4096)
  })

  it('is only loaded on Windows, and off Windows nothing is cut', () => {
    if (process.platform === 'win32') {
      expect(windowGeometryStatus()).toEqual({ available: true, error: null })
      // A real window's frame reads back with a size: the taskbar, or the desktop behind everything.
      const windows = foregroundApi()!
      const shell = [...windows.topDown()].filter((hwnd) => ['Shell_TrayWnd', 'Progman'].includes(windows.describe(hwnd)?.className ?? ''))
      const readings = shell.map((hwnd) => windowGeometryApi()!.read(hwnd)).filter((reading) => reading !== null)
      expect(readings.length).toBeGreaterThan(0)
      for (const reading of readings) {
        expect(reading.frame.width).toBeGreaterThan(0)
        expect(reading.frame.height).toBeGreaterThan(0)
        expect(reading.window.width).toBeGreaterThanOrEqual(reading.frame.width)
        expect(reading.gdiRegion!.width).toBeGreaterThan(0)
        expect(reading.pages).toEqual([])
      }
      expect(typeof windowGeometryApi()!.physicalPixels()).toBe('boolean')
    } else {
      expect(windowGeometryApi()).toBeNull()
      expect(windowGeometryStatus()).toEqual({ available: false, error: null })
      expect(lookUpWindowGeometry('window:42:0')).toEqual({ ok: false, reason: 'the page is only found on Windows' })
    }
  })

  it('looks a source id up through the API, and says why when it cannot', () => {
    const geometry = { frame: rect(0, 0, 1600, 1000), window: rect(-7, 0, 1614, 1007), pages: [rect(0, 110, 1600, 890)], walked: 3 }
    const read: number[] = []
    let physical = true
    setWindowGeometryApiForTests({ read: (hwnd) => (read.push(hwnd), hwnd === 42 ? geometry : null), physicalPixels: () => physical })
    expect(lookUpWindowGeometry('window:42:0')).toEqual({ ok: true, geometry })
    expect(lookUpWindowGeometry('window:43:0')).toEqual({ ok: false, reason: 'the browser window could not be read (closed or minimized)' })
    expect(lookUpWindowGeometry('screen:0:0')).toEqual({ ok: false, reason: 'the window source has no window handle' })
    physical = false
    expect(lookUpWindowGeometry('window:42:0').ok).toBe(false)
    expect(read).toEqual([42, 43])
    setWindowGeometryApiForTests({ read: () => { throw new Error('boom') }, physicalPixels: () => true })
    expect(lookUpWindowGeometry('window:42:0')).toEqual({ ok: false, reason: 'the browser window could not be read (boom)' })
    // A failing DPI-awareness query is no crash either: the whole window is kept.
    setWindowGeometryApiForTests({ read: () => geometry, physicalPixels: () => { throw new Error('no context') } })
    expect(lookUpWindowGeometry('window:42:0')).toEqual({ ok: false, reason: 'the browser window could not be read (no context)' })
  })
})

describe('the snapshot keeps the page of the chart window', () => {
  interface FakeImage { width: number; height: number; croppedTo: Rect | null }
  function image(width: number, height: number, croppedTo: Rect | null = null): NativeImage {
    const fake = {
      width,
      height,
      croppedTo,
      isEmpty: () => width === 0 || height === 0,
      getSize: () => ({ width, height }),
      crop: (r: Rect) => image(r.width, r.height, r)
    }
    return fake as unknown as NativeImage
  }
  const asFake = (value: NativeImage): FakeImage => value as unknown as FakeImage
  const display = { id: 1, bounds: rect(0, 0, 1920, 1080), scaleFactor: 1 } as unknown as Display

  function context(geometry: WindowGeometry | null, picture: { width: number; height: number }): CaptureContext & { asked: SourcesOptions[] } {
    const asked: SourcesOptions[] = []
    return {
      asked,
      getSources: async (options) => {
        asked.push(options)
        const empty = options.thumbnailSize?.width === 0
        const sources: CaptureSource[] = [
          { id: 'window:42:0', name: 'ES1! 6,123.25 ▲ +0.35% Unnamed - Google Chrome', display_id: '', thumbnail: empty ? image(0, 0) : image(picture.width, picture.height) },
          { id: 'screen:1:0', name: 'Entire screen', display_id: '1', thumbnail: empty ? image(0, 0) : image(1920, 1080) }
        ]
        return sources.filter((s) => options.types.includes(s.id.startsWith('screen:') ? 'screen' : 'window'))
      },
      displays: [display],
      cursorDisplay: display,
      docked: null,
      ownTitle: 'Trading Notes',
      readGeometry: (id) => (geometry && id === 'window:42:0' ? { ok: true, geometry } : { ok: false, reason: 'the page is only found on Windows' })
    }
  }

  it('asks for the picture at the frame’s size and keeps only the page', async () => {
    const geometry = { frame: rect(100, 50, 1000, 800), pages: [rect(100, 140, 760, 710), rect(860, 140, 240, 710)] }
    const ctx = context(geometry, { width: 1000, height: 800 })
    const result = await captureChart(ctx)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.from).toBe('window')
    expect(ctx.asked[1]!.thumbnailSize).toEqual({ width: 1000, height: 800 })
    expect(asFake(result.image)).toMatchObject({ width: 760, height: 710, croppedTo: rect(0, 90, 760, 710) })
    expect(result.crop).toEqual({
      method: 'page',
      reason: null,
      rect: rect(0, 90, 760, 710),
      picture: { width: 1000, height: 800 },
      requested: { width: 1000, height: 800 },
      pictured: geometry.frame,
      frame: geometry.frame,
      gdiRegion: null,
      pages: geometry.pages,
      dpi: null
    })
  })

  it('asks for the picture at the GDI region’s size, and places the page in it', async () => {
    const geometry = { frame: rect(100, 50, 1000, 800), gdiRegion: rect(97, 51, 1006, 802), pages: [rect(100, 140, 760, 710)], dpi: 96 }
    const ctx = context(geometry, { width: 1006, height: 802 })
    const result = await captureChart(ctx)
    expect(ctx.asked[1]!.thumbnailSize).toEqual({ width: 1006, height: 802 })
    expect(result.ok && asFake(result.image)).toMatchObject({ width: 760, height: 710, croppedTo: rect(3, 89, 760, 710) })
    expect(result.ok && result.crop).toMatchObject({ method: 'page', pictured: rect(97, 51, 1006, 802), gdiRegion: rect(97, 51, 1006, 802), dpi: 96 })
  })

  it('keeps a picture whole when it is not of the size asked for (not the window as read)', async () => {
    const geometry = { frame: rect(100, 50, 1000, 800), pages: [rect(100, 140, 760, 710)] }
    const result = await captureChart(context(geometry, { width: 500, height: 400 }))
    expect(result.ok && asFake(result.image)).toMatchObject({ width: 500, height: 400, croppedTo: null })
    expect(result.ok && result.crop).toMatchObject({ method: 'none', reason: 'the picture is not of the browser window as Windows reports it', requested: { width: 1000, height: 800 } })
  })

  it('keeps the whole window, as before, when the page cannot be found', async () => {
    const ctx = context(null, { width: 1600, height: 900 })
    const result = await captureChart(ctx)
    expect(result.ok && asFake(result.image)).toMatchObject({ width: 1600, height: 900, croppedTo: null })
    expect(result.ok && result.crop).toEqual({
      method: 'none',
      reason: 'the page is only found on Windows',
      rect: null,
      picture: { width: 1600, height: 900 },
      requested: null,
      pictured: null,
      frame: null,
      gdiRegion: null,
      pages: [],
      dpi: null
    })
    // The picture is then asked for at the largest display's size, as before.
    expect(ctx.asked[1]!.thumbnailSize).toEqual({ width: 1920, height: 1080 })
    const implausible = await captureChart(context({ frame: rect(0, 0, 1600, 900), pages: [rect(0, 0, 200, 200)] }, { width: 1600, height: 900 }))
    expect(implausible.ok && asFake(implausible.image)).toMatchObject({ width: 1600, height: 900, croppedTo: null })
    expect(implausible.ok && implausible.crop?.reason).toBe('the page window is too small to be the chart')
  })

  it('a full-screen page is kept as captured, without a crop', () => {
    const picture = image(1920, 1080)
    const { image: kept, crop } = cropToPage(picture, { ok: true, geometry: { frame: rect(0, 0, 1920, 1080), gdiRegion: rect(0, 0, 1920, 1080), pages: [rect(0, 0, 1920, 1080)], dpi: 96 } }, { width: 1920, height: 1080 })
    expect(kept).toBe(picture)
    expect(crop).toMatchObject({ method: 'page', rect: rect(0, 0, 1920, 1080) })
    // Without the size it was asked for, nothing can be placed in a picture.
    expect(cropToPage(picture, { ok: true, geometry: { frame: rect(0, 0, 1920, 1080), pages: [rect(0, 0, 1920, 1080)] } }, null).crop).toMatchObject({ method: 'none' })
  })

  it('the display under the pointer is never cut to a page', async () => {
    const ctx = context({ frame: rect(0, 0, 1000, 800), pages: [rect(0, 90, 1000, 710)] }, { width: 1000, height: 800 })
    ctx.getSources = async (options) => (options.types.includes('screen') ? [{ id: 'screen:1:0', name: 'Entire screen', display_id: '1', thumbnail: image(1920, 1080) }] : [])
    const result = await captureChart(ctx)
    expect(result.ok && result.from).toBe('display')
    expect(result.ok && result.crop).toBeNull()
    expect(result.ok && asFake(result.image)).toMatchObject({ width: 1920, height: 1080, croppedTo: null })
  })
})
