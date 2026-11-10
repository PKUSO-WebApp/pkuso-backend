import {
  DEFAULT_FULL_BODY,
  DEFAULT_FULL_SUBJECT,
  expandTargetSections,
  filterRecipients,
  normalizeTargetSections,
  renderTemplate,
  type RecipientRow,
} from './handler.ts'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

Deno.test('normalizeTargetSections: array / fallback / dedupe', () => {
  assert(
    JSON.stringify(normalizeTargetSections(['长笛', ' 长笛 ', '木管'])) ===
      JSON.stringify(['长笛', '木管']),
    'array normalize',
  )
  assert(
    JSON.stringify(normalizeTargetSections(undefined, '长笛，双簧管、长笛')) ===
      JSON.stringify(['长笛', '双簧管']),
    'fallback split',
  )
  assert(normalizeTargetSections(null).length === 0, 'empty')
})

Deno.test('expandTargetSections: group expands, instrument stays', () => {
  const expanded = expandTargetSections(['木管', '长笛'], [
    { group_name: '木管', member_name: '长笛' },
    { group_name: '木管', member_name: '双簧管' },
    { group_name: '弦乐', member_name: '中提琴' },
  ])
  assert(expanded.includes('木管'), 'group retained')
  assert(expanded.includes('长笛'), 'instrument retained')
  assert(expanded.includes('双簧管'), 'group member expanded')
  assert(!expanded.includes('中提琴'), 'unrelated group not expanded')
})

Deno.test('filterRecipients: synthetic / out-of-orchestra / section', () => {
  const rows: RecipientRow[] = [
    { email: 'a@example.com', is_in_orchestra: true, instrument: '长笛' },
    { email: 'b@example.com', is_in_orchestra: true, instrument: '双簧管' },
    { email: 'c@example.com', is_in_orchestra: false, instrument: '长笛' },
    { email: 'wechat_x@placeholder.local', is_in_orchestra: true, instrument: '长笛' },
    { email: null, is_in_orchestra: true, instrument: '长笛' },
  ]
  assert(JSON.stringify(filterRecipients(rows, 'full', [])) === JSON.stringify([
    'a@example.com',
    'b@example.com',
  ]), 'full filters')
  assert(JSON.stringify(filterRecipients(rows, 'section', ['长笛'])) === JSON.stringify([
    'a@example.com',
  ]), 'section filters')
})

Deno.test('renderTemplate: replacements are escaped', () => {
  const html = renderTemplate(DEFAULT_FULL_BODY, {
    title: '<b>曲目</b>',
    dateStr: '2026-11-10 19:00',
    location: 'A&B',
    signature: 'PKUSO',
    targetSection: '',
  })
  assert(html.includes('&lt;b&gt;曲目&lt;/b&gt;'), 'title escaped')
  assert(html.includes('A&amp;B'), 'location escaped')
  assert(html.includes('2026-11-10 19:00'), 'date retained')
  assert(DEFAULT_FULL_SUBJECT.includes('{title}'), 'default subject')
})

Deno.test('handler: method guard without touching auth', async () => {
  const { handler } = await import('./handler.ts')
  const res = await handler(new Request('http://localhost/notify-rehearsal', { method: 'GET' }))
  assert(res.status === 405, 'GET rejected')
  const options = await handler(
    new Request('http://localhost/notify-rehearsal', { method: 'OPTIONS' }),
  )
  assert(options.status === 204, 'OPTIONS handled')
})
