import { mkdir, copyFile, writeFile } from 'node:fs/promises';

const token = process.env.FOOTBALL_DATA_TOKEN;
if (!token) throw new Error('Missing FOOTBALL_DATA_TOKEN repository secret.');

const now = new Date();
const season = now.getUTCMonth() >= 6 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
const leagues = ['PL', 'PD', 'SA'];
const output = new URL('../site/', import.meta.url);
await mkdir(new URL('data/', output), { recursive: true });
await copyFile(new URL('../index.html', import.meta.url), new URL('index.html', output));

async function matches(code, year) {
  const url = `https://api.football-data.org/v4/competitions/${code}/matches?season=${year}`;
  const response = await fetch(url, { headers: { 'X-Auth-Token': token } });
  if (!response.ok) throw new Error(`${code} ${year}: HTTP ${response.status}`);
  const body = await response.json();
  if (!Array.isArray(body.matches)) throw new Error(`${code} ${year}: missing matches`);
  return body.matches;
}

function minimal(m) {
  return {
    id: m.id,
    utcDate: m.utcDate,
    status: m.status,
    homeTeam: { name: m.homeTeam?.name ?? null },
    awayTeam: { name: m.awayTeam?.name ?? null },
    score: { fullTime: { home: m.score?.fullTime?.home ?? null, away: m.score?.fullTime?.away ?? null } },
  };
}

for (const code of leagues) {
  const current = await matches(code, season);
  let previous = [], historyAvailable = true;
  try { previous = await matches(code, season - 1); }
  catch (error) { historyAvailable = false; process.stdout.write(`${code}: previous season unavailable (${error.message})\n`); }
  const payload = { generatedAt: now.toISOString(), season, historyAvailable, matches: [...previous, ...current].map(minimal) };
  await writeFile(new URL(`data/${code}.json`, output), JSON.stringify(payload));
  process.stdout.write(`${code}: ${current.length} current matches; ${previous.length} previous matches\n`);
}
