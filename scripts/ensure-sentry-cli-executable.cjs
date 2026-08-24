const fs = require('node:fs')
const path = require('node:path')

const nodeModules = path.join(process.cwd(), 'node_modules')
const candidates = [path.join(nodeModules, '@sentry', 'cli', 'bin', 'sentry-cli')]
const pnpmStore = path.join(nodeModules, '.pnpm')

if (fs.existsSync(pnpmStore)) {
  for (const entry of fs.readdirSync(pnpmStore)) {
    if (entry.startsWith('@sentry+cli@')) {
      candidates.push(
        path.join(pnpmStore, entry, 'node_modules', '@sentry', 'cli', 'bin', 'sentry-cli'),
      )
    }
  }
}

const existing = [...new Set(candidates)].filter(fs.existsSync)

if (existing.length === 0) {
  throw new Error('Unable to find the Sentry CLI launcher after dependency installation.')
}

for (const executable of existing) {
  fs.chmodSync(executable, 0o755)
  const mode = fs.statSync(executable).mode & 0o777
  if (process.platform !== 'win32' && (mode & 0o111) === 0) {
    throw new Error(`Sentry CLI is still not executable: ${executable}`)
  }
  console.log(
    `Ensured executable permissions (${mode.toString(8)}) for ${path.relative(process.cwd(), executable)}`,
  )
}
