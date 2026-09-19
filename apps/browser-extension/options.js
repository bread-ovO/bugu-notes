const status = document.querySelector('#status')
async function show() {
  const p = await chrome.permissions.getAll()
  status.textContent = `已授权：${p.origins?.join('、') || '无'}。扩展 ID：${chrome.runtime.id}`
}
document.querySelector('#github').onclick = async () => {
  await chrome.permissions.request({ origins: ['https://github.com/*'] })
  show()
}
document.querySelector('#feishu').onclick = async () => {
  await chrome.permissions.request({
    origins: ['https://*.feishu.cn/*', 'https://*.larksuite.com/*'],
  })
  show()
}
document.querySelector('#revoke').onclick = async () => {
  const p = await chrome.permissions.getAll()
  await chrome.permissions.remove({ origins: p.origins ?? [] })
  show()
}
show()
