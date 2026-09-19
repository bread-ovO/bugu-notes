import { spawn } from 'node:child_process'

/** Native helper owns OS credential storage. Secret material never appears in argv or logs. */
export async function pairingSecret(
  executable: string,
  operation: 'seal' | 'unseal' | 'forget',
  value: string,
): Promise<string> {
  if (value.length > 8192 || /[\r\n\0]/.test(value))
    throw Error('NEXT_PAIRING_INVALID')
  if (operation === 'seal' && !/^[a-f0-9]{64}$/.test(value))
    throw Error('NEXT_PAIRING_INVALID')
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [`--${operation}`], {
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true,
    })
    let output = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(Error('NEXT_SECURE_STORAGE_UNAVAILABLE'))
    }, 10000)
    child.stdout.on('data', (chunk) => {
      output += chunk.toString('utf8')
      if (output.length > 8192) {
        child.kill()
        reject(Error('NEXT_PAIRING_INVALID'))
      }
    })
    child.on('error', () => {
      clearTimeout(timer)
      reject(Error('NEXT_SECURE_STORAGE_UNAVAILABLE'))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      const result = output.trim()
      if (
        code !== 0 ||
        (operation === 'unseal' && !/^[a-f0-9]{64}$/.test(result)) ||
        (operation === 'seal' &&
          !/^(keychain|dpapi|secret):[a-zA-Z0-9-]+$/.test(result))
      )
        reject(Error('NEXT_SECURE_STORAGE_UNAVAILABLE'))
      else resolve(result)
    })
    child.stdin.on('error', () => {})
    child.stdin.end(value + '\n')
  })
}
