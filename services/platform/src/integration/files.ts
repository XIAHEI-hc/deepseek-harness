/**
 * Filesystem helpers for immutable snapshots and analysis outputs.
 *
 * Every path is assembled from validated identifiers below a configured root.
 * Symlinks are refused rather than followed so a workspace cannot be turned into
 * a host path, and reads are byte-capped.
 *
 * @module @deepseek-ai/dsh-platform-services/integration/files
 */

import { createHash, randomUUID } from 'node:crypto'
import { lstatSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { relative, resolve, sep } from 'node:path'

/** Stable identifier syntax accepted for owner and object path segments. */
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u

/**
 * Refuse an identifier that would not be safe as one path segment.
 * @param value - candidate identifier.
 * @param name - field name for the error.
 * @throws {Error} when the value is not a single safe segment.
 */
export function assertSafeSegment(value: string, name: string): void {
  if (!SAFE_SEGMENT.test(value) || value === '.' || value === '..') {
    throw new Error(`${name} is not a safe path segment`)
  }
}

/**
 * Join validated segments below one root, proving the result stays inside it.
 * @param root - configured physical root.
 * @param segments - validated path segments.
 * @returns the absolute path.
 */
export function resolveWithin(root: string, ...segments: string[]): string {
  for (const segment of segments) assertSafeSegment(segment, 'path segment')
  const candidate = resolve(root, ...segments)
  const rel = relative(resolve(root), candidate)
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`)) {
    throw new Error('path escapes its configured root')
  }
  if (rel.split(sep).some(part => part === '..')) throw new Error('path escapes its configured root')
  return candidate
}

/**
 * Create one directory below a root and return its path.
 * @param root - configured root.
 * @param segments - validated segments.
 * @returns the created directory path.
 */
export function ensureDirectory(root: string, ...segments: string[]): string {
  const path = resolveWithin(root, ...segments)
  mkdirSync(path, { recursive: true })
  const stats = lstatSync(path)
  if (stats.isSymbolicLink() || !stats.isDirectory()) throw new Error('directory path is not a real directory')
  return path
}

/**
 * Compute a SHA-256 hex digest.
 * @param bytes - input bytes.
 * @returns the hex digest.
 */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * Write one immutable file, refusing to overwrite an existing path.
 * @param path - absolute destination.
 * @param bytes - content bytes.
 */
export function writeNewFile(path: string, bytes: Uint8Array): void {
  writeFileSync(path, bytes, { flag: 'wx', mode: 0o600 })
}

/**
 * Read one regular file with a hard byte cap and no symlink following.
 * @param path - absolute file path.
 * @param limit - maximum accepted bytes.
 * @returns the file bytes.
 * @throws {Error} when the path is a symlink, not a regular file, or too large.
 */
export function readRegularFile(path: string, limit: number): Uint8Array {
  const stats = lstatSync(path)
  if (stats.isSymbolicLink() || !stats.isFile()) throw new Error('artifact path is not a regular file')
  if (stats.size > limit) throw new Error('artifact exceeds the read limit')
  return readFileSync(path)
}

/** One regular file discovered under a directory. */
export interface DiscoveredFile {
  readonly relativePath: string
  readonly size: number
}

/**
 * List every regular file below a directory, refusing symlinks.
 * @param root - directory to walk.
 * @param maxFiles - maximum accepted file count.
 * @returns files with POSIX-style relative paths.
 * @throws {Error} when a symlink or non-regular entry is found, or the cap is exceeded.
 */
export function listRegularFiles(root: string, maxFiles: number): DiscoveredFile[] {
  const files: DiscoveredFile[] = []
  const walk = (directory: string): void => {
    const entries = readdirSync(directory, { withFileTypes: true })
    for (const entry of entries) {
      const path = resolve(directory, entry.name)
      const stats = lstatSync(path)
      if (stats.isSymbolicLink()) throw new Error(`symlink is not allowed in analysis output: ${entry.name}`)
      if (stats.isDirectory()) {
        walk(path)
        continue
      }
      if (!stats.isFile()) throw new Error(`non-regular analysis output: ${entry.name}`)
      if (files.length >= maxFiles) throw new Error('analysis output exceeds the file-count limit')
      files.push({ relativePath: relative(root, path).split(sep).join('/'), size: statSync(path).size })
    }
  }
  walk(root)
  return files
}

/**
 * Choose a content type from a file extension.
 * @param path - file path.
 * @returns a conservative media type.
 */
export function mimeForPath(path: string): string {
  const lower = path.toLowerCase()
  if (lower.endsWith('.json')) return 'application/json'
  if (lower.endsWith('.csv')) return 'text/csv; charset=utf-8'
  if (lower.endsWith('.md')) return 'text/markdown; charset=utf-8'
  if (lower.endsWith('.txt') || lower.endsWith('.log')) return 'text/plain; charset=utf-8'
  if (lower.endsWith('.html')) return 'text/html; charset=utf-8'
  if (lower.endsWith('.png')) return 'image/png'
  if (lower.endsWith('.svg')) return 'image/svg+xml'
  if (lower.endsWith('.pdf')) return 'application/pdf'
  return 'application/octet-stream'
}

/**
 * Allocate one random object id.
 * @returns a UUID.
 */
export function newObjectId(): string {
  return randomUUID()
}
