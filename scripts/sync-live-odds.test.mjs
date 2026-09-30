import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { eventFor, quote, attachSnapshots, summarize } from './sync-live-odds.mjs';

const now = '2026-10-01T10:00:00Z';
const record = { id: 1, league: 'Premier League · API', kickoffUtc: '2026-10-02T14:00:00Z', home: 'Arsenal FC', away: 'Brighton & Hove Albion FC', predictedAt: '2026-09-30T09:00:00Z', probs: [.55,.25,.20], result: null };
const event = { id:'odds-1', commence_time: record.kickoffUtc, home_team:'Arsenal', away_team:'Brighton and Hove Albion', bookmakers:[{key:'betsson',title:'Betsson',markets:[{key:'h2h',last_update:'2026-10-01T09:55:00Z',outcomes:[{name:'Arsenal',price:1.8},{name:'Draw',price:4.6},{name:'Brighton and Hove Albion',price:5.1}]}]}] };

test('match exactly one fixture with club aliases and kickoff tolerance', () => {
  assert.equal(eventFor(record,[event]),event);
  assert.equal(eventFor(record,[event,event]),null);
  assert.equal(eventFor(record,[{...event,commence_time:'2026-10-03T14:00:00Z'}]),null);
  const pairs=[
    ['Club Atlético de Madrid','Atletico Madrid'],['Athletic Club','Athletic Bilbao'],
    ['RC Celta de Vigo','Celta Vigo'],['Real Betis Balompié','Real Betis'],
    ['FC Internazionale Milano','Inter Milan'],['Genoa CFC','Genoa']
  ];
  for(const [api,odds] of pairs){
    const fixture={...record,home:api,away:'Arsenal FC'};
    const candidate={...event,home_team:odds,away_team:'Arsenal'};
    assert.equal(eventFor(fixture,[candidate]),candidate,api);
  }
});

test('fixed rule locks one quote and settles a flat stake', () => {
  const chosen = quote(record,event,now);
  assert.deepEqual(chosen.odds,[1.8,4.6,5.1]);
  assert.equal(chosen.pick,'D'); // EV 15%, whereas home outcome has negative EV.
  const start = {version:1,records:[record]};
  const first = attachSnapshots(start,{[record.league]:[event]},now);
  assert.equal(first.attached,1);
  assert.equal(summarize(first.ledger).selected,1);
  const changed = structuredClone(event);changed.bookmakers[0].markets[0].outcomes[1].price=100;
  const second = attachSnapshots(first.ledger,{[record.league]:[changed]},'2026-10-01T12:00:00Z');
  assert.equal(second.attached,0);
  assert.deepEqual(second.ledger.records[0].oddsSnapshot,chosen);
  const win = summarize({records:[{...second.ledger.records[0],result:'D'}]});
  assert.ok(Math.abs(win.profitUnits-3.6)<1e-9);assert.ok(Math.abs(win.roi-3.6)<1e-9);
  const loss = summarize({records:[{...second.ledger.records[0],result:'H'}]});
  assert.equal(loss.profitUnits,-1);
});

test('no retroactive, ambiguous, stale or incomplete bookmaker quotes', () => {
  assert.equal(quote(record,event,'2026-10-02T14:00:00Z'),null);
  assert.equal(quote({...record,predictedAt:'2026-10-02T15:00:00Z'},event,now),null);
  assert.equal(quote(record,{...event,bookmakers:[]},now),null);
  const stale=structuredClone(event);stale.bookmakers[0].markets[0].last_update='2026-09-30T01:00:00Z';
  assert.equal(quote(record,stale,now),null);
  const missing=structuredClone(event);missing.bookmakers[0].markets[0].outcomes.pop();
  assert.equal(quote(record,missing,now),null);
});
