import { pairingSecret } from './pairing-secret'
import { unlinkSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto'
import {
  chmod,
  copyFile,
  cp,
  mkdir,
  readFile,
  rm,
  writeFile,
  rename,
} from 'node:fs/promises'
import { join } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
const exec = promisify(execFile)
/** This parser is also exercised independently with malformed/forged extension frames. */
export function browserObject(line: string, secret: string): string | null {
  if (Buffer.byteLength(line) > 8192) return null
  try {
    const value = JSON.parse(line)
    if (
      value.protocolVersion !== 1 ||
      typeof value.token !== 'string' ||
      value.token.length !== 64 ||
      secret.length !== 64 ||
      !timingSafeEqual(Buffer.from(value.token), Buffer.from(secret))
    )
      return null
    const p = value.payload
    if (p?.type === 'hidden' && Object.keys(p).length === 1) return ''
    if (
      !p ||
      p.type !== 'visible-object' ||
      typeof p.url !== 'string' ||
      p.url.length > 2048 ||
      Object.keys(p).some((k) => !['type', 'url'].includes(k))
    )
      return null
    const url = new URL(p.url)
    if (url.protocol !== 'https:' || url.username || url.password || url.port)
      return null
    if (
      url.hostname !== 'github.com' &&
      !/(^|\.)(feishu\.cn|larksuite\.com)$/.test(url.hostname)
    )
      return null
    url.search = ''
    url.hash = ''
    return url.href
  } catch {
    return null
  }
}
export class BrowserContextBridge {
  private server: Server | null = null
  private secret = randomBytes(32).toString('hex')
  private endpoint = ''
  private directory = ''
  private lifecycle: Promise<unknown> = Promise.resolve()
  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const result = this.lifecycle.then(work)
    this.lifecycle = result.catch(() => {})
    return result
  }
  constructor(
    private data: string,
    private assets: string,
    private native: string,
    private onPage: (url: string) => void,
  ) {
    this.directory = join(data, 'next-action-browser')
  }
  async start() {
    if (this.server) return
    this.directory = join(this.data, 'next-action-browser')
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    // macOS Unix sockets have a short sun_path limit; a private temp directory keeps the path bounded.
    const socketDirectory = join(
      tmpdir(),
      `bugu-${createHash('sha256').update(this.data).digest('hex').slice(0, 16)}`,
    )
    if (process.platform !== 'win32') {
      await mkdir(socketDirectory, { recursive: true, mode: 0o700 })
      await chmod(socketDirectory, 0o700)
    }
    this.endpoint =
      process.platform === 'win32'
        ? `\\\\.\\pipe\\bugu-${createHash('sha256').update(this.data).digest('hex').slice(0, 24)}`
        : join(socketDirectory, 'context.sock')
    if (process.platform !== 'win32') await rm(this.endpoint, { force: true })
    const server = createServer((socket) => {
      let buffer = ''
      socket.setTimeout(1500, () => socket.destroy())
      socket.on('error', () => {})
      socket.on('data', (chunk) => {
        buffer += chunk.toString('utf8')
        if (Buffer.byteLength(buffer) > 8192) {
          socket.destroy()
          return
        }
        const end = buffer.indexOf('\n')
        if (end >= 0) {
          const url = browserObject(buffer.slice(0, end), this.secret)
          socket.end()
          if (url !== null) this.onPage(url)
        }
      })
    })
    this.server = server
    server.on('error', () => {})
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(this.endpoint, () => {
        server.removeListener('error', reject)
        resolve()
      })
    })
    if (process.platform !== 'win32') await chmod(this.endpoint, 0o600)
  }
  install(): Promise<{ directory: string }> {
    return this.serialize(async () => {
      try {
        return await this.installInternal()
      } catch (error) {
        this.stop()
        throw error
      }
    })
  }
  private async installInternal(): Promise<{ directory: string }> {
    await this.start()
    const directory = join(this.directory, 'extension')
    await cp(this.assets, directory, { recursive: true })
    const manifest = JSON.parse(
      await readFile(join(directory, 'manifest.json'), 'utf8'),
    ) as { key: string }
    const id = createHash('sha256')
      .update(Buffer.from(manifest.key, 'base64'))
      .digest('hex')
      .slice(0, 32)
      .replace(/[0-9a-f]/g, (c) => String.fromCharCode(97 + parseInt(c, 16)))
    const host = join(
      this.directory,
      process.platform === 'win32' ? 'browser-host.exe' : 'browser-host',
    )
    await copyFile(this.native, host)
    await chmod(host, 0o700)
    const configPath = join(this.directory, 'browser-host.conf')
    const previous = (await readFile(configPath, 'utf8').catch(() => '')).split(
      '\n',
    )[1]
    const sealed = await pairingSecret(host, 'seal', this.secret)
    try {
      await writeFile(
        configPath + '.tmp',
        `${this.endpoint}\n${sealed}\nchrome-extension://${id}/\n`,
        { mode: 0o600 },
      )
      await rename(configPath + '.tmp', configPath)
    } catch (error) {
      await pairingSecret(host, 'forget', sealed).catch(() => {})
      throw error
    }
    if (previous && /^(keychain|dpapi|secret):/.test(previous))
      await pairingSecret(host, 'forget', previous).catch(() => {})
    const config = {
      name: 'dev.bugu.context',
      description: 'BUGU authorized context bridge',
      path: host,
      type: 'stdio',
      allowed_origins: [`chrome-extension://${id}/`],
    }
    const hostManifest = join(this.directory, 'dev.bugu.context.json')
    await writeFile(hostManifest, JSON.stringify(config), { mode: 0o600 })
    if (process.platform === 'darwin') {
      for (const browser of ['Google/Chrome', 'Microsoft Edge']) {
        const dir = join(
          homedir(),
          'Library/Application Support',
          browser,
          'NativeMessagingHosts',
        )
        await mkdir(dir, { recursive: true })
        await copyFile(hostManifest, join(dir, 'dev.bugu.context.json'))
      }
    } else if (process.platform === 'win32') {
      for (const browser of ['Google\\Chrome', 'Microsoft\\Edge'])
        await exec(
          'reg.exe',
          [
            'add',
            `HKCU\\Software\\${browser}\\NativeMessagingHosts\\dev.bugu.context`,
            '/ve',
            '/t',
            'REG_SZ',
            '/d',
            hostManifest,
            '/f',
          ],
          { windowsHide: true, timeout: 5000 },
        )
    } else {
      for (const browser of ['google-chrome', 'microsoft-edge', 'chromium']) {
        const dir = join(homedir(), '.config', browser, 'NativeMessagingHosts')
        await mkdir(dir, { recursive: true })
        await copyFile(hostManifest, join(dir, 'dev.bugu.context.json'))
      }
    }
    await writeFile(
      join(this.directory, 'README.txt'),
      `在 Chrome 或 Edge 的扩展管理页启用开发者模式，选择“加载已解压的扩展程序”，选择 extension 文件夹。\n扩展 ID：${id}\n然后点击扩展图标授权 GitHub 或飞书站点。在 BUGU 中还需授权对应连接。\n仅已授权且能够匹配本地具体对象的网页会进入事件分析。没有匹配的页面不会采集正文。\n`,
      { mode: 0o600 },
    )
    return { directory: this.directory }
  }
  resume() {
    return this.serialize(() => this.resumeInternal())
  }
  private async resumeInternal() {
    const file = join(this.directory, 'browser-host.conf')
    try {
      const conf = (await readFile(file, 'utf8')).split('\n')
      if (/^[a-f0-9]{64}$/.test(conf[1] ?? '')) {
        // Upgrade pre-release plaintext pairing; never keep or accept it if sealing fails.
        this.secret = conf[1]!
        try {
          await this.installInternal()
        } catch {
          await rm(file, { force: true })
          this.stop()
        }
        return
      }
      this.secret = await pairingSecret(
        this.hostPath(),
        'unseal',
        conf[1] ?? '',
      )
      await this.start()
      if (conf[0] !== this.endpoint) await this.installInternal()
    } catch {
      this.stop()
    }
  }
  private hostPath() {
    return join(
      this.directory,
      process.platform === 'win32' ? 'browser-host.exe' : 'browser-host',
    )
  }
  uninstall() {
    return this.serialize(() => this.uninstallInternal())
  }
  private async uninstallInternal() {
    // Revocation must take effect even if the OS credential store is locked.
    this.stop()
    this.secret = randomBytes(32).toString('hex')
    let credentialError: unknown
    const sealed = (
      await readFile(join(this.directory, 'browser-host.conf'), 'utf8').catch(
        () => '',
      )
    ).split('\n')[1]
    if (sealed && /^(keychain|dpapi|secret):/.test(sealed)) {
      try {
        await pairingSecret(this.hostPath(), 'forget', sealed)
      } catch (error) {
        credentialError = error
      }
    }
    if (process.platform === 'win32') {
      for (const browser of ['Google\\Chrome', 'Microsoft\\Edge']) {
        const key = `HKCU\\Software\\${browser}\\NativeMessagingHosts\\dev.bugu.context`
        try {
          const { stdout } = await exec('reg.exe', ['query', key, '/ve'], {
            windowsHide: true,
            timeout: 3000,
          })
          if (stdout.includes(join(this.directory, 'dev.bugu.context.json')))
            await exec('reg.exe', ['delete', key, '/f'], {
              windowsHide: true,
              timeout: 3000,
            })
        } catch {
          /* already removed */
        }
      }
    } else {
      const roots =
        process.platform === 'darwin'
          ? ['Google/Chrome', 'Microsoft Edge'].map((b) =>
              join(homedir(), 'Library/Application Support', b),
            )
          : ['google-chrome', 'microsoft-edge', 'chromium'].map((b) =>
              join(homedir(), '.config', b),
            )
      for (const root of roots) {
        const file = join(root, 'NativeMessagingHosts/dev.bugu.context.json')
        try {
          const m = JSON.parse(await readFile(file, 'utf8'))
          if (m.path === join(this.directory, 'browser-host'))
            await rm(file, { force: true })
        } catch {
          /* absent or another profile */
        }
      }
    }
    if (this.directory)
      await rm(this.directory, { recursive: true, force: true })
    if (credentialError) throw credentialError
  }
  stop() {
    this.server?.close()
    this.server = null
    if (process.platform !== 'win32' && this.endpoint) {
      // Synchronous unlink prevents a late cleanup from deleting a newly resumed socket.
      try {
        unlinkSync(this.endpoint)
      } catch {
        /* already closed */
      }
    }
  }
}
