import { contextBridge, ipcRenderer } from 'electron'
import type { NextHintBridge, NextHintView } from '@memo/contracts'
const bridge: NextHintBridge = Object.freeze({
  ready: () => ipcRenderer.send('next-hint:ready'),
  onShow(callback: (view: NextHintView) => void) {
    const listener = (_event: unknown, value: NextHintView) => callback(value)
    ipcRenderer.on('next-hint:show', listener)
    return () => ipcRenderer.removeListener('next-hint:show', listener)
  },
  onHide(callback: () => void) {
    const listener = () => callback()
    ipcRenderer.on('next-hint:hide', listener)
    return () => ipcRenderer.removeListener('next-hint:hide', listener)
  },
  confirm: (id: string) => ipcRenderer.send('next-hint:confirm', id),
  dismiss: (id: string) => ipcRenderer.send('next-hint:dismiss', id),
})
contextBridge.exposeInMainWorld('nextHint', bridge)
