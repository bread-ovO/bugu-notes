import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const mocks = vi.hoisted(() => ({ home: '', secret: vi.fn() }))
vi.mock('node:os', async (original) => ({
  ...(await original<typeof import('node:os')>()),
  homedir: () => mocks.home,
}))
vi.mock('../../apps/desktop/src/main/next-action/pairing-secret', () => ({
  pairingSecret: mocks.secret,
}))
import { BrowserContextBridge } from '../../apps/desktop/src/main/next-action/browser-bridge'
let root: string
let bridge: BrowserContextBridge
let config: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'bugu-pairing-test-'))
  mocks.home = join(root, 'home')
  const assets = join(root, 'assets'),
    native = join(root, 'native')
  await mkdir(assets)
  await writeFile(
    join(assets, 'manifest.json'),
    JSON.stringify({ key: Buffer.from('fixture-key').toString('base64') }),
  )
  await writeFile(native, 'isolated fixture, never executed')
  config = join(root, 'data/next-action-browser/browser-host.conf')
  mocks.secret
    .mockReset()
    .mockImplementation(async (_host: string, operation: string) =>
      operation === 'seal' ? 'keychain:fixture' : '',
    )
  bridge = new BrowserContextBridge(join(root, 'data'), assets, native, vi.fn())
})
afterEach(async () => {
  bridge.stop()
  await rm(root, { recursive: true, force: true })
})
// Windows registration uses the real registry; its native lifecycle is checked by the build matrix.
describe.skipIf(process.platform === 'win32')(
  'isolated browser pairing lifecycle',
  () => {
    it('revokes config and registrations even when the OS secret store refuses deletion', async () => {
      await bridge.install()
      const state = bridge as unknown as { secret: string; server: unknown }
      const old = state.secret
      mocks.secret.mockRejectedValueOnce(
        Error('NEXT_SECURE_STORAGE_UNAVAILABLE'),
      )
      await expect(bridge.uninstall()).rejects.toThrow(
        'NEXT_SECURE_STORAGE_UNAVAILABLE',
      )
      expect(state.server).toBeNull()
      expect(state.secret).not.toBe(old)
      await expect(readFile(config)).rejects.toMatchObject({ code: 'ENOENT' })
      await bridge.resume()
      expect(state.server).toBeNull()
    })
    it('serializes install and removal, leaving no late-created pairing', async () => {
      let release!: () => void
      const sealed = new Promise<void>((resolve) => {
        release = resolve
      })
      mocks.secret.mockImplementation(
        async (_host: string, operation: string) => {
          if (operation === 'seal') {
            await sealed
            return 'keychain:fixture'
          }
          return ''
        },
      )
      const install = bridge.install()
      const removal = bridge.uninstall()
      release()
      await install
      await removal
      await expect(readFile(config)).rejects.toMatchObject({ code: 'ENOENT' })
      expect((bridge as unknown as { server: unknown }).server).toBeNull()
    })
    it('closes a failed installation and can retry cleanly', async () => {
      mocks.secret.mockRejectedValueOnce(
        Error('NEXT_SECURE_STORAGE_UNAVAILABLE'),
      )
      await expect(bridge.install()).rejects.toThrow(
        'NEXT_SECURE_STORAGE_UNAVAILABLE',
      )
      expect((bridge as unknown as { server: unknown }).server).toBeNull()
      await bridge.install()
      expect(await readFile(config, 'utf8')).toContain('keychain:fixture')
      await bridge.uninstall()
    })
  },
)
