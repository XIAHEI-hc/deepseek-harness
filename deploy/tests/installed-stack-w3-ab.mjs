import { readFileSync } from 'node:fs'

const mode = process.argv[2] ?? 'login'
const base = process.env.BASE ?? 'http://127.0.0.1:18082'
const provider = process.env.PROVIDER ?? 'http://172.17.0.1:19090'
const statePath = '/tmp/dsh-w3-ab-state.json'

class Jar {
  cookies = new Map()
  absorb(setCookies) {
    for (const text of setCookies) {
      const [pair] = text.split(';')
      const index = pair.indexOf('=')
      if (index <= 0) continue
      const name = pair.slice(0, index).trim()
      const value = pair.slice(index + 1).trim()
      if (value === '' || /max-age=0/i.test(text)) this.cookies.delete(name)
      else this.cookies.set(name, value)
    }
  }
  header() {
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ')
  }
  async request(url, init = {}) {
    const response = await fetch(url, {
      ...init,
      headers: { ...(this.cookies.size ? { cookie: this.header() } : {}), ...(init.headers ?? {}) },
      redirect: 'manual',
    })
    this.absorb(response.headers.getSetCookie())
    return response
  }
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

async function rpc(jar, endpoint, args) {
  const response = await jar.request(`${base}/api/${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method: endpoint, payload: { args } }),
  })
  return (await response.json()).result
}

async function login(account) {
  const jar = new Jar()
  await jar.request(`${provider}/__account?account=${account}`)
  const start = await jar.request(`${base}/auth/login?return_to=%2F`)
  if (start.status !== 302) throw new Error(`login start ${start.status}`)
  const authorize = await jar.request(start.headers.get('location'))
  if (authorize.status !== 302) throw new Error(`authorize ${authorize.status}`)
  const callback = await jar.request(authorize.headers.get('location'))
  if (callback.status !== 302) throw new Error(`callback ${callback.status}`)
  await jar.request(`${base}${callback.headers.get('location') ?? '/'}`)
  const me = await (await jar.request(`${base}/auth/me`)).json()
  await jar.request(`${base}/`)
  let state = 'UNKNOWN'
  for (let i = 0; i < 180; i++) {
    state = (await (await jar.request(`${base}/api/runtime/me`)).json()).state
    if (state === 'READY' || state === 'FAILED') break
    await sleep(1000)
  }
  return { jar, account, userId: me.user.id, displayName: me.user.displayName, state }
}

if (mode === 'login') {
  const a = await login('a')
  const b = await login('b')
  const createdA = await rpc(a.jar, 'session/create', { request: {} })
  const sessionA = createdA.value.sessionId
  const createdB = await rpc(b.jar, 'session/create', { request: {} })
  const sessionB = createdB.value.sessionId
  await rpc(a.jar, 'session/rename', { request: { sessionId: sessionA, title: 'A-only-web-title' } })
  await rpc(b.jar, 'session/rename', { request: { sessionId: sessionB, title: 'B-only-web-title' } })
  const listA = await rpc(a.jar, 'session/list', { _request: {} })
  const listB = await rpc(b.jar, 'session/list', { _request: {} })
  const idsA = (listA.value.items ?? []).map(item => item.sessionId)
  const idsB = (listB.value.items ?? []).map(item => item.sessionId)
  const cross = await rpc(a.jar, 'session/state', { request: { sessionId: sessionB } })
  const pageA = await a.jar.request(`${base}/`)
  const bootA = (await pageA.text()).includes('__DSH_BOOT__')
  const pageB = await b.jar.request(`${base}/`)
  const bootB = (await pageB.text()).includes('__DSH_BOOT__')
  const result = {
    mode,
    A: { userId: a.userId, displayName: a.displayName, state: a.state },
    B: { userId: b.userId, displayName: b.displayName, state: b.state },
    sessionA, sessionB,
    listAHasOwn: idsA.includes(sessionA),
    listALacksB: !idsA.includes(sessionB),
    listBHasOwn: idsB.includes(sessionB),
    listBLacksA: !idsB.includes(sessionA),
    crossStateOk: cross.ok,
    bootA, bootB,
    cookiesA: Object.fromEntries(a.jar.cookies),
    cookiesB: Object.fromEntries(b.jar.cookies),
  }
  const { writeFileSync } = await import('node:fs')
  writeFileSync(statePath, JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result))
} else if (mode === 'revoke') {
  const saved = JSON.parse(readFileSync(statePath, 'utf8'))
  const jarA = new Jar()
  for (const [name, value] of Object.entries(saved.cookiesA)) jarA.cookies.set(name, value)
  const jarB = new Jar()
  for (const [name, value] of Object.entries(saved.cookiesB)) jarB.cookies.set(name, value)
  const csrf = jarA.cookies.get('dsh_csrf') ?? ''
  const logout = await jarA.request(`${base}/auth/logout`, {
    method: 'POST',
    headers: { 'x-csrf-token': csrf },
  })
  const meA = await jarA.request(`${base}/auth/me`)
  const meB = await jarB.request(`${base}/auth/me`)
  const pageB = await jarB.request(`${base}/`)
  console.log(JSON.stringify({
    mode,
    logoutStatus: logout.status,
    aMeAfterLogout: meA.status,
    bMeAfterLogout: meB.status,
    bNativeBootAfterALogout: (await pageB.text()).includes('__DSH_BOOT__'),
  }))
} else {
  const saved = JSON.parse(readFileSync(statePath, 'utf8'))
  console.log(JSON.stringify({ mode, savedSessions: [saved.sessionA, saved.sessionB] }))
}
