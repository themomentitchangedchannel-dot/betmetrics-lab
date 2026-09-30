import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeGoals } from './goals-report.mjs';

const record={league:'Premier League · API',kickoffUtc:'2026-10-02T14:00:00Z',goalsForecast:{predictedAt:'2026-10-01T09:00:00Z',probs:{over25:.6,btts:.55}},resultGoals:{home:2,away:1},
  totals25Snapshot:{bookmaker:'betsson',point:2.5,quotedAt:'2026-10-01T10:00:00Z',odds:[2,1.9],pick:'Over'}};
test('scores each goal event from final score and settles frozen over 2.5 line',()=>{
  const s=summarizeGoals({version:1,records:[record]},'2026-10-03T00:00:00Z').overall;
  assert.equal(s.finished,1);assert.equal(s.quoted,1);assert.equal(s.selected,1);assert.equal(s.profitUnits,1);
  assert.ok(Math.abs(s.brierOver-2*.4**2)<1e-12);
  assert.ok(Math.abs(s.brierBtts-2*.45**2)<1e-12);
  assert.equal(s.paired,1);
});
test('no quote after kickoff, no settlement before final score, no retroactive forecast',()=>{
  const rows=[{...record,resultGoals:undefined},{...record,totals25Snapshot:{...record.totals25Snapshot,quotedAt:'2026-10-02T15:00:00Z'}},
    {...record,goalsForecast:{...record.goalsForecast,predictedAt:'2026-10-03T09:00:00Z'}}];
  const s=summarizeGoals({version:1,records:rows},'2026-10-03T00:00:00Z').overall;
  assert.equal(s.forecasts,2);assert.equal(s.quoted,1);assert.equal(s.finished,1);assert.equal(s.settled,0);
});
