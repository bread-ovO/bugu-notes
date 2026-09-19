// Real renderer -> typed preload -> runtime -> utility core -> model bridge -> isolated SQLite.
// Only model transport and OS application launch are injected; no user history or credentials.
import { app, BrowserWindow, ipcMain, protocol, net } from 'electron'
import { writeFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { openStore } from '@memo/storage'
import type {
  NextModelInput,
  NextActionOutput,
  CoreRequest,
} from '@memo/contracts'
import { CoreClient } from '../../apps/desktop/src/main/core-client'
import { createRequestHandler } from '../../apps/desktop/src/main/request-handler'
import { NextActionRuntime } from '../../apps/desktop/src/main/next-action/runtime'
const root = process.env.NEXT_WORKFLOW_TEST_ROOT,
  out = process.env.NEXT_WORKFLOW_TEST_OUT
if (!root || !out) throw Error('ISOLATED_TEST_ROOT_REQUIRED')
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'memo',
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  },
])
app.setPath('userData', join(root, 'electron'))
void app.whenReady().then(async () => {
  const path = join(root, 'store.sqlite'),
    store = openStore(path)
  store.tasks.createProject('p', '隔离路演项目')
  const file = join(root, 'codex.jsonl')
  writeFileSync(file, '')
  const source = store.sources.authorize({
    projectId: 'p',
    path: file,
    displayName: 'Codex 会话 · 隔离测试',
  })
  store.sources.receiveBatch(
    source.id,
    source.grantVersion,
    Array.from({ length: 7 }, (_, i) => ({
      schemaVersion: 1 as const,
      sourceInstanceId: source.id,
      externalId: `m${i}`,
      revision: '1',
      occurredAt: new Date().toISOString(),
      role: 'user' as const,
      text: `BUG-${i}：登录回调后显示白屏，请修复并补测试。本段是专用自动化夹具，预期选择测试编辑器处理；不包含真实工作消息。`,
    })),
    'page',
    '',
  )
  store.close()
  const core = new CoreClient(join(out, 'main/core.js'), path)
  let opens = 0,
    fail = false,
    modelCalls = 0
  core.modelHandler = async (request) => {
    modelCalls++
    const i = JSON.parse(request.messages[1]!.content) as NextModelInput
    const o: NextActionOutput = {
      mode: i.mode,
      eventType: i.mode === 'classify-event' ? 'bug_fix' : i.event.eventType,
      action: 'handle',
      related: true,
      confidence: 0.99,
      reason: '夹具引用正确',
      targetIds: i.mode === 'recommend' ? [i.targets[0]!.id] : [],
      citations: i.evidence.map((e) => ({
        id: e.id,
        revision: e.revision,
        quote: e.text.slice(0, 16),
      })),
    }
    return { content: JSON.stringify(o), model: 'isolated-fixture' }
  }
  core.start()
  for (let i = 0; i < 60; i++) {
    if ((await core.request({ method: 'health' })).ok) break
    await new Promise((r) => setTimeout(r, 50))
  }
  const rendererRoot = resolve(out, 'renderer')
  protocol.handle('memo', (request) => {
    const url = new URL(request.url)
    const target = resolve(rendererRoot, '.' + url.pathname)
    if (url.hostname !== 'app' || !target.startsWith(rendererRoot + sep))
      return new Response('not found', { status: 404 })
    return net.fetch(pathToFileURL(target).href)
  })
  const page = 'memo://app/index.html'
  const window = new BrowserWindow({
    width: 1100,
    height: 780,
    webPreferences: {
      preload: join(out, 'preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      additionalArguments: ['--bugu-mode=real'],
    },
  })
  const runtime = new NextActionRuntime({
    request: (r) => core.request(r),
    data: root,
    nativeDirectory: join(out, 'native'),
    extensionDirectory: join(out, 'browser-extension'),
    pageURL: pathToFileURL(join(out, 'renderer/next-hint.html')).href,
    preload: join(out, 'preload/next-hint.js'),
    window: () => window,
    catalog: async () => [
      {
        id: 'fixture',
        label: '测试编辑器',
        identity: 'fixture',
        path: join(root, 'not-an-executable'),
      },
    ],
    launch: async () => {
      opens++
      return fail ? 'failed' : 'dispatched'
    },
  })
  await runtime.start()
  ipcMain.handle(
    'memo:request',
    createRequestHandler(
      () => window.webContents,
      page,
      async (request) => {
        if (request.method.startsWith('nextAction.'))
          return runtime.handle(
            request as Extract<CoreRequest, { method: `nextAction.${string}` }>,
          )
        try {
          return await core.request(
            request as Parameters<CoreClient['request']>[0],
          )
        } catch {
          return { ok: false, error: 'INVALID_REQUEST' }
        }
      },
    ),
  )
  Object.assign(globalThis, {
    nextWorkflowTest: {
      state: () => ({ opens, modelCalls }),
      fail: () => {
        fail = true
      },
      revoke: () => core.request({ method: 'sources.revoke', id: source.id }),
    },
  })
  await window.loadURL(page)
  app.on('before-quit', () => {
    runtime.dispose()
    core.stop()
  })
})
