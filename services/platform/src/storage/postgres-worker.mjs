/**
 * Worker that owns the async PostgreSQL pool for the synchronous bridge.
 *
 * Protocol on the shared control words:
 *   0 - statement state: 0 idle, 1 request, 2 response, 3 error
 *   1 - readiness: 0 starting, 1 ready, 2 failed
 *   2 - readiness failure
 * The payload starts at byte 16: a little-endian uint32 length followed by UTF-8
 * JSON. Both sides resynchronize on state 0 after a completed call.
 */
import { workerData } from 'node:worker_threads'
import pg from 'pg'

const { connectionString, buffer } = workerData
const control = new Int32Array(buffer, 0, 4)
const payload = new Uint8Array(buffer, 16)
const view = new DataView(buffer, 16)
const decoder = new TextDecoder()
const encoder = new TextEncoder()

const pool = new pg.Pool({ connectionString, max: 4 })
let transactionClient = null

/**
 * Execute one statement on the pool or the active transaction client.
 * @param {string} sql - statement text with `$n` placeholders.
 * @param {unknown[]} params - positional parameters.
 * @returns {Promise<{ rows: Record<string, unknown>[], changes: number }>}
 */
async function runStatement(sql, params) {
  const text = sql.trim()
  const upper = text.toUpperCase()
  if (upper.startsWith('BEGIN')) {
    if (transactionClient === null) transactionClient = await pool.connect()
    await transactionClient.query(text)
    return { rows: [], changes: 0 }
  }
  if (upper.startsWith('COMMIT') || upper.startsWith('ROLLBACK')) {
    if (transactionClient !== null) {
      await transactionClient.query(text)
      transactionClient.release()
      transactionClient = null
    }
    return { rows: [], changes: 0 }
  }
  const result = transactionClient === null
    ? await pool.query(text, params)
    : await transactionClient.query(text, params)
  return { rows: result.rows ?? [], changes: result.rowCount ?? 0 }
}

/**
 * Publish one response and wait until the main thread consumes it.
 * @param {number} state - 2 for response, 3 for error.
 * @param {object} body - payload.
 */
function publish(state, body) {
  const encoded = encoder.encode(JSON.stringify(body))
  view.setUint32(0, encoded.length, true)
  payload.set(encoded, 4)
  Atomics.store(control, 0, state)
  Atomics.notify(control, 0)
  while (Atomics.load(control, 0) !== 0) {
    Atomics.wait(control, 0, state, 10_000)
  }
  Atomics.store(control, 0, 0)
}

async function main() {
  let lastError = null
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      const client = await pool.connect()
      client.release()
      lastError = null
      break
    } catch (error) {
      lastError = error
      await new Promise(resolve => setTimeout(resolve, 250))
    }
  }
  if (lastError !== null) {
    const encoded = encoder.encode(lastError instanceof Error ? lastError.message : String(lastError))
    view.setUint32(0, encoded.length, true)
    payload.set(encoded, 4)
    Atomics.store(control, 1, 2)
    Atomics.notify(control, 1)
    return
  }
  Atomics.store(control, 1, 1)
  Atomics.notify(control, 1)
  for (;;) {
    const outcome = Atomics.wait(control, 0, 0, 60_000)
    if (outcome === 'timed-out') {
      await pool.end().catch(() => {})
      return
    }
    if (Atomics.load(control, 0) !== 1) continue
    const length = view.getUint32(0, true)
    const request = JSON.parse(decoder.decode(payload.subarray(4, 4 + length)))
    try {
      const result = await runStatement(request.sql, request.params ?? [])
      publish(2, { ok: true, rows: result.rows, changes: result.changes })
    } catch (error) {
      publish(3, { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }
}

await main()
