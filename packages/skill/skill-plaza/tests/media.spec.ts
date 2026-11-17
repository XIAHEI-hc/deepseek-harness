/**
 * Image admission: the format is decided by the file signature, and the
 * dimensions come from the container header, so neither the declared name nor
 * the declared media type can admit something the plaza cannot render.
 */
import { describe, expect, it } from 'vitest'
import { admitImage } from '../src/media.ts'
import { MAX_PLAZA_IMAGE_SIDE } from '../src/presentation.ts'

/** Build a PNG header carrying the given dimensions. */
function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  bytes.set([0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52], 8)
  const view = new DataView(bytes.buffer)
  view.setUint32(16, width)
  view.setUint32(20, height)
  return bytes
}

/** Build a JPEG header with one start-of-frame segment. */
function jpeg(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array([
    0xff, 0xd8,
    0xff, 0xe0, 0x00, 0x04, 0x00, 0x00,
    0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x00, 0x00, 0x00, 0x03,
  ])
  const view = new DataView(bytes.buffer)
  view.setUint16(13, height)
  view.setUint16(15, width)
  return bytes
}

/** Build a lossless VP8L WebP header. */
function webpLossless(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(30)
  bytes.set([0x52, 0x49, 0x46, 0x46], 0)
  bytes.set([0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x4c], 8)
  bytes[20] = 0x2f
  const packed = ((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14)
  new DataView(bytes.buffer).setUint32(21, packed, true)
  return bytes
}

/** Build an extended VP8X WebP header. */
function webpExtended(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(30)
  bytes.set([0x52, 0x49, 0x46, 0x46], 0)
  bytes.set([0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x58], 8)
  const w = width - 1
  const h = height - 1
  bytes[24] = w & 0xff
  bytes[25] = (w >> 8) & 0xff
  bytes[26] = (w >> 16) & 0xff
  bytes[27] = h & 0xff
  bytes[28] = (h >> 8) & 0xff
  bytes[29] = (h >> 16) & 0xff
  return bytes
}

describe('plaza image admission', () => {
  it('reads PNG dimensions from the IHDR chunk', () => {
    expect(admitImage(png(640, 480))).toEqual({
      ok: true,
      facts: { mimeType: 'image/png', width: 640, height: 480 },
    })
  })

  it('reads JPEG dimensions from the start-of-frame segment', () => {
    expect(admitImage(jpeg(320, 200))).toEqual({
      ok: true,
      facts: { mimeType: 'image/jpeg', width: 320, height: 200 },
    })
  })

  it('reads both WebP container variants', () => {
    expect(admitImage(webpLossless(800, 600))).toEqual({
      ok: true,
      facts: { mimeType: 'image/webp', width: 800, height: 600 },
    })
    expect(admitImage(webpExtended(1024, 768))).toEqual({
      ok: true,
      facts: { mimeType: 'image/webp', width: 1024, height: 768 },
    })
  })

  it('rejects an empty file and anything without a known signature', () => {
    const empty = admitImage(new Uint8Array())
    expect(empty.ok).toBe(false)
    const gif = admitImage(new TextEncoder().encode('GIF89a'))
    expect(gif.ok).toBe(false)
    if (gif.ok) return
    expect(gif.reason).toContain('PNG')
  })

  it('rejects a truncated header it cannot measure', () => {
    expect(admitImage(png(10, 10).slice(0, 20))).toMatchObject({ ok: false })
    expect(admitImage(jpeg(10, 10).slice(0, 8))).toMatchObject({ ok: false })
  })

  it('rejects a side longer than the admitted maximum', () => {
    const oversized = admitImage(png(MAX_PLAZA_IMAGE_SIDE + 1, 10))
    expect(oversized.ok).toBe(false)
    if (oversized.ok) return
    expect(oversized.reason).toContain('longest admitted side')
  })
})
