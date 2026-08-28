// Copies only the built browser artifact, never admin/.env or node_modules.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import assert from 'node:assert/strict'
const root = new URL('../', import.meta.url)
const source = new URL('admin/dist/', root)
assert(existsSync(new URL('index.html', source)), 'Run npm run admin:build first')
const read = path => readFileSync(path, 'utf8')
assert(read(new URL('index.html', source)).includes('/admin/assets/'), 'Build must use /admin/ base')
for (const file of readdirSync(new URL('assets/', source))) {
  assert(/\.(js|css)$/.test(file), `Unexpected public asset: ${file}`)
  const body = read(new URL(`assets/${file}`, source))
  assert(!/sb_secret_[A-Za-z0-9_-]{20,}|-----BEGIN .*PRIVATE KEY/.test(body), 'Secret in browser artifact')
  for (const match of body.matchAll(/eyJ[A-Za-z0-9_-]+\.([A-Za-z0-9_-]+)\.[A-Za-z0-9_-]+/g)) {
    assert.notEqual(JSON.parse(Buffer.from(match[1], 'base64url').toString()).role, 'service_role', 'Privileged JWT in browser artifact')
  }
}
const target = new URL('github-site/admin/', root)
mkdirSync(target, { recursive: true })
cpSync(new URL('index.html', source), new URL('index.html', target))
cpSync(new URL('assets/', source), new URL('assets/', target), { recursive: true })
console.log('Packaged admin browser assets under github-site/admin/.')
