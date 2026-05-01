// Unit tests for the worker's transition logic.
import { decideTransition } from '../src/index.js';

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
console.log(`\n${pass}/${pass+fail} passed`);
process.exit(fail === 0 ? 0 : 1);
