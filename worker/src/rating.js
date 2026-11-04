// PvP rating (ELO), levels / experience and the rules that keep them from being farmed.
// - Ranked fights change the ELO rating. Normal fights and cleared stages only give experience. Friend rooms (room code) never reach the server.
// - A fight gives its reward only if both players reported the same winner (or the opponent left and an AI took over, see online.js),
//   it lasted long enough, and the same two accounts have not fought each other too often in the last 24 hours (pairPercent).
export const START_ELO = 1000;
export const MIN_ELO = 100;
export const PVP_MIN_MS = 6000;              // a real fight lasts longer than this (same floor as the single-player stage ticket)
export const RANKED_MIN_LEVEL = 5;           // ranked matches need this level
export const MAX_LEVEL = 100;

// ---- levels: going from level L to L+1 takes 100 + 20 * (L - 1) experience (level 5 = 520 in total)
export const levelNeed = L => 100 + 20 * (L - 1);
export function levelOf(xp) {
  let level = 1, rest = Math.max(0, xp | 0);
  while (level < MAX_LEVEL && rest >= levelNeed(level)) { rest -= levelNeed(level); level++; }
  return { level, into: rest, need: levelNeed(level) };
}
// experience for one fight (before the repeat-pairing percentage) and for stages
export const fightXp = (ranked, won) => (ranked ? (won ? 60 : 30) : (won ? 40 : 20));
export const stageFirstXp = stage => 30 + 5 * stage;           // first clear of a stage
export const STAGE_REPLAY_XP = 10, STAGE_LOSS_XP = 5;      // a loss always gives clearly less than a win

// new players move faster until their rating has settled
export const kFactor = games => (games < 30 ? 32 : 20);

// rating change for each side. aWon: did side A win. Returns the change that is actually applied (the rating never drops below MIN_ELO)
export function eloChange(ra, rb, aWon, gamesA, gamesB) {
  const ea = 1 / (1 + Math.pow(10, (rb - ra) / 400)), eb = 1 - ea;
  const rawA = Math.round(kFactor(gamesA) * ((aWon ? 1 : 0) - ea));
  const rawB = Math.round(kFactor(gamesB) * ((aWon ? 0 : 1) - eb));
  return [Math.max(MIN_ELO, ra + rawA) - ra, Math.max(MIN_ELO, rb + rawB) - rb];
}

// the same two accounts within 24 h: fights 1-2 give the full reward, fight 3 half, and from fight 4 on nothing if the same player has won every
// earlier fight of the pair ("keeps winning") - otherwise half. After MAX_PAIR_FIGHTS fights nothing is given at all.
// prior = winners (account names) of the earlier counted fights between the two, oldest first
export const MAX_PAIR_FIGHTS = 8;
export function pairPercent(prior, winner) {
  const idx = prior.length + 1;
  if (idx > MAX_PAIR_FIGHTS) return 0;
  if (idx <= 2) return 100;
  if (idx === 3) return 50;
  return prior.every(w => w === winner) ? 0 : 50;
}
// a reduced fight moves both ratings by the same amount (the winner gains exactly what the loser loses)
export function scaleElo(d1, d2, pct, winnerIsHost) {
  if (pct >= 100) return [d1, d2];
  const mag = Math.round((Math.abs(d1) + Math.abs(d2)) / 2 * pct / 100);
  return winnerIsHost ? [mag, -mag] : [-mag, mag];
}
