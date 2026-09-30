import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { predict, goalProbabilities } from './build-forecast-ledger.mjs';
import { csvRows, teamKey } from './backtest-odds.mjs';

const divisions={PL:['E0','Premier League · API'],PD:['SP1','La Liga · API'],SA:['I1','Serie A · API']};
const localDay=new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Ljubljana',year:'numeric',month:'2-digit',day:'2-digit'});
function csvDate(value){
  const parts=String(value||'').split('/').map(Number);if(parts.length!==3||parts.some(x=>!Number.isInteger(x)))return null;
  const [d,m,year]=parts,y=year<100?year+2000:year;
  const date=`${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
  return Number.isFinite(Date.parse(date))?date:null;
}
const score=(p,yes)=>2*(p-Number(yes))**2;

export function evaluateGoalHistory(apiMatches,csvText,league,season){
  const games=apiMatches.filter(m=>m.status==='FINISHED'&&Number.isInteger(m.score?.fullTime?.home)&&Number.isInteger(m.score?.fullTime?.away)&&m.homeTeam?.name&&m.awayTeam?.name)
    .map(m=>({date:localDay.format(new Date(m.utcDate)),league,home:m.homeTeam.name,away:m.awayTeam.name,hg:m.score.fullTime.home,ag:m.score.fullTime.away}));
  const byMatch=new Map();
  for(const row of csvRows(csvText)){
    const date=csvDate(row.Date);if(!date||!row.HomeTeam||!row.AwayTeam)continue;
    const key=`${date}:${teamKey(row.HomeTeam)}:${teamKey(row.AwayTeam)}`;
    byMatch.set(key,[...(byMatch.get(key)||[]),row]);
  }
  const rows=[],counts={completed:0,eligible:0,matched:0,priced:0,selected:0,scoreMismatch:0};
  for(const g of games){
    const year=Number(g.date.slice(0,4))-(Number(g.date.slice(5,7))<7?1:0);
    if(year!==season)continue;counts.completed++;
    const model=predict(games,league,g.home,g.away,g.date);
    if(!model)continue;counts.eligible++;
    const past=games.filter(x=>x.date<g.date),p=goalProbabilities(model.lh,model.la);
    const over=g.hg+g.ag>2,btts=g.hg>0&&g.ag>0;
    const baseline={over25:past.filter(x=>x.hg+x.ag>2).length/past.length,btts:past.filter(x=>x.hg>0&&x.ag>0).length/past.length};
    const row={date:g.date,modelOver:score(p.over25,over),baselineOver:score(baseline.over25,over),modelBtts:score(p.btts,btts),baselineBtts:score(baseline.btts,btts),marketOver:null,pick:null,profit:null};
    const candidates=byMatch.get(`${g.date}:${teamKey(g.home)}:${teamKey(g.away)}`);
    if(candidates?.length===1){
      const csv=candidates[0];
      if(Number(csv.FTHG)!==g.hg||Number(csv.FTAG)!==g.ag)counts.scoreMismatch++;
      else{
        counts.matched++;
        const odds=['B365C>2.5','B365C<2.5'].map(k=>Number(csv[k]));
        if(odds.every(o=>Number.isFinite(o)&&o>1.01&&o<100)){
          counts.priced++;
          const sum=1/odds[0]+1/odds[1],fair=(1/odds[0])/sum;
          row.marketOver=score(fair,over);
          const ev=[p.over25*odds[0]-1,(1-p.over25)*odds[1]-1];
          const choice=ev.map((value,i)=>({value,i})).filter(x=>x.value>=.05&&odds[x.i]>=1.4&&odds[x.i]<=5).sort((a,b)=>b.value-a.value)[0];
          if(choice){row.pick=choice.i===0?'Over':'Under';row.profit=(choice.i===Number(!over)?odds[choice.i]-1:-1);counts.selected++}
        }
      }
    }
    rows.push(row);
  }
  return {rows,counts};
}

export function summarizeGoalHistory(parts,generatedAt){
  const seasons=[];
  for(const season of [...new Set(parts.map(p=>p.season))].sort()){
    const group=parts.filter(p=>p.season===season),rows=group.flatMap(p=>p.rows),priced=rows.filter(r=>r.marketOver!==null),selected=rows.filter(r=>r.pick);
    const avg=(list,key)=>list.length?list.reduce((sum,row)=>sum+row[key],0)/list.length:null;
    const profit=selected.reduce((sum,row)=>sum+row.profit,0);
    const byLeague=group.map(p=>{
      const priced=p.rows.filter(r=>r.marketOver!==null),selected=p.rows.filter(r=>r.pick);
      const profitUnits=selected.reduce((sum,r)=>sum+r.profit,0);
      return {league:p.league,...p.counts,n:p.rows.length,
        pairedModelOver:avg(priced,'modelOver'),pairedMarketOver:avg(priced,'marketOver'),
        brierBtts:avg(p.rows,'modelBtts'),baselineBtts:avg(p.rows,'baselineBtts'),
        profitUnits,roi:selected.length?profitUnits/selected.length:null};
    });
    seasons.push({season,n:rows.length,matched:group.reduce((sum,p)=>sum+p.counts.matched,0),priced:priced.length,selected:selected.length,
      brierOver:avg(rows,'modelOver'),baselineOver:avg(rows,'baselineOver'),brierBtts:avg(rows,'modelBtts'),baselineBtts:avg(rows,'baselineBtts'),
      pairedModelOver:avg(priced,'modelOver'),pairedMarketOver:avg(priced,'marketOver'),profitUnits:profit,roi:selected.length?profit/selected.length:null,
      byLeague});
  }
  return {version:2,generatedAt,source:'football-data.co.uk',book:'Bet365',oddsType:'closing',strategy:'Poisson goals v1; max EV >= 5%; odds 1.4–5; one over/under 2.5 per match; 1 unit',seasons};
}

async function main(){
  const root=new URL('../',import.meta.url),cachePath=new URL('data/goals-odds-backtest.json',root),sitePath=new URL('site/data/goals-odds-backtest.json',root);
  let previous=null;try{previous=JSON.parse(await readFile(cachePath,'utf8'))}catch{/* first run */}
  await mkdir(new URL('site/data/',root),{recursive:true});
  const age=Date.now()-Date.parse(previous?.generatedAt);
  if(previous?.version===2&&Array.isArray(previous.seasons)&&Number.isFinite(age)&&age>=0&&age<7*86400000&&process.env.GOALS_BACKTEST_REFRESH!=='1'){
    await writeFile(sitePath,JSON.stringify(previous,null,2)+'\n');process.stdout.write(`Using cached goal odds report from ${previous.generatedAt}.\n`);return;
  }
  const parts=[],warnings=[];
  for(const [code,[division,league]] of Object.entries(divisions)){
    const data=JSON.parse(await readFile(new URL(`site/data/${code}.json`,root),'utf8'));
    for(const season of [2025,2026]){
      const span=`${String(season).slice(2)}${String(season+1).slice(2)}`;
      try{
        const response=await fetch(`https://www.football-data.co.uk/mmz4281/${span}/${division}.csv`,{signal:AbortSignal.timeout(15000)});
        if(!response.ok)throw Error(`HTTP ${response.status}`);
        const result=evaluateGoalHistory(data.matches,await response.text(),league,season);
        parts.push({season,league,...result});
        process.stdout.write(`${division} ${span}: ${result.counts.eligible} modeled; ${result.counts.priced} closing total quotes; ${result.counts.selected} selections.\n`);
      }catch(error){warnings.push(`${division} ${span}: ${error.message}`)}
    }
  }
  if(warnings.length&&[1,2].includes(previous?.version)&&previous.seasons?.length){
    await writeFile(sitePath,JSON.stringify(previous,null,2)+'\n');process.stdout.write('Goal odds source incomplete; retaining prior report.\n');return;
  }
  const report={...summarizeGoalHistory(parts,new Date().toISOString()),warnings};
  const output=JSON.stringify(report,null,2)+'\n';await writeFile(cachePath,output);await writeFile(sitePath,output);
  process.stdout.write(`Goal market backtest: ${report.seasons.map(s=>`${s.season}: ${s.selected} picks, ${s.profitUnits.toFixed(2)} units`).join('; ')}\n`);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await main();
