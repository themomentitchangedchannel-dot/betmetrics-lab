import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { opportunity, evolveDailyCandidates, dailySummary, auditDailyCandidates } from './daily-candidates.mjs';

const now = '2026-10-08T12:00:00Z';
const fixture = (id, kickoffUtc = '2026-10-10T12:00:00Z') => ({
  id, league: 'Premier League · API', home: 'Home ' + id, away: 'Away ' + id,
  kickoffUtc, result: null, resultGoals: null,
  predictedAt: '2026-10-07T10:00:00Z', probs: [.35,.35,.30],
  oddsSnapshot: { bookmaker: 'betsson', quotedAt: '2026-10-08T11:00:00Z', odds: [3.2,3.2,3.5], pick: 'H' },
  goalsForecast: { predictedAt: '2026-10-07T10:00:00Z', probs: { over25: .6 } },
  totals25Snapshot: { bookmaker: 'betsson', quotedAt: '2026-10-08T11:00:00Z', odds: [2,1.8], pick: 'Over' }
});

test('only eligible pre-match, fresh and near-term quotes enter the shortlist', () => {
  assert.ok(opportunity(fixture(1), 'h2h', now));
  assert.equal(opportunity(fixture(1, '2026-10-15T12:00:00Z'), 'h2h', now), null);
  assert.equal(opportunity({...fixture(1), oddsSnapshot:{...fixture(1).oddsSnapshot,quotedAt:'2026-10-06T11:00:00Z'}}, 'h2h', now), null);
  assert.equal(opportunity({...fixture(1), predictedAt:'2026-10-08T11:30:00Z'}, 'h2h', now), null);
  assert.equal(opportunity({...fixture(1), result:'H'}, 'h2h', now), null);
});

test('lock at most one market per match and five matches per local day', () => {
  const forecasts = {version:1,records:Array.from({length:7},(_,i)=>fixture(i+1))};
  const initial={version:1,records:[]};
  const first=evolveDailyCandidates(initial,forecasts,now);
  assert.equal(first.added,5);
  assert.equal(new Set(first.ledger.records.map(r=>r.id)).size,5);
  assert.ok(first.ledger.records.every(r=>r.market==='goals'));
  const changed={version:1,records:forecasts.records.map(r=>({
    ...r, latestOddsSnapshot:{bookmaker:'betsson',quotedAt:'2026-10-09T10:00:00Z',odds:[4.9,3.2,3.5],pick:'H'}
  }))};
  const second=evolveDailyCandidates(first.ledger,changed,'2026-10-09T12:00:00Z');
  assert.equal(second.added,0);
  assert.deepEqual(second.ledger.records.map(r=>r.odds),first.ledger.records.map(r=>r.odds));
  assert.deepEqual(second.ledger.records.map(r=>r.market),first.ledger.records.map(r=>r.market));
});

test('settles the original paper selection after the result arrives', () => {
  const first=evolveDailyCandidates({version:1,records:[]},{version:1,records:[fixture(1)]},now);
  const finished={...fixture(1),result:'A',resultGoals:{home:3,away:1}};
  const second=evolveDailyCandidates(first.ledger,{version:1,records:[finished]},'2026-10-11T10:00:00Z');
  assert.equal(second.added,0);
  assert.equal(second.ledger.records[0].result,'Over');
  assert.equal(second.ledger.records[0].selectedAt,now);
  assert.deepEqual(dailySummary(second.ledger),{selected:1,settled:1,wins:1,profitUnits:1,roi:1});
});

test('public audit keeps the two markets separate and waits for enough settled picks', () => {
  const row = (id, market, result) => ({id,market,pick:market==='h2h'?'H':'Over',result,odds:2,
    predictedAt:'2026-10-07T10:00:00Z',quotedAt:'2026-10-08T11:00:00Z',
    selectedAt:now,kickoffUtc:'2026-10-10T12:00:00Z'});
  const records=[...Array.from({length:100},(_,i)=>row(i,'h2h','H')),
    ...Array.from({length:100},(_,i)=>row(100+i,'goals','Under')),
    row(201,'goals',null),{...row(202,'h2h','H'),selectedAt:'2026-10-11T12:00:00Z'}];
  const report=auditDailyCandidates({version:1,records},'2026-10-12T12:00:00Z');
  assert.equal(report.overall.settled,200);
  assert.equal(report.overall.open,1);
  assert.equal(report.byMarket.h2h.status,'review');
  assert.deepEqual(report.byMarket.h2h.interval95,[1,1]);
  assert.equal(report.byMarket.goals.status,'negative');
  assert.equal(report.byMarket.goals.profitUnits,-100);
  const early=auditDailyCandidates({version:1,records:records.slice(0,29)},now);
  assert.equal(early.overall.status,'collecting');
  assert.equal(early.overall.interval95,null);
});
