import { readFileSync, mkdirSync, copyFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
const root = resolve('apps/browser-extension')
const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'))
if (
  manifest.manifest_version !== 3 ||
  manifest.permissions.some(
    (p) => !['nativeMessaging', 'storage', 'scripting'].includes(p),
  )
)
  throw Error('UNEXPECTED_EXTENSION_PERMISSION')
const out = resolve('release/browser-extension')
mkdirSync(out, { recursive: true })
const files = [
  'manifest.json',
  'background.js',
  'content.js',
  'options.html',
  'options.js',
]
for (const file of files) copyFileSync(join(root, file), join(out, file))
const id = createHash('sha256')
  .update(Buffer.from(manifest.key, 'base64'))
  .digest('hex')
  .slice(0, 32)
  .replace(/[0-9a-f]/g, (c) => String.fromCharCode(97 + parseInt(c, 16)))
const archive = resolve(
  `release/BUGU-context-extension-${manifest.version}.zip`,
)
// Python's ZIP writer is deterministic and includes only the reviewed allowlist.
execFileSync('python3', [
  '-c',
  `import sys,zipfile,pathlib
root=pathlib.Path(sys.argv[1])
with zipfile.ZipFile(sys.argv[2],'w',zipfile.ZIP_DEFLATED) as z:
 for name in sys.argv[3:]:
  info=zipfile.ZipInfo(name,date_time=(2026,1,1,0,0,0));info.compress_type=zipfile.ZIP_DEFLATED;info.external_attr=0o644<<16
  z.writestr(info,(root/name).read_bytes())`,
  out,
  archive,
  ...files,
])
const hash = createHash('sha256').update(readFileSync(archive)).digest('hex')
writeFileSync(`${archive}.sha256`, `${hash}  ${archive.split('/').at(-1)}\n`)
writeFileSync(
  join(out, 'build-report.json'),
  JSON.stringify(
    {
      version: manifest.version,
      developmentExtensionId: id,
      sha256: hash,
      files,
      storePublished: false,
    },
    null,
    2,
  ) + '\n',
)
console.log(
  JSON.stringify({
    archive,
    sha256: hash,
    developmentExtensionId: id,
    storePublished: false,
  }),
)
