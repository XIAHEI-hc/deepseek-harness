/**
 * Minimal W3 test provider for deployment-stack smoke tests.
 * Binds 0.0.0.0 so a Docker platform container can reach it through docker0.
 */
import { createServer } from 'node:http'

const port = Number(process.argv[2] ?? '19090')
const codes = new Map()

function readBody(request) {
  return new Promise(resolve => {
    const chunks = []
    request.on('data', chunk => chunks.push(chunk))
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
  })
}
function parseBody(contentType, body) {
  if (body === '') return {}
  const result = {}
  if ((contentType ?? '').includes('application/json')) {
    try {
      const parsed = JSON.parse(body)
      if (parsed !== null && typeof parsed === 'object') {
        for (const [key, value] of Object.entries(parsed)) if (typeof value === 'string') result[key] = value
      }
    } catch {
      return {}
    }
    return result
  }
  for (const [key, value] of new URLSearchParams(body)) result[key] = value
  return result
}
function accountFromCookie(header) {
  for (const part of String(header ?? '').split(';')) {
    const [name, value] = part.trim().split('=')
    if (name === 'w3_account' && value !== undefined && value !== '') return value
  }
  return 'a'
}

createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', 'http://provider.invalid')
  const body = request.method === 'POST' ? await readBody(request) : ''
  if (url.pathname === '/health') {
    response.writeHead(200, { 'content-type': 'text/plain' })
    response.end('ok')
    return
  }
  if (url.pathname === '/__account') {
    const account = url.searchParams.get('account') ?? 'a'
    response.writeHead(200, {
      'content-type': 'text/plain',
      'set-cookie': `w3_account=${account}; Path=/; HttpOnly; SameSite=Lax`,
    })
    response.end('ok')
    return
  }
  if (url.pathname === '/authorize') {
    const state = url.searchParams.get('state') ?? ''
    const redirectUri = url.searchParams.get('redirect_uri') ?? ''
    if (state === '' || redirectUri === '') {
      response.writeHead(400, { 'content-type': 'text/plain' })
      response.end('missing state or redirect_uri')
      return
    }
    const account = accountFromCookie(request.headers.cookie)
    const code = `${account}:${String(codes.size)}`
    codes.set(code, account)
    const target = new URL(redirectUri)
    target.searchParams.set('code', code)
    target.searchParams.set('state', state)
    response.writeHead(302, { location: target.toString() })
    response.end()
    return
  }
  if (url.pathname === '/token') {
    const parsed = parseBody(request.headers['content-type'], body)
    const valid = parsed.client_id === 'dsh-client'
      && parsed.client_secret === 'dsh-secret'
      && parsed.grant_type === 'authorization_code'
      && parsed.redirect_uri !== undefined
      && codes.has(parsed.code ?? '')
    if (!valid) {
      response.writeHead(400, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: 'invalid_request' }))
      return
    }
    const account = codes.get(parsed.code ?? '') ?? 'a'
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ access_token: `tok:${account}`, token_type: 'bearer', expires_in: 3600 }))
    return
  }
  if (url.pathname === '/userinfo') {
    const parsed = parseBody(request.headers['content-type'], body)
    const account = (parsed.access_token ?? '').replace('tok:', '')
    const valid = account !== '' && parsed.client_id === 'dsh-client' && parsed.scope === 'base.profile'
    if (!valid) {
      response.writeHead(400, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: 'invalid_request' }))
      return
    }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({
      uuid: `w3-${account}`,
      uid: `uid-${account}`,
      displayName: `User ${account.toUpperCase()}`,
      email: `${account}@example.test`,
    }))
    return
  }
  response.writeHead(404, { 'content-type': 'text/plain' })
  response.end('not found')
}).listen(port, '0.0.0.0', () => {
  console.log(JSON.stringify({ type: 'ready', port }))
})
