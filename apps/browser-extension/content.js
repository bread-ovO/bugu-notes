;(() => {
  if (globalThis.__buguVisibleObject) return
  globalThis.__buguVisibleObject = true
  let timer,
    last = '',
    acknowledgedAt = 0
  const schedule = () => {
    clearTimeout(timer)
    if (document.visibilityState !== 'visible' || !document.hasFocus()) return
    const url = location.href
    timer = setTimeout(() => {
      if (
        document.visibilityState === 'visible' &&
        document.hasFocus() &&
        location.href === url &&
        (last !== url || Date.now() - acknowledgedAt >= 10000)
      ) {
        chrome.runtime
          .sendMessage({ type: 'visible-object', url })
          .then((result) => {
            if (result?.ok) {
              last = url
              acknowledgedAt = Date.now()
            }
          })
          .catch(() => {})
      }
    }, 1500)
  }
  addEventListener('focus', schedule)
  addEventListener('blur', () => {
    clearTimeout(timer)
    last = ''
  })
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') last = ''
    schedule()
  })
  addEventListener('popstate', schedule)
  setInterval(() => {
    if (location.href !== last || Date.now() - acknowledgedAt >= 10000)
      schedule()
  }, 2000)
  schedule()
})()
