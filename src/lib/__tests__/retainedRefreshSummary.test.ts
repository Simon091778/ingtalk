const { summarizeRetained } = require('../../../scripts/summarize-retained-refresh.cjs')

test('keeps retained visibility separate from validation and rejects the previous request completion', () => {
  const e = (screen: string, cycle: number, atMs: number, stage: string, extra = {}) => ({ run: 'run', screen, cycle, atMs, stage, ...extra })
  const result = summarizeRetained([
    e('Discover.navigation', 2, 100, 'tab press'),
    e('Discover.navigation', 2, 180, 'UI_VISIBLE', { rows: 12 }),
    e('Discover', 1, 200, 'DATA_REFRESH_COMPLETE', { parentCycle: 0 }),
    e('Discover', 3, 700, 'DATA_REFRESH_COMPLETE', { parentCycle: 2 }),
    e('Board.navigation', 4, 800, 'tab press'),
    e('Discover', 3, 900, 'FEED_REFRESH_COMPLETE', { parentCycle: 2, freshLocation: true }),
  ])
  expect(result.rows[0]).toMatchObject({ UI_VISIBLE: 80, DATA_REFRESH_COMPLETE: 600, FRESH_LOCATION_COMPLETE: null, mounted: false })
})
