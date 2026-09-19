import { expect, _electron as electron } from '@playwright/test'
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
export async function host() {
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
export async function ready(page: Awaited<ReturnType<typeof host>>['page']) {
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
export const idle = async (page: Awaited<ReturnType<typeof host>>['page']) =>
  expect
    .poll(async () => {
      const s = await page.evaluate(() => window.memo.nextAction.workbench())
      return s.ok && !s.data.busy
    })
    .toBe(true)
export async function train(page: Awaited<ReturnType<typeof host>>['page']) {
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
