const fs = require('node:fs')
function parse(text) {
  return text.split(/\r?\n/).flatMap(line => {
    const start = line.indexOf('[PERF] ')
    if (start < 0) return []
    try { return [JSON.parse(line.slice(start + 7))] } catch { return [] }
  })
}
function stats(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b)
  if (!sorted.length) return { n: 0 }
  const mid = Math.floor(sorted.length / 2)
  return { n: sorted.length, min: sorted[0], median: sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2, max: sorted.at(-1), values }
}
function summarize(events) {
  const cycles = new Map()
  for (const event of events) {
    const key = `${event.run}:${event.cycle}`
    if (!cycles.has(key)) cycles.set(key, [])
    cycles.get(key).push(event)
  }
  const navigations = []
  for (const group of cycles.values()) {
    const action = group.find(item => ['tab press', 'tab reselect', 'manual refresh', 'foreground'].includes(item.stage))
    if (!action) continue
    const screen = action.screen.replace(/\.navigation$/, '')
    const nextAction = events.find(item => item.run === action.run && item.atMs > action.atMs && item.screen.endsWith('.navigation') && item.stage === 'start')
    const until = nextAction?.atMs ?? Infinity
    const children = events.filter(item => item.run === action.run && item.atMs >= action.atMs && item.atMs < until && (item.screen === screen || item.screen === `${screen}.lifecycle`))
    // An earlier poll may commit while a manual request is still pending. Do not
    // call that commit completion of the new refresh.
    const refreshStart = children.find(item => item.screen === screen && item.stage === 'start')
    const refreshCycle = refreshStart ? events.filter(item => item.run === refreshStart.run && item.cycle === refreshStart.cycle) : []
    const dataStages = screen === 'Discover' ? ['saved-location discovery end'] : screen === 'Board' ? ['query end'] : screen === 'ChatList' ? ['rooms end', 'requests end'] : screen === 'OpenChatList' ? ['rooms end', 'account end'] : ['state ready']
    const completions = dataStages.map(stage => refreshCycle.find(item => item.stage === stage)?.atMs)
    const dataReadyAt = completions.every(Number.isFinite) ? Math.max(...completions) : refreshCycle.find(item => item.stage === 'state ready')?.atMs ?? Infinity
    const threshold = ['manual refresh', 'foreground'].includes(action.stage) ? dataReadyAt : action.atMs
    const usable = children.find(item => item.stage === 'usable UI candidate' && item.ready && item.atMs >= threshold)
    const mount = children.find(item => item.stage === 'MOUNT')
    const ready = children.find(item => item.stage === 'state commit' && item.ready && item.atMs >= threshold)
    navigations.push({ run: action.run, cycle: action.cycle, screen, trigger: action.stage, atMs: action.atMs, mountMs: mount ? mount.atMs - action.atMs : null, readyCommitMs: ready ? ready.atMs - action.atMs : null, usableCandidateMs: usable ? usable.atMs - action.atMs : null, rows: usable?.rows })
  }
  const timings = {}
  for (const event of events) if (Number.isFinite(event.durationMs) && event.stage !== 'start') {
    const key = `${event.screen}/${event.stage}`
    ;(timings[key] ??= []).push(event.durationMs)
  }
  const requestStarts = events.filter(item => item.screen.startsWith('Network.') && item.stage === 'fetch start')
  const contention = requestStarts.map(event => ({ run: event.run, atMs: event.atMs, requests: requestStarts.filter(item => item.run === event.run && item.atMs >= event.atMs && item.atMs < event.atMs + 500).map(item => item.screen.slice(8)) })).sort((a, b) => b.requests.length - a.requests.length).slice(0, 10)
  const navigationStats = {}
  for (const item of navigations) if (item.usableCandidateMs !== null) (navigationStats[`${item.screen}/${item.trigger}`] ??= []).push(item.usableCandidateMs)
  return { events: events.length, navigations, navigationStats: Object.fromEntries(Object.entries(navigationStats).map(([key, values]) => [key, stats(values)])), timings: Object.fromEntries(Object.entries(timings).map(([key, values]) => [key, stats(values)])), contention }
}
module.exports = { parse, stats, summarize }
if (require.main === module) {
  const [input, output] = process.argv.slice(2)
  const result = JSON.stringify(summarize(parse(fs.readFileSync(input, 'utf8'))), null, 2)
  if (output) fs.writeFileSync(output, result)
  else console.log(result)
}
