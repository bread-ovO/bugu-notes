import { openStore } from '@memo/storage'
import { defaultNextActionSettings } from '@memo/contracts'
import { join } from 'node:path'
import { event, choice } from './next-action'
const root = process.argv[2]
if (!root) throw Error('ISOLATED_ROOT_REQUIRED')
const store = openStore(join(root, 'memo.sqlite'))
try {
  store.tasks.createProject('project-a', '虚构学习项目')
  store.nextAction.grant({ projectId: 'project-a', accountId: 'account-a', sourceId: 'source-a', revision: 1, active: true })
  store.nextAction.configure({ ...defaultNextActionSettings, enabled: true }, store.nextAction.snapshot().version)
  const createdAt = Date.now() - 5000
  store.nextAction.putEvent(event('e1', { createdAt }), store.nextAction.snapshot().version)
  store.nextAction.putChoice(choice('c1', 'e1', { createdAt: createdAt + 1000 }), store.nextAction.snapshot().version)
} finally { store.close() }
