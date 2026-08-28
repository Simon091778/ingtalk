// Run after build-github-site and admin:build. --live also checks the published site.
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
const root = new URL('../', import.meta.url)
const read = path => readFileSync(new URL(path, root), 'utf8')
const escape = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
let count = 0
for (const [file, prefix, suffix] of [['src/content/legal.ts', '', ''], ['src/content/legal.en.ts', 'en/', '_EN']]) {
  const source = read(file)
  for (const [page, constant] of [['privacy', 'PRIVACY_POLICY_TEXT'], ['terms', 'TERMS_OF_SERVICE_TEXT']]) {
    const text = source.match(new RegExp(`export const ${constant}${suffix} = \x60([\\s\\S]*?)\x60`))?.[1]
    assert(text)
    const resolved = text.replace(/\$\{([A-Z_]+)\}/g, (_, key) => {
      const value = source.match(new RegExp(`export const ${key} = '([^']+)'`))?.[1]
      assert(value)
      return value
    })
    const path = `${prefix}${page}.html`
    const local = read(`github-site/${path}`)
    for (const line of resolved.split(/\r?\n/).filter(Boolean)) assert(local.includes(escape(line)), `${path}: missing source paragraph`)
    assert(local.includes('class="container"'), `${path}: missing constrained layout`)
    assert(!local.includes('<%'), `${path}: unrendered ASP`)
    if (process.argv.includes('--live')) {
      const response = await fetch(`https://ingtalk.vercel.app/${path}`, { cache: 'no-store' })
      assert.equal(response.status, 200, path)
      assert.equal((await response.text()).replaceAll('\r\n', '\n'), local.replaceAll('\r\n', '\n'), `${path}: deployment differs`)
    }
    count++
  }
}
const admin = read('github-site/admin/index.html')
const assets = [...admin.matchAll(/(?:src|href)="(\/admin\/assets\/[^"?]+)"/g)].map(match => match[1])
assert(assets.length >= 2, 'Admin JS/CSS must use /admin/ base')
for (const asset of assets) {
  assert(existsSync(new URL(`github-site${asset}`, root)), asset)
  if (process.argv.includes('--live')) assert.equal((await fetch(`https://ingtalk.vercel.app${asset}`)).status, 200, asset)
}
console.log(`Verified ${count} synchronized legal pages and ${assets.length} admin assets${process.argv.includes('--live') ? ' including production URLs' : ''}.`)
