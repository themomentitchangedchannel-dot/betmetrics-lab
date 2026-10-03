import test from 'node:test';
import assert from 'node:assert/strict';
import { evolveLedger, predict, predictChallenger, benchmarkModels, goalProbabilities } from './build-forecast-ledger.mjs';

test('goal markets come from the same independent Poisson rates', () => {
  const p=goalProbabilities(1.5,1.2);
  assert.ok(Math.abs(p.over25-(1-Math.exp(-2.7)*(1+2.7+2.7**2/2)))<1e-12);
  assert.ok(Math.abs(p.btts-(1-Math.exp(-1.5))*(1-Math.exp(-1.2)))<1e-12);
});

const league = 'Premier League · API';
const oldMatches = Array.from({ length: 60 }, (_, i) => ({
  id: i + 1, utcDate: `2026-08-${String(1 + i % 30).padStart(2, '0')}T18:00:00Z`, status: 'FINISHED',
  homeTeam: { name: i % 2 ? 'Alpha' : 'Beta' }, awayTeam: { name: i % 2 ? 'Beta' : 'Alpha' },
  score: { fullTime: { home: i % 3, away: i % 2 } },
}));
const fixture = { id: 999, utcDate: '2026-10-10T18:00:00Z', status: 'TIMED', homeTeam: { name: 'Alpha' }, awayTeam: { name: 'Beta' }, score: { fullTime: { home: null, away: null } } };
const empty = { version: 1, records: [] };

test('prediction contains normalized 1/X/2 probabilities and frozen baseline', () => {
  const games = oldMatches.map(m => ({ league, date: m.utcDate.slice(0, 10), home: m.homeTeam.name, away: m.awayTeam.name, hg: m.score.fullTime.home, ag: m.score.fullTime.away }));
  const result = predict(games, league, 'Alpha', 'Beta', '2026-10-10');
  assert.ok(result);
  assert.ok(Math.abs(result.probs.reduce((a, b) => a + b) - 1) < 1e-10);
  assert.ok(Math.abs(result.baseline.reduce((a, b) => a + b) - 1) < 1e-10);
  assert.equal(result.n, 60);
});

test('Bundesliga enters the same pre-match ledger using only its own older results', () => {
  const time='2026-09-30T08:00:00Z';
  const german=evolveLedger(empty,{BL1:[...oldMatches,fixture]},time);
  assert.equal(german.added,1);
  assert.equal(german.ledger.records[0].league,'Bundesliga · API');
  assert.equal(german.ledger.records[0].trainingMatches,60);
  assert.equal(evolveLedger(empty,{BL1:[fixture],PL:oldMatches},time).added,0);
});

test('creates once before kickoff and settles without changing original probabilities', () => {
  const time = '2026-09-30T08:00:00Z';
  const first = evolveLedger(empty, { PL: [...oldMatches, fixture], PD: [], SA: [] }, time);
  assert.equal(first.added, 1);
  assert.equal(first.ledger.records[0].predictedAt, time);
  assert.equal(first.ledger.records[0].goalsForecast.predictedAt, time);
  const frozen = first.ledger.records[0].probs;
  const again = evolveLedger(first.ledger, { PL: [...oldMatches, fixture], PD: [], SA: [] }, '2026-10-01T08:00:00Z');
  assert.equal(again.added, 0);
  assert.deepEqual(again.ledger.records[0].probs, frozen);
  assert.deepEqual(again.ledger.records[0].goalsForecast,first.ledger.records[0].goalsForecast);
  const played = { ...fixture, status: 'FINISHED', score: { fullTime: { home: 2, away: 1 } } };
  const finished = evolveLedger(again.ledger, { PL: [...oldMatches, played], PD: [], SA: [] }, '2026-10-11T08:00:00Z');
  assert.equal(finished.settled, 1);
  assert.equal(finished.ledger.records[0].result, 'H');
  assert.deepEqual(finished.ledger.records[0].resultGoals,{home:2,away:1});
  assert.deepEqual(finished.ledger.records[0].probs, frozen);
});

test('a moved fixture clears stale odds and cannot get a new quote under the old prediction', () => {
  const first=evolveLedger(empty,{PL:[...oldMatches,fixture]},'2026-09-30T08:00:00Z').ledger;
  const record=first.records[0];
  record.oddsSnapshot={quotedAt:'2026-10-01T08:00:00Z',odds:[2,3,4]};
  record.latestTotals25Snapshot={quotedAt:'2026-10-01T08:00:00Z',odds:[2,2]};
  const moved={...fixture,utcDate:'2026-10-11T18:00:00Z'};
  const next=evolveLedger(first,{PL:[...oldMatches,moved]},'2026-10-02T08:00:00Z').ledger.records[0];
  assert.equal(next.kickoffUtc,moved.utcDate);
  assert.equal(next.scheduleChangedAt,'2026-10-02T08:00:00Z');
  assert.equal(next.fixtureStatus,'TIMED');
  assert.equal(next.oddsSnapshot,undefined);
  assert.equal(next.latestTotals25Snapshot,undefined);
  assert.deepEqual(next.probs,record.probs);
  const finished=evolveLedger({version:1,records:[next]},{PL:[...oldMatches,{...moved,status:'FINISHED',score:{fullTime:{home:2,away:1}}}]},'2026-10-12T08:00:00Z').ledger.records[0];
  assert.equal(finished.result,'H');
  assert.equal(finished.scheduleChangedAt,next.scheduleChangedAt);
});

test('adds goal probabilities to existing upcoming fixtures but never after kickoff', () => {
  const old=evolveLedger(empty,{PL:[...oldMatches,fixture]},'2026-09-30T08:00:00Z').ledger;
  delete old.records[0].goalsForecast;
  const updated=evolveLedger(old,{PL:[...oldMatches,fixture]},'2026-10-01T08:00:00Z').ledger;
  assert.equal(updated.records[0].goalsForecast.predictedAt,'2026-10-01T08:00:00Z');
  const frozen=updated.records[0].goalsForecast;
  const later=evolveLedger(updated,{PL:[...oldMatches,fixture]},'2026-10-10T18:01:00Z').ledger;
  assert.deepEqual(later.records[0].goalsForecast,frozen);
});

test('does not create a prediction after a match has begun', () => {
  const outcome = evolveLedger(empty, { PL: [...oldMatches, fixture] }, '2026-10-10T18:01:00Z');
  assert.equal(outcome.added, 0);
});

test('challenger is frozen before kickoff, including for an existing incumbent forecast', () => {
  const older = evolveLedger(empty, { PL: [...oldMatches, fixture] }, '2026-09-30T08:00:00Z').ledger;
  delete older.records[0].challenger; // existing v1 records from before the challenger launch
  const updated = evolveLedger(older, { PL: [...oldMatches, fixture] }, '2026-10-01T08:00:00Z').ledger;
  const frozen = updated.records[0].challenger;
  assert.equal(frozen.model, 'recency-v2');
  assert.equal(frozen.predictedAt, '2026-10-01T08:00:00Z');
  assert.ok(Math.abs(frozen.probs.reduce((a, b) => a + b) - 1) < 1e-10);
  const afterKickoff = evolveLedger(updated, { PL: [...oldMatches, fixture] }, '2026-10-10T18:01:00Z').ledger;
  assert.deepEqual(afterKickoff.records[0].challenger, frozen);
  assert.equal(afterKickoff.records[0].predictedAt, '2026-09-30T08:00:00Z');
});

test('never backfills a challenger forecast after kickoff', () => {
  const old = evolveLedger(empty, { PL: [...oldMatches, fixture] }, '2026-09-30T08:00:00Z').ledger;
  delete old.records[0].challenger;
  const late = evolveLedger(old, { PL: [...oldMatches, fixture] }, '2026-10-10T18:01:00Z').ledger;
  assert.equal(late.records[0].challenger, undefined);
});

test('walk-forward benchmark compares both models on the same completed games', () => {
  const games = [...oldMatches, { ...fixture, status: 'FINISHED', score: { fullTime: { home: 2, away: 1 } } }];
  const result = benchmarkModels({ PL: games });
  assert.equal(result.version, 1);
  assert.ok(result.seasons.reduce((sum, row) => sum + row.n, 0) > 0);
  const row = result.seasons[0];
  assert.ok(Number.isFinite(row.incumbentSum) && Number.isFinite(row.challengerSum) && Number.isFinite(row.baselineSum));
  const hist = oldMatches.map(m => ({ league, date: m.utcDate.slice(0, 10), home: m.homeTeam.name, away: m.awayTeam.name, hg: m.score.fullTime.home, ag: m.score.fullTime.away }));
  assert.deepEqual(predictChallenger(hist, league, 'Alpha', 'Beta', '2026-10-10')?.probs.length, 3);
});
