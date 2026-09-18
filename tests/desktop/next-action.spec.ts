import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test'
import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
const require = createRequire(resolve('apps/desktop/package.json'))
const env = () => Object.fromEntries(Object.entries(process.env).filter(([key, value]) => key !== 'ELECTRON_RUN_AS_NODE' && value !== undefined)) as Record<string, string>
const close = async (app: ElectronApplication) => { await app.evaluate(({ app }) => app.quit()).catch(() => {}); await app.close().catch(() => {}) }

test('internal settings save, restart, shortcuts, clear and IPC restrictions', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'bugu-next-settings-')))
  const launch = () => electron.launch({ executablePath: require('electron'), args: [resolve('apps/desktop/out/main/index.js'), '--bugu-next-action-preview'], env: { ...env(), MEMO_TEST_USER_DATA: root } })
  let app = await launch()
  try {
    let page = await app.firstWindow()
    await expect(page.getByRole('heading', { name: '跟进', exact: true })).toBeVisible()
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await page.locator('#settings-next-action > summary').click()
    await expect(page.getByText('开发预览 · 跨应用观察尚未接入')).toBeVisible()
    await page.getByRole('switch', { name: '启用事件学习' }).click()
    await page.getByLabel('确认方式', { exact: true }).fill('click')
    await page.getByLabel('展示时长', { exact: true }).selectOption('5000')
    await page.getByRole('button', { name: '保存设置', exact: true }).click()
    await expect(page.getByRole('status').filter({ hasText: '设置已保存' })).toBeVisible()
    const stored = await page.evaluate(() => window.memo.nextAction.status())
    expect(stored.ok && stored.data.settings).toMatchObject({ enabled: true, shortcut: 'click', durationMs: 5000 })
    await page.getByLabel('确认方式', { exact: true }).fill('Alt+F4')
    await page.getByRole('button', { name: '保存设置', exact: true }).click()
    await expect(page.getByText('未保存，请检查快捷键或稍后重试')).toBeVisible()
    expect((await page.evaluate(() => window.memo.nextAction.status()))).toEqual(stored)
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(860, 620))
    expect(await page.locator('.next-action-settings').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true)
    await page.screenshot({ path: 'test-results/next-action-settings-narrow.png' })
    await close(app); app = await launch(); page = await app.firstWindow()
    await expect(page.getByRole('heading', { name: '跟进', exact: true })).toBeVisible()
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await page.locator('#settings-next-action > summary').click()
    await expect(page.getByLabel('确认方式', { exact: true })).toHaveValue('click')
    await expect(page.getByRole('switch', { name: '启用事件学习' })).toBeChecked()
    await page.getByRole('button', { name: '清除学习记录' }).click()
    await page.getByRole('button', { name: '取消', exact: true }).click()
    await expect(page.getByRole('switch', { name: '启用事件学习' })).toBeChecked()
    await page.getByRole('button', { name: '清除学习记录' }).click()
    await page.getByRole('button', { name: '确认清除', exact: true }).click()
    await expect(page.getByText('学习记录已清除，功能已关闭')).toBeVisible()
    await expect(page.getByRole('switch', { name: '启用事件学习' })).not.toBeChecked()
    expect(await page.evaluate(() => 'require' in window || 'ipcRenderer' in window)).toBe(false)
    expect(await page.evaluate(() => Object.keys(window.memo.nextAction).sort())).toEqual(['clear', 'configure', 'feedback', 'status', 'undo'])
  } finally { await close(app); await rm(root, { recursive: true, force: true }) }
})

test('unfinished feature is hidden and cannot be enabled in ordinary launches', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'bugu-next-release-gate-')))
  const app = await electron.launch({ executablePath: require('electron'), args: [resolve('apps/desktop/out/main/index.js')], env: { ...env(), MEMO_TEST_USER_DATA: root } })
  try {
    const page = await app.firstWindow()
    await expect(page.getByRole('heading', { name: '跟进', exact: true })).toBeVisible()
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await expect(page.locator('#settings-next-action')).toHaveCount(0)
    expect(await page.evaluate(() => window.memo.nextAction.status())).toEqual({ ok: false, error: 'INVALID_REQUEST' })
  } finally { await close(app); await rm(root, { recursive: true, force: true }) }
})

type HintTest = { show(shortcut?: string, durationMs?: number): Promise<boolean>; state(): { opens: number; id: string; mainFocused: boolean; windows: { id: number; visible: boolean; focusable: boolean; bounds: { x: number; y: number; width: number; height: number } }[] }; revoke(): void; hideMain(): void; dismiss(): void }
declare global { var nextHintTest: HintTest }
async function hintHost() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'bugu-hint-host-')))
  const entry = join(root, 'main.cjs')
  await build({ entryPoints: [resolve('tests/fixtures/next-action-hint-host.ts')], outfile: entry, bundle: true, platform: 'node', format: 'cjs', external: ['electron'], tsconfig: resolve('tsconfig.json') })
  const app = await electron.launch({ executablePath: require('electron'), args: [entry], env: { ...env(), NEXT_HINT_TEST_ROOT: root, NEXT_HINT_TEST_OUT: resolve('apps/desktop/out') } })
  const main = await app.firstWindow()
  await expect.poll(() => app.evaluate(() => !!globalThis.nextHintTest)).toBe(true)
  return { app, main, cleanup: async () => { await close(app); await rm(root, { recursive: true, force: true }) } }
}

test('independent hint shows without pet, stays nonactivating and confirms once', async () => {
  const { app, main, cleanup } = await hintHost()
  try {
    await main.getByRole('textbox', { name: '编辑器' }).fill('测试输入')
    expect(await app.evaluate(() => globalThis.nextHintTest.show())).toBe(true)
    const hint = app.windows().find(p => p !== main)!
    await expect(hint.getByRole('button', { name: '打开 测试编辑器', exact: true })).toBeVisible()
    await expect(hint.locator('kbd')).toHaveCount(0)
    expect(await hint.evaluate(() => 'memo' in window || 'require' in window)).toBe(false)
    const state = await app.evaluate(() => globalThis.nextHintTest.state())
    expect(state.windows.find(w => !w.focusable)?.bounds.width).toBe(360)
    expect(state.mainFocused).toBe(true)
    await hint.screenshot({ path: 'test-results/next-action-hint.png' })
    // Another window with the same limited preload is not an authorized sender.
    await main.evaluate(id => window.nextHint.confirm(id), state.id)
    expect((await app.evaluate(() => globalThis.nextHintTest.state())).opens).toBe(0)
    await hint.getByRole('button', { name: '打开 测试编辑器', exact: true }).click()
    await expect.poll(() => app.evaluate(() => globalThis.nextHintTest.state().opens)).toBe(1)
    await hint.evaluate(id => window.nextHint.confirm(id), state.id)
    expect((await app.evaluate(() => globalThis.nextHintTest.state())).opens).toBe(1)
  } finally { await cleanup() }
})

test('hint expires after three seconds while main window is hidden; late confirm cannot open anything', async () => {
  const { app, main, cleanup } = await hintHost()
  try {
    await app.evaluate(() => globalThis.nextHintTest.hideMain())
    expect(await app.evaluate(() => globalThis.nextHintTest.show())).toBe(true)
    const hint = app.windows().find(p => p !== main)!
    await expect(hint.getByRole('button', { name: '打开 测试编辑器', exact: true })).toBeVisible()
    const id = await app.evaluate(() => globalThis.nextHintTest.state().id)
    await expect.poll(() => app.evaluate(() => globalThis.nextHintTest.state().windows.some(w => !w.focusable && w.visible)), { timeout: 5000 }).toBe(false)
    await hint.evaluate(id => window.nextHint.confirm(id), id)
    expect((await app.evaluate(() => globalThis.nextHintTest.state())).opens).toBe(0)
  } finally { await cleanup() }
})

test('permission withdrawal hides hint; unsupported Tab never appears or registers a global key', async () => {
  const { app, main, cleanup } = await hintHost()
  try {
    expect(await app.evaluate(() => globalThis.nextHintTest.show('Tab'))).toBe(false)
    expect(app.windows()).toHaveLength(1)
    expect(await app.evaluate(({ globalShortcut }) => globalShortcut.isRegistered('Tab'))).toBe(false)
    expect(await app.evaluate(() => globalThis.nextHintTest.show())).toBe(true)
    const hint = app.windows().find(p => p !== main)!
    await expect(hint.getByRole('button', { name: '打开 测试编辑器', exact: true })).toBeVisible()
    const id = await app.evaluate(() => globalThis.nextHintTest.state().id)
    await app.evaluate(() => globalThis.nextHintTest.revoke())
    await expect.poll(() => app.evaluate(() => globalThis.nextHintTest.state().windows.some(w => !w.focusable && w.visible))).toBe(false)
    await hint.evaluate(id => window.nextHint.confirm(id), id)
    expect((await app.evaluate(() => globalThis.nextHintTest.state())).opens).toBe(0)
  } finally { await cleanup() }
})


test('recent choices support specific feedback, undo, and deletion through the real core bridge', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'bugu-next-feedback-')))
  const seed = join(root, 'seed.cjs')
  await build({ entryPoints: [resolve('tests/fixtures/next-action-settings-seed.ts')], outfile: seed, bundle: true, platform: 'node', format: 'cjs', external: ['better-sqlite3'], tsconfig: resolve('tsconfig.json') })
  execFileSync(require('electron'), [seed, root], { env: { ...env(), ELECTRON_RUN_AS_NODE: '1', NODE_PATH: resolve('apps/desktop/node_modules') }, timeout: 30000 })
  const app = await electron.launch({ executablePath: require('electron'), args: [resolve('apps/desktop/out/main/index.js'), '--bugu-next-action-preview'], env: { ...env(), MEMO_TEST_USER_DATA: root } })
  try {
    const page = await app.firstWindow()
    await expect(page.getByRole('heading', { name: '跟进', exact: true })).toBeVisible()
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await page.locator('#settings-next-action > summary').click()
    await page.locator('.next-action-settings summary').click()
    const feedback = page.getByLabel('纠正 codex c1', { exact: true })
    await feedback.selectOption('wrong-target')
    await expect(page.locator('.next-action-feedback')).toContainText('会话不对')
    const state = await page.evaluate(() => window.memo.nextAction.status())
    expect(state.ok && state.data.choiceCount).toBe(1)
    await page.getByRole('button', { name: '撤销', exact: true }).click()
    await expect(feedback).toBeVisible()
    await feedback.selectOption('wrong-event')
    await expect(page.locator('.next-action-feedback')).toContainText('这次不对')
    const corrected = await page.evaluate(() => window.memo.nextAction.status())
    expect(corrected.ok && corrected.data.recent[0]!.feedback?.kind).toBe('wrong-event')
    expect(corrected.ok && corrected.data.choiceCount).toBe(0)
    await page.getByRole('button', { name: '清除学习记录' }).click()
    await page.getByRole('button', { name: '确认清除', exact: true }).click()
    await expect(page.getByText('还没有记录', { exact: true })).toBeVisible()
    expect((await page.evaluate(() => window.memo.nextAction.status()))).toMatchObject({ ok: true, data: { eventCount: 0, choiceCount: 0, recent: [] } })
  } finally { await close(app); await rm(root, { recursive: true, force: true }) }
})
