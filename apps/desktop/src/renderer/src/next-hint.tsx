import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ArrowUpRight, X } from '@phosphor-icons/react'
import type { NextHintBridge, NextHintView } from '@memo/contracts'
import './next-hint.css'
declare global { interface Window { nextHint: NextHintBridge } }
function Hint() {
  const [view, setView] = useState<NextHintView | null>(null)
  const [leaving, setLeaving] = useState(false)
  useEffect(() => {
    const show = window.nextHint.onShow(value => { setView(value); setLeaving(false) })
    const hide = window.nextHint.onHide(() => setLeaving(true))
    window.nextHint.ready()
    return () => { show(); hide() }
  }, [])
  if (!view) return null
  return <section key={view.id} className={`next-hint ${leaving ? 'leaving' : ''}`} aria-label="猜你想做">
    <button className="next-hint-action" aria-label={view.label} onClick={() => window.nextHint.confirm(view.id)}><ArrowUpRight size={20} aria-hidden="true" /><span><small>可能你想</small><strong>{view.label}</strong></span>{view.keycap && <kbd>{view.keycap}</kbd>}</button>
    <button className="next-hint-close" aria-label="忽略这次建议" onClick={() => window.nextHint.dismiss(view.id)}><X size={16} aria-hidden="true" /></button>
    <svg className="next-hint-countdown" viewBox="0 0 356 68" preserveAspectRatio="none" aria-hidden="true"><rect x="1" y="1" width="354" height="66" rx="12" pathLength="1" style={{ animationDuration: `${view.durationMs}ms` }} /></svg>
  </section>
}
createRoot(document.getElementById('root')!).render(<Hint />)
