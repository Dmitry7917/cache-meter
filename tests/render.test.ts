import { expect, test } from 'claude-code/testing'

const scroll = { offset: 0, bodyRows: 40 }
const tokens = { input: 1_000, read: 100_000, write: 10_000, output: 2_000 }
const NOW = Date.parse('2026-10-14T09:00:00Z')

/** What the plugin's state reads answer in this test, by key. */
const seeded: Record<string, unknown> = {
  context: { tokens: 250_000, window: 1_000_000, percent: 25 },
  last: { at: NOW - 10 * 60_000, hitPercent: 97, model: 'opus' },
  now: NOW,
  rateLimits: [
    { kind: 'five_hour', percentUsed: 23, resetsAt: '2026-10-14T11:30:00Z' },
    { kind: 'seven_day', percentUsed: 81 },
  ],
  agentLog: [
    { id: 'a1', type: 'Explore', description: 'find handleRequest callers', isRunning: true, startedAt: NOW, tokens: 340_000 },
    { id: 'a2', type: 'Plan', description: 'draft the migration', isRunning: false, startedAt: NOW - 60_000, tokens: 160_000 },
  ],
  turns: [
    { at: 0, requests: 3, tokens, agentRuns: 1, agentTokens: 340_000, contextTokens: 120_000 },
    { at: 60_000, requests: 1, tokens, agentRuns: 0, agentTokens: 0, contextTokens: 160_000 },
  ],
  losses: [{ at: 0, hitPercent: 2, written: 150_000, reason: 'смена модели: a → b' }],
  agentTotals: { runs: 1, tokens: 340_000 },
  tzOffsetMinutes: 180,
  bigResults: [{ at: 0, label: 'Read UserController.php', tokens: 22_000 }],
  fileReads: { '/a/UserController.php': { reads: 3, tokens: 60_000 } },
  toolUsage: { Read: { calls: 12, tokens: 84_000 }, 'MCP phpstorm': { calls: 3, tokens: 9_000 } },
}

test('the band and the pane draw on terminal and desktop', async ($, on) => {
  on('state.get', ($, e, next) =>
    e.plugin === 'cache-meter' && e.key in seeded ? { value: { value: seeded[e.key], version: 1 } } : next(e),
  )

  for (const surface of ['terminal', 'desktop'] as const) {
    const band = await $.ui.mount({
      plugin: 'cache-meter',
      surface,
      component: 'AbovePrompt',
      props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 160, scroll, view: {} },
    })
    // JSX keys do not reach the drawn tree: elements are found by what they show.
    expect((await band.find({ type: 'Text', text: /^█/ }))?.props.color).toBe('#e5c000')
    expect((await band.find({ type: 'Text', text: /^50:00$/ }))?.props.color).toBe('#4caf50')
    expect((await band.find({ type: 'Text', text: /^81%$/ }))?.props.color).toBe('#ff8c00')
    expect(await band.find({ type: 'Text', text: /^ до 14:30$/ })).toBeDefined()
    expect(await band.find({ type: 'Text', text: /1 \(340k\)/ })).toBeDefined()
    await band.unmount()

    const pane = await $.ui.mount({
      plugin: 'cache-meter',
      surface,
      component: 'Pane',
      requestId: 'cache-meter',
      props: { title: 'Cache meter', isFocused: true, bodyColumns: 120, placement: 'dock', scroll, view: {} },
    })
    expect(await pane.find({ type: 'Text', text: /Самые дорогие ответы/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /смена модели/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /Explore\s+find handleRequest callers\s+идёт\s+≈\s*340k/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /Plan\s+draft the migration\s+готов\s+≈\s*160k/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /^Read\s+≈\s*84k/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /22k  Read UserController\.php/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /^UserController\.php  3×  ≈60k/ })).toBeDefined()
    await pane.unmount()
  }
})

test('after a compaction the band marks the size as estimated and the cache as not yet written', async ($, on) => {
  const afterCompact: Record<string, unknown> = {
    context: { tokens: 42_000, window: 1_000_000, percent: 4, isEstimate: true },
    last: null,
    now: NOW,
  }
  on('state.get', ($, e, next) =>
    e.plugin === 'cache-meter' && e.key in afterCompact
      ? { value: { value: afterCompact[e.key], version: 1 } }
      : next(e),
  )

  for (const surface of ['terminal', 'desktop'] as const) {
    const band = await $.ui.mount({
      plugin: 'cache-meter',
      surface,
      component: 'AbovePrompt',
      props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 160, scroll, view: {} },
    })
    expect(await band.find({ type: 'Text', text: /≈42k\/1M \(4%\)/ })).toBeDefined()
    expect(await band.find({ type: 'Text', text: /после сжатия запишется с первым запросом/ })).toBeDefined()
    await band.unmount()
  }
})

test('the stats pane sums every session by day and period', async ($, on) => {
  const day = (answers: number, read: number) => ({
    answers,
    requests: answers * 2,
    main: { input: 1_000, read, write: 10_000, output: 2_000 },
    agents: { input: 0, read: 0, write: 0, output: 0 },
    service: { input: 0, read: 0, write: 0, output: 0 },
    losses: 1,
    lostWritten: 150_000,
    compactions: 0,
  })
  const stats: Record<string, unknown> = {
    now: NOW,
    tzOffsetMinutes: 180,
    ownDays: { '2026-10-14': day(3, 100_000) },
    otherDays: { '2026-10-14': day(2, 100_000), '2026-10-13': day(5, 400_000), '2026-09-01': day(9, 900_000) },
  }
  on('state.get', ($, e, next) =>
    e.plugin === 'cache-meter' && e.key in stats ? { value: { value: stats[e.key], version: 1 } } : next(e),
  )

  for (const surface of ['terminal', 'desktop'] as const) {
    const pane = await $.ui.mount({
      plugin: 'cache-meter',
      surface,
      component: 'Pane',
      requestId: 'cache-stats',
      props: { title: 'Cache stats', isFocused: true, bodyColumns: 160, placement: 'dock', scroll, view: {} },
    })
    expect(await pane.find({ type: 'Text', text: /^Сегодня\s+≈.* 5 ответов, 10 запр\. · hit 90%/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /^Вчера\s+≈.* 5 ответов/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /^7 дней\s+≈.* 10 ответов/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /^30 дней\s+≈.* 10 ответов/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /потери кэша 2 \(записано 300k\)/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /^ср 14\.10/ })).toBeDefined()
    await pane.unmount()
  }
})
