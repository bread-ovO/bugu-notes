import { describe, expect, it } from 'vitest'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { analysisCliInvocation, modelCliCandidates, runAnalysisCli } from '../../apps/desktop/src/main/task-cli-provider'

describe('model CLI native and npm entrypoints', () => {
  it('finds Windows native executables and official npm script entries without cmd shell', () => {
    const paths = modelCliCandidates('codex-cli', 'win32', 'C:\\Users\\Test User', 'C:\\Tools With Spaces;relative;C:\\Other')
    expect(paths).toContain('C:\\Tools With Spaces\\codex.exe')
    expect(paths).toContain('C:\\Users\\Test User\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js')
    expect(paths.some((p) => p.endsWith('.cmd') || p.startsWith('relative'))).toBe(false)
    expect(modelCliCandidates('claude-cli', 'win32', 'C:\\Users\\A', '')).toContain('C:\\Users\\A\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js')
    expect(modelCliCandidates('unknown', 'win32', 'C:\\Users\\A', '')).toEqual([])
  })
  it('preserves arguments literally and uses the bundled Node runtime for npm scripts', () => {
    const script = 'C:\\User Name\\node_modules\\@openai\\codex\\bin\\codex.js'
    const args = ['--model', 'literal & echo secret', '--json-schema', '{"x":"%PATH%"}']
    expect(analysisCliInvocation(script, args, 'win32', 'C:\\BUGU\\BUGU.exe')).toEqual({ executable:'C:\\BUGU\\BUGU.exe',args:[script,...args],nodeScript:true })
    expect(analysisCliInvocation('C:\\Tools\\claude.exe', args, 'win32').nodeScript).toBe(false)
    expect(analysisCliInvocation('/usr/bin/codex', args, 'darwin').executable).toBe('/usr/bin/codex')
  })
  it('runs a spaced-path synthetic CLI, passes stdin and cancels an in-flight process', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bugu cli test '))
    try {
      const file = join(root, 'fake cli.cjs')
      await writeFile(file, 'let text="";process.stdin.on("data",c=>text+=c);process.stdin.on("end",()=>process.stdout.write(JSON.stringify({text,args:process.argv.slice(2)})))')
      const output = await runAnalysisCli(process.execPath, [file, 'literal & %PATH%'], root, 'synthetic prompt', new AbortController().signal)
      expect(JSON.parse(output)).toEqual({text:'synthetic prompt',args:['literal & %PATH%']})
      await writeFile(file, 'setInterval(()=>{},1000)')
      const controller = new AbortController()
      const pending = runAnalysisCli(process.execPath, [file], root, 'fixture', controller.signal)
      setTimeout(() => controller.abort(), 100)
      await expect(pending).rejects.toThrow('MODEL_CANCELLED')
    } finally { await rm(root,{recursive:true,force:true}) }
  })
})
