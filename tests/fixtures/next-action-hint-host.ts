// Isolated Electron E2E host. No production injection flag, history readers, model calls or OS launch actions.
import { app, BrowserWindow } from 'electron'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { NextTargetRegistry } from '@memo/next-action'
import { NextActionHintWindow } from '../../apps/desktop/src/main/next-action/hint-window'
import { target } from './next-action'
const data = process.env.NEXT_HINT_TEST_ROOT
if (!data || !process.env.NEXT_HINT_TEST_OUT) throw Error('ISOLATED_TEST_ROOT_REQUIRED')
app.setPath('userData', join(data, 'data'))
void app.whenReady().then(async () => {
  const registry = new NextTargetRegistry()
  let opens = 0
  let valid = true
  let id = ''
  registry.register({ target: target('fixture', { label: '测试编辑器' }), available: async () => true,
    open: async () => { opens++; return { state: 'dispatched' } } })
  const preload = join(process.env.NEXT_HINT_TEST_OUT!, 'preload/next-hint.js')
  const host = new NextActionHintWindow({ registry, preload, pageURL: pathToFileURL(join(process.env.NEXT_HINT_TEST_OUT!, 'renderer/next-hint.html')).href })
  const main = new BrowserWindow({ width: 860, height: 620, webPreferences: { preload, contextIsolation: true, sandbox: true, nodeIntegration: false } })
  await main.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<title>Isolated hint test</title><input aria-label="编辑器" autofocus>'))
  Object.assign(globalThis, { nextHintTest: {
    async show(shortcut = 'click', durationMs = 3000) {
      valid = true
      id = randomUUID()
      const expires = Date.now() + 15000
      const t = target('fixture', { label: '测试编辑器' })
      registry.issue(id, t, expires, Date.now())
      return host.present({ target: t, token: id, context: { id, targetId: t.id, targetRevision: t.revision,
        contextRevision: 1, shortcutRevision: 1, validUntil: expires, durationMs, shortcut } }, () => valid)
    },
    state: () => ({ opens, id, mainFocused: main.isFocused(), windows: BrowserWindow.getAllWindows().map(w => ({ id: w.id, visible: w.isVisible(), focusable: w.isFocusable(), bounds: w.getBounds() })) }),
    revoke() { valid = false; registry.invalidate() },
    hideMain() { main.hide() },
    dismiss() { host.dismiss() },
  } })
  app.on('before-quit', () => host.dispose())
})
