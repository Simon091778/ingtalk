// App text is the canonical source for app, ASP, Markdown and public HTML.
import { readFileSync, writeFileSync } from 'node:fs'
const root = new URL('../', import.meta.url)
const read = path => readFileSync(new URL(path, root), 'utf8')
function document(file, name) {
  const source = read(file)
  const text = source.match(new RegExp('export const ' + name + ' = `([\\s\\S]*?)`'))?.[1]
  if (!text) throw new Error(`Missing legal text ${name}`)
  return text.replace(/\$\{([A-Z_]+)\}/g, (_, key) => {
    const value = source.match(new RegExp(`export const ${key} = '([^']+)'`))?.[1]
    if (!value) throw new Error(`Unsupported template ${key}`)
    return value
  })
}
const escape = text => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
function body(text, title) {
  const lines = text.split(/\r?\n/)
  return `<header class="page-head"><h1>${escape(title)}</h1><p class="effective">${escape(lines.shift())}</p></header>\n` + lines.filter(Boolean).map(line => /^\d+\. /.test(line)
    ? `<h2>${escape(line)}</h2>` : `<p>${escape(line)}</p>`).join('\n')
}
for (const [page, constant, koTitle, enTitle] of [
  ['privacy', 'PRIVACY_POLICY_TEXT', '잉톡 개인정보처리방침', 'Ingtalk Privacy Policy'],
  ['terms', 'TERMS_OF_SERVICE_TEXT', '잉톡 이용약관', 'Ingtalk Terms of Service'],
]) {
  const ko = document('src/content/legal.ts', constant)
  const en = document('src/content/legal.en.ts', `${constant}_EN`)
  const file = `store/web/ingtalk/${page}.asp`
  const original = read(file)
  const start = original.indexOf('<main')
  const end = original.lastIndexOf('</main>')
  if (start < 0 || end < 0) throw new Error(`Missing main in ${file}`)
  const html = `<main id="main" class="container"><% If lang = "en" Then %>\n${body(en, enTitle)}\n<% Else %>\n${body(ko, koTitle)}\n<% End If %></main>`
  writeFileSync(new URL(file, root), original.slice(0, start) + html + original.slice(end + 7), 'utf8')
  const markdown = page === 'privacy' ? 'PRIVACY_POLICY_KO.md' : 'TERMS_OF_SERVICE_KO.md'
  writeFileSync(new URL(`store/legal/${markdown}`, root), `# ${koTitle}\n\n${ko}\n`, 'utf8')
}
console.log('Synchronized legal ASP and Markdown from app text.')
