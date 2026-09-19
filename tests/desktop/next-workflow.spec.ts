import { test, expect, _electron as electron } from '@playwright/test'
import { build } from 'esbuild'
import { mkdtemp, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
const require = createRequire(resolve('apps/desktop/package.json'))
declare global {
  var nextWorkflowTest: {
    state(): { opens: number; modelCalls: number }
    fail(): void
    revoke(): Promise<unknown>
  }
}
async function host() {
  const root = await realpath(
      await mkdtemp(join(tmpdir(), 'bugu-workflow-e2e-')),
    ),
    entry = join(root, 'main.cjs')
  await symlink(
    resolve('apps/desktop/node_modules'),
    join(root, 'node_modules'),
    'dir',
  )
  await build({
    entryPoints: [resolve('tests/fixtures/next-workflow-host.ts')],
    outfile: entry,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['electron', 'better-sqlite3'],
    tsconfig: resolve('tsconfig.json'),
  })
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([k, v]) => k !== 'ELECTRON_RUN_AS_NODE' && v !== undefined,
    ),
  ) as Record<string, string>
  const app = await electron.launch({
    executablePath: require('electron'),
    args: [entry],
    env: {
      ...env,
      NODE_PATH: resolve('apps/desktop/node_modules'),
      NEXT_WORKFLOW_TEST_ROOT: root,
      NEXT_WORKFLOW_TEST_OUT: resolve('apps/desktop/out'),
    },
  })
  const page = await app.firstWindow()
  await expect(
    page.getByRole('heading', { name: '跟进', exact: true }),
  ).toBeVisible()
  const cleanup = async () => {
    await app.evaluate(({ app }) => app.quit()).catch(() => {})
    await app.close().catch(() => {})
    await rm(root, { recursive: true, force: true })
  }
  return { app, page, cleanup }
}
async function ready(page: Awaited<ReturnType<typeof host>>['page']) {
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.locator('#settings-next-action > summary').click()
  await page.getByRole('switch', { name: '启用事件学习' }).click()
  await page.getByLabel('确认方式', { exact: true }).fill('click')
  await page.getByRole('button', { name: '保存设置', exact: true }).click()
  await expect(page.getByText('设置已保存', { exact: true })).toBeVisible()
  await page.getByRole('checkbox').check()
  await page.getByRole('button', { name: '确认授权范围' }).click()
  await expect(page.getByText('学习范围已保存', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '猜你想做', exact: true }).click()
}
const idle = async (page: Awaited<ReturnType<typeof host>>['page']) =>
  expect
    .poll(async () => {
      const s = await page.evaluate(() => window.memo.nextAction.workbench())
      return s.ok && !s.data.busy
    })
    .toBe(true)
async function train(page: Awaited<ReturnType<typeof host>>['page']) {
  const ids = await page.evaluate(async () => {
    const s = await window.memo.nextAction.workbench()
    return s.ok ? s.data.contexts.map((c) => c.recordId) : []
  })
  for (const recordId of ids.slice(0, 5)) {
    await page.evaluate((id) => window.memo.nextAction.inspect(id), recordId)
    await idle(page)
    const event = await page.evaluate(async (id) => {
      const s = await window.memo.nextAction.workbench()
      return s.ok ? s.data.events.find((e) => e.recordId === id) : null
    }, recordId)
    expect(event).toBeTruthy()
    await page.evaluate(
      (id) => window.memo.nextAction.choose(id, 'app:fixture'),
      event!.id,
    )
  }
  return ids
}
test('authorization, model classification, five real choices, recommendation and correction through actual bridge', async () => {
  const { app, page, cleanup } = await host()
  try {
    await ready(page)
    expect(
      (await app.evaluate(() => globalThis.nextWorkflowTest.state()))
        .modelCalls,
    ).toBe(0)
    await page.locator('.next-context-list button').first().click()
    await idle(page)
    await page.locator('.next-source > summary').click()
    await expect(page.locator('.next-source-text')).toContainText(
      '专用自动化夹具',
    )
    await page.locator('.next-source > summary').click()
    await expect(
      page.locator('.next-event-card').getByText('修复问题 · 学习中 · 0 件事'),
    ).toBeVisible()
    const ids = await train(page)
    expect(
      (await app.evaluate(() => globalThis.nextWorkflowTest.state())).opens,
    ).toBe(5)
    await page.evaluate((id) => window.memo.nextAction.inspect(id), ids[5]!)
    await idle(page)
    await expect(page.getByText('修复问题 · 已形成偏好').first()).toBeVisible()
    await expect(
      page.getByRole('button', { name: '打开', exact: true }),
    ).toBeVisible()
    const suggestions = await page.evaluate(async () => {
      const s = await window.memo.nextAction.workbench()
      return s.ok ? s.data.suggestions : []
    })
    await page
      .getByLabel(`纠正建议 ${suggestions[0]!.id}`)
      .selectOption('wrong-target')
    await expect(
      page.getByText('反馈已记录，可在设置的最近选择中撤销'),
    ).toBeVisible()
    const status = await page.evaluate(() => window.memo.nextAction.status())
    expect(status.ok && status.data.choiceCount).toBe(5)
    expect(
      (await app.evaluate(() => globalThis.nextWorkflowTest.state())).opens,
    ).toBe(5)
    await page.screenshot({ path: 'test-results/next-workflow-desktop.png' })
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.setSize(860, 620),
    )
    expect(
      await page
        .locator('.next-workbench[aria-label="猜你想做"]')
        .evaluate((el) => el.scrollWidth <= el.clientWidth),
    ).toBe(true)
    await page.screenshot({ path: 'test-results/next-workflow-narrow.png' })
  } finally {
    await cleanup()
  }
})
test('launch failure contributes no real choice; revoked source invalidates open panel and rejects stale action', async () => {
  const { app, page, cleanup } = await host()
  try {
    await ready(page)
    await page.locator('.next-context-list button').first().click()
    await idle(page)
    const state = await page.evaluate(() => window.memo.nextAction.workbench())
    expect(state.ok).toBe(true)
    if (!state.ok) return
    const event = state.data.events[0]!
    await app.evaluate(() => globalThis.nextWorkflowTest.fail())
    await page
      .getByRole('button', { name: '打开 测试编辑器', exact: true })
      .click()
    await expect(
      page.getByText('未完成操作，请检查授权、应用或模型设置'),
    ).toBeVisible()
    const status = await page.evaluate(() => window.memo.nextAction.status())
    expect(status.ok && status.data.choiceCount).toBe(0)
    await app.evaluate(() => globalThis.nextWorkflowTest.revoke())
    await expect
      .poll(async () => {
        const s = await page.evaluate(() => window.memo.nextAction.workbench())
        return s.ok ? s.data.events.length : -1
      })
      .toBe(0)
    expect(
      await page.evaluate(
        (id) => window.memo.nextAction.choose(id, 'app:fixture'),
        event.id,
      ),
    ).toMatchObject({ ok: false })
    expect(
      (await app.evaluate(() => globalThis.nextWorkflowTest.state())).opens,
    ).toBe(1)
    await expect(page.getByText('授权范围内还没有可用记录。')).toBeVisible()
  } finally {
    await cleanup()
  }
})
