import test from 'node:test';
import assert from 'node:assert/strict';
import { csvRows, teamKey, evaluateOdds, summarizeOdds } from './backtest-odds.mjs';

test('CSV parser handles quoted team names and bookmaker columns', () => {
  const rows=csvRows('Date,HomeTeam,AwayTeam,FTR,B365CH,B365CD,B365CA\r\n"30/09/2026","Team, FC",Away,H,2.2,3,4\r\n');
  assert.equal(rows[0].HomeTeam,'Team, FC');
  assert.equal(rows[0].B365CH,'2.2');
  assert.equal(teamKey('Manchester City FC'),teamKey('Man City'));
  assert.equal(teamKey('Club Atlético de Madrid'),teamKey('Ath Madrid'));
});

test('historical quote is used only for a uniquely matched result and prior-match forecast', () => {
  const history=Array.from({length:60},(_,i)=>({id:i+1,utcDate:`2025-08-${String(1+i%30).padStart(2,'0')}T13:00:00Z`,status:'FINISHED',homeTeam:{name:i%2?'Arsenal FC':'Manchester City FC'},awayTeam:{name:i%2?'Manchester City FC':'Arsenal FC'},score:{fullTime:{home:i%3,away:i%2}}}));
  const match={id:99,utcDate:'2026-09-30T18:00:00Z',status:'FINISHED',homeTeam:{name:'Arsenal FC'},awayTeam:{name:'Manchester City FC'},score:{fullTime:{home:2,away:1}}};
  const csv='Date,HomeTeam,AwayTeam,FTR,B365CH,B365CD,B365CA\n30/09/2026,Arsenal,Man City,H,2.4,3.5,3.2\n';
  const outcome=evaluateOdds([...history,match],csv,'Premier League · API',2026);
  assert.equal(outcome.counts.completed,1);
  assert.equal(outcome.counts.matched,1);
  assert.equal(outcome.counts.eligible,1);
  assert.ok(Number.isFinite(outcome.rows[0].brierMarket));
  const mismatched=evaluateOdds([...history,match],csv.replace(',H,2.4',',A,2.4'),'Premier League · API',2026);
  assert.equal(mismatched.counts.resultMismatch,1);
  assert.equal(mismatched.rows.length,0);
  const report=summarizeOdds([{season:2026,league:'Premier League · API',...outcome}],'2026-09-30T20:00:00Z');
  assert.equal(report.seasons[0].n,1);
});
