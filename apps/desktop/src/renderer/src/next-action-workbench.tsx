import { useEffect, useRef, useState } from 'react'
import { ArrowSquareOutIcon, SparkleIcon } from '@phosphor-icons/react'
import type { CoreReply, NextWorkbench } from '@memo/contracts'
import {
  AppButton,
  AppDialog,
  DialogTitle,
  DialogDescription,
  IconButton,
} from './ui'
import { HelpTip } from './ui/help-tip'
import './next-action-settings.css'
export const nextTypeLabels: Record<string, string> = {
  bug_fix: '修复问题',
  development: '开发功能',
  code_review: '代码评审',
  research: '查找资料',
  document: '处理文档',
  data: '处理数据',
  reply: '回复消息',
  unknown: '尚未确定',
}
export function NextActionWorkbench({
  configuration = false,
}: {
  configuration?: boolean
}) {
  const [state, setState] = useState<NextWorkbench | null>(null)
  const [selection, setSelection] = useState<string[] | null>(null)
  const [chosen, setChosen] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const alive = useRef(false)
  const read = async () => {
    const r = await window.memo.nextAction.workbench()
    if (alive.current && r.ok) setState(r.data)
  }
  useEffect(() => {
    alive.current = true
    void read()
    const timer = setInterval(() => void read(), 2000)
    return () => {
      alive.current = false
      clearInterval(timer)
    }
  }, [])
  async function run(
    operation: () => Promise<CoreReply<unknown>>,
    success = '',
  ) {
    if (busy) return
    setBusy(true)
    setMessage('')
    try {
      const r = await operation()
      if (!alive.current) return
      if (r.ok) {
        setMessage(success)
        await read()
      } else
        setMessage(
          r.error === 'NEXT_SECURE_STORAGE_UNAVAILABLE'
            ? '系统安全存储不可用，浏览器尚未配对。请解锁系统钥匙串或密钥环后重试。'
            : r.error === 'VERSION_CONFLICT'
              ? '记录已变化，请重新确认'
              : '未完成操作，请检查授权、应用或模型设置',
        )
    } catch {
      if (alive.current) setMessage('本地服务暂不可用')
    } finally {
      if (alive.current) setBusy(false)
    }
  }
  if (!state) return <p role="status">正在读取…</p>
  const selected =
    selection ?? state.sources.filter((s) => s.selected).map((s) => s.id)
  return (
    <section
      className="next-workbench"
      aria-label={configuration ? '事件学习授权' : '猜你想做'}
    >
      {configuration && (
        <>
          <details
            className="next-scope"
            open={!state.sources.some((s) => s.selected)}
          >
            <summary>
              学习范围{' '}
              <span className="next-action-muted">
                {state.sources.filter((s) => s.selected).length} 个连接
              </span>
            </summary>
            {!state.sources.length && (
              <p className="next-action-muted">先在「连接」授权一个来源。</p>
            )}
            {state.sources.map((s) => (
              <label className="next-scope-option" key={s.id}>
                <input
                  type="checkbox"
                  checked={selected.includes(s.id)}
                  onChange={(e) =>
                    setSelection(
                      e.target.checked
                        ? [...selected, s.id]
                        : selected.filter((x) => x !== s.id),
                    )
                  }
                />
                <span>
                  {s.label}
                  <small>{s.projectName}</small>
                </span>
              </label>
            ))}
            <p className="next-action-muted">
              所选记录会交给设置中的分析模型。同步消息不代表你已查看。
            </p>
            <AppButton
              disabled={busy || !state.sources.length}
              onClick={() =>
                void run(async () => {
                  const current = await window.memo.nextAction.workbench()
                  if (!current.ok) return current
                  const r = await window.memo.nextAction.enroll(
                    selected,
                    current.data.version,
                  )
                  if (r.ok) setSelection(null)
                  return r
                }, '学习范围已保存')
              }
            >
              确认授权范围
            </AppButton>
          </details>
          <div className="next-action-row">
            <span>
              观察所选应用{' '}
              <HelpTip label="系统观察范围">
                只获取前台应用与临时输入状态，不保存按键。浏览器桥接只发送可见对象网址；必须能对应已授权记录才会分析。
              </HelpTip>
            </span>
            <AppButton
              disabled={busy || !state.settings.enabled}
              onClick={() =>
                void run(() =>
                  window.memo.nextAction.observation(
                    !state.observation.enabled,
                    [
                      ...new Set(
                        state.sources
                          .filter((s) => s.selected)
                          .map((s) => s.appId),
                      ),
                    ],
                  ),
                )
              }
            >
              {state.observation.enabled ? '停止观察' : '开启观察'}
            </AppButton>
          </div>
          {state.observation.enabled && (
            <div className="next-action-row">
              <span className="next-action-muted">
                {state.capability?.reason || '正在检测系统能力'}
              </span>
              <AppButton
                disabled={busy}
                onClick={() =>
                  void run(() => window.memo.nextAction.permission())
                }
              >
                检查系统许可
              </AppButton>
            </div>
          )}
          <div className="next-action-fields">
            <AppButton
              disabled={busy}
              onClick={() =>
                void run(
                  () => window.memo.nextAction.browserSetup(),
                  '扩展目录已打开，按说明加载并授权站点',
                )
              }
            >
              安装浏览器桥接
            </AppButton>
            <AppButton
              disabled={busy}
              onClick={() =>
                void run(
                  () => window.memo.nextAction.addApplication(),
                  '应用已加入可选目标',
                )
              }
            >
              添加应用
            </AppButton>
            <AppButton
              disabled={busy}
              onClick={() =>
                void run(
                  () => window.memo.nextAction.browserRemove(),
                  '浏览器桥接已停用，请在浏览器中移除扩展',
                )
              }
            >
              停用浏览器桥接
            </AppButton>
            <AppButton
              disabled={busy}
              onClick={() =>
                void run(
                  () => window.memo.nextAction.diagnostics(),
                  '诊断导出操作已结束',
                )
              }
            >
              导出诊断
            </AppButton>
          </div>
        </>
      )}
      {!configuration && (
        <>
          {!state.settings.enabled && (
            <p className="next-action-muted">
              请在设置的「猜你想做」中开启学习并选择来源。
            </p>
          )}
          {state.settings.enabled && (
            <>
              <details open={!state.events.length}>
                <summary>
                  打开已授权记录{' '}
                  <HelpTip label="主动打开说明">
                    主动打开一条记录后，模型识别这是什么事。再选择要用的工具，记录这次真实选择。
                  </HelpTip>
                </summary>
                <div className="next-context-list">
                  {state.contexts.slice(0, 30).map((c) => (
                    <AppButton
                      key={c.recordId}
                      disabled={busy || state.busy}
                      onClick={() =>
                        void run(() =>
                          window.memo.nextAction.inspect(c.recordId),
                        )
                      }
                    >
                      <span>
                        <strong>{c.label}</strong>
                        <small>{c.preview}</small>
                      </span>
                      <ArrowSquareOutIcon size={16} />
                    </AppButton>
                  ))}
                </div>
                {!state.contexts.length && (
                  <p className="next-action-muted">
                    授权范围内还没有可用记录。
                  </p>
                )}
              </details>
              {state.opened && (
                <details className="next-source">
                  <summary>查看原文 · {state.opened.label}</summary>
                  <p className="next-source-text">{state.opened.text}</p>
                </details>
              )}
              {state.busy && <p role="status">正在理解这件事…</p>}
              {state.events
                .filter(
                  (e) =>
                    e.recordId ===
                      (state.opened?.recordId ?? state.observedRecordId) ||
                    (!state.opened &&
                      !state.observedRecordId &&
                      e.id === state.events[0]?.id),
                )
                .map((e) => (
                  <article className="next-event-card" key={e.id}>
                    <h3>{e.label}</h3>
                    <div className="next-action-row">
                      <span className="next-action-muted">
                        {nextTypeLabels[e.eventType]} ·{' '}
                        {e.habit.state === 'ready'
                          ? '已形成偏好'
                          : `学习中 · ${e.habit.eventCount} 件事`}
                      </span>
                      <select
                        aria-label={`修正类型 ${e.id}`}
                        value={e.eventType}
                        disabled={busy || state.busy}
                        onChange={(x) =>
                          void run(() =>
                            window.memo.nextAction.reclassify(
                              e.id,
                              x.target.value as typeof e.eventType,
                            ),
                          )
                        }
                      >
                        {Object.entries(nextTypeLabels).map(([id, label]) => (
                          <option value={id} key={id}>
                            {label}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="next-targets">
                      <select
                        aria-label="选择处理工具"
                        value={chosen[e.id] ?? e.targets[0]?.id ?? ''}
                        onChange={(x) =>
                          setChosen({ ...chosen, [e.id]: x.target.value })
                        }
                      >
                        {e.targets.map((t) => (
                          <option key={t.id} value={t.id}>
                            {t.kind === 'open-app' ? '打开 ' : ''}
                            {t.label}
                          </option>
                        ))}
                      </select>
                      <AppButton
                        className="primary"
                        disabled={busy || state.busy || !e.targets.length}
                        onClick={() =>
                          void run(
                            () =>
                              window.memo.nextAction.choose(
                                e.id,
                                chosen[e.id] ?? e.targets[0]!.id,
                              ),
                            '已请求打开目标，并记录这次选择',
                          )
                        }
                      >
                        打开{' '}
                        {
                          e.targets.find(
                            (t) => t.id === (chosen[e.id] ?? e.targets[0]?.id),
                          )?.label
                        }
                      </AppButton>
                    </div>
                    <details>
                      <summary>此类事件的偏好</summary>
                      <div className="next-action-fields">
                        <select
                          aria-label={`偏好工具 ${e.id}`}
                          defaultValue=""
                          onChange={(x) => {
                            if (x.target.value)
                              void run(
                                () =>
                                  window.memo.nextAction.prefer(
                                    e.id,
                                    x.target.value,
                                    'project',
                                  ),
                                '已记住本项目偏好',
                              )
                          }}
                        >
                          <option value="">本项目优先使用…</option>
                          {state.tools.map((t) => (
                            <option value={t.id} key={t.id}>
                              {t.label}
                            </option>
                          ))}
                        </select>
                        <select
                          aria-label={`通用偏好 ${e.id}`}
                          defaultValue=""
                          onChange={(x) => {
                            if (x.target.value)
                              void run(
                                () =>
                                  window.memo.nextAction.prefer(
                                    e.id,
                                    x.target.value,
                                    'personal',
                                  ),
                                '已记住个人偏好',
                              )
                          }}
                        >
                          <option value="">所有授权项目优先使用…</option>
                          {state.tools.map((t) => (
                            <option value={t.id} key={t.id}>
                              {t.label}
                            </option>
                          ))}
                        </select>
                        <AppButton
                          disabled={busy}
                          onClick={() =>
                            void run(
                              () =>
                                window.memo.nextAction.forgetPreference(
                                  e.id,
                                  'project',
                                ),
                              '已取消项目偏好',
                            )
                          }
                        >
                          取消项目特例
                        </AppButton>
                      </div>
                    </details>
                  </article>
                ))}
            </>
          )}
          {!!state.events.length && (
            <details>
              <summary>
                最近处理的事{' '}
                <span className="next-action-muted">{state.events.length}</span>
              </summary>
              {state.events.map((e) => (
                <div className="next-action-row" key={e.id}>
                  <span className="next-record-label">{e.label}</span>
                  <AppButton
                    disabled={busy || state.busy}
                    onClick={() =>
                      void run(() => window.memo.nextAction.inspect(e.recordId))
                    }
                  >
                    查看
                  </AppButton>
                </div>
              ))}
            </details>
          )}
          <details open>
            <summary>
              最近建议{' '}
              <span className="next-action-muted">
                {state.suggestions.length}
              </span>
            </summary>
            {state.suggestions.map((s) => (
              <div className="next-action-row" key={s.id}>
                <span>
                  {s.label}
                  <small className="next-action-muted">
                    {' '}
                    · {new Date(s.createdAt).toLocaleString()}
                  </small>
                </span>
                {s.state === 'offered' ? (
                  <span className="next-action-fields">
                    <AppButton
                      disabled={busy}
                      onClick={() =>
                        void run(
                          () =>
                            window.memo.nextAction.choose(
                              s.eventId,
                              s.targetId,
                              s.id,
                            ),
                          '已请求打开目标',
                        )
                      }
                    >
                      打开
                    </AppButton>
                    <select
                      aria-label={`纠正建议 ${s.id}`}
                      defaultValue=""
                      onChange={(e) => {
                        if (e.target.value)
                          void run(
                            () =>
                              window.memo.nextAction.dismissSuggestion(
                                s.id,
                                e.target.value as
                                  | 'wrong-event'
                                  | 'wrong-type'
                                  | 'wrong-target'
                                  | 'dismissed',
                              ),
                            '反馈已记录，可在设置的最近选择中撤销',
                          )
                      }}
                    >
                      <option value="">不合适…</option>
                      <option value="wrong-event">这次不需要</option>
                      <option value="wrong-type">事情理解错了</option>
                      <option value="wrong-target">目标不对</option>
                      <option value="dismissed">这次略过</option>
                    </select>
                  </span>
                ) : (
                  <span className="next-action-muted">
                    {s.state === 'confirmed'
                      ? '已选择'
                      : s.state === 'failed'
                        ? '未能打开'
                        : '已略过'}
                  </span>
                )}
              </div>
            ))}
            {!state.suggestions.length && (
              <p className="next-action-muted">
                建议会保留在这里，弹窗消失后也能查看。
              </p>
            )}
          </details>
        </>
      )}
      {state.error && (
        <p role="status" className="next-action-muted">
          {state.error === 'NEXT_BUDGET_EXHAUSTED'
            ? '今天的分析额度已用完，明天继续。'
            : '这次未能完成分析；请检查分析模型设置，稍后重新打开记录。'}
        </p>
      )}
      {message && <p role="status">{message}</p>}
    </section>
  )
}
export function NextActionEntry() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <IconButton label="猜你想做" onClick={() => setOpen(true)}>
        <SparkleIcon size={20} />
      </IconButton>
      <AppDialog open={open} onOpenChange={setOpen} size="lg">
        <DialogTitle>猜你想做</DialogTitle>
        <DialogDescription>
          从真实选择学习，让下一步少一次寻找。
        </DialogDescription>
        {open && <NextActionWorkbench />}
      </AppDialog>
    </>
  )
}
