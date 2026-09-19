;(() => {
  let timer,
    last = ''
  const schedule = () => {
    clearTimeout(timer)
    if (document.visibilityState !== 'visible' || !document.hasFocus()) return
    const url = location.href
    timer = setTimeout(() => {
      if (
        document.visibilityState === 'visible' &&
        document.hasFocus() &&
        location.href === url &&
        last !== url
      ) {
        chrome.runtime
          .sendMessage({ type: 'visible-object', url })
          .then((result) => {
            if (result?.ok) last = url
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
  document.addEventListener('visibilitychange', schedule)
  addEventListener('popstate', schedule)
  setInterval(() => {
    if (location.href !== last) schedule()
  }, 2000)
  schedule()
})()
