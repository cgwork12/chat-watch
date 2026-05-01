// Unit tests for the worker's transition logic + SSR HTML extractor + buildText.
import { decideTransition, extractRoomFromHtml, buildText, buildCaptureText } from '../src/index.js';

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

// ---------- buildText (notification body w/ UUID details) ----------

function makeBoard(uuids, limit, title = 't') {
  return { _id: 'roomid', title, callUserIds: uuids, callLimit: limit };
}
function makePrev(uuids, limit, title = 't') {
  return { callUserIds: uuids, callNum: uuids.length, callLimit: limit, title };
}

const textCases = [
  ['started includes current uuids',
    () => buildText(makeBoard(['aaaaaaaa-bbbb', 'cccccccc-dddd'], 5), { kind: 'started', prevNum: 0, curNum: 2, limit: 5 }, makePrev([], 5)),
    /🟢/, /0 → 2\/5/, /👤 aaaaaaaa, cccccccc/],

  ['becameFull shows joined and full list',
    () => buildText(makeBoard(['aaaaaaaa', 'bbbbbbbb', 'cccccccc', 'dddddddd', 'eeeeeeee'], 5),
      { kind: 'becameFull', prevNum: 4, curNum: 5, limit: 5 },
      makePrev(['aaaaaaaa', 'bbbbbbbb', 'cccccccc', 'dddddddd'], 5)),
    /🔴/, /\+ 入室: eeeeeeee/, /👥 全員: aaaaaaaa, bbbbbbbb, cccccccc, dddddddd, eeeeeeee/],

  ['opened shows who left and remaining',
    () => buildText(makeBoard(['aaaaaaaa', 'bbbbbbbb', 'cccccccc'], 5),
      { kind: 'opened', prevNum: 5, curNum: 3, limit: 5 },
      makePrev(['aaaaaaaa', 'bbbbbbbb', 'cccccccc', 'dddddddd', 'eeeeeeee'], 5)),
    /🟡/, /- 退室: dddddddd, eeeeeeee/, /👥 残り: aaaaaaaa, bbbbbbbb, cccccccc/],

  ['ended shows who left',
    () => buildText(makeBoard([], 5),
      { kind: 'ended', prevNum: 2, curNum: 0, limit: 5 },
      makePrev(['aaaaaaaa', 'bbbbbbbb'], 5)),
    /⚫/, /2\/5 → 0\/5/, /退室: aaaaaaaa, bbbbbbbb/],
];

for (const [label, gen, ...patterns] of textCases) {
  const text = gen();
  const ok = patterns.every((p) => p.test(text));
  console.log(`${ok ? '✅' : '❌'} ${label}`);
  if (!ok) {
    console.log('   --- output ---');
    console.log('   ' + text.replace(/\n/g, '\n   '));
    for (const p of patterns) if (!p.test(text)) console.log('   missing pattern:', p);
  }
  if (ok) pass++; else fail++;
}

// ---------- buildCaptureText ----------

const captureCases = [
  ['no change -> null',
    () => buildCaptureText(makeBoard(['aaaaaaaa-bbbb', 'cccccccc-dddd'], 5), makePrev(['aaaaaaaa-bbbb', 'cccccccc-dddd'], 5)),
    null],

  ['join only',
    () => buildCaptureText(makeBoard(['aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', 'ffffffff-1111-2222-3333-444444444444'], 5),
      makePrev(['aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'], 5)),
    [/🔍 \[UID捕獲モード\]/, /1\/5 → 2\/5/, /\+ 入室: ffffffff-1111-2222-3333-444444444444/, /👥 全員:/]],

  ['leave only',
    () => buildCaptureText(makeBoard(['aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'], 5),
      makePrev(['aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', 'ffffffff-1111-2222-3333-444444444444'], 5)),
    [/2\/5 → 1\/5/, /- 退室: ffffffff-1111-2222-3333-444444444444/, /👥 全員:/]],

  ['simultaneous swap',
    () => buildCaptureText(makeBoard(['aaaaaaaa-1111-2222-3333-444444444444', 'cccccccc-1111-2222-3333-444444444444'], 5),
      makePrev(['aaaaaaaa-1111-2222-3333-444444444444', 'bbbbbbbb-1111-2222-3333-444444444444'], 5)),
    [/2\/5 → 2\/5/, /\+ 入室: cccccccc-1111-2222-3333-444444444444/, /- 退室: bbbbbbbb-1111-2222-3333-444444444444/]],

  ['all leave (room empties)',
    () => buildCaptureText(makeBoard([], 5),
      makePrev(['aaaaaaaa-1111-2222-3333-444444444444', 'bbbbbbbb-1111-2222-3333-444444444444'], 5)),
    [/2\/5 → 0\/5/, /- 退室: aaaaaaaa-1111-2222-3333-444444444444/, /- 退室: bbbbbbbb-1111-2222-3333-444444444444/]],
];

for (const [label, gen, expected] of captureCases) {
  const text = gen();
  let ok;
  if (expected === null) {
    ok = text === null;
  } else {
    ok = typeof text === 'string' && expected.every((re) => re.test(text));
  }
  console.log(`${ok ? '✅' : '❌'} capture: ${label}`);
  if (!ok) {
    console.log('   --- output ---');
    console.log('   ' + (typeof text === 'string' ? text.replace(/\n/g, '\n   ') : String(text)));
  }
  if (ok) pass++; else fail++;
}

console.log(`\n${pass}/${pass+fail} passed`);
process.exit(fail === 0 ? 0 : 1);
