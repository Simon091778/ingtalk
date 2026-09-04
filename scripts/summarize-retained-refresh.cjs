const fs = require('node:fs')
const { parse, stats } = require('./summarize-refresh-perf.cjs')

function summarizeRetained(events) {
  const actions = events.filter(e => ['tab press', 'tab reselect', 'manual refresh', 'foreground'].includes(e.stage))
  const rows = actions.map(action => {
    const screen = action.screen.replace(/\.navigation$/, '')
    const next = actions.find(e => e.run === action.run && e.atMs > action.atMs)
    const within = events.filter(e => e.run === action.run && e.atMs >= action.atMs && e.atMs < (next?.atMs ?? Infinity))
    const visible = within.find(e => e.cycle === action.cycle && e.stage === 'UI_VISIBLE')
    const child = within.filter(e => e.screen === screen && e.parentCycle === action.cycle)
    const data = child.find(e => e.stage === 'DATA_REFRESH_COMPLETE')
    const feed = child.find(e => e.stage === 'FEED_REFRESH_COMPLETE')
    const fresh = child.find(e => e.stage === 'FEED_REFRESH_COMPLETE' && e.freshLocation)
    const mount = within.some(e => e.screen === screen + '.lifecycle' && e.stage === 'MOUNT')
    const refreshReact = child.filter(e => e.stage === 'React update' && e.atMs >= (feed?.atMs ?? data?.atMs ?? Infinity))
    const firstReact = within.find(e => e.screen === screen && e.stage.startsWith('React '))
    return { run: action.run, cycle: action.cycle, screen, trigger: action.stage, atMs: action.atMs, mounted: mount,
      UI_VISIBLE: visible ? visible.atMs - action.atMs : null, rows: visible?.rows,
      DATA_REFRESH_COMPLETE: data ? data.atMs - action.atMs : null,
      FEED_REFRESH_COMPLETE: feed ? feed.atMs - action.atMs : null,
      FRESH_LOCATION_COMPLETE: fresh ? fresh.atMs - action.atMs : null,
      firstReactMs: firstReact?.durationMs ?? null,
      largestRefreshReactMs: refreshReact.length ? Math.max(...refreshReact.map(e => e.durationMs)) : null }
  })
  const groups = {}
  for (const row of rows) {
    const key = `${row.screen}/${row.trigger}/${row.mounted ? 'mount' : 'retained'}`
    const group = groups[key] ??= {}
    for (const metric of ['UI_VISIBLE', 'DATA_REFRESH_COMPLETE', 'FEED_REFRESH_COMPLETE', 'FRESH_LOCATION_COMPLETE', 'firstReactMs', 'largestRefreshReactMs']) {
      if (Number.isFinite(row[metric])) (group[metric] ??= []).push(row[metric])
    }
  }
  return { rows, stats: Object.fromEntries(Object.entries(groups).map(([key, metrics]) => [key, Object.fromEntries(Object.entries(metrics).map(([metric, values]) => [metric, stats(values)]))])) }
}
module.exports = { summarizeRetained }
if (require.main === module) {
  const [input, output, since = '0'] = process.argv.slice(2)
  const result = JSON.stringify(summarizeRetained(parse(fs.readFileSync(input, 'utf8')).filter(e => e.atMs >= Number(since))), null, 2)
  if (output) fs.writeFileSync(output, result)
  else console.log(result)
}
