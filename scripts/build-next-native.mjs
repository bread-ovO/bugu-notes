import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const output = resolve(root, 'apps/desktop/out/native/next-action-observer')
mkdirSync(dirname(output), { recursive: true })
if (process.platform === 'darwin')
  execFileSync(
    '/usr/bin/xcrun',
    [
      'swiftc',
      '-O',
      '-framework',
      'AppKit',
      '-framework',
      'ApplicationServices',
      '-framework',
      'Carbon',
      resolve(root, 'apps/desktop/native/next-action/observer.swift'),
      '-o',
      output,
    ],
    { stdio: 'inherit', timeout: 120000 },
  )
if (process.platform === 'win32')
  execFileSync(
    'cl.exe',
    [
      '/nologo',
      '/utf-8',
      '/EHsc',
      '/std:c++17',
      '/O2',
      resolve(root, 'apps/desktop/native/next-action/observer.cpp'),
      `/Fe:${output}.exe`,
      '/link',
      'user32.lib',
      'imm32.lib',
      'ole32.lib',
      'oleaut32.lib',
      'uiautomationcore.lib',
      'uuid.lib',
    ],
    { stdio: 'inherit', timeout: 120000 },
  )

if (process.platform === 'darwin')
  execFileSync(
    '/usr/bin/xcrun',
    [
      'swiftc',
      '-O',
      resolve(root, 'apps/desktop/native/next-action/browser-host.swift'),
      '-o',
      resolve(root, 'apps/desktop/out/native/next-action-browser-host'),
    ],
    { stdio: 'inherit', timeout: 120000 },
  )
if (process.platform === 'win32')
  execFileSync(
    'cl.exe',
    [
      '/nologo',
      '/utf-8',
      '/EHsc',
      '/std:c++17',
      '/O2',
      resolve(root, 'apps/desktop/native/next-action/browser-host.cpp'),
      `/Fe:${resolve(root, 'apps/desktop/out/native/next-action-browser-host.exe')}`,
      '/link',
      'crypt32.lib',
    ],
    { stdio: 'inherit', timeout: 120000 },
  )
if (process.platform === 'linux')
  execFileSync(
    'c++',
    [
      '-std=c++17',
      '-O2',
      resolve(root, 'apps/desktop/native/next-action/browser-host.cpp'),
      ...execFileSync('pkg-config', ['--cflags', '--libs', 'libsecret-1'], {
        encoding: 'utf8',
      })
        .trim()
        .split(/\s+/),
      '-o',
      resolve(root, 'apps/desktop/out/native/next-action-browser-host'),
    ],
    { stdio: 'inherit', timeout: 120000 },
  )
const { cpSync } = await import('node:fs')
cpSync(
  resolve(root, 'apps/browser-extension'),
  resolve(root, 'apps/desktop/out/browser-extension'),
  { recursive: true },
)

if (process.platform === 'linux')
  execFileSync(
    'c++',
    [
      '-std=c++17',
      '-O2',
      '-pthread',
      resolve(root, 'apps/desktop/native/next-action/observer-linux.cpp'),
      '-lX11',
      '-o',
      output,
    ],
    { stdio: 'inherit', timeout: 120000 },
  )
