const hosts = [
  'https://github.com/*',
  'https://*.feishu.cn/*',
  'https://*.larksuite.com/*',
]
async function configure() {
  const granted = (await chrome.permissions.getAll()).origins ?? []
  await chrome.scripting.unregisterContentScripts()
  const matches = hosts.filter((h) => granted.includes(h))
  if (matches.length)
    await chrome.scripting.registerContentScripts([
      {
        id: 'bugu-visible-object',
        matches,
        js: ['content.js'],
        runAt: 'document_idle',
        persistAcrossSessions: true,
      },
    ])
}
chrome.permissions.onAdded.addListener(configure)
chrome.permissions.onRemoved.addListener(() => {
  clearContext()
  void configure().catch(() => {})
})
chrome.runtime.onInstalled.addListener(configure)
chrome.runtime.onStartup.addListener(configure)
const seen = new Map()
let generation = 0
let nativeQueue = Promise.resolve()
const native = (payload, expectedGeneration) => {
  const operation = nativeQueue.then(() => {
    if (expectedGeneration !== undefined && expectedGeneration !== generation)
      return { ok: false }
    return chrome.runtime.sendNativeMessage('dev.bugu.context', payload)
  })
  nativeQueue = operation.catch(() => {})
  return operation
}
chrome.runtime.onMessage.addListener((value, sender, reply) => {
  if (
    !sender.tab ||
    sender.frameId !== 0 ||
    !value ||
    value.type !== 'visible-object' ||
    typeof value.url !== 'string' ||
    value.url.length > 2048
  )
    return
  const tab = sender.tab
  const observedGeneration = generation
  ;(async () => {
    const current = await chrome.tabs.get(tab.id)
    const window = await chrome.windows.get(tab.windowId)
    if (!current.active || !window.focused || current.url !== value.url)
      return reply({ ok: false })
    const url = new URL(value.url)
    if (url.protocol !== 'https:' || url.username || url.password || url.port)
      return reply({ ok: false })
    const permitted = await chrome.permissions.contains({
      origins: [`${url.origin}/*`],
    })
    if (!permitted) return reply({ ok: false })
    if (Date.now() - (seen.get(tab.id) ?? 0) < 1500) return reply({ ok: true })
    url.search = ''
    url.hash = ''
    // URL is resolved against existing BUGU grants. Page scripts cannot provide message text or launch targets.
    const acknowledgement = await native(
      { type: 'visible-object', url: url.href },
      observedGeneration,
    )
    const ok =
      observedGeneration === generation &&
      acknowledgement?.ok === true &&
      acknowledgement.protocolVersion === 1
    if (ok) {
      seen.set(tab.id, Date.now())
      if (seen.size > 100) seen.delete(seen.keys().next().value)
    }
    reply({ ok })
  })().catch(() => reply({ ok: false }))
  return true
})

const clearContext = () => {
  generation++
  seen.clear()
  return native({ type: 'hidden' }).catch(() => {})
}
chrome.tabs.onActivated.addListener(clearContext)
chrome.windows.onFocusChanged.addListener(clearContext)
chrome.tabs.onUpdated.addListener((_id, change) => {
  if (change.status === 'loading') clearContext()
})
