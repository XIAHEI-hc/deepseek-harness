/**
 * Container backend: Docker argv, mounts, limits, private address reservation,
 * readiness, inspection, stop, and the gated real-Docker lifecycle.
 */

import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createPlatformConfig, type RuntimeConfig } from '../src/config.ts'
import {
  containerNameForSpace,
  createDefaultDockerExecutor,
  createDockerBackend,
  ensureRuntimeSpaceDirs,
  pickContainerIp,
  resolveRuntimeSpace,
  RuntimeBackendError,
  type ContainerBackendOptions,
  type DockerCommandResult,
  type DockerExecutor,
  type RuntimeSpacePaths,
  type RuntimeStartSpec,
} from '../src/runtime/index.ts'

const SECRET = 'container-test-secret-0123456789abcdef'
const RELEM = 'test-realm'
const USER = 'user-container_1'
const SUBNET = '172.28.0.0/16'
const temporaryDirectories: string[] = []

/** Scripted Docker CLI that records argv and answers by subcommand. */
class FakeDocker {
  readonly calls: string[][] = []
  subnet = SUBNET
  used: string[] = []
  running = true
  containerIp = '172.28.3.7'
  exists = true
  networkAvailable = true
  failingCommand: string | null = null
  throwOnCall = false

  /**
   * Execute one scripted Docker command.
   * @param args - Docker CLI argv.
   * @returns the scripted result.
   */
  readonly execute: DockerExecutor = async (args): Promise<DockerCommandResult> => {
    this.calls.push([...args])
    if (this.throwOnCall) throw new Error('docker is not installed')
    if (this.failingCommand !== null && args[0] === this.failingCommand) {
      return { stdout: '', stderr: 'failed', exitCode: 1 }
    }
    if (args[0] === 'network' && args[1] === 'inspect') {
      if (!this.networkAvailable) return { stdout: '', stderr: 'no such network', exitCode: 1 }
      const format = args[3] ?? ''
      if (format.includes('IPAM')) return { stdout: `${this.subnet} `, stderr: '', exitCode: 0 }
      return { stdout: this.used.map(entry => `${entry} `).join(''), stderr: '', exitCode: 0 }
    }
    if (args[0] === 'run') return { stdout: 'container-id\n', stderr: '', exitCode: 0 }
    if (args[0] === 'inspect') {
      if (!this.exists) return { stdout: '', stderr: 'no such container', exitCode: 1 }
      return { stdout: `${String(this.running)}|${this.running ? this.containerIp : ''}`, stderr: '', exitCode: 0 }
    }
    return { stdout: '', stderr: '', exitCode: 0 }
  }

  /**
   * Find the single recorded `docker run` invocation.
   * @returns the argv, or undefined.
   */
  runArguments(): string[] | undefined {
    return this.calls.find(args => args[0] === 'run')
  }
}

/**
 * Create a tracked temporary directory.
 * @returns the absolute directory.
 */
async function makeTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-runtime-container-'))
  temporaryDirectories.push(directory)
  return directory
}

/**
 * Build one resolved user space with every directory created.
 * @param root - space root.
 * @returns the resolved space paths.
 */
async function makeSpace(root: string, userId: string = USER): Promise<RuntimeSpacePaths> {
  const space = resolveRuntimeSpace({ root, realm: RELEM, userId, spaceKeySecret: SECRET })
  await ensureRuntimeSpaceDirs(space)
  return space
}

/**
 * Build the container runtime configuration used by the backend under test.
 * @param root - space root.
 * @param dataDir - platform data directory.
 * @param overrides - runtime overrides such as the Docker network or image.
 * @returns the runtime configuration.
 */
async function makeRuntimeConfig(
  root: string,
  dataDir: string,
  overrides: Partial<RuntimeConfig> = {},
): Promise<RuntimeConfig> {
  const platform = createPlatformConfig({
    dataDir,
    realm: RELEM,
    runtime: {
      kind: 'container',
      root,
      spaceKeySecret: SECRET,
      image: 'registry.example/dsh-runtime@sha256:deadbeef',
      dockerCommand: 'docker',
      network: 'dsh-private',
      containerDataRoot: '/data',
      containerPublicKeyPath: '/run/dsh/gateway-public.pem',
      containerPatchPath: '/run/dsh/platform-runtime.patch.yml',
      containerPort: 3_080,
      containerUid: 1_000,
      cpuLimit: '1.5',
      memoryLimitMb: 2_048,
      pidsLimit: 512,
      patchFile: join(root, 'platform-runtime.patch.yml'),
      startTimeoutMs: 5_000,
      ...overrides,
    },
  })
  return platform.runtime
}

/**
 * Build one container start specification.
 * @param space - resolved user space.
 * @returns the specification.
 */
function makeStartSpec(space: RuntimeSpacePaths, userId: string = USER): RuntimeStartSpec {
  return {
    realm: RELEM,
    userId,
    spaceKey: space.spaceKey,
    generation: 7,
    space,
    patchFile: join(space.root, 'platform-runtime.patch.yml'),
    runtimeAuth: {
      publicKeyFile: join(space.root, 'gateway-public.pem'),
      issuer: 'dsh-gateway',
      audience: 'dsh-web',
      keyId: 'dsh-gateway-key-v1',
      replayWindowSeconds: 60,
      maxLifetimeSeconds: 300,
    },
    publicOrigin: 'https://dsh.example',
    publicAuthority: 'dsh.example',
    startTimeoutMs: 5_000,
    onExit: () => undefined,
  }
}

/**
 * Collect the argument values that follow a repeated flag.
 * @param args - Docker CLI argv.
 * @param flag - flag whose values are collected.
 * @returns the values in argument order.
 */
function valuesAfterFlag(args: readonly string[], flag: string): string[] {
  const values: string[] = []
  for (let index = 0; index < args.length - 1; index += 1) {
    if (args[index] !== flag) continue
    const value = args[index + 1]
    if (value !== undefined) values.push(value)
  }
  return values
}

/**
 * Build a backend over one scripted Docker CLI.
 * @param config - runtime configuration.
 * @param docker - scripted Docker CLI.
 * @param overrides - injected probe, clock, and sleep.
 * @returns the backend.
 */
function makeBackend(
  config: RuntimeConfig,
  docker: FakeDocker,
  overrides: ContainerBackendOptions = {},
): ReturnType<typeof createDockerBackend> {
  return createDockerBackend(config, {
    executor: docker.execute,
    probe: async () => true,
    ...overrides,
  })
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('container backend launch', () => {
  it('runs one labeled, limited, private container with the documented mounts and arguments', async () => {
    const root = await makeTemporaryDirectory()
    const dataDir = await makeTemporaryDirectory()
    const config = await makeRuntimeConfig(root, dataDir)
    const space = await makeSpace(root)
    const docker = new FakeDocker()
    const backend = makeBackend(config, docker)

    const instance = await backend.start(makeStartSpec(space))

    const args = docker.runArguments()
    if (args === undefined) throw new Error('expected a docker run call')
    const name = containerNameForSpace(space.spaceKey)
    expect(instance.runtimeId).toBe(name)
    expect(instance.port).toBe(3_080)
    expect(instance.imageDigest).toBe(config.image)
    expect(args.slice(0, 4)).toEqual(['run', '-d', '--name', name])
    expect(args).toContain('--label')
    expect(args[args.indexOf('--label') + 1]).toBe('dsh.platform=1')
    expect(args[args.indexOf('--network') + 1]).toBe('dsh-private')
    expect(args).toContain('--cpus')
    expect(args[args.indexOf('--cpus') + 1]).toBe('1.5')
    expect(args[args.indexOf('--memory') + 1]).toBe('2048m')
    expect(args[args.indexOf('--pids-limit') + 1]).toBe('512')
    expect(args[args.indexOf('--user') + 1]).toBe('1000:1000')
    expect(args).not.toContain('--publish')
    expect(args).not.toContain('-p')

    const ip = args[args.indexOf('--ip') + 1]
    expect(ip).toMatch(/^172\.28\.\d{1,3}\.\d{1,3}$/)
    const mounts = args.reduce<string[]>((collected, value, index) => {
      if (value === '-v') {
        const mount = args[index + 1]
        if (mount !== undefined) collected.push(mount)
      }
      return collected
    }, [])
    expect(mounts).toHaveLength(8)
    expect(mounts).toContain(`${space.dshHome}:/data/dsh-home`)
    expect(mounts).toContain(`${space.home}:/data/home`)
    expect(mounts).toContain(`${space.agentsHome}:/data/agents-home`)
    expect(mounts).toContain(`${space.workspaces}:/data/workspaces`)
    expect(mounts).toContain(`${space.uploads}:/data/uploads`)
    expect(mounts).toContain(`${space.tmp}:/data/tmp`)
    expect(mounts).toContain(`${join(space.root, 'gateway-public.pem')}:/run/dsh/gateway-public.pem:ro`)
    expect(mounts).toContain(`${join(space.root, 'platform-runtime.patch.yml')}:/run/dsh/platform-runtime.patch.yml:ro`)
    // Only the Gateway public key and the overlay are read-only; nothing else is
    // mounted, so the container can never see a Docker socket or a private key.
    expect(mounts.filter(mount => mount.endsWith(':ro'))).toHaveLength(2)
    expect(mounts.some(mount => mount.includes('docker.sock'))).toBe(false)
    expect(mounts.some(mount => mount.includes('private'))).toBe(false)

    const environment = args.reduce<string[]>((collected, value, index) => {
      if (value === '-e') {
        const entry = args[index + 1]
        if (entry !== undefined) collected.push(entry)
      }
      return collected
    }, [])
    expect(environment).toContain('DSH_HOME=/data/dsh-home')
    expect(environment).toContain('HOME=/data/home')
    expect(environment).toContain('DSH_AGENTS_HOME=/data/agents-home')
    expect(environment).toContain('TMP=/data/tmp')
    expect(environment).toContain('TEMP=/data/tmp')
    expect(environment).toContain('DSH_RUNTIME_SUBJECT=user-container_1')
    expect(environment).toContain('DSH_RUNTIME_GENERATION=7')
    expect(environment).toContain('DSH_GATEWAY_PUBLIC_KEY_FILE=/run/dsh/gateway-public.pem')
    expect(environment).toContain('DSH_GATEWAY_ISSUER=dsh-gateway')
    expect(environment).toContain('DSH_GATEWAY_AUDIENCE=dsh-web')
    expect(environment).toContain('DSH_GATEWAY_KEY_ID=dsh-gateway-key-v1')
    expect(environment).toContain('DSH_GATEWAY_REPLAY_WINDOW_SECONDS=60')
    expect(environment).toContain('DSH_GATEWAY_MAX_LIFETIME_SECONDS=300')
    expect(environment).toContain('NO_COLOR=1')

    const imageIndex = args.indexOf(config.image)
    expect(imageIndex).toBeGreaterThan(0)
    expect(args.slice(imageIndex + 1)).toEqual([
      'web',
      '--patch',
      '/run/dsh/platform-runtime.patch.yml',
      '--no-open',
      '--host',
      ip,
      '--port',
      '3080',
      '--public-url',
      'https://dsh.example',
      '--trusted-host',
      'dsh.example',
    ])
    expect(args[args.indexOf('--host') + 1]).toBe(ip)
    await backend.close()
  })

  it('gives two users separate containers with separate mounts', async () => {
    const root = await makeTemporaryDirectory()
    const dataDir = await makeTemporaryDirectory()
    const config = await makeRuntimeConfig(root, dataDir)
    const spaceA = await makeSpace(root, 'user-container_1')
    const spaceB = await makeSpace(root, 'user-container_2')
    const docker = new FakeDocker()
    const backend = makeBackend(config, docker)
    const instanceA = await backend.start(makeStartSpec(spaceA, 'user-container_1'))
    const instanceB = await backend.start(makeStartSpec(spaceB, 'user-container_2'))
    expect(instanceA.runtimeId).not.toBe(instanceB.runtimeId)
    const runs = docker.calls.filter(call => call[0] === 'run')
    expect(runs).toHaveLength(2)
    const mountsA = runs[0] === undefined ? [] : valuesAfterFlag(runs[0], '-v')
    const mountsB = runs[1] === undefined ? [] : valuesAfterFlag(runs[1], '-v')
    expect(mountsA.some(mount => mount.startsWith(`${spaceA.dshHome}:`))).toBe(true)
    expect(mountsB.some(mount => mount.startsWith(`${spaceB.dshHome}:`))).toBe(true)
    expect(mountsA.some(mount => mount.startsWith(`${spaceB.dshHome}:`))).toBe(false)
    expect(mountsB.some(mount => mount.startsWith(`${spaceA.dshHome}:`))).toBe(false)
    await backend.close()
  })

  it('reuses the existing network and reserves a free address when the first choice is taken', async () => {
    const root = await makeTemporaryDirectory()
    const dataDir = await makeTemporaryDirectory()
    const config = await makeRuntimeConfig(root, dataDir)
    const space = await makeSpace(root)
    const docker = new FakeDocker()
    const firstChoice = pickContainerIp(SUBNET, [], space.spaceKey)
    expect(firstChoice).not.toBeNull()
    docker.used = [firstChoice === null ? '' : `${firstChoice}/16`]
    const backend = makeBackend(config, docker)

    await backend.start(makeStartSpec(space))

    const args = docker.runArguments()
    const ip = args?.[args.indexOf('--ip') + 1]
    expect(ip).not.toBe(firstChoice)
    expect(pickContainerIp(SUBNET, [firstChoice === null ? '' : firstChoice], space.spaceKey)).toBe(ip)
    expect(docker.calls.some(call => call[0] === 'network' && call.includes('dsh-private'))).toBe(true)
    await backend.close()
  })

  it('refuses to launch when the private network does not exist', async () => {
    const root = await makeTemporaryDirectory()
    const dataDir = await makeTemporaryDirectory()
    const config = await makeRuntimeConfig(root, dataDir)
    const space = await makeSpace(root)
    const docker = new FakeDocker()
    docker.networkAvailable = false
    const backend = makeBackend(config, docker)
    await expect(backend.start(makeStartSpec(space))).rejects.toMatchObject({ code: 'RUNTIME_BACKEND_ERROR' })
    expect(docker.runArguments()).toBeUndefined()
    await backend.close()
  })

  it('reports RUNTIME_BACKEND_ERROR when the Docker CLI cannot be executed', async () => {
    const root = await makeTemporaryDirectory()
    const dataDir = await makeTemporaryDirectory()
    const config = await makeRuntimeConfig(root, dataDir)
    const space = await makeSpace(root)
    const docker = new FakeDocker()
    docker.throwOnCall = true
    const backend = makeBackend(config, docker)
    await expect(backend.start(makeStartSpec(space))).rejects.toBeInstanceOf(RuntimeBackendError)
    await backend.close()
  })
})

describe('container backend readiness, inspection, and stop', () => {
  it('reports RUNTIME_EXITED when the container exits before the probe answers', async () => {
    const root = await makeTemporaryDirectory()
    const dataDir = await makeTemporaryDirectory()
    const config = await makeRuntimeConfig(root, dataDir)
    const space = await makeSpace(root)
    const docker = new FakeDocker()
    docker.running = false
    const backend = makeBackend(config, docker)
    await expect(backend.start(makeStartSpec(space))).rejects.toMatchObject({ code: 'RUNTIME_EXITED' })
    expect(docker.calls.some(call => call[0] === 'stop')).toBe(true)
    expect(docker.calls.some(call => call[0] === 'rm')).toBe(true)
    await backend.close()
  })

  it('reports RUNTIME_START_TIMEOUT and cleans the container up when the probe never answers', async () => {
    const root = await makeTemporaryDirectory()
    const dataDir = await makeTemporaryDirectory()
    const config = await makeRuntimeConfig(root, dataDir)
    const space = await makeSpace(root)
    const docker = new FakeDocker()
    let clock = 0
    const backend = makeBackend(config, docker, {
      probe: async () => false,
      now: () => clock,
      sleep: async () => {
        clock += 60_000
      },
    })
    await expect(backend.start(makeStartSpec(space))).rejects.toMatchObject({ code: 'RUNTIME_START_TIMEOUT' })
    expect(docker.calls.some(call => call[0] === 'stop')).toBe(true)
    expect(docker.calls.some(call => call[0] === 'rm')).toBe(true)
    await backend.close()
  })

  it('inspects a running container through its private address', async () => {
    const root = await makeTemporaryDirectory()
    const dataDir = await makeTemporaryDirectory()
    const config = await makeRuntimeConfig(root, dataDir)
    const space = await makeSpace(root)
    const docker = new FakeDocker()
    const backend = makeBackend(config, docker)
    const instance = await backend.start(makeStartSpec(space))
    expect(await backend.inspect(instance.runtimeId)).toEqual({
      running: true,
      host: docker.containerIp,
      port: 3_080,
    })
    docker.running = false
    expect(await backend.inspect(instance.runtimeId)).toEqual({ running: false, host: null, port: null })
    docker.exists = false
    expect(await backend.inspect(instance.runtimeId)).toEqual({ running: false, host: null, port: null })
    expect(await backend.inspect('')).toEqual({ running: false, host: null, port: null })
    await backend.close()
  })

  it('stops and removes the container, leaving its mounted data untouched', async () => {
    const root = await makeTemporaryDirectory()
    const dataDir = await makeTemporaryDirectory()
    const config = await makeRuntimeConfig(root, dataDir)
    const space = await makeSpace(root)
    const docker = new FakeDocker()
    const backend = makeBackend(config, docker)
    const instance = await backend.start(makeStartSpec(space))
    await backend.stop(instance.runtimeId)
    const stopCall = docker.calls.find(call => call[0] === 'stop')
    const removeCall = docker.calls.find(call => call[0] === 'rm')
    expect(stopCall).toEqual(['stop', '-t', '10', instance.runtimeId])
    expect(removeCall).toEqual(['rm', '-f', instance.runtimeId])
    expect((await stat(space.dshHome)).isDirectory()).toBe(true)
    await backend.close()
  })
})

describe('container address reservation', () => {
  it('rejects unusable subnets and keeps the network address and gateway out of the range', () => {
    expect(pickContainerIp('not-a-subnet', [], 'a'.repeat(64))).toBeNull()
    expect(pickContainerIp('172.28.0.0/32', [], 'a'.repeat(64))).toBeNull()
    expect(pickContainerIp('172.28.0.0/31', [], 'a'.repeat(64))).toBeNull()
    expect(pickContainerIp('10.0.0.0/30', [], 'a'.repeat(64))).toBe('10.0.0.2')
  })

  it('never returns an address already attached to the network', () => {
    const spaceKey = 'b'.repeat(64)
    const first = pickContainerIp('10.10.0.0/24', [], spaceKey)
    expect(first).not.toBeNull()
    if (first === null) throw new Error('expected an address')
    const second = pickContainerIp('10.10.0.0/24', [first], spaceKey)
    expect(second).not.toBeNull()
    expect(second).not.toBe(first)
  })
})

describe('container backend against a real Docker daemon', () => {
  const enabled = process.env.DSH_PLATFORM_DOCKER_TEST === '1'
  const image = process.env.DSH_RUNTIME_IMAGE ?? ''

  it('runs, observes, and removes a real container', async (context) => {
    if (!enabled) {
      context.skip('set DSH_PLATFORM_DOCKER_TEST=1 to exercise the real Docker daemon')
      return
    }
    if (image === '') {
      context.skip('DSH_RUNTIME_IMAGE is not set; the real Docker case needs the immutable runtime image')
      return
    }
    const docker = createDefaultDockerExecutor(process.env.DSH_RUNTIME_DOCKER_COMMAND ?? 'docker')
    const version = await docker(['version', '--format', '{{.Server.Version}}'])
    if (version.exitCode !== 0) {
      context.skip('the Docker daemon is not reachable from this host')
      return
    }
    const imageInspection = await docker(['image', 'inspect', image])
    if (imageInspection.exitCode !== 0) {
      context.skip(`runtime image ${image} is not present locally`)
      return
    }
    const root = await makeTemporaryDirectory()
    const dataDir = await makeTemporaryDirectory()
    const network = `dsh-runtime-test-${String(Date.now())}`
    const config = await makeRuntimeConfig(root, dataDir, { image, network })
    const space = await makeSpace(root)
    const createNetwork = await docker(['network', 'create', '--subnet', `172.31.${String(Date.now() % 200)}.0/24`, network])
    expect(createNetwork.exitCode).toBe(0)
    const backend = createDockerBackend(config, {
      executor: docker,
      // The supervisor runs on the Docker host in production; this Windows
      // development host cannot route to a container address on a user-defined
      // bridge, so the probe is answered locally while the container lifecycle
      // and the real `docker inspect` observation stay real.
      probe: async () => true,
      sleep: async () => undefined,
    })
    try {
      const instance = await backend.start(makeStartSpec(space))
      expect(instance.runtimeId).toBe(containerNameForSpace(space.spaceKey))
      const running = await docker(['inspect', '-f', '{{.State.Running}}', instance.runtimeId])
      expect(running.stdout.trim()).toBe('true')
      await backend.stop(instance.runtimeId)
      const gone = await docker(['inspect', instance.runtimeId])
      expect(gone.exitCode).not.toBe(0)
    } finally {
      await backend.close()
      await docker(['network', 'rm', network])
    }
  }, 120_000)
})
