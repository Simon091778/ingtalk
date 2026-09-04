const { parse, stats, summarize } = require('../../../scripts/summarize-refresh-perf.cjs')

test('log parser ignores unrelated and truncated lines and calculates true medians', () => {
  expect(parse('noise\n INFO [PERF] {"run":"r","cycle":1}\n[PERF] {')).toEqual([{ run: 'r', cycle: 1 }])
  expect(stats([4, 1, 3, 2]).median).toBe(2.5)
  expect(stats([4, 1, 3]).median).toBe(3)
  expect(stats([])).toEqual({ n: 0 })
})

test('navigation summaries do not borrow ready UI from a later navigation or another app run', () => {
  const events = [
    { run: 'a', cycle: 1, screen: 'Discover.navigation', stage: 'tab press', atMs: 0 },
    { run: 'a', cycle: 2, screen: 'Board.navigation', stage: 'start', atMs: 10 },
    { run: 'b', cycle: 3, screen: 'Discover', stage: 'usable UI candidate', atMs: 12, ready: true },
    { run: 'a', cycle: 4, screen: 'Discover', stage: 'usable UI candidate', atMs: 20, ready: true },
  ]
  expect(summarize(events).navigations[0].usableCandidateMs).toBeNull()
})

test('manual refresh excludes a ready commit from an earlier poll', () => {
  const events = [
    { run: 'a', cycle: 1, screen: 'ChatList.navigation', stage: 'manual refresh', atMs: 0 },
    { run: 'a', cycle: 2, screen: 'ChatList', stage: 'start', atMs: 5 },
    { run: 'a', cycle: 2, screen: 'ChatList', stage: 'usable UI candidate', atMs: 50, ready: true },
    { run: 'a', cycle: 2, screen: 'ChatList', stage: 'state ready', atMs: 300 },
    { run: 'a', cycle: 2, screen: 'ChatList', stage: 'usable UI candidate', atMs: 350, ready: true },
  ]
  expect(summarize(events).navigations[0].usableCandidateMs).toBe(350)
})
