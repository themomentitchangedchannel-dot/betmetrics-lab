import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateGoalHistory, summarizeGoalHistory, calibrateGoalHistory } from './backtest-goals.mjs';

const league='Premier League · API';
const prior=Array.from({length:60},(_,i)=>({
  id:i+1,utcDate:`2026-08-${String(1+i%30).padStart(2,'0')}T18:00:00Z`,status:'FINISHED',
  homeTeam:{name:i%2?'Alpha':'Beta'},awayTeam:{name:i%2?'Beta':'Alpha'},
  score:{fullTime:{home:i%3,away:i%2}}
}));
const target={id:999,utcDate:'2026-10-10T18:00:00Z',status:'FINISHED',homeTeam:{name:'Alpha'},awayTeam:{name:'Beta'},score:{fullTime:{home:2,away:1}}};
const header='Date,HomeTeam,AwayTeam,FTHG,FTAG,B365C>2.5,B365C<2.5\n';

test('models past games only; pairs closing total quotes on the exact score and match',()=>{
  const result=evaluateGoalHistory([...prior,target],header+'10/10/2026,Alpha,Beta,2,1,4,4\n',league,2026);
  assert.equal(result.counts.completed,61);assert.ok(result.counts.eligible>0);
  assert.equal(result.counts.matched,1);assert.equal(result.counts.priced,1);assert.equal(result.counts.selected,1);
  const quoted=result.rows.find(r=>r.marketOver!==null);
  assert.equal(quoted.date,'2026-10-10');assert.ok(Number.isFinite(quoted.modelBtts));
  assert.equal(quoted.profit,quoted.pick==='Over'?3:-1);
  const report=summarizeGoalHistory([{season:2026,league,...result}],'2026-10-11T00:00:00Z');
  assert.equal(report.version,3);
  assert.equal(report.seasons[0].priced,1);assert.equal(report.seasons[0].selected,1);
  assert.ok(Number.isFinite(report.seasons[0].pairedMarketOver));
  const split=report.seasons[0].byLeague[0];
  assert.equal(split.n,result.rows.length);assert.equal(split.selected,1);
  assert.equal(split.profitUnits,quoted.profit);
  assert.equal(split.roi,quoted.profit);
  assert.ok(Number.isFinite(split.pairedMarketOver));
});

test('calibration fits only the earlier season and scores later quotes without refitting',()=>{
  const row=(actual)=>({modelProbOver:.8,baselineProbOver:.2,overActual:actual,
    modelOver:2*(.8-Number(actual))**2,marketOver:2*(.5-Number(actual))**2,odds25:[2,2]});
  const rows=[{season:2025,rows:Array.from({length:100},()=>row(false))},
    {season:2026,rows:Array.from({length:50},()=>row(true))}];
  const report=calibrateGoalHistory(rows);
  assert.equal(report.weight,1);
  assert.equal(report.trainingMatches,100);assert.equal(report.holdoutMatches,50);
  assert.ok(report.challengerBrier>report.incumbentBrier);
  assert.equal(report.selected,50);assert.equal(report.profitUnits,-50);
  assert.equal(calibrateGoalHistory(rows.filter(p=>p.season===2025)),null);
});

test('rejects discrepant results and missing closing prices',()=>{
  const mismatch=evaluateGoalHistory([...prior,target],header+'10/10/2026,Alpha,Beta,0,1,4,4\n',league,2026);
  assert.equal(mismatch.counts.scoreMismatch,1);assert.equal(mismatch.counts.priced,0);
  const missing=evaluateGoalHistory([...prior,target],header+'10/10/2026,Alpha,Beta,2,1,,4\n',league,2026);
  assert.equal(missing.counts.priced,0);
});
