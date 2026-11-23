/**
 * Startup configuration review: safe defaults, production fail-closed rules, and
 * the gateway key pair lifecycle.
 *
 * @module @deepseek-ai/dsh-platform-services/tests/config.spec
 */

import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createPlatformConfig,
  ensureGatewayKeyPair,
  loadPlatformConfig,
  PlatformConfigError,
} from '../src/config.ts'

/** Data directories created by one test. */
let temporaryDirs: string[]

/** Create one temporary directory and register it for cleanup. */
async function makeDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-platform-config-'))
  temporaryDirs.push(dir)
  return dir
}

beforeEach(() => {
  temporaryDirs = []
})

afterEach(async () => {
  await Promise.all(temporaryDirs.map(async dir => rm(dir, { recursive: true, force: true })))
})

describe('loadPlatformConfig', () => {
  it('resolves a development Mock configuration with process runtimes', () => {
    const config = loadPlatformConfig({
      APP_ENV: 'development',
      AUTH_MODE: 'mock',
      DSH_PLATFORM_DATA_DIR: 'C:/tmp/dsh-platform',
      DSH_PLATFORM_REPO_ROOT: 'C:/tmp/repo',
      DSH_GATEWAY_PUBLIC_URL: 'http://127.0.0.1:8080',
    })
    expect(config.appEnv).toBe('development')
    expect(config.identity.mode).toBe('mock')
    expect(config.runtime.kind).toBe('process')
    expect(config.gateway.publicOrigin).toBe('http://127.0.0.1:8080')
    expect(config.runtime.publicAuthority).toBe('127.0.0.1:8080')
    expect(config.gateway.generateKeyPairIfMissing).toBe(true)
    expect(config.identity.internalApiKey).toBe('')
  })

  it('refuses Mock authentication in production', () => {
    expect(() => loadPlatformConfig({
      APP_ENV: 'production',
      AUTH_MODE: 'mock',
      DSH_GATEWAY_PUBLIC_URL: 'https://dsh.example.test',
    })).toThrow(/Mock authentication is forbidden in production/u)
  })

  it('fails closed on missing production secrets and insecure transport', () => {
    try {
      loadPlatformConfig({
        APP_ENV: 'production',
        AUTH_MODE: 'w3',
        DSH_GATEWAY_PUBLIC_URL: 'http://dsh.example.test',
        W3_CLIENT_ID: 'client',
        W3_CLIENT_SECRET: 'secret',
        W3_AUTHORIZE_URL: 'http://w3.example.test/authorize',
        W3_TOKEN_URL: 'http://w3.example.test/token',
        W3_USERINFO_URL: 'http://w3.example.test/userinfo',
        W3_REDIRECT_URI: 'http://dsh.example.test/auth/callback',
      })
      expect.unreachable('production configuration without secrets must be rejected')
    } catch (error) {
      expect(error).toBeInstanceOf(PlatformConfigError)
      const message = error instanceof Error ? error.message : ''
      expect(message).toContain('DSH_INTERNAL_API_KEY')
      expect(message).toContain('DSH_PLATFORM_SPACE_KEY_SECRET')
      expect(message).toContain('https origin in production')
      expect(message).toContain('W3_TOKEN_URL must use https in production')
    }
  })

  it('accepts a complete production configuration', () => {
    const config = loadPlatformConfig({
      APP_ENV: 'production',
      AUTH_MODE: 'w3',
      DSH_GATEWAY_PUBLIC_URL: 'https://dsh.example.test',
      AUTH_COOKIE_SECURE: 'true',
      DSH_INTERNAL_API_KEY: 'i'.repeat(40),
      DSH_PLATFORM_SPACE_KEY_SECRET: 's'.repeat(40),
      DSH_RUNTIME_KIND: 'container',
      DSH_RUNTIME_IMAGE: 'registry.example/dsh-runtime@sha256:' + 'a'.repeat(64),
      DSH_RUNTIME_NETWORK: 'dsh-private',
      DSH_GATEWAY_LISTEN_HOST: '0.0.0.0',
      DSH_GATEWAY_SIGNING_PRIVATE_KEY_FILE: 'C:/tmp/keys/private.pem',
      DSH_GATEWAY_PUBLIC_KEY_FILE: 'C:/tmp/keys/public.pem',
      W3_CLIENT_ID: 'client',
      W3_CLIENT_SECRET: 'secret',
      W3_AUTHORIZE_URL: 'https://w3.example.test/authorize',
      W3_TOKEN_URL: 'https://w3.example.test/token',
      W3_USERINFO_URL: 'https://w3.example.test/userinfo',
      W3_REDIRECT_URI: 'https://dsh.example.test/auth/callback',
    })
    expect(config.identity.cookieSecure).toBe(true)
    expect(config.runtime.kind).toBe('container')
    expect(config.gateway.generateKeyPairIfMissing).toBe(false)
  })

  it('requires every W3 provider field when AUTH_MODE is w3', () => {
    expect(() => loadPlatformConfig({
      APP_ENV: 'testing',
      AUTH_MODE: 'w3',
      DSH_GATEWAY_PUBLIC_URL: 'http://127.0.0.1:8080',
    })).toThrow(/W3_CLIENT_ID is required/u)
  })

  it('bounds WebSocket revalidation so revocation stays prompt', () => {
    expect(() => loadPlatformConfig({
      APP_ENV: 'development',
      AUTH_MODE: 'mock',
      DSH_GATEWAY_PUBLIC_URL: 'http://127.0.0.1:8080',
      DSH_GATEWAY_WS_REVALIDATE_SECONDS: '30',
    })).toThrow(/WS_REVALIDATE_SECONDS must be 20 seconds or less/u)
  })

  it('rejects a public URL that is not a bare origin', () => {
    expect(() => loadPlatformConfig({
      APP_ENV: 'development',
      AUTH_MODE: 'mock',
      DSH_GATEWAY_PUBLIC_URL: 'http://127.0.0.1:8080/prefix',
    })).toThrow(/bare origin/u)
  })

  it('refuses an unknown runtime kind', () => {
    expect(() => loadPlatformConfig({
      APP_ENV: 'development',
      AUTH_MODE: 'mock',
      DSH_GATEWAY_PUBLIC_URL: 'http://127.0.0.1:8080',
      DSH_RUNTIME_KIND: 'lambda',
    })).toThrow(/DSH_RUNTIME_KIND must be process or container/u)
  })

  it('refuses quoting in the process command instead of splitting it wrongly', () => {
    expect(() => loadPlatformConfig({
      APP_ENV: 'development',
      AUTH_MODE: 'mock',
      DSH_GATEWAY_PUBLIC_URL: 'http://127.0.0.1:8080',
      DSH_RUNTIME_PROCESS_COMMAND: '"/opt/node/bin/node" --import tsx/esm cli.ts',
    })).toThrow(/does not support quoting/u)
  })
})

describe('createPlatformConfig', () => {
  it('merges section overrides and keeps the public authority in step', async () => {
    const dataDir = await makeDir()
    const config = createPlatformConfig({
      dataDir,
      gateway: { listenPort: 4321, publicOrigin: 'http://127.0.0.1:4321' },
      runtime: { idleSeconds: 5 },
      identity: { cookieSecure: true },
    })
    expect(config.runtime.publicAuthority).toBe('127.0.0.1:4321')
    expect(config.runtime.idleSeconds).toBe(5)
    expect(config.identity.cookieSecure).toBe(true)
    expect(config.gateway.publicOrigin).toBe('http://127.0.0.1:4321')
  })

  it('rejects an override that exceeds the assertion lifetime bound', async () => {
    const dataDir = await makeDir()
    expect(() => createPlatformConfig({ dataDir, gateway: { assertionTtlSeconds: 999 } }))
      .toThrow(/assertionTtlSeconds exceeds maxAssertionLifetimeSeconds/u)
  })
})

describe('ensureGatewayKeyPair', () => {
  it('generates a development key pair on first use', async () => {
    const dataDir = await makeDir()
    const config = createPlatformConfig({ dataDir })
    const files = ensureGatewayKeyPair(config.gateway)
    const privatePem = await readFile(files.privateKeyFile, 'utf8')
    const publicPem = await readFile(files.publicKeyFile, 'utf8')
    expect(privatePem).toContain('BEGIN PRIVATE KEY')
    expect(publicPem).toContain('BEGIN PUBLIC KEY')
    expect((await stat(files.privateKeyFile)).isFile()).toBe(true)
  })

  it('keeps an existing pair instead of rotating it', async () => {
    const dataDir = await makeDir()
    const config = createPlatformConfig({ dataDir })
    const first = ensureGatewayKeyPair(config.gateway)
    const privatePem = await readFile(first.privateKeyFile, 'utf8')
    ensureGatewayKeyPair(config.gateway)
    expect(await readFile(first.privateKeyFile, 'utf8')).toBe(privatePem)
  })

  it('refuses to generate a missing production key', async () => {
    const dataDir = await makeDir()
    const config = createPlatformConfig({ dataDir, gateway: { generateKeyPairIfMissing: false } })
    expect(() => ensureGatewayKeyPair(config.gateway))
      .toThrow(/DSH_GATEWAY_SIGNING_PRIVATE_KEY_FILE/u)
  })
})
