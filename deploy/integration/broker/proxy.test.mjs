/** Allowlisted egress proxy behavior, exercised without Docker. */
import { spawn } from 'node:child_process'
import { createServer, request as httpRequest } from 'node:http'
import { createServer as createTcpServer } from 'node:net'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import assert from 'node:assert/strict'

const PROXY = fileURLToPath(new URL('./proxy.mjs', import.meta.url))

/**
 * Reserve one loopback port.
 * @returns {Promise<number>} the free port.
 */
async function freePort() {
  const server = createTcpServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  const port = address.port
  server.close()
  await once(server, 'close')
  return port
}

/**
 * Start the target service.
 * @returns {Promise<{port: number, close: () => Promise<void>}>} server handle.
 */
async function targetService() {
  const server = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain' })
    response.end(`target:${request.url ?? ''}`)
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no target port')
  return {
    port: address.port,
    close: async () => {
      server.close()
      await once(server, 'close')
    },
  }
}

test('allows an exact allowlisted target and refuses another port', async () => {
  const target = await targetService()
  const proxyPort = await freePort()
  const child = spawn(process.execPath, [PROXY], {
    env: {
      ...process.env,
      PORT: String(proxyPort),
      DSH_FUSION_EGRESS_ALLOWLIST: `127.0.0.1:${String(target.port)}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  try {
    await once(child.stdout, 'data')
    const response = await new Promise((resolve, reject) => {
      const request = createServerRequest(proxyPort, `http://127.0.0.1:${String(target.port)}/hello`)
      request.on('response', resolve)
      request.on('error', reject)
      request.end()
    })
    assert.equal(response.statusCode, 200)
    const body = await readBody(response)
    assert.equal(body, 'target:/hello')

    const denied = await new Promise((resolve, reject) => {
      const request = createServerRequest(proxyPort, 'http://127.0.0.1:1/nope')
      request.on('response', resolve)
      request.on('error', reject)
      request.end()
    })
    assert.equal(denied.statusCode, 403)
  } finally {
    child.kill()
    await target.close()
  }
})

/**
 * Build one proxy request.
 * @param {number} port - proxy port.
 * @param {string} path - absolute target URL.
 * @returns {import('node:http').ClientRequest} request.
 */
function createServerRequest(port, path) {
  return httpRequest({ host: '127.0.0.1', port, path, method: 'GET' })
}

/**
 * Read one response body.
 * @param {import('node:http').IncomingMessage} response - response.
 * @returns {Promise<string>} decoded text.
 */
async function readBody(response) {
  let body = ''
  for await (const chunk of response) body += chunk.toString()
  return body
}
