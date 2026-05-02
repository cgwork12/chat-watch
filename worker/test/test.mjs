// Unit tests for the worker's transition logic + SSR HTML extractor + buildText.
import { decideTransition, extractRoomFromHtml, buildText, attemptAttribution, renderUuidWithIcon, colorName, inferAllowedMentions, jstDateString } from '../src/index.js';

const board = (id, title, n, limit) => ({
  _id: id, title, callUserIds: Array(n).fill('x'), callLimit: limit,
});
const prev = (n, limit, title = 't') => ({ callNum: n, callLimit: limit, title });

const cases = [
  ['no prev (first sight)', null, board('a','t',1,5), null],
  ['started 0->1', prev(0,5), board('a','t',1,5), 'started'],
  ['becameFull 4->5', prev(4,5), board('a','t',5,5), 'becameFull'],
  ['becameFull 0->5 (beats started)', prev(0,5), board('a','t',5,5), 'becameFull'],
  ['opened 5->4', prev(5,5), board('a','t',4,5), 'opened'],
  ['ended 1->0', prev(1,5), board('a','t',0,5), 'ended'],
  ['ended 5->0 (beats opened)', prev(5,5), board('a','t',0,5), 'ended'],
  ['no-op 1->2', prev(1,5), board('a','t',2,5), null],
  ['no-op 0->0', prev(0,5), board('a','t',0,5), null],
  ['no-op 5->5', prev(5,5), board('a','t',5,5), null],
  // user's exact scenario
  ['user scenario: 5/5 -> 3/5 should fire opened', prev(5,5), board('a','ながら雑談',3,5), 'opened'],
];

let pass = 0, fail = 0;
for (const [label, p, b, expected] of cases) {
  const d = decideTransition(p, b);
  const got = d ? d.kind : null;
  const ok = got === expected;
  console.log(`${ok ? '✅' : '❌'} ${label}: expected=${expected}, got=${got}`);
  if (ok) pass++; else fail++;
}
// ---------- extractRoomFromHtml ----------

function fakeBoardJson(id, title, n, limit) {
  // Build an escaped JSON string the way Next.js __next_f.push embeds it.
  const uuids = Array.from({ length: n }, (_, i) =>
    `${'0'.repeat(8)}-aaaa-bbbb-cccc-${String(i).padStart(12, '0')}`,
  );
  const inner =
    `\\"_id\\":\\"${id}\\",\\"title\\":\\"${title}\\",\\"category\\":\\"call\\",` +
    `\\"callUserIds\\":[${uuids.map((u) => `\\"${u}\\"`).join(',')}],` +
    `\\"callLimit\\":${limit}`;
  return inner;
}

const id = '699244bce7401621a87adf10';
const otherId = 'aaaaaaaaaaaaaaaaaaaaaaaa';

const htmlCases = [
  ['extract single room',
    `<html>... ${fakeBoardJson(id, 'ながら雑談', 3, 5)} ...</html>`,
    { title: 'ながら雑談', n: 3, limit: 5 }],

  ['target id not present -> null',
    `<html>... ${fakeBoardJson(otherId, 'other', 2, 5)} ...</html>`,
    null],

  ['empty callUserIds',
    `<html>... ${fakeBoardJson(id, 'empty', 0, 5)} ...</html>`,
    { title: 'empty', n: 0, limit: 5 }],

  ['title with newline (escaped)',
    `<html>... ${fakeBoardJson(id, 'line1\\nline2', 1, 3)} ...</html>`,
    { title: 'line1\nline2', n: 1, limit: 3 }],

  ['title with special chars',
    `<html>... ${fakeBoardJson(id, '#1 雑談 🍰', 5, 5)} ...</html>`,
    { title: '#1 雑談 🍰', n: 5, limit: 5 }],

  ['multiple boards, target id second',
    `<html>... ${fakeBoardJson(otherId, 'other', 1, 3)} ... more text ... ${fakeBoardJson(id, 'target', 2, 4)} ...</html>`,
    { title: 'target', n: 2, limit: 4 }],
];

for (const [label, html, expected] of htmlCases) {
  const r = extractRoomFromHtml(html, id);
  let ok;
  if (expected === null) {
    ok = r === null;
  } else {
    ok = r && r.title === expected.title && r.callUserIds.length === expected.n && r.callLimit === expected.limit;
  }
  console.log(`${ok ? '✅' : '❌'} ${label}: expected=${JSON.stringify(expected)}, got=${r ? JSON.stringify({ title: r.title, n: r.callUserIds.length, limit: r.callLimit }) : null}`);
  if (ok) pass++; else fail++;
}

// ---------- buildText (unified notification builder) ----------

function makeBoard(uuids, limit, title = 't') {
  return { _id: 'roomid', title, callUserIds: uuids, callLimit: limit };
}
function makePrev(uuids, limit, title = 't') {
  return { callUserIds: uuids, callNum: uuids.length, callLimit: limit, title };
}
const u = (n) => `${'a'.repeat(8)}-bbbb-cccc-dddd-${String(n).padStart(12, '0')}`;
const v = (c, n) => `${c.repeat(8)}-bbbb-cccc-dddd-${String(n).padStart(12, '0')}`;

const textCases = [
  ['no change -> null',
    () => buildText(makeBoard([u(1), u(2)], 5), null, makePrev([u(1), u(2)], 5)),
    null],

  ['started uses 🟢 wording with full UUIDs',
    () => buildText(makeBoard([u(1)], 5),
      { kind: 'started', prevNum: 0, curNum: 1, limit: 5 },
      makePrev([], 5)),
    [/🟢.*が始まりました/, new RegExp(`\\+ 入室: ${u(1)}`), /👥 全員:/]],

  ['becameFull uses 🔴 wording',
    () => buildText(makeBoard([u(1), u(2), u(3), u(4), u(5)], 5),
      { kind: 'becameFull', prevNum: 4, curNum: 5, limit: 5 },
      makePrev([u(1), u(2), u(3), u(4)], 5)),
    [/🔴.*が満室になりました/, new RegExp(`\\+ 入室: ${u(5)}`), /4\/5 → 満室\(5\/5\)/]],

  ['opened uses 🟡 wording with leavers',
    () => buildText(makeBoard([u(1), u(2), u(3)], 5),
      { kind: 'opened', prevNum: 5, curNum: 3, limit: 5 },
      makePrev([u(1), u(2), u(3), u(4), u(5)], 5)),
    [/🟡.*に空きが出ました/, new RegExp(`- 退室: ${u(4)}`), new RegExp(`- 退室: ${u(5)}`)]],

  ['ended uses ⚫ wording with full UUIDs of leavers',
    () => buildText(makeBoard([], 5),
      { kind: 'ended', prevNum: 2, curNum: 0, limit: 5 },
      makePrev([u(1), u(2)], 5)),
    [/⚫.*の通話が終了しました/, new RegExp(`- 退室: ${u(1)}`), /2\/5 → 0\/5/]],

  ['middle change (1 -> 2) uses 🔵 generic header',
    () => buildText(makeBoard([u(1), u(2)], 5), null, makePrev([u(1)], 5)),
    [/🔵.*1\/5 → 2\/5/, new RegExp(`\\+ 入室: ${u(2)}`)]],

  ['middle leave (3 -> 2) uses 🔵',
    () => buildText(makeBoard([u(1), u(2)], 5), null, makePrev([u(1), u(2), u(3)], 5)),
    [/🔵.*3\/5 → 2\/5/, new RegExp(`- 退室: ${u(3)}`)]],

  ['simultaneous swap (count unchanged) still notifies',
    () => buildText(makeBoard([v('a', 1), v('c', 2)], 5), null, makePrev([v('a', 1), v('b', 2)], 5)),
    [/🔵.*2\/5 → 2\/5/, new RegExp(`\\+ 入室: ${v('c', 2)}`), new RegExp(`- 退室: ${v('b', 2)}`)]],
];

for (const [label, gen, expected] of textCases) {
  const text = gen();
  let ok;
  if (expected === null) {
    ok = text === null;
  } else {
    ok = typeof text === 'string' && expected.every((re) => re.test(text));
  }
  console.log(`${ok ? '✅' : '❌'} ${label}`);
  if (!ok) {
    console.log('   --- output ---');
    console.log('   ' + (typeof text === 'string' ? text.replace(/\n/g, '\n   ') : String(text)));
  }
  if (ok) pass++; else fail++;
}

// ---------- attemptAttribution ----------

const mkMsg = (num, color, char, isHost = false) => ({
  num, create: '2026-05-01T00:00:00Z',
  userIcon: { color, char, isHost },
});

const attribCases = [
  ['1 join + 1 fresh icon -> mapped',
    { lastMessageNum: 100, uuidToIcon: {} },
    [u(1)],
    [mkMsg(100, '#0fb9b1', '渡辺'), mkMsg(101, '#0fb9b1', '渡辺')],   // last seen num 100, msg 101 is new
    (r) => r.mapping[u(1)]?.char === '渡辺' && r.mapping[u(1)]?.color === '#0fb9b1'],

  ['1 join but no new chat -> not mapped',
    { lastMessageNum: 100, uuidToIcon: {} },
    [u(1)],
    [mkMsg(100, '#0fb9b1', '渡辺')],   // nothing newer than 100
    (r) => !r.mapping[u(1)]],

  ['2 joiners + 1 new icon -> ambiguous, not mapped',
    { lastMessageNum: 100, uuidToIcon: {} },
    [u(1), u(2)],
    [mkMsg(101, '#2d98da', '鈴木')],
    (r) => !r.mapping[u(1)] && !r.mapping[u(2)]],

  ['existing icon already mapped -> next joiner not falsely linked',
    { lastMessageNum: 100, uuidToIcon: { [u(0)]: { color: '#0fb9b1', char: '渡辺', isHost: false } } },
    [u(1)],
    [mkMsg(101, '#0fb9b1', '渡辺')],   // only icon is the already-mapped one; no candidate left
    (r) => !r.mapping[u(1)]],

  ['lastMessageNum is updated to max',
    { lastMessageNum: 100, uuidToIcon: {} },
    [],
    [mkMsg(105, '#0fb9b1', 'A'), mkMsg(110, '#fc5c65', 'B')],
    (r) => r.lastMessageNum === 110],
];

for (const [label, prev, joined, msgs, check] of attribCases) {
  const r = attemptAttribution(prev, joined, msgs);
  const ok = check(r);
  console.log(`${ok ? '✅' : '❌'} attrib: ${label}`);
  if (!ok) console.log('   ', JSON.stringify(r, null, 2).slice(0, 400));
  if (ok) pass++; else fail++;
}

// ---------- renderUuidWithIcon / colorName ----------
{
  const m = { [u(1)]: { color: '#0fb9b1', char: '渡辺', isHost: false }, [u(2)]: { color: '#d1d8e0', char: '主', isHost: true } };
  const r1 = renderUuidWithIcon(u(1), m);
  const r2 = renderUuidWithIcon(u(2), m);
  const r3 = renderUuidWithIcon(u(99), m);  // no mapping
  const ok1 = r1.includes(u(1)) && r1.includes('ティール') && r1.includes('渡辺');
  const ok2 = r2.includes(u(2)) && r2.includes('グレー') && r2.includes('主') && r2.includes('👑');
  const ok3 = r3 === u(99);
  console.log(`${ok1 ? '✅' : '❌'} render: mapped renders "色 名前"  ->  ${r1}`);
  console.log(`${ok2 ? '✅' : '❌'} render: host adds 👑           ->  ${r2}`);
  console.log(`${ok3 ? '✅' : '❌'} render: unmapped returns raw uuid  ->  ${r3}`);
  if (ok1) pass++; else fail++;
  if (ok2) pass++; else fail++;
  if (ok3) pass++; else fail++;
}

// buildText with mapping
{
  const m = { [u(1)]: { color: '#0fb9b1', char: '渡辺', isHost: false } };
  const t = buildText(makeBoard([u(1)], 5),
    { kind: 'started', prevNum: 0, curNum: 1, limit: 5 },
    makePrev([], 5),
    m);
  const ok = /\+ 入室:.*ティール 渡辺/.test(t);
  console.log(`${ok ? '✅' : '❌'} buildText with mapping renders icon next to UUID`);
  if (!ok) { console.log('   ', t.replace(/\n/g, '\n    ')); }
  if (ok) pass++; else fail++;
}

// dayCount rendering ("(N回目)" = N distinct days seen)
{
  const m = { [u(1)]: { color: '#0fb9b1', char: '渡辺', isHost: false } };
  const t = buildText(makeBoard([u(1)], 5),
    { kind: 'started', prevNum: 0, curNum: 1, limit: 5 },
    makePrev([], 5),
    m,
    { [u(1)]: 3 });
  const ok = /\+ 入室:.*\(3回目\)/.test(t);
  console.log(`${ok ? '✅' : '❌'} buildText: 入室 shows "(N回目)"`);
  if (!ok) console.log('   ', t.replace(/\n/g, '\n    '));
  if (ok) pass++; else fail++;
}

{
  // 退室 should NOT show count
  const t = buildText(makeBoard([], 5),
    { kind: 'ended', prevNum: 1, curNum: 0, limit: 5 },
    makePrev([u(1)], 5),
    {}, { [u(1)]: 5 });
  const ok = !/\(5回目\)/.test(t) && /- 退室:/.test(t);
  console.log(`${ok ? '✅' : '❌'} buildText: 退室 has no (N回目)`);
  if (!ok) console.log('   ', t.replace(/\n/g, '\n    '));
  if (ok) pass++; else fail++;
}

{
  // joinCount=0 (or absent) → no suffix
  const t = buildText(makeBoard([u(1), u(2)], 5),
    null,
    makePrev([u(1)], 5),
    {}, { [u(1)]: 1 });
  // u(2) joined this tick, has no joinCount entry yet → no suffix
  const lines = t.split('\n');
  const joinLine = lines.find((l) => l.startsWith('+ 入室:'));
  const ok = joinLine && !/\(\d+回目\)/.test(joinLine);
  console.log(`${ok ? '✅' : '❌'} buildText: 入室 with joinCount=0 omits suffix`);
  if (!ok) console.log('   joinLine=', joinLine);
  if (ok) pass++; else fail++;
}

// ---------- inferAllowedMentions ----------
{
  const a1 = inferAllowedMentions('@everyone');
  const a2 = inferAllowedMentions('@here');
  const a3 = inferAllowedMentions('<@123456789012345>');
  const a4 = inferAllowedMentions('<@!123456789012345>');
  const a5 = inferAllowedMentions('<@&987654321>');
  const a6 = inferAllowedMentions('plain text');
  const a7 = inferAllowedMentions('');
  const ok1 = a1?.parse?.includes('everyone');
  const ok2 = a2?.parse?.includes('everyone');
  const ok3 = JSON.stringify(a3) === JSON.stringify({ users: ['123456789012345'] });
  const ok4 = JSON.stringify(a4) === JSON.stringify({ users: ['123456789012345'] });
  const ok5 = JSON.stringify(a5) === JSON.stringify({ roles: ['987654321'] });
  const ok6 = a6 === null;
  const ok7 = a7 === null;
  for (const [label, ok] of [['@everyone', ok1], ['@here', ok2], ['user mention', ok3], ['user! mention', ok4], ['role mention', ok5], ['plain text', ok6], ['empty', ok7]]) {
    console.log(`${ok ? '✅' : '❌'} mention: ${label}`);
    if (ok) pass++; else fail++;
  }
}

// ---------- jstDateString ----------
{
  // Around UTC midnight, JST should already be 9 AM next day
  const utcMidnight = new Date('2026-05-02T00:00:00Z');
  const jstDate = jstDateString(utcMidnight);
  const ok1 = jstDate === '2026-05-02';
  console.log(`${ok1 ? '✅' : '❌'} jstDateString: 00:00 UTC -> 09:00 JST same day -> ${jstDate}`);
  if (ok1) pass++; else fail++;

  // 15:00 UTC = 00:00 JST next day -> date should be next day
  const utcAfternoon = new Date('2026-05-01T15:00:00Z');
  const jstDate2 = jstDateString(utcAfternoon);
  const ok2 = jstDate2 === '2026-05-02';
  console.log(`${ok2 ? '✅' : '❌'} jstDateString: 15:00 UTC -> 00:00 JST next day -> ${jstDate2}`);
  if (ok2) pass++; else fail++;
}

console.log(`\n${pass}/${pass+fail} passed`);
process.exit(fail === 0 ? 0 : 1);
