import { access, readdir, open } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { basename, join } from 'node:path'
import { homedir } from 'node:os'
import { createHash } from 'node:crypto'
const exec = promisify(execFile)
export interface InstalledTool {
  id: string
  label: string
  identity: string
  path: string
}
const known: Array<{
  id: string
  label: string
  mac: string
  win: string
  linux: string
}> = [
  {
    id: 'codex',
    label: 'Codex',
    mac: 'com.openai.codex',
    win: 'Codex.exe',
    linux: 'codex',
  },
  {
    id: 'claude',
    label: 'Claude',
    mac: 'com.anthropic.claudefordesktop',
    win: 'claude.exe',
    linux: 'claude',
  },
  {
    id: 'kimi',
    label: 'Kimi',
    mac: 'com.moonshot.kimi',
    win: 'kimi.exe',
    linux: 'kimi',
  },
  {
    id: 'vscode',
    label: 'Visual Studio Code',
    mac: 'com.microsoft.VSCode',
    win: 'Code.exe',
    linux: 'code',
  },
  {
    id: 'cursor',
    label: 'Cursor',
    mac: 'com.todesktop.230313mzl4w4u92',
    win: 'Cursor.exe',
    linux: 'cursor',
  },
  {
    id: 'feishu',
    label: '飞书',
    mac: 'com.bytedance.macos.feishu',
    win: 'Feishu.exe',
    linux: 'bytedance-feishu',
  },
  {
    id: 'chrome',
    label: 'Chrome',
    mac: 'com.google.Chrome',
    win: 'chrome.exe',
    linux: 'google-chrome',
  },
  {
    id: 'edge',
    label: 'Edge',
    mac: 'com.microsoft.edgemac',
    win: 'msedge.exe',
    linux: 'microsoft-edge',
  },
  {
    id: 'obsidian',
    label: 'Obsidian',
    mac: 'md.obsidian',
    win: 'Obsidian.exe',
    linux: 'obsidian',
  },
  {
    id: 'notion',
    label: 'Notion',
    mac: 'notion.id',
    win: 'Notion.exe',
    linux: 'notion',
  },
]
export async function installedTools(): Promise<InstalledTool[]> {
  const results: InstalledTool[] = [
    {
      id: 'github',
      label: 'GitHub',
      identity: 'github.com',
      path: 'https://github.com/',
    },
  ]
  if (process.platform === 'darwin') {
    for (const directory of [
      '/Applications',
      join(homedir(), 'Applications'),
    ]) {
      for (const entry of await readdir(directory).catch(() => [])) {
        if (!entry.endsWith('.app')) continue
        const path = join(directory, entry)
        try {
          const { stdout } = await exec(
            '/usr/bin/plutil',
            [
              '-extract',
              'CFBundleIdentifier',
              'raw',
              '-o',
              '-',
              join(path, 'Contents/Info.plist'),
            ],
            { timeout: 1500, maxBuffer: 4096 },
          )
          const identity = stdout.trim()
          const app = known.find(
            (a) => a.mac.toLowerCase() === identity.toLowerCase(),
          )
          // All installed applications can be chosen, not just the named presets.
          if (
            identity &&
            /^[\w.-]{1,200}$/.test(identity) &&
            !identity.startsWith('dev.multisource.')
          )
            results.push({
              id: app?.id ?? `mac.${identity}`,
              label: (app?.label ?? entry.slice(0, -4)).slice(0, 120),
              identity,
              path,
            })
        } catch {
          /* invalid bundle */
        }
      }
    }
  } else if (process.platform === 'win32') {
    // Registry App Paths resolves OS-installed executables, never a model-generated command.
    for (const app of known) {
      for (const hive of ['HKCU', 'HKLM']) {
        try {
          const { stdout } = await exec(
            'reg.exe',
            [
              'query',
              `${hive}\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${app.win}`,
              '/ve',
            ],
            { timeout: 1500, maxBuffer: 4096, windowsHide: true },
          )
          const path = stdout
            .split(/\r?\n/)
            .map((x) => x.match(/REG_SZ\s+(.+)$/)?.[1]?.trim())
            .find(Boolean)
          if (path) {
            await access(path)
            results.push({
              id: app.id,
              label: app.label,
              identity: app.win.toLowerCase(),
              path,
            })
            break
          }
        } catch {
          /* not installed */
        }
      }
    }
  } else {
    for (const app of known) {
      for (const dir of ['/usr/bin', '/usr/local/bin', '/snap/bin']) {
        const path = join(dir, app.linux)
        try {
          await access(path)
          results.push({
            id: app.id,
            label: app.label,
            identity: app.linux,
            path,
          })
          break
        } catch {
          /* not installed */
        }
      }
    }
  }
  return results
    .filter((t, i, a) => a.findIndex((x) => x.id === t.id) === i)
    .sort(
      (a, b) =>
        Number(known.some((k) => k.id === b.id)) -
        Number(known.some((k) => k.id === a.id)),
    )
    .slice(0, 24)
}
export async function launchInstalled(
  tool: InstalledTool,
): Promise<'dispatched' | 'failed'> {
  try {
    if (tool.id === 'github' && tool.path === 'https://github.com/') {
      const { shell } = await import('electron')
      await shell.openExternal(tool.path)
      return 'dispatched'
    }
    await access(tool.path)
    if (process.platform === 'darwin')
      await exec('/usr/bin/open', ['-a', tool.path], {
        timeout: 5000,
        maxBuffer: 4096,
      })
    else {
      // shell.openPath uses the installed app association and doesn't execute a command string.
      const { shell } = await import('electron')
      if (await shell.openPath(tool.path)) return 'failed'
    }
    return 'dispatched'
  } catch {
    return 'failed'
  }
}
export async function validateCustomTool(path: string): Promise<InstalledTool> {
  await access(path)
  if (process.platform === 'darwin' && path.endsWith('.app')) {
    const { stdout } = await exec(
      '/usr/bin/plutil',
      [
        '-extract',
        'CFBundleIdentifier',
        'raw',
        '-o',
        '-',
        join(path, 'Contents/Info.plist'),
      ],
      { timeout: 1500, maxBuffer: 4096 },
    )
    const identity = stdout.trim()
    if (!/^[\w.-]{1,200}$/.test(identity)) throw Error('NEXT_INVALID_TARGET')
    const app = known.find(
      (a) => a.mac.toLowerCase() === identity.toLowerCase(),
    )
    return {
      id: app?.id ?? `mac.${identity}`,
      label: (app?.label ?? basename(path, '.app')).slice(0, 120),
      identity,
      path,
    }
  }
  if (process.platform === 'win32' && /\.exe$/i.test(path))
    return executableTool(path, 'win32')
  if (process.platform === 'linux' && !(await isExecutableHeader(path)))
    throw Error('NEXT_INVALID_TARGET')
  if (process.platform === 'linux') return executableTool(path, 'linux')
  throw Error('NEXT_INVALID_TARGET')
}

export function executableTool(
  path: string,
  platform: 'win32' | 'linux',
): InstalledTool {
  const name = basename(path)
  const identity = platform === 'win32' ? name.toLowerCase() : name
  const app = known.find((a) =>
    platform === 'win32'
      ? a.win.toLowerCase() === identity
      : a.linux === identity,
  )
  return {
    id:
      app?.id ??
      `${platform}.${createHash('sha256').update(identity).digest('hex').slice(0, 24)}`,
    label: (
      app?.label ?? (platform === 'win32' ? name.replace(/\.exe$/i, '') : name)
    ).slice(0, 120),
    identity,
    path,
  }
}

async function isExecutableHeader(path: string) {
  const file = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(4)
    const { bytesRead } = await file.read(buffer, 0, 4, 0)
    return (
      bytesRead === 4 && buffer.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))
    )
  } finally {
    await file.close()
  }
}
