// Unit tests for the worker's count-based transition logic + SSR HTML
// extractor + buildText. (The site removed the per-user `callUserIds` list in
// 2026-07, so everything is count-based on `callNum` now.)
import { decideTransition, extractRoomFromHtml, buildText, inferAllowedMentions, jstTimeString } from '../src/index.js';

// A "board" now only needs a count + limit.
const board = (id, title, n, limit) => ({ _id: id, title, callNum: n, callLimit: limit });
const prev = (n, limit, title = 't') => ({ callNum: n, callLimit: limit, title });

let pass = 0, fail = 0;

// ---------- decideTransition ----------
const cases = [
  ['no prev (first sight)', null, board('a', 't', 1, 5), null],
  ['started 0->1', prev(0, 5), board('a', 't', 1, 5), 'started'],
  ['becameFull 4->5', prev(4, 5), board('a', 't', 5, 5), 'becameFull'],
  ['becameFull 0->5 (beats started)', prev(0, 5), board('a', 't', 5, 5), 'becameFull'],
  ['opened 5->4', prev(5, 5), board('a', 't', 4, 5), 'opened'],
  ['ended 1->0', prev(1, 5), board('a', 't', 0, 5), 'ended'],
  ['ended 5->0 (beats opened)', prev(5, 5), board('a', 't', 0, 5), 'ended'],
  ['no-op 1->2 (mid-room churn)', prev(1, 5), board('a', 't', 2, 5), null],
  ['no-op 3->2 (mid-room churn)', prev(3, 5), board('a', 't', 2, 5), null],
  ['no-op 0->0', prev(0, 5), board('a', 't', 0, 5), null],
  ['no-op 5->5', prev(5, 5), board('a', 't', 5, 5), null],
  // user's exact scenario
  ['user scenario: 5/5 -> 3/5 should fire opened', prev(5, 5), board('a', 'ながら雑談', 3, 5), 'opened'],
];

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
  // Field order mirrors the real page: title, category, ..., callLimit, callNum.
  return (
    `\\"_id\\":\\"${id}\\",\\"title\\":\\"${title}\\",\\"category\\":\\"call\\",` +
    `\\"callLimit\\":${limit},\\"hasPassword\\":false,\\"messageLength\\":42,` +
    `\\"callNum\\":${n}`
  );
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

  ['empty room (callNum 0)',
    `<html>... ${fakeBoardJson(id, 'empty', 0, 5)} ...</html>`,
    { title: 'empty', n: 0, limit: 5 }],

  ['full room (callNum == limit)',
    `<html>... ${fakeBoardJson(id, 'full', 5, 5)} ...</html>`,
    { title: 'full', n: 5, limit: 5 }],

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
    ok = r && r.title === expected.title && r.callNum === expected.n && r.callLimit === expected.limit;
  }
  console.log(`${ok ? '✅' : '❌'} ${label}: expected=${JSON.stringify(expected)}, got=${r ? JSON.stringify({ title: r.title, n: r.callNum, limit: r.callLimit }) : null}`);
  if (ok) pass++; else fail++;
}

// ---------- buildText (count-based, 4 transitions only) ----------
const bd = (n, limit, title = 't', _id = 'roomid') => ({ _id, title, callNum: n, callLimit: limit });

const textCases = [
  ['no transition -> null',
    () => buildText(bd(2, 5), null),
    null],

  ['started uses 🟢 wording',
    () => buildText(bd(1, 5, 'ながら雑談'), { kind: 'started', prevNum: 0, curNum: 1, limit: 5 }),
    [/🟢.*「ながら雑談」が始まりました/, /0 → 1\/5/]],

  ['becameFull uses 🔴 wording',
    () => buildText(bd(5, 5), { kind: 'becameFull', prevNum: 4, curNum: 5, limit: 5 }),
    [/🔴.*が満室になりました/, /4\/5 → 満室\(5\/5\)/]],

  ['opened uses 🟡 wording',
    () => buildText(bd(3, 5), { kind: 'opened', prevNum: 5, curNum: 3, limit: 5 }),
    [/🟡.*に空きが出ました/, /満室\(5\/5\) → 3\/5/]],

  ['ended uses ⚫ wording',
    () => buildText(bd(0, 5), { kind: 'ended', prevNum: 2, curNum: 0, limit: 5 }),
    [/⚫.*の通話が終了しました/, /2\/5 → 0\/5/]],

  ['includes room URL',
    () => buildText(bd(1, 5, 't', 'abc123'), { kind: 'started', prevNum: 0, curNum: 1, limit: 5 }),
    [/https:\/\/randomchat\.pnyo\.jp\/groupcall\/abc123/]],

  ['does NOT contain per-user lines anymore',
    () => buildText(bd(1, 5), { kind: 'started', prevNum: 0, curNum: 1, limit: 5 }),
    [/^(?!.*入室)(?!.*全員)[\s\S]*$/]],
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

// ---------- buildText ends with 🕐 HH:MM:SS (JST) ----------
{
  const t = buildText(bd(1, 5), { kind: 'started', prevNum: 0, curNum: 1, limit: 5 },
    new Date('2026-05-13T06:32:15Z'));
  const ok = /🕐 15:32:15$/.test(t);
  console.log(`${ok ? '✅' : '❌'} buildText: ends with 🕐 HH:MM:SS in JST`);
  if (!ok) console.log('   ', t.replace(/\n/g, '\n    '));
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

// ---------- jstTimeString ----------
{
  // 06:32:15 UTC -> 15:32:15 JST
  const t = jstTimeString(new Date('2026-05-13T06:32:15Z'));
  const ok = t === '15:32:15';
  console.log(`${ok ? '✅' : '❌'} jstTimeString: 06:32:15 UTC -> ${t}`);
  if (ok) pass++; else fail++;
}

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail === 0 ? 0 : 1);
