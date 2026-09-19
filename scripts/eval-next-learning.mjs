import { build } from 'esbuild'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
const dir = await mkdtemp(join(tmpdir(), 'bugu-learning-replay-'))
try {
  const entry = join(dir, 'replay.cjs')
  await build({
    entryPoints: ['tests/evals/next-learning-replay.ts'],
    outfile: entry,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    tsconfig: 'tsconfig.json',
  })
  await import(pathToFileURL(entry).href)
} finally {
  await rm(dir, { recursive: true, force: true })
}
