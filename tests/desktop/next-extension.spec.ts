import { test, expect, chromium } from '@playwright/test'
import {
  mkdtemp,
  mkdir,
  copyFile,
  writeFile,
  rm,
  realpath,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { BrowserContextBridge } from '../../apps/desktop/src/main/next-action/browser-bridge'
import { pairingSecret } from '../../apps/desktop/src/main/next-action/pairing-secret'

// Native permission UI must be explicitly exercised in a disposable profile; never reuse a real browser profile.
test('isolated Chromium extension grants, native host, tab changes, revocation and restart', async () => {
  test.skip(
    process.env.BUGU_EXTENSION_UI !== '1' || process.platform === 'win32',
    'Opt-in native permission UI; Windows native registration requires a separate fixture registry',
  )
  test.setTimeout(180000)
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'bugu-extension-e2e-')),
  )
  const profile = join(root, 'profile'),
    assets = resolve('apps/browser-extension'),
    host = join(root, 'host/browser-host')
  const seen: string[] = []
  const bridge = new BrowserContextBridge(
    join(root, 'data'),
    assets,
    'unused',
    (url) => seen.push(url),
  )
  let context:
    | Awaited<ReturnType<typeof chromium.launchPersistentContext>>
    | undefined
  let sealed = ''
  const launch = () =>
    chromium.launchPersistentContext(profile, {
      channel: 'chromium',
      headless: false,
      args: [
        `--disable-extensions-except=${assets}`,
        `--load-extension=${assets}`,
      ],
    })
  try {
    await bridge.start()
    const state = bridge as unknown as { endpoint: string; secret: string }
    await mkdir(join(root, 'host'))
    await mkdir(join(profile, 'NativeMessagingHosts'), { recursive: true })
    await copyFile(
      resolve('apps/desktop/out/native/next-action-browser-host'),
      host,
    )
    sealed = await pairingSecret(host, 'seal', state.secret)
    const id = 'focajhkglkjjahihpcppojgakcbpcece'
    await writeFile(
      join(root, 'host/browser-host.conf'),
      `${state.endpoint}\n${sealed}\nchrome-extension://${id}/\n`,
      { mode: 0o600 },
    )
    await writeFile(
      join(profile, 'NativeMessagingHosts/dev.bugu.context.json'),
      JSON.stringify({
        name: 'dev.bugu.context',
        description: 'BUGU isolated acceptance fixture',
        path: host,
        type: 'stdio',
        allowed_origins: [`chrome-extension://${id}/`],
      }),
    )
    context = await launch()
    await context.route('https://**/*', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><title>BUGU isolated acceptance</title><h1>Synthetic work object; no real network or account</h1>',
      }),
    )
    const worker =
      context.serviceWorkers()[0] ??
      (await context.waitForEvent('serviceworker'))
    expect(worker.url()).toContain(id)
    const options = await context.newPage()
    await options.goto(`chrome-extension://${id}/options.html`)
    await expect(options.locator('#status')).toContainText('已授权：无')
    await options.locator('#github').click()
    console.log(
      'Accept the GitHub permission in this isolated Chrome for Testing window; all HTTPS requests are synthetic fixtures.',
    )
    await expect(options.locator('#status')).toContainText(
      'https://github.com/*',
      { timeout: 120000 },
    )
    const work = await context.newPage()
    await work.goto(
      'https://github.com/bugu-fixture/isolated/pull/7?token=synthetic#fragment',
    )
    await work.bringToFront()
    const canonical = 'https://github.com/bugu-fixture/isolated/pull/7'
    await expect
      .poll(() => seen.includes(canonical), { timeout: 30000 })
      .toBe(true)
      .catch(async (error) => {
        console.log(
          'Window:',
          await worker.evaluate(async () => {
            const c = (globalThis as any).chrome
            return {
              windows: await c.windows.getAll(),
              tabs: await c.tabs.query({ active: true }),
              scripts: await c.scripting.getRegisteredContentScripts(),
            }
          }),
        )
        throw error
      })
    expect(
      seen.every((url) => !url.includes('token=') && !url.includes('#')),
    ).toBe(true)
    const other = await context.newPage()
    await other.goto('https://ungranted.invalid/')
    await other.bringToFront()
    await expect.poll(() => seen.at(-1)).toBe('')
    const count = seen.filter((url) => url === canonical).length
    await other.waitForTimeout(2500)
    expect(seen.filter((url) => url === canonical)).toHaveLength(count)
    await work.bringToFront()
    await expect
      .poll(() => seen.filter((url) => url === canonical).length, {
        timeout: 20000,
      })
      .toBeGreaterThan(count)
      .catch(async (error) => {
        console.log(
          'Synthetic browser state:',
          await work.evaluate(() => ({
            visible: document.visibilityState,
            focused: document.hasFocus(),
          })),
          'Frames:',
          seen,
          'Window:',
          await worker.evaluate(async () => {
            const c = (globalThis as any).chrome
            return {
              windows: await c.windows.getAll(),
              tabs: await c.tabs.query({ active: true }),
            }
          }),
        )
        throw error
      })
    await options.bringToFront()
    await options.locator('#revoke').click()
    await expect(options.locator('#status')).toContainText('已授权：无')
    await expect.poll(() => seen.at(-1)).toBe('')
    const revoked = seen.filter((url) => url === canonical).length
    await work.bringToFront()
    await work.waitForTimeout(3500)
    expect(seen.filter((url) => url === canonical)).toHaveLength(revoked)
    await context.close()
    context = await launch()
    const reopened = await context.newPage()
    await reopened.goto(`chrome-extension://${id}/options.html`)
    await expect(reopened.locator('#status')).toContainText('已授权：无')
    await reopened.screenshot({
      path: 'test-results/next-extension-revoked.png',
    })
  } finally {
    await context?.close()
    bridge.stop()
    if (sealed) await pairingSecret(host, 'forget', sealed)
    await rm(root, { recursive: true, force: true })
  }
})
