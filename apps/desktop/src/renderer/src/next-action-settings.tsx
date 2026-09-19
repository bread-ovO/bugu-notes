import { NextActionWorkbench } from './next-action-workbench'
import { useEffect, useRef, useState } from 'react'
import { Switch } from '@cloudflare/kumo/components/switch'
import type {
  CoreReply,
  NextActionSettings,
  NextActionSnapshot,
  NextFeedbackKind,
} from '@memo/contracts'
import {
  AppButton,
  AppDialog,
  AppInput,
  DialogTitle,
  DialogDescription,
} from './ui'
import { HelpTip } from './ui/help-tip'
import './next-action-settings.css'

const typeLabels: Record<string, string> = {
  bug_fix: '修复问题',
  development: '开发功能',
  code_review: '代码评审',
  research: '查找资料',
  document: '处理文档',
  data: '处理数据',
  reply: '回复消息',
  unknown: '尚未确定',
}
const feedbackLabels: Record<NextFeedbackKind, string> = {
  'wrong-event': '这次不对',
  'wrong-type': '事情理解错了',
  'wrong-target': '会话不对',
  'launch-failed': '没有打开',
  dismissed: '这次略过',
}
export function NextActionSettingsPanel() {
  const [state, setState] = useState<NextActionSnapshot | null>(null)
  const [draft, setDraft] = useState<NextActionSettings | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [clearing, setClearing] = useState(false)
  const mounted = useRef(false)
  const inFlight = useRef(false)
  const read = async () => {
    const result = await window.memo.nextAction.status()
    if (mounted.current && result.ok) {
      setState(result.data)
      setDraft(result.data.settings)
    }
  }
  useEffect(() => {
    mounted.current = true
    void read().catch(() => {
      if (mounted.current) setMessage('暂时无法读取设置')
    })
    const timer = setInterval(() => {
      void window.memo.nextAction.status().then((result) => {
        if (mounted.current && result.ok) setState(result.data)
      })
    }, 2000)
    return () => {
      mounted.current = false
      clearInterval(timer)
    }
  }, [])
  async function change(
    operation: () => Promise<CoreReply<NextActionSnapshot>>,
    success: string,
  ) {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setMessage('')
    try {
      const result = await operation()
      if (!mounted.current) return
      if (result.ok) {
        setState(result.data)
        setDraft(result.data.settings)
        setMessage(success)
      } else {
        setMessage(
          result.error === 'VERSION_CONFLICT'
            ? '记录已变化，已重新读取，请重试'
            : '未保存，请检查快捷键或稍后重试',
        )
        await read()
      }
    } catch {
      if (mounted.current) setMessage('本地核心暂不可用')
    } finally {
      inFlight.current = false
      if (mounted.current) setBusy(false)
    }
  }
  if (!state || !draft) return <p role="status">{message || '正在读取设置…'}</p>
  const patch = (value: Partial<NextActionSettings>) =>
    setDraft({ ...draft, ...value })
  return (
    <section className="next-action-settings" aria-label="猜你想做设置">
      <div className="next-action-row">
        <div>
          <h2>
            事件学习{' '}
            <HelpTip label="猜你想做说明">
              根据已授权的事件和真实选择学习工具偏好，不按停留时长判断；忽略提示不会扣分。
            </HelpTip>
          </h2>
        </div>
        <Switch
          aria-label="启用事件学习"
          checked={draft.enabled}
          disabled={busy}
          onClick={() => patch({ enabled: !draft.enabled })}
        />
      </div>
      <div className="next-action-row">
        <span>
          跨项目使用工具偏好{' '}
          <HelpTip label="共享范围说明">
            只共享工具偏好。会话、文档与具体目标始终限定在当前项目与账号。关闭后只使用本项目记录。
          </HelpTip>
        </span>
        <Switch
          aria-label="跨项目使用工具偏好"
          checked={draft.shareAcrossProjects}
          disabled={busy}
          onClick={() =>
            patch({ shareAcrossProjects: !draft.shareAcrossProjects })
          }
        />
      </div>
      <div className="next-action-row">
        <span>
          主动提示{' '}
          <HelpTip label="主动提示说明">
            同类事件先积累真实选择，可靠后才会提示。没有采集和输入能力时不会弹窗，不会占用
            Tab。
          </HelpTip>
        </span>
        <Switch
          aria-label="主动提示"
          checked={draft.proactive}
          disabled={busy}
          onClick={() => patch({ proactive: !draft.proactive })}
        />
      </div>
      <div className="next-action-fields">
        <label>
          确认方式
          <AppInput
            aria-label="确认方式"
            value={draft.shortcut}
            disabled={busy}
            onChange={(e) => patch({ shortcut: e.target.value })}
          />
        </label>
        <HelpTip label="确认方式说明">
          Tab、click（仅点击），或 CommandOrControl+Shift+J
          等组合键。实际注册成功后才会显示键帽。Tab
          仅在系统许可和输入状态可靠时短暂生效，否则只支持点击。
        </HelpTip>
        <label>
          展示时长
          <select
            aria-label="展示时长"
            value={draft.durationMs}
            disabled={busy}
            onChange={(e) =>
              patch({
                durationMs: Number(
                  e.target.value,
                ) as NextActionSettings['durationMs'],
              })
            }
          >
            <option value={3000}>3 秒</option>
            <option value={5000}>5 秒</option>
            <option value={8000}>8 秒</option>
          </select>
        </label>
        <AppButton
          className="primary"
          disabled={
            busy || JSON.stringify(state.settings) === JSON.stringify(draft)
          }
          onClick={() =>
            void change(
              () => window.memo.nextAction.configure(draft, state.version),
              '设置已保存',
            )
          }
        >
          保存设置
        </AppButton>
      </div>
      <div className="next-action-row">
        <span className="next-action-muted">
          {state.settings.enabled ? '学习中' : '已关闭'} · {state.eventCount}{' '}
          件事 · {state.choiceCount} 次真实选择
        </span>
        <AppButton disabled={busy} onClick={() => setClearing(true)}>
          清除学习记录
        </AppButton>
      </div>
      <NextActionWorkbench configuration />
      <details>
        <summary>
          最近选择{' '}
          <span className="next-action-muted">{state.recent.length}</span>
        </summary>
        {!state.recent.length && (
          <p className="next-action-muted">还没有记录</p>
        )}
        {state.recent.map((item) => (
          <div className="next-action-row" key={item.choiceId}>
            <div>
              <strong>{item.toolId}</strong>
              <span className="next-action-muted">
                {' '}
                · {typeLabels[item.eventType]}
              </span>
            </div>
            {item.feedback ? (
              <span className="next-action-feedback">
                {feedbackLabels[item.feedback.kind]}
                <AppButton
                  disabled={busy}
                  onClick={() =>
                    void change(
                      () =>
                        window.memo.nextAction.undo(
                          item.feedback!.id,
                          state.version,
                        ),
                      '已撤销纠错',
                    )
                  }
                >
                  撤销
                </AppButton>
              </span>
            ) : (
              <select
                aria-label={`纠正 ${item.toolId} ${item.choiceId}`}
                value=""
                disabled={busy}
                onChange={(e) => {
                  const kind = e.target.value as NextFeedbackKind
                  if (kind)
                    void change(
                      () =>
                        window.memo.nextAction.feedback(
                          item.choiceId,
                          kind,
                          state.version,
                        ),
                      '反馈已记录',
                    )
                }}
              >
                <option value="">纠正这次选择</option>
                {Object.entries(feedbackLabels).map(([key, label]) => (
                  <option key={key} value={key}>
                    {label}
                  </option>
                ))}
              </select>
            )}
          </div>
        ))}
      </details>
      {message && <p role="status">{message}</p>}
      <AppDialog open={clearing} onOpenChange={setClearing} size="sm">
        <DialogTitle>清除学习记录？</DialogTitle>
        <DialogDescription>
          删除事件、选择、纠错与授权记录，并关闭学习。不会删除事项或原始会话。
        </DialogDescription>
        <div className="next-action-fields">
          <AppButton onClick={() => setClearing(false)}>取消</AppButton>
          <AppButton
            className="primary"
            disabled={busy}
            onClick={() => {
              setClearing(false)
              void change(
                () => window.memo.nextAction.clear(state.version),
                '学习记录已清除，功能已关闭',
              )
            }}
          >
            确认清除
          </AppButton>
        </div>
      </AppDialog>
    </section>
  )
}
