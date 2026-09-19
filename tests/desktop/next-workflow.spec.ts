import { test, expect } from '@playwright/test'
import { host, ready, idle, train } from '../fixtures/next-workflow-client'
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
