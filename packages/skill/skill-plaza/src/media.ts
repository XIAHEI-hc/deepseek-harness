/**
 * Static image admission for plaza media.
 *
 * Only PNG, JPEG, and WebP are admitted, and the format is decided by the file
 * signature rather than by the declared name or media type. Dimensions come
 * from the container header so a caller cannot publish a 20 000-pixel image by
 * lying about it.
 *
 * @module @deepseek-ai/dsh-skill-plaza
 */

import { MAX_PLAZA_ASSET_BYTES, MAX_PLAZA_IMAGE_SIDE } from './presentation.ts'
import type { PlazaMediaType } from './types.ts'

/** Pixel dimensions read from an image container header. */
export interface PlazaImageFacts {
  /** Detected format. */
  readonly mimeType: PlazaMediaType
  /** Pixel width. */
  readonly width: number
  /** Pixel height. */
  readonly height: number
}

/** Outcome of sniffing one candidate image. */
export type PlazaImageAdmission =
  | { readonly ok: true; readonly facts: PlazaImageFacts }
  | { readonly ok: false; readonly reason: string }

/**
 * Detect one candidate image's format and dimensions.
 * @param bytes - the complete uploaded file.
 * @returns its facts, or the reason it is not an admitted image.
 */
export function admitImage(bytes: Uint8Array): PlazaImageAdmission {
  if (bytes.byteLength === 0) return { ok: false, reason: 'the file is empty' }
  if (bytes.byteLength > MAX_PLAZA_ASSET_BYTES) {
    return { ok: false, reason: `the file exceeds ${MAX_PLAZA_ASSET_BYTES} bytes` }
  }
  const facts = pngFacts(bytes) ?? jpegFacts(bytes) ?? webpFacts(bytes)
  if (facts === undefined) {
    return { ok: false, reason: 'the file is not a PNG, JPEG, or WebP image' }
  }
  if (facts.width > MAX_PLAZA_IMAGE_SIDE || facts.height > MAX_PLAZA_IMAGE_SIDE) {
    return {
      ok: false,
      reason: `the image is ${facts.width}x${facts.height}; the longest admitted side is ${MAX_PLAZA_IMAGE_SIDE}`,
    }
  }
  return { ok: true, facts }
}

/** Read one unsigned 16-bit big-endian word. */
function u16be(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] as number) * 0x100 + (bytes[offset + 1] as number)
}

/** Read one unsigned 32-bit big-endian word. */
function u32be(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] as number) * 0x1000000)
    + ((bytes[offset + 1] as number) * 0x10000)
    + ((bytes[offset + 2] as number) * 0x100)
    + (bytes[offset + 3] as number)
}

/** Read one 24-bit little-endian word. */
function u24le(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] as number)
    + ((bytes[offset + 1] as number) * 0x100)
    + ((bytes[offset + 2] as number) * 0x10000)
}

/** Whether the buffer starts with the given signature. */
function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  if (bytes.byteLength < signature.length) return false
  return signature.every((value, index) => bytes[index] === value)
}

/** PNG facts from the IHDR chunk. */
function pngFacts(bytes: Uint8Array): PlazaImageFacts | undefined {
  if (!startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return undefined
  // 8-byte signature, 4-byte chunk length, "IHDR", then width and height.
  if (bytes.byteLength < 24) return undefined
  if (String.fromCharCode(...bytes.subarray(12, 16)) !== 'IHDR') return undefined
  const width = u32be(bytes, 16)
  const height = u32be(bytes, 20)
  if (width === 0 || height === 0) return undefined
  return { mimeType: 'image/png', width, height }
}

/** Start-of-frame markers that carry JPEG dimensions. */
const JPEG_SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf])

/** JPEG facts from the first start-of-frame segment. */
function jpegFacts(bytes: Uint8Array): PlazaImageFacts | undefined {
  if (!startsWith(bytes, [0xff, 0xd8])) return undefined
  let offset = 2
  while (offset + 9 < bytes.byteLength) {
    if (bytes[offset] !== 0xff) return undefined
    const marker = bytes[offset + 1] as number
    const length = u16be(bytes, offset + 2)
    if (length < 2) return undefined
    if (JPEG_SOF.has(marker)) {
      const height = u16be(bytes, offset + 5)
      const width = u16be(bytes, offset + 7)
      if (width === 0 || height === 0) return undefined
      return { mimeType: 'image/jpeg', width, height }
    }
    offset += 2 + length
  }
  return undefined
}

/** WebP facts from the VP8, VP8L, or VP8X chunk. */
function webpFacts(bytes: Uint8Array): PlazaImageFacts | undefined {
  if (bytes.byteLength < 30) return undefined
  if (String.fromCharCode(...bytes.subarray(0, 4)) !== 'RIFF') return undefined
  if (String.fromCharCode(...bytes.subarray(8, 12)) !== 'WEBP') return undefined
  const chunk = String.fromCharCode(...bytes.subarray(12, 16))
  if (chunk === 'VP8 ') {
    if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) return undefined
    const width = u16be(bytes, 26) & 0x3fff
    const height = u16be(bytes, 28) & 0x3fff
    if (width === 0 || height === 0) return undefined
    return { mimeType: 'image/webp', width, height }
  }
  if (chunk === 'VP8L') {
    if (bytes[20] !== 0x2f) return undefined
    const bits = (bytes[21] as number) + ((bytes[22] as number) * 0x100)
      + ((bytes[23] as number) * 0x10000) + ((bytes[24] as number) * 0x1000000)
    return {
      mimeType: 'image/webp',
      width: (bits & 0x3fff) + 1,
      height: ((bits >> 14) & 0x3fff) + 1,
    }
  }
  if (chunk === 'VP8X') {
    return {
      mimeType: 'image/webp',
      width: u24le(bytes, 24) + 1,
      height: u24le(bytes, 27) + 1,
    }
  }
  return undefined
}
