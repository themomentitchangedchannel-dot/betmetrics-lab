import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { analyzeProspective } from './prospective-report.mjs';

const forecast={league:'Premier League · API',predictedAt:'2026-09-01T09:00:00Z',kickoffUtc:'2026-09-02T15:00:00Z',probs:[.5,.3,.2],result:'H'};
const oddsSnapshot={bookmaker:'betsson',quotedAt:'2026-09-01T10:00:00Z',bookmakerUpdatedAt:'2026-09-01T09:59:00Z',odds:[2.2,3.2,4],pick:'H'};
test('compares frozen model and margin-adjusted market on the same concluded fixtures',()=>{
  const report=analyzeProspective({version:1,records:[{...forecast,oddsSnapshot}]},'2026-09-03T00:00:00Z').overall;
  const fair=[1/2.2,1/3.2,1/4].map(p=>p/(1/2.2+1/3.2+1/4));
  assert.equal(report.quoted,1);assert.equal(report.settledQuotes,1);assert.equal(report.settledPicks,1);
  assert.ok(Math.abs(report.profitUnits-1.2)<1e-9);
  assert.ok(Math.abs(report.brierModel-(.5**2+.3**2+.2**2))<1e-9);
  assert.ok(Math.abs(report.brierMarket-((fair[0]-1)**2+fair[1]**2+fair[2]**2))<1e-9);
});
test('unquoted and no-pick games count separately; invalid and late snapshots do not count',()=>{
  const records=[{...forecast,result:'D'},{...forecast,result:'D',oddsSnapshot:{...oddsSnapshot,pick:null}},
    {...forecast,oddsSnapshot:{...oddsSnapshot,quotedAt:'2026-09-02T15:01:00Z'}}];
  const r=analyzeProspective({version:1,records},'2026-09-03T00:00:00Z').overall;
  assert.equal(r.forecasts,3);assert.equal(r.quoted,1);assert.equal(r.settledQuotes,1);
  assert.equal(r.selected,0);assert.equal(r.settledPicks,0);assert.equal(r.roi,null);
});
