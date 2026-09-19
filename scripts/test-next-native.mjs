import { execFileSync, spawn } from 'node:child_process'
import {
  mkdtempSync,
  copyFileSync,
  writeFileSync,
  rmSync,
  chmodSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from 'node:net'
import assert from 'node:assert/strict'
const root = mkdtempSync(join(tmpdir(), 'bugu-native-'))
try {
  const ext = process.platform === 'win32' ? '.exe' : ''
  if (true) {
    const result = JSON.parse(
      execFileSync(
        resolve(`apps/desktop/out/native/next-action-observer${ext}`),
        ['--self-test'],
        { encoding: 'utf8', timeout: 15000 },
      ),
    )
    assert.equal(result.selfTest, true)
    assert.equal(result.observedUserData, false)
  }
  const endpoint =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\bugu-native-test-${process.pid}`
      : join(root, 'test.sock')
  const host = join(root, `browser-host${ext}`)
  copyFileSync(
    resolve(`apps/desktop/out/native/next-action-browser-host${ext}`),
    host,
  )
  chmodSync(host, 0o700)
  const secret = 'b'.repeat(64),
    origin = `chrome-extension://${'a'.repeat(32)}/`
  writeFileSync(
    join(root, 'browser-host.conf'),
    `${endpoint}\n${secret}\n${origin}\n`,
    { mode: 0o600 },
  )
  let received = ''
  const server = createServer((socket) => {
    socket.on('data', (chunk) => (received += chunk.toString()))
    socket.on('error', () => {})
  })
  await new Promise((r) => server.listen(endpoint, r))
  async function run(args, input) {
    return await new Promise((resolve, reject) => {
      const child = spawn(host, args, { stdio: ['pipe', 'pipe', 'pipe'] })
      const chunks = []
      child.stdout.on('data', (d) => chunks.push(d))
      child.once('error', reject)
      const timer = setTimeout(() => {
        child.kill()
        reject(Error('host timeout'))
      }, 15000)
      child.once('exit', (code) => {
        clearTimeout(timer)
        resolve({ code, output: Buffer.concat(chunks) })
      })
      child.stdin.end(input)
      child.stdin.on('error', () => {})
    })
  }
  const payload = Buffer.from(
    JSON.stringify({
      type: 'visible-object',
      url: 'https://github.com/test/fixture/pull/1',
    }),
  )
  const header = Buffer.alloc(4)
  header.writeUInt32LE(payload.length)
  const valid = await run([origin], Buffer.concat([header, payload]))
  assert.equal(valid.code, 0)
  assert.equal(JSON.parse(valid.output.subarray(4).toString()).ok, true)
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(JSON.parse(received.trim()).token, secret)
  const before = received
  assert.notEqual(
    (await run(['chrome-extension://evil/'], Buffer.concat([header, payload])))
      .code,
    0,
  )
  assert.equal(received, before)
  const large = Buffer.alloc(4)
  large.writeUInt32LE(4097)
  assert.notEqual((await run([origin], large)).code, 0)
  assert.notEqual(
    (await run([origin], Buffer.concat([header, payload.subarray(0, 3)]))).code,
    0,
  )
  await new Promise((r) => server.close(r))
  console.log(
    'Native helper and native-messaging protocol passed (isolated frames; no user data or keyboard interception).',
  )
} finally {
  rmSync(root, { recursive: true, force: true })
}
