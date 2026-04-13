const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));

// ─── ROOMS ───────────────────────────────────────────────────────────────────
const rooms = {}; // roomCode -> gameState

function makeCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

// ─── DECK ────────────────────────────────────────────────────────────────────
const SUITS = ['♠', '♥', '♦', '♣'];
const RANKS = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
const RANK_VAL = {2:2,3:3,4:4,5:5,6:6,7:7,8:8,9:9,10:10,J:11,Q:12,K:13,A:14};

function buildDeck() {
  const deck = [];
  for (const suit of SUITS)
    for (const rank of RANKS)
      deck.push({ rank, suit, isJoker: false });
  deck.push({ rank: 'Joker', suit: '', isJoker: true });
  return deck;
}

function shuffle(deck) {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

// ─── HAND EVALUATION ─────────────────────────────────────────────────────────
function evalFiveHand(cards) {
  if (!cards || cards.length !== 5) return { rank: -1, name: 'Incomplete', tiebreak: [] };
  if (cards.some(c => c.isJoker)) return tryJokerFive(cards);
  return evalFiveNoJoker(cards);
}

function tryJokerFive(cards) {
  // Pai Gow Poker semi-wild joker rules:
  // Joker can ONLY be used as:
  //   1. An Ace (for pairs, trips of Aces, full house with Aces, etc.)
  //   2. To complete a straight
  //   3. To complete a flush
  //   4. To complete a straight flush / royal flush
  // It CANNOT substitute for non-Ace ranks to make trips, quads, etc.
  const others = cards.filter(c => !c.isJoker);
  let best = { rank: -1, name: '', tiebreak: [] };

  // Try joker as Ace in every suit
  for (const suit of SUITS) {
    const test = [...others, { rank: 'A', suit, isJoker: false }];
    const r = evalFiveNoJoker(test);
    if (compareFive(r, best) > 0) best = r;
  }

  // Try joker to complete a flush (use the majority suit)
  // ONLY accept the result if it is actually a flush or better
  const suitCounts = {};
  others.forEach(c => { suitCounts[c.suit] = (suitCounts[c.suit] || 0) + 1; });
  const flushSuit = Object.entries(suitCounts).sort((a, b) => b[1] - a[1])[0]?.[0];
  if (flushSuit) {
    for (const rank of RANKS) {
      const test = [...others, { rank, suit: flushSuit, isJoker: false }];
      const r = evalFiveNoJoker(test);
      if (r.rank >= 5 && compareFive(r, best) > 0) best = r; // rank 5 = Flush minimum
    }
  }

  // Try joker to complete a straight (try all ranks in a neutral suit)
  // ONLY accept the result if it is actually a straight or better
  for (const rank of RANKS) {
    const test = [...others, { rank, suit: '♠', isJoker: false }];
    const rv = test.map(c => RANK_VAL[c.rank]).sort((a, b) => b - a);
    if (checkStraight(rv)) {
      const r = evalFiveNoJoker(test);
      if (r.rank >= 4 && compareFive(r, best) > 0) best = r; // rank 4 = Straight minimum
    }
  }

  return best;
}

function evalFiveNoJoker(cards) {
  const rv = cards.map(c => RANK_VAL[c.rank]);
  const suits = cards.map(c => c.suit);
  rv.sort((a, b) => b - a);
  const counts = {};
  rv.forEach(v => counts[v] = (counts[v] || 0) + 1);
  const freq = Object.values(counts).sort((a, b) => b - a);
  const isFlush = suits.every(s => s === suits[0]);
  const isStraight = checkStraight(rv);
  if (isFlush && isStraight) return { rank: 8, name: 'Straight Flush', tiebreak: rv, isRoyal: rv[0] === 14 };
  if (freq[0] === 4) return { rank: 7, name: 'Four of a Kind', tiebreak: sortByFreq(rv, counts) };
  if (freq[0] === 3 && freq[1] === 2) return { rank: 6, name: 'Full House', tiebreak: sortByFreq(rv, counts) };
  if (isFlush) return { rank: 5, name: 'Flush', tiebreak: rv };
  if (isStraight) return { rank: 4, name: 'Straight', tiebreak: rv };
  if (freq[0] === 3) return { rank: 3, name: 'Three of a Kind', tiebreak: sortByFreq(rv, counts) };
  if (freq[0] === 2 && freq[1] === 2) return { rank: 2, name: 'Two Pair', tiebreak: sortByFreq(rv, counts) };
  if (freq[0] === 2) return { rank: 1, name: 'One Pair', tiebreak: sortByFreq(rv, counts) };
  return { rank: 0, name: 'High Card', tiebreak: rv };
}

function checkStraight(sortedVals) {
  const v = [...new Set(sortedVals)];
  if (v.length !== 5) return false;
  if (v[0] - v[4] === 4) return true;
  if (JSON.stringify(v) === '[14,5,4,3,2]') return true;
  return false;
}

function sortByFreq(vals, counts) {
  const res = [];
  const byCount = {};
  vals.forEach(v => { const c = counts[v] || 0; byCount[c] = byCount[c] || []; if (!byCount[c].includes(v)) byCount[c].push(v); });
  [4, 3, 2, 1].forEach(c => { if (byCount[c]) byCount[c].sort((a, b) => b - a).forEach(v => { for (let i = 0; i < c; i++) res.push(v); }); });
  return res;
}

function compareFive(a, b) {
  if (a.rank !== b.rank) return a.rank - b.rank;
  for (let i = 0; i < Math.min(a.tiebreak.length, b.tiebreak.length); i++) {
    if (a.tiebreak[i] !== b.tiebreak[i]) return a.tiebreak[i] - b.tiebreak[i];
  }
  return 0;
}

function evalTwoHand(cards) {
  if (!cards || cards.length !== 2) return { rank: -1, name: 'Incomplete', tiebreak: [] };
  if (cards.some(c => c.isJoker)) {
    const other = cards.find(c => !c.isJoker);
    return evalTwoNoJoker([{ rank: 'A', suit: '♠', isJoker: false }, other]);
  }
  return evalTwoNoJoker(cards);
}

function evalTwoNoJoker(cards) {
  const rv = cards.map(c => RANK_VAL[c.rank]).sort((a, b) => b - a);
  return rv[0] === rv[1]
    ? { rank: 1, name: 'Pair', tiebreak: rv }
    : { rank: 0, name: 'High Card', tiebreak: rv };
}

function compareTwo(a, b) {
  if (a.rank !== b.rank) return a.rank - b.rank;
  for (let i = 0; i < a.tiebreak.length; i++) {
    if (a.tiebreak[i] !== b.tiebreak[i]) return a.tiebreak[i] - b.tiebreak[i];
  }
  return 0;
}

// ─── HOUSE WAY ───────────────────────────────────────────────────────────────
// Returns { high: Card[5], low: Card[2] }
function applyHouseWay(cards) {

  // ── Helpers ────────────────────────────────────────────────────────────────
  const rv = c => c.isJoker ? 14.5 : RANK_VAL[c.rank];

  // Remove `used` cards from `pool` by identity key
  function without(pool, used) {
    const keys = used.map(c => c.isJoker ? 'JKR' : `${c.rank}${c.suit}`);
    const seen = {};
    return pool.filter(c => {
      const k = c.isJoker ? 'JKR' : `${c.rank}${c.suit}`;
      if (keys.includes(k) && !seen[k]) { seen[k] = true; return false; }
      return true;
    });
  }

  // Pick up to n cards of rank from pool (naturals preferred over joker)
  function pick(rank, n, pool) {
    const nats = pool.filter(c => !c.isJoker && c.rank === rank);
    const jkrs = pool.filter(c => c.isJoker);
    const out = [];
    for (const c of nats) { if (out.length < n) out.push(c); }
    if (out.length < n && jkrs.length) out.push(jkrs[0]);
    return out;
  }

  function topN(pool, n) {
    return [...pool].sort((a, b) => rv(b) - rv(a)).slice(0, n);
  }

  function make(low, all) {
    return { high: without(all, low), low };
  }

  // ── Build rank inventory ───────────────────────────────────────────────────
  const hasJoker = cards.some(c => c.isJoker);
  const nats     = cards.filter(c => !c.isJoker);
  const cnt      = {};
  nats.forEach(c => cnt[c.rank] = (cnt[c.rank] || 0) + 1);
  // Joker counts as an Ace for pairing/grouping purposes
  if (hasJoker) cnt['A'] = (cnt['A'] || 0) + 1;

  const byCount = n =>
    Object.entries(cnt).filter(([, c]) => c === n)
      .map(([r]) => r)
      .sort((a, b) => RANK_VAL[b] - RANK_VAL[a]);

  const quads  = byCount(4);   // ranks with exactly 4
  const trips  = byCount(3);   // ranks with exactly 3
  const pairs  = byCount(2);   // ranks with exactly 2
  // singles are everything else (count === 1)

  // ── Straight / Flush detectors on a 5-card subset ─────────────────────────
  function isStraight5(five) {
    const vals = five.map(c => c.isJoker ? 14 : RANK_VAL[c.rank]).sort((a, b) => b - a);
    const uniq = [...new Set(vals)];
    if (uniq.length !== 5) return false;
    if (uniq[0] - uniq[4] === 4) return true;
    if (JSON.stringify(uniq) === '[14,5,4,3,2]') return true; // wheel
    return false;
  }
  function isFlush5(five) {
    const suits = five.map(c => c.suit).filter(s => s); // joker has no suit
    if (suits.length < 5) {
      // joker is present — check if the 4 naturals share a suit
      return suits.every(s => s === suits[0]);
    }
    return suits.every(s => s === suits[0]);
  }
  function isSF5(five) { return isStraight5(five) && isFlush5(five); }

  // All 7-choose-5 combos
  function allFive(pool) {
    const out = [];
    for (let i = 0; i < pool.length; i++)
      for (let j = i+1; j < pool.length; j++) {
        const two = [pool[i], pool[j]];
        out.push({ five: without(pool, two), two });
      }
    return out;
  }

  // ── 5-ACE CHECK (must come before quads since joker makes "5 aces") ────────
  const aceCount = (cnt['A'] || 0); // includes joker-as-ace
  const hasFiveAces = hasJoker && aceCount >= 5; // 4 natural aces + joker

  if (hasFiveAces) {
    // Exception: if also have a pair of Kings, play Kings in low hand
    const kingCards = cards.filter(c => !c.isJoker && c.rank === 'K');
    if (kingCards.length >= 2) {
      const low = kingCards.slice(0, 2);
      return make(low, cards);
    }
    // Default five aces: play two aces in low hand
    const allAces = cards.filter(c => !c.isJoker && c.rank === 'A');
    const low = allAces.slice(0, 2);
    return make(low, cards);
  }

  // ── FOUR OF A KIND ────────────────────────────────────────────────────────
  if (quads.length > 0) {
    const qRank = quads[0];
    const qVal  = RANK_VAL[qRank];
    const qCards = pick(qRank, 4, cards);
    const rest   = without(cards, qCards);

    // Four of a Kind with a Pair (or Trips) in the remaining cards → pair/trips low
    const restCnt = {};
    rest.forEach(c => { const k = c.isJoker ? 'A' : c.rank; restCnt[k] = (restCnt[k]||0)+1; });
    const restPairRanks = Object.entries(restCnt).filter(([,c])=>c>=2).map(([r])=>r).sort((a,b)=>RANK_VAL[b]-RANK_VAL[a]);
    if (restPairRanks.length > 0) {
      const low = pick(restPairRanks[0], 2, rest);
      return make(low, cards);
    }

    // 2–6: never split
    if (qVal <= 6) {
      return make(topN(rest, 2), cards);
    }
    // 7–10: split unless Ace available in rest to play low (keep quads high)
    if (qVal <= 10) {
      const restAce = rest.find(c => c.isJoker || c.rank === 'A');
      if (restAce) {
        // Keep quads high; Ace + next best in low
        const otherRest = without(rest, [restAce]).sort((a,b)=>rv(b)-rv(a));
        const low = [restAce, otherRest[0]];
        return make(low, cards);
      }
      // No ace: split quads 2-2
      const low = qCards.slice(0, 2);
      return make(low, cards);
    }
    // J, Q, K, A: always split
    const low = qCards.slice(0, 2);
    return make(low, cards);
  }

  // ── FULL HOUSE variants ───────────────────────────────────────────────────
  // Full House = trips + pair (or trips + two-pair, or trips + trips)
  if (trips.length >= 2) {
    // Two trips: play pair from HIGHEST trips in low hand
    const highTripCards = pick(trips[0], 3, cards);
    const low = highTripCards.slice(0, 2);
    return make(low, cards);
  }

  if (trips.length === 1 && pairs.length >= 2) {
    // Trips + Two Pair: play highest pair in low
    const low = pick(pairs[0], 2, cards);
    return make(low, cards);
  }

  if (trips.length === 1 && pairs.length === 1) {
    // Classic full house: always split, pair in low
    const low = pick(pairs[0], 2, cards);
    return make(low, cards);
  }

  // ── THREE OF A KIND (no pair) ─────────────────────────────────────────────
  if (trips.length === 1 && pairs.length === 0) {
    const tRank = trips[0];

    // Check for straight/flush possibilities — play pair of trips in low if SF/straight/flush preserved
    const tCards  = pick(tRank, 3, cards);
    const nonTrip = without(cards, tCards);
    // Try keeping 2 of the trips in high (with the non-trip cards) + 1 trip card in low
    // Look for best 5-card hand among the 6 cards that aren't the card we split off
    // (Rule: Three of a Kind — play pair in low if SF/straight/flush preserved)
    let sfCombo = null;
    for (let i = 0; i < tCards.length; i++) {
      const oneOut  = [tCards[i]];
      const fivePool = without(cards, oneOut);
      for (const { five, two } of allFive(fivePool)) {
        if (isSF5(five) || isStraight5(five) || isFlush5(five)) {
          // Found a straight/flush — play the remaining trip card + best of two in low
          const lowCard = oneOut[0];
          // We need exactly 2 for low: the split-off trip card + best remaining single
          const remainFor2 = without(cards, five);
          // remainFor2 has 2 cards; use both as low
          if (remainFor2.length === 2) {
            sfCombo = { five, low: remainFor2 };
            break;
          }
        }
      }
      if (sfCombo) break;
    }

    if (sfCombo) return { high: sfCombo.five, low: sfCombo.low };

    // Exception: three Aces → one Ace + highest non-Ace kicker in low; two Aces in high
    if (tRank === 'A') {
      const aceCards  = pick('A', 3, cards);
      const nonAces   = without(cards, aceCards).sort((a,b) => rv(b) - rv(a));
      const oneAce    = aceCards[0];
      const kicker    = nonAces[0];
      const low       = [oneAce, kicker];
      return make(low, cards);
    }

    // All other trips: keep in high, top-2 remaining in low
    return make(topN(nonTrip, 2), cards);
  }

  // ── THREE PAIR ────────────────────────────────────────────────────────────
  if (pairs.length >= 3) {
    // Play highest pair in low hand
    const low = pick(pairs[0], 2, cards);
    return make(low, cards);
  }

  // ── TWO PAIR ──────────────────────────────────────────────────────────────
  if (pairs.length === 2) {
    const hiRank = pairs[0], loRank = pairs[1];
    const hiVal  = RANK_VAL[hiRank], loVal = RANK_VAL[loRank];

    // Both pairs J+ → always split; play low pair in low hand
    const bothHighCard = hiVal >= 11 && loVal >= 11;
    // One pair 7–10 with the other being J+ → split, low pair in low
    const midHigh = (loVal >= 7 && loVal <= 10) && hiVal >= 11;

    if (bothHighCard || midHigh) {
      return make(pick(loRank, 2, cards), cards);
    }

    // Extra Ace or Joker beyond the pairs → keep both pairs high, Ace/Joker + kicker in low
    const pairCards = [...pick(hiRank, 2, cards), ...pick(loRank, 2, cards)];
    const rest = without(cards, pairCards);
    const freeAce = rest.find(c => c.isJoker || c.rank === 'A');
    if (freeAce) {
      const kicker = without(rest, [freeAce]).sort((a,b)=>rv(b)-rv(a))[0];
      return make([freeAce, kicker], cards);
    }

    // Default: split, low pair in low hand
    return make(pick(loRank, 2, cards), cards);
  }

  // ── ONE PAIR ──────────────────────────────────────────────────────────────
  if (pairs.length === 1) {
    const pRank  = pairs[0];
    const pVal   = RANK_VAL[pRank];
    const pCards = pick(pRank, 2, cards);
    const rest   = without(cards, pCards).sort((a, b) => rv(b) - rv(a));

    // Check if a straight/flush/SF exists in 5 of the 7 cards
    // Rule: play pair in low if SF/straight/flush preserved in high
    // Exception: pair of 10s+ with an Ace or face card → play pair in high instead
    let bestSFHand = null;
    for (const { five, two } of allFive(cards)) {
      if (isSF5(five) || isStraight5(five) || isFlush5(five)) {
        // Check if this combo frees up a better low hand
        if (!bestSFHand || rv(two[0]) + rv(two[1]) > rv(bestSFHand.two[0]) + rv(bestSFHand.two[1])) {
          bestSFHand = { five, two };
        }
      }
    }

    if (bestSFHand) {
      // Exception: pair of 10s or better + Ace or face (J/Q/K) → play pair high
      const pairIsHighEnough = pVal >= 10;
      const twoHasAceOrFace  = bestSFHand.two.some(c => (c.isJoker || RANK_VAL[c.rank] >= 11));
      if (pairIsHighEnough && twoHasAceOrFace) {
        // Play pair in high hand as normal (fall through)
      } else {
        // Play pair in low hand, SF/straight/flush in high
        return { high: bestSFHand.five, low: bestSFHand.two };
      }
    }

    // Standard one pair: pair in high, top-2 remaining in low
    const low = rest.slice(0, 2);
    const high = [...pCards, ...rest.slice(2)];
    return { high, low };
  }

  // ── NO PAIR (includes straights / flushes with no pair) ───────────────────
  // Find all valid straight/flush/SF combos; pick the one with highest two-card low
  let bestNoP = null;
  for (const { five, two } of allFive(cards)) {
    if (isSF5(five) || isStraight5(five) || isFlush5(five)) {
      const twoVal = rv(two[0]) + rv(two[1]);
      if (!bestNoP || twoVal > rv(bestNoP.two[0]) + rv(bestNoP.two[1])) {
        bestNoP = { five, two };
      }
    }
  }
  if (bestNoP) return { high: bestNoP.five, low: bestNoP.two };

  // Pure no pair, no straight/flush: 2nd and 3rd highest in low
  const desc = [...cards].sort((a, b) => rv(b) - rv(a));
  return make([desc[1], desc[2]], cards);
}

// ─── BONUS EVALUATION ────────────────────────────────────────────────────────
function hasFiveAces(cards) {
  if (!cards.some(c => c.isJoker)) return false;
  return cards.filter(c => !c.isJoker && c.rank === 'A').length === 4;
}

function sevenCardSFType(cards) {
  const hasJoker = cards.some(c => c.isJoker);
  if (!hasJoker) {
    const suit = cards[0].suit;
    if (!cards.every(c => c.suit === suit)) return null;
    const vals = cards.map(c => RANK_VAL[c.rank]).sort((a, b) => a - b);
    const isConsec = vals[6] - vals[0] === 6 && new Set(vals).size === 7;
    const isWheel = JSON.stringify(vals) === '[2,3,4,5,6,7,14]';
    return (isConsec || isWheel) ? 'natural' : null;
  } else {
    const naturals = cards.filter(c => !c.isJoker);
    const suit = naturals[0].suit;
    if (!naturals.every(c => c.suit === suit)) return null;
    const vals = naturals.map(c => RANK_VAL[c.rank]).sort((a, b) => a - b);
    if (new Set(vals).size !== 6) return null;
    for (let low = 1; low <= 8; low++) {
      const window = [low,low+1,low+2,low+3,low+4,low+5,low+6].map(v => v === 1 ? 14 : v);
      if (window.filter(v => !vals.includes(v)).length === 1) return 'joker';
    }
    const wheelMissing = [2,3,4,5,6,7,14].filter(v => !vals.includes(v));
    if (wheelMissing.length === 1) return 'joker';
    return null;
  }
}

function hasThreePairs(cards) {
  const hasJoker = cards.some(c => c.isJoker);
  const naturals = cards.filter(c => !c.isJoker);
  const counts = {};
  naturals.forEach(c => counts[c.rank] = (counts[c.rank] || 0) + 1);

  if (hasJoker) {
    const aceCount = counts['A'] || 0;
    if (aceCount < 1) return false;
    const remaining = { ...counts };
    remaining['A'] -= 1;
    if (remaining['A'] === 0) delete remaining['A'];
    const remVals = Object.values(remaining);
    return remVals.filter(v => v >= 2).length === 2 && remVals.filter(v => v === 1).length === 1;
  }
  const pairRanks = Object.keys(counts).filter(r => counts[r] >= 2);
  if (pairRanks.length !== 3) return false;
  return !pairRanks.some(r => counts[r] >= 3);
}

function evalSevenCardBonus(cards) {
  const sfType = sevenCardSFType(cards);
  if (sfType === 'natural') return { bonusType: 'sf7natural' };
  if (sfType === 'joker')   return { bonusType: 'sf7joker' };
  if (hasFiveAces(cards))   return { bonusType: 'fiveaces' };

  let best = { rank: -1, name: '', tiebreak: [], isRoyal: false };
  for (let i = 0; i < 7; i++) for (let j = i + 1; j < 7; j++) {
    const five = cards.filter((_, k) => k !== i && k !== j);
    const ev = evalFiveHand(five);
    if (ev.rank === 8 && ev.tiebreak[0] === 14) ev.isRoyal = true;
    if (compareFive(ev, best) > 0 || (ev.rank === best.rank && ev.isRoyal && !best.isRoyal)) best = { ...ev };
  }

  if (best.rank >= 3) return { bonusType: '_five', fiveEval: best };
  if (hasThreePairs(cards)) return { bonusType: 'threepair' };
  return { bonusType: '_five', fiveEval: best };
}

function getBonusPayout(sevenResult, bp) {
  const bt = sevenResult.bonusType;
  if (bt === 'sf7natural') return { mult: bp.sf7natural, label: 'Natural 7-Card Straight Flush 🔥' };
  if (bt === 'sf7joker')   return { mult: bp.sf7joker,   label: '7-Card Straight Flush (Joker) ⭐' };
  if (bt === 'fiveaces')   return { mult: bp.fiveaces,   label: 'Five Aces 👑' };
  if (bt === 'threepair')  return { mult: bp.threepair,  label: '3 Pairs' };
  const ev = sevenResult.fiveEval;
  if (!ev || ev.rank < 0) return null;
  if (ev.isRoyal)    return { mult: bp.royal,    label: 'Royal Flush' };
  if (ev.rank === 8) return { mult: bp.sf,        label: 'Straight Flush' };
  if (ev.rank === 7) return { mult: bp.quads,     label: 'Four of a Kind' };
  if (ev.rank === 6) return { mult: bp.fullhouse, label: 'Full House' };
  if (ev.rank === 5) return { mult: bp.flush,     label: 'Flush' };
  if (ev.rank === 4) return { mult: bp.straight,  label: 'Straight' };
  if (ev.rank === 3) return { mult: bp.trips,     label: 'Three of a Kind' };
  return null;
}

// ─── GAME STATE FACTORY ──────────────────────────────────────────────────────
function makeGame(hostId, hostName, startingChips, bonusPayouts, poolContribution, minBet, maxBet, fixedBuyIn) {
  return {
    hostId,
    phase: 'lobby',   // lobby | bet | set | reveal | done
    round: 1,
    bankerIdx: 0,
    deck: [],
    startingChips,
    bonusPayouts,
    poolContribution: poolContribution || 0,
    bonusPool: 0,
    totalBuyIns: 0,       // sum of all chips ever brought to table
    pendingPoolTopUp: false, // true when banker has triggered a top-up vote
    pendingPoolTopUpAmount: 0,
    minBet: minBet || 0,
    maxBet: Math.min(maxBet || 5, 5),
    fixedBuyIn: fixedBuyIn || false,
    houseBonus: { collected: 0, paid: 0, rounds: 0 },
    sessionBestHand: null,
    revealStep: -1,
    players: [{
      id: hostId,
      name: hostName,
      chips: startingChips,
      bet: 0,
      bonusBet: 0,
      hand: [],
      highHand: [],
      lowHand: [],
      handSet: false,
      folded: false,
      playerReady: false,
      result: null,
      netChips: null,
      bonusNet: null,
      bonusLabel: '',
      bonusWon: false,
      revealed: false,
      seatIndex: null,  // null = banker/dealer seat; 0-5 = arc seats
      stats: { wins: 0, losses: 0, pushes: 0, rounds: 0, netChips: 0, buyins: 0, initialBuyIn: 0 }
    }]
  };
}

// ─── CARD VISIBILITY HELPER ─────────────────────────────────────────────────
function vis(arr, show) {
  if (show) return arr;
  return arr.length > 0 ? arr.map(() => ({ hidden: true })) : [];
}
function cardVisibility(p, isMe, isBanker, bankerHasSet) {
  const seeAll      = isMe || isBanker || p.revealed;
  const seeArranged = isBanker && bankerHasSet;
  return {
    hand:     vis(p.hand,     seeAll),
    highHand: vis(p.highHand, seeAll || seeArranged),
    lowHand:  vis(p.lowHand,  seeAll || seeArranged),
  };
}

// ─── SAFE STATE (strip private hand data before broadcasting) ────────────────
function safeState(room, forSocketId) {
  const g = rooms[room];
  if (!g) return null;
  return {
    phase: g.phase,
    round: g.round,
    bankerIdx: g.bankerIdx,
    startingChips: g.startingChips,
    bonusPayouts: g.bonusPayouts,
    houseBonus: g.houseBonus,
    bankerAceHighPush: g.bankerAceHighPush || false,
    bankerId: g.players[g.bankerIdx] ? g.players[g.bankerIdx].id : null,
    hostId: g.hostId,
    bonusPool: g.bonusPool || 0,
    poolContribution: g.poolContribution || 0,
    bankerInsolvent: g.bankerInsolvent || false,
    minBet: g.minBet || 0,
    maxBet: g.maxBet || 5,
    fixedBuyIn: g.fixedBuyIn || false,
    totalBuyIns: g.totalBuyIns || 0,
    pendingPoolTopUp: g.pendingPoolTopUp || false,
    pendingPoolTopUpAmount: g.pendingPoolTopUpAmount || 0,
    dealOrderNum: g.dealOrderNum || null,
    players: g.players.map(p => {
      const isMe = p.id === forSocketId;
      const isBanker = g.players.indexOf(p) === g.bankerIdx;
      return {
        id: p.id,
        name: p.name,
        chips: p.chips,
        bet: p.bet,
        bonusBet: p.bonusBet,
        handSet: p.handSet,
        folded: p.folded,
        playerReady: p.playerReady || false,
        result: p.result,
        netChips: p.netChips,
        bonusNet: p.bonusNet,
        bonusLabel: p.bonusLabel,
        bonusWon: p.bonusWon,
        revealed: p.revealed,
        lateJoiner: p.lateJoiner || false,
        poolBlocked: p.poolBlocked || false,
        seatIndex: p.seatIndex !== undefined ? p.seatIndex : null,
        disconnected: p.disconnected || false,
        addingChips: p.addingChips || false,
        bonusPending: p.bonusPending || 0,
        stats: p.stats,
        netPL: Math.round((p.chips - (p.stats.initialBuyIn + p.stats.buyins)) * 100) / 100,
        // Card visibility delegated to cardVisibility() helper
        ...cardVisibility(p, isMe, isBanker, g.players[g.bankerIdx].handSet),
      };
    }),
    sessionBestHand: g.sessionBestHand,
    revealStep: g.revealStep,
  };
}

function broadcastState(room) {
  const g = rooms[room];
  if (!g) return;
  g.players.forEach(p => {
    io.to(p.id).emit('state', safeState(room, p.id));
  });
}

// ─── SETTLE ROUND ────────────────────────────────────────────────────────────
function settleRound(room) {
  const g = rooms[room];
  const banker = g.players[g.bankerIdx];
  const bankerHigh = evalFiveHand(banker.highHand);
  const bankerLow = evalTwoHand(banker.lowHand);

  // Ace-high push rule
  const bankerAceHighPush = bankerHigh.rank === 0 && bankerHigh.tiebreak[0] === 14;

  // First pass: calculate results and what banker owes / receives
  let bankerDelta = 0; // net chips banker must pay (positive) or receive (negative)
  g.players.forEach((p, idx) => {
    if (idx === g.bankerIdx || p.folded || p.bet === 0) return;
    const pHigh = evalFiveHand(p.highHand);
    const pLow  = evalTwoHand(p.lowHand);
    const highWin = compareFive(pHigh, bankerHigh);
    const lowWin  = compareTwo(pLow, bankerLow);

    let result, net;
    if (bankerAceHighPush)              { net = 0;      result = 'push'; }
    else if (highWin > 0 && lowWin > 0) { net =  p.bet; result = 'win';  }
    else if (highWin < 0 && lowWin < 0) { net = -p.bet; result = 'lose'; }
    else                                 { net = 0;      result = 'push'; }

    p.result   = result;
    p.netChips = net;
    bankerDelta += net; // positive = banker pays out, negative = banker collects
    p.stats.rounds++;
    p.stats.netChips += net;
    if (result === 'win')       p.stats.wins++;
    else if (result === 'lose') p.stats.losses++;
    else                        p.stats.pushes++;

    // Bonus bet — Option B accounting:
    // Stake was already deducted at deal time.
    // Win: pool pays (stake + winnings) back to player. Net shown = winnings only.
    // Loss: stake already gone from chips; add it to pool now for accounting.
    let bonusNet = 0, bonusLabel = '', bonusWon = false;
    if (p.bonusBet > 0 && p.hand.length === 7) {
      const sr = evalSevenCardBonus(p.hand);
      const payout = getBonusPayout(sr, g.bonusPayouts);
      if (payout) {
        // Stake was moved to pool at deal time.
        // Win: pool pays back stake + winnings (mult × stake). Total out of pool = stake*(mult+1)
        const winnings    = Math.round(p.bonusBet * payout.mult * 100) / 100;
        const totalReturn = Math.round(p.bonusBet * (payout.mult + 1) * 100) / 100; // stake + winnings
        bonusNet  = winnings; // net profit shown to player
        bonusLabel = `${payout.label} (${payout.mult}×) +$${totalReturn.toFixed(2)}`;
        bonusWon  = true;
        if (!poolCanCover(g, totalReturn)) {
          // Pool insufficient — flag for banker-controlled top-up, partial payout
          g.pendingPoolTopUp = true;
          g.pendingPoolTopUpAmount = Math.max(g.pendingPoolTopUpAmount,
            Math.round((totalReturn - g.bonusPool) * 100) / 100);
          const partial = Math.max(0, Math.round(g.bonusPool * 100) / 100);
          g.bonusPool = 0;
          p.chips = Math.round((p.chips + partial) * 100) / 100;
          p.bonusPending = Math.round((totalReturn - partial) * 100) / 100;
        } else {
          g.bonusPool = Math.round((g.bonusPool - totalReturn) * 100) / 100;
          p.chips     = Math.round((p.chips + totalReturn) * 100) / 100;
        }
        g.houseBonus.paid = Math.round((g.houseBonus.paid + winnings) * 100) / 100;
      } else {
        bonusNet   = -p.bonusBet; // net shown as loss (stake already in pool from deal)
        bonusLabel = 'No bonus';
        // Stake is already in pool from deal-time deduction — no further action needed
        g.houseBonus.collected = Math.round((g.houseBonus.collected + p.bonusBet) * 100) / 100;
      }
      g.houseBonus.rounds++;
    }
    p.bonusNet    = bonusNet;
    p.bonusLabel  = bonusLabel;
    p.bonusWon    = bonusWon;
  });

  // Check if banker can cover net payout
  const bankerOwes = bankerDelta; // chips banker must pay winners (may be negative if banker wins net)
  const wouldGoNeg = banker.chips - bankerOwes < 0;

  if (wouldGoNeg && bankerOwes > 0) {
    // Banker cannot cover — suspend transfers, flag for mandatory buy-in
    g.bankerInsolvent = true;
    g.pendingBankerDelta = bankerOwes;
    // Do NOT move chips yet — players' netChips are set for display only
  } else {
    // Solvent — execute transfers now
    g.bankerInsolvent = false;
    g.pendingBankerDelta = 0;
    g.players.forEach((p, idx) => {
      if (idx === g.bankerIdx || p.folded || p.bet === 0) return;
      p.chips    = Math.round((p.chips    + p.netChips) * 100) / 100;
      banker.chips = Math.round((banker.chips - p.netChips) * 100) / 100;
    });
  }

  g.bankerAceHighPush = bankerAceHighPush;

  // Track session best hand (highest high-hand rank across all active players including banker)
  const activePlayers = g.players.filter((p, i) => p.hand.length > 0);
  activePlayers.forEach((p, _) => {
    if (p.highHand.length !== 5) return;
    const ev = evalFiveHand(p.highHand);
    const isBanker = g.players.indexOf(p) === g.bankerIdx;
    const handScore = ev.rank * 1000 + (ev.tiebreak[0] || 0);
    const bestScore = g.sessionBestHand
      ? g.sessionBestHand.rank * 1000 + (g.sessionBestHand.tiebreak0 || 0)
      : -1;
    if (handScore > bestScore) {
      g.sessionBestHand = {
        playerName: p.name,
        handName: ev.name,
        rank: ev.rank,
        tiebreak0: ev.tiebreak[0] || 0,
        isBanker,
        round: g.round,
      };
    }
  });

  // Sequential reveal: start at step 0 (banker shown). Players revealed via advanceReveal socket event.
  g.revealStep = 0;
  // Mark banker as revealed immediately
  g.players[g.bankerIdx].revealed = true;
  g.phase = 'done';
}

// ─── ROUNDING HELPER ─────────────────────────────────────────────────────────
// Rounds to 2 decimal places — prevents float drift in chip arithmetic
const r = n => Math.round(n * 100) / 100;

// ─── RATE LIMITER (Fix #3) ───────────────────────────────────────────────────
const betEventCounts = {}; // socketId -> { count, resetAt }
function rateLimitBet(socketId) {
  const now = Date.now();
  if (!betEventCounts[socketId] || betEventCounts[socketId].resetAt < now) {
    betEventCounts[socketId] = { count: 1, resetAt: now + 1000 };
    return false; // not limited
  }
  betEventCounts[socketId].count++;
  return betEventCounts[socketId].count > 10; // limited if > 10/sec
}

// ─── BANKER AUTH HELPER ──────────────────────────────────────────────────────
function isCurrentBanker(g, socketId) {
  return g && g.players[g.bankerIdx] && g.players[g.bankerIdx].id === socketId;
}

// ─── BONUS POOL HELPERS ──────────────────────────────────────────────────────
// Collect one poolContribution from every active (non-disconnected) player
function collectPoolContributions(g) {
  const contrib = g.poolContribution || 0;
  if (contrib <= 0) return;
  g.players.forEach(p => {
    if (p.disconnected) return;
    const actual = Math.min(contrib, p.chips);
    p.chips -= actual;
    g.bonusPool += actual;
  });
}

// Ensure pool has enough to cover payout.
// Returns true if pool is sufficient, false if top-up is needed.
// Caller must check and pause settlement if false.
function poolCanCover(g, amount) {
  return g.bonusPool >= amount;
}

// Charge a banker-set top-up amount from all active non-disconnected players
// Returns true if all players could afford it, false if any were blocked
function executePoolTopUp(g, amount, roomCode, io) {
  g.players.forEach(p => {
    if (p.disconnected) return;
    if (p.chips >= amount) {
      p.chips = Math.round((p.chips - amount) * 100) / 100;
      g.bonusPool = Math.round((g.bonusPool + amount) * 100) / 100;
    } else {
      // Player can't afford — flag them
      p.poolBlocked = true;
      io.to(roomCode).emit('poolTopUpBlocked', { name: p.name, needed: amount, has: p.chips });
    }
  });
  g.pendingPoolTopUp = false;
  g.pendingPoolTopUpAmount = 0;
}

// ─── SOCKET EVENTS ───────────────────────────────────────────────────────────
io.on('connection', (socket) => {

  // Create room
  socket.on('createRoom', ({ name, startingChips, bonusPayouts, poolContribution, minBet, maxBet, fixedBuyIn }) => {
    let code;
    do { code = makeCode(); } while (rooms[code]);
    rooms[code] = makeGame(socket.id, name, startingChips, bonusPayouts, Math.max(0, parseFloat(poolContribution)||0), parseFloat(minBet)||0, parseFloat(maxBet)||5, !!fixedBuyIn);
    socket.join(code);
    socket.emit('roomCreated', { code });
    broadcastState(code);
  });

  // Request seat list — sent before joinRoom so player can pick a seat
  socket.on('requestSeats', ({ code }) => {
    const g = rooms[code];
    if (!g) { socket.emit('error', 'Room not found'); return; }
    const takenSeats = g.players
      .filter(p => p.seatIndex !== null && p.seatIndex !== undefined)
      .map(p => ({ seatIndex: p.seatIndex, name: p.name, disconnected: p.disconnected || false }));
    socket.emit('seatList', { takenSeats, phase: g.phase, roomName: code });
  });

  // Join room with chosen seat (allowed at any phase — late joiners sit out current round)
  socket.on('joinRoom', ({ code, name, seatIndex }) => {
    const g = rooms[code];
    if (!g) { socket.emit('error', 'Room not found'); return; }

    // Check for reconnect: same name, disconnected player holding seat
    const existing = g.players.find(p =>
      p.name.toLowerCase() === name.toLowerCase() && p.disconnected
    );
    if (existing) {
      // Reconnect — restore socket id, clear disconnected flag, cancel seat release timer
      if (existing.seatReleaseTimer) {
        clearTimeout(existing.seatReleaseTimer);
        existing.seatReleaseTimer = null;
      }
      existing.id = socket.id;
      existing.disconnected = false;
      socket.join(code);
      socket.emit('joinedRoom', { code });
      broadcastState(code);
      return;
    }

    // Validate name uniqueness (non-disconnected players)
    if (g.players.some(p => p.name.toLowerCase() === name.toLowerCase() && !p.disconnected)) {
      socket.emit('error', 'That name is already taken'); return;
    }
    // Validate seat
    if (seatIndex === undefined || seatIndex === null) {
      socket.emit('error', 'No seat selected'); return;
    }
    if (g.players.some(p => p.seatIndex === seatIndex && !p.disconnected)) {
      socket.emit('error', 'That seat is already taken'); return;
    }
    if (g.players.length >= 7) { socket.emit('error', 'Room is full (max 7 players)'); return; }

    // Late joiner: sitting out if mid-hand (set/done phase)
    const sittingOut = g.phase !== 'lobby' && g.phase !== 'bet';
    let newChips = g.startingChips;
    let poolBlocked = false;
    if (g.phase !== 'lobby' && g.poolContribution > 0) {
      if (newChips >= g.poolContribution) {
        newChips     = r(newChips - g.poolContribution);
        g.bonusPool  = r(g.bonusPool + g.poolContribution);
      } else {
        poolBlocked = true;
      }
    }
    const newPlayer = makePlayer(socket.id, name, newChips, seatIndex, {
      folded: sittingOut, playerReady: sittingOut, lateJoiner: sittingOut, poolBlocked
    });
    g.players.push(newPlayer);
    // Track chips entering the table
    g.totalBuyIns = r(g.totalBuyIns + newChips + (poolBlocked ? 0 : (g.phase !== 'lobby' && g.poolContribution > 0 ? g.poolContribution : 0)));
    socket.join(code);
    socket.emit('joinedRoom', { code });
    broadcastState(code);
  });

  // Start game (host only)
  socket.on('startGame', ({ code }) => {
    const g = rooms[code];
    if (!g || g.hostId !== socket.id) return;
    if (g.players.length < 2) { socket.emit('error', 'Need at least 2 players to start'); return; }

    // Assign host an arc seat if they still have seatIndex: null
    // (host bypasses seat picker, so we auto-assign the lowest free slot)
    const host = g.players[0];
    if (host.seatIndex === null || host.seatIndex === undefined) {
      const takenSeats = new Set(g.players.map(p => p.seatIndex).filter(s => s !== null && s !== undefined));
      for (let s = 0; s < 6; s++) {
        if (!takenSeats.has(s)) { host.seatIndex = s; break; }
      }
    }

    // Record initial buy-in for every player (for net P&L tracking)
    g.players.forEach(p => {
      p.stats.initialBuyIn = p.chips; // chips at game start before pool deduction
    });

    // Collect initial bonus pool contributions from ALL players including host
    if (g.poolContribution > 0) {
      g.players.forEach(p => {
        if (p.chips >= g.poolContribution) {
          p.chips     = r(p.chips     - g.poolContribution);
          g.bonusPool = r(g.bonusPool + g.poolContribution);
        } else {
          p.poolBlocked = true;
        }
      });
    }

    // Total chips on table = all player chips + pool (conservation baseline)
    g.totalBuyIns = r(g.players.reduce((s, p) => s + p.chips, 0) + g.bonusPool);

    g.phase = 'bet';
    broadcastState(code);
  });

  // Place bet
  socket.on('placeBet', ({ code, amount }) => {
    if (rateLimitBet(socket.id)) return;
    const g = rooms[code];
    if (!g || g.phase !== 'bet') return;
    const p = g.players.find(p => p.id === socket.id);
    if (!p || p.folded || p.poolBlocked) return;
    const idx = g.players.indexOf(p);
    if (idx === g.bankerIdx) return;
    const MAX_MAIN_BET = g.maxBet || 5;
    const available = Math.min(p.chips - p.bonusBet, MAX_MAIN_BET - p.bet);
    const add = Math.min(amount, available);
    if (add <= 0.001) return;
    p.bet = Math.round((p.bet + add) * 100) / 100;
    broadcastState(code);
  });

  socket.on('clearBet', ({ code }) => {
    if (rateLimitBet(socket.id)) return;
    const g = rooms[code];
    if (!g || g.phase !== 'bet') return;
    const p = g.players.find(p => p.id === socket.id);
    if (p) { p.bet = 0; broadcastState(code); }
  });

  socket.on('placeBonusBet', ({ code, amount }) => {
    if (rateLimitBet(socket.id)) return;
    const g = rooms[code];
    if (!g || g.phase !== 'bet') return;
    const p = g.players.find(p => p.id === socket.id);
    if (!p || p.folded || p.poolBlocked) return;
    const idx = g.players.indexOf(p);
    if (idx === g.bankerIdx) return;
    const MAX_BONUS_BET = 0.25;
    const available = Math.min(p.chips - p.bet, MAX_BONUS_BET - p.bonusBet);
    const add = Math.min(amount, available);
    if (add <= 0.001) return;
    p.bonusBet = Math.round((p.bonusBet + add) * 100) / 100;
    broadcastState(code);
  });

  socket.on('clearBonusBet', ({ code }) => {
    if (rateLimitBet(socket.id)) return;
    const g = rooms[code];
    if (!g || g.phase !== 'bet') return;
    const p = g.players.find(p => p.id === socket.id);
    if (p) { p.bonusBet = 0; broadcastState(code); }
  });


  // Player signals ready or sits out
  socket.on('playerReady', ({ code, sitOut }) => {
    const g = rooms[code];
    if (!g || g.phase !== 'bet') return;
    const p = g.players.find(p => p.id === socket.id);
    if (!p) return;
    const idx = g.players.indexOf(p);
    if (idx === g.bankerIdx) return; // banker doesn't need to ready up
    if (sitOut) {
      p.folded = true;
      p.bet = 0;
      p.bonusBet = 0;
    }
    p.playerReady = true;
    broadcastState(code);
  });

  // Player un-readies (Change Bet)
  socket.on('playerUnready', ({ code }) => {
    const g = rooms[code];
    if (!g || g.phase !== 'bet') return;
    const p = g.players.find(p => p.id === socket.id);
    if (!p) return;
    const idx = g.players.indexOf(p);
    if (idx === g.bankerIdx) return;
    p.playerReady = false;
    p.folded = false; // un-sit-out when changing bet
    broadcastState(code);
  });

  // Deal (current banker only)
  socket.on('deal', ({ code }) => {
    const g = rooms[code];
    if (!g || !isCurrentBanker(g, socket.id) || g.phase !== 'bet') return;
    // Check at least one non-banker player is betting
    const activePlayers = g.players.filter((p, i) => i !== g.bankerIdx && !p.disconnected);
    const bettors = activePlayers.filter(p => p.bet > 0);
    if (bettors.length === 0) { socket.emit('error', 'At least one player must place a bet'); return; }

    g.deck = shuffle(buildDeck());
    // Roll deal order number 1-7 (1=banker, 2=right of banker, clockwise)
    g.dealOrderNum = Math.floor(Math.random() * 7) + 1;
    // Auto-fold anyone below minBet (0 bet = sitting out; below minBet = must fold)
    if (g.minBet > 0) {
      g.players.forEach((p, i) => {
        if (i !== g.bankerIdx && p.bet > 0 && p.bet < g.minBet) {
          p.bet = 0; p.folded = true;
        }
      });
    }
    g.players.forEach(p => {
      p.hand = []; p.highHand = []; p.lowHand = [];
      p.handSet = false; p.playerReady = false; p.result = null;
      p.netChips = null; p.bonusNet = null;
      p.bonusLabel = ''; p.bonusWon = false;
      p.revealed = false;
    });
    const active = g.players.filter((p, i) => i === g.bankerIdx || (!p.folded && p.bet > 0));
    active.forEach(p => { for (let i = 0; i < 7; i++) p.hand.push(g.deck.pop()); });
    // Option B: deduct bonus bets from chips at deal time and hold in pool temporarily
    // This keeps chips+pool constant (conservation invariant maintained)
    active.forEach(p => {
      if (p.bonusBet > 0) {
        p.chips = Math.round((p.chips - p.bonusBet) * 100) / 100;
        g.bonusPool = Math.round((g.bonusPool + p.bonusBet) * 100) / 100; // held in pool until settle
      }
    });
    g.phase = 'set';
    broadcastState(code);
  });

  // Set hand (banker must set before players can confirm)
  socket.on('setHand', ({ code, highHand, lowHand }) => {
    const g = rooms[code];
    if (!g || g.phase !== 'set') return;
    const p = g.players.find(p => p.id === socket.id);
    if (!p || p.hand.length === 0) return;
    const pIdx = g.players.indexOf(p);
    const isBanker = pIdx === g.bankerIdx;
    // Non-bankers cannot finalise until banker has set
    if (!isBanker && !g.players[g.bankerIdx].handSet) {
      socket.emit('error', 'Banker must set their hand first'); return;
    }
    if (highHand.length !== 5 || lowHand.length !== 2) {
      socket.emit('error', 'Must have 5 cards in high hand and 2 in low hand'); return;
    }
    // Validate cards belong to player's hand
    const handKeys = p.hand.map(c => `${c.rank}${c.suit}`);
    const submitted = [...highHand, ...lowHand].map(c => `${c.rank}${c.suit}`);
    const valid = submitted.every(k => handKeys.includes(k)) && new Set(submitted).size === 7;
    if (!valid) { socket.emit('error', 'Invalid hand — cards do not match your dealt hand'); return; }
    p.highHand = highHand;
    p.lowHand = lowHand;
    p.handSet = true;
    broadcastState(code);

    // Auto-reveal if everyone is set
    const needToSet = g.players.filter((p, i) => i === g.bankerIdx ? p.hand.length > 0 : !p.folded && p.bet > 0);
    if (needToSet.every(p => p.handSet)) {
      settleRound(code);
      broadcastState(code);
    }
  });

  // House way request
  socket.on('houseWay', ({ code }) => {
    const g = rooms[code];
    if (!g) return;
    const p = g.players.find(p => p.id === socket.id);
    if (!p || p.hand.length === 0) return;
    const { high, low } = applyHouseWay(p.hand);
    socket.emit('houseWaySuggestion', { high, low });
  });

  // Reveal (current banker only)
  socket.on('reveal', ({ code }) => {
    const g = rooms[code];
    if (!g || !isCurrentBanker(g, socket.id) || g.phase !== 'set') return;
    const needToSet = g.players.filter((p, i) => i === g.bankerIdx ? p.hand.length > 0 : !p.folded && p.bet > 0);
    const unset = needToSet.filter(p => !p.handSet).map(p => p.name);
    if (unset.length > 0) { socket.emit('error', `${unset.join(', ')} haven't set their hand yet`); return; }
    settleRound(code);
    broadcastState(code);
  });

  // Next round (current banker only)
  socket.on('nextRound', ({ code }) => {
    const g = rooms[code];
    if (!g || !isCurrentBanker(g, socket.id) || g.phase !== 'done') return;
    // Block Next Round while banker owes chips to winners
    if (g.bankerInsolvent) { socket.emit('error', 'Banker must buy in to cover pending payouts first'); return; }
    g.players.forEach(p => {
      p.bet = 0; p.bonusBet = 0;
      p.hand = []; p.highHand = []; p.lowHand = [];
      p.handSet = false; p.folded = false;
      p.playerReady = false;
      p.lateJoiner = false;
      p.poolBlocked = false; // cleared each round — they'll be re-checked on next deal
      p.result = null; p.netChips = null;
      p.bonusNet = null; p.bonusLabel = ''; p.bonusWon = false;
      p.revealed = false;
    });
    // Rotate banker, skipping any disconnected players
    const playerCount = g.players.length;
    let next = (g.bankerIdx + 1) % playerCount;
    for (let i = 0; i < playerCount; i++) {
      if (!g.players[next].disconnected) break;
      next = (next + 1) % playerCount;
    }
    g.bankerIdx = next;
    g.round++;
    g.revealStep = -1;
    g.dealOrderNum = null;
    g.bankerInsolvent = false;
    g.pendingBankerDelta = 0;
    g.phase = 'bet';
    broadcastState(code);
  });

  // Banker sets pool top-up amount and charges all players
  socket.on('triggerPoolTopUp', ({ code, amount }) => {
    const g = rooms[code];
    if (!g || !isCurrentBanker(g, socket.id)) return;
    const topUp = Math.round(parseFloat(amount) * 100) / 100;
    if (topUp <= 0) return;
    g.pendingPoolTopUpAmount = topUp;
    // Notify all players of the top-up
    io.to(code).emit('poolTopUpNotice', { amount: topUp, bankerName: g.players[g.bankerIdx].name });
    executePoolTopUp(g, topUp, code, io);
    // If pool can now cover any pending bonus payouts, resolve them
    if (!g.pendingPoolTopUp) {
      // resolve any bonusPending amounts
      g.players.forEach(p => {
        if (p.bonusPending > 0) {
          if (poolCanCover(g, p.bonusPending)) {
            g.bonusPool = Math.round((g.bonusPool - p.bonusPending) * 100) / 100;
            p.chips = Math.round((p.chips + p.bonusPending) * 100) / 100;
            p.bonusPending = 0;
          }
        }
      });
    }
    broadcastState(code);
  });

  // Rotate banker (current banker only, bet phase only)
  socket.on('rotateBanker', ({ code }) => {
    const g = rooms[code];
    if (!g || !isCurrentBanker(g, socket.id) || g.phase !== 'bet') return;
    g.bankerIdx = (g.bankerIdx + 1) % g.players.length;
    broadcastState(code);
  });

  // Buy in — cap $500, notify table, track totalBuyIns, resolve insolvency/pool-block
  socket.on('buyIn', ({ code, amount }) => {
    const g = rooms[code];
    if (!g) return;
    const p = g.players.find(p => p.id === socket.id);
    if (!p || amount < 0.01) return;
    const headroom = Math.max(0, 500 - p.chips);
    const actual = Math.round(Math.min(amount, headroom) * 100) / 100;
    if (actual <= 0) { socket.emit('error', 'You are already at the chip limit ($500)'); return; }
    // Flag player as adding chips so table sees status
    p.addingChips = true;
    broadcastState(code);
    p.chips = Math.round((p.chips + actual) * 100) / 100;
    p.stats.buyins = Math.round((p.stats.buyins + actual) * 100) / 100;
    g.totalBuyIns  = Math.round((g.totalBuyIns  + actual) * 100) / 100;
    p.addingChips = false;
    // Notify all players at table
    io.to(code).emit('chipReload', { name: p.name, amount: actual, total: p.chips });

    // Unblock if previously pool-blocked and can now afford contribution
    if (p.poolBlocked && g.poolContribution > 0 && p.chips >= g.poolContribution) {
      p.chips -= g.poolContribution;
      g.bonusPool += g.poolContribution;
      p.poolBlocked = false;
    }

    // If banker bought in, check if insolvency is now resolved
    const isBanker = g.players.indexOf(p) === g.bankerIdx;
    if (isBanker && g.bankerInsolvent && g.pendingBankerDelta > 0) {
      const banker = p;
      if (banker.chips >= g.pendingBankerDelta) {
        // Banker can now cover — execute suspended transfers
        g.players.forEach((pl, idx) => {
          if (idx === g.bankerIdx || pl.folded || pl.bet === 0 || pl.result === null) return;
          pl.chips     = Math.round((pl.chips     + pl.netChips) * 100) / 100;
          banker.chips = Math.round((banker.chips - pl.netChips) * 100) / 100;
        });
        g.bankerInsolvent = false;
        g.pendingBankerDelta = 0;
      }
    }

    broadcastState(code);
  });

  // Advance reveal — current banker clicks to flip next player's cards
  socket.on('advanceReveal', ({ code }) => {
    const g = rooms[code];
    if (!g || !isCurrentBanker(g, socket.id) || g.phase !== 'done') return;
    // Build ordered list of non-banker active players in seat order
    const activePlayers = g.players
      .map((p, i) => ({ p, i }))
      .filter(({ p, i }) => i !== g.bankerIdx && p.hand.length > 0 && !p.folded);
    // revealStep 0 = banker already shown; 1..N = reveal activePlayers[0..N-1]
    const nextIdx = g.revealStep; // activePlayers index to reveal next
    if (nextIdx < activePlayers.length) {
      activePlayers[nextIdx].p.revealed = true;
      g.revealStep++;
    }
    broadcastState(code);
  });

  // Chat message
  socket.on('chatMessage', ({ code, text }) => {
    const g = rooms[code];
    if (!g) return;
    const p = g.players.find(p => p.id === socket.id);
    if (!p) return;
    const clean = String(text).trim().slice(0, 200);
    if (!clean) return;
    io.to(code).emit('chatMessage', {
      name: p.name,
      text: clean,
      timestamp: Date.now()
    });
  });

  // Disconnect
  socket.on('disconnect', () => {
    // Clean up rate limit entry
    delete betEventCounts[socket.id];
    for (const [code, g] of Object.entries(rooms)) {
      const idx = g.players.findIndex(p => p.id === socket.id);
      if (idx === -1) continue;
      io.to(code).emit('playerLeft', { name: g.players[idx].name });
      if (g.phase === 'lobby') {
        g.players.splice(idx, 1);
        if (g.players.length === 0) { delete rooms[code]; break; }
        if (g.hostId === socket.id) g.hostId = g.players[0].id;
      } else {
        const p = g.players[idx];
        // Mark disconnected, fold any active bet, hold seat for 15 minutes
        p.folded = true;
        p.bet = 0;
        p.disconnected = true;
        p.seatReleaseTimer = setTimeout(() => {
          const stillThere = g.players.findIndex(pl => pl.id === socket.id);
          if (stillThere !== -1 && g.players[stillThere].disconnected) {
            g.players.splice(stillThere, 1);
            if (g.bankerIdx >= g.players.length) g.bankerIdx = 0;
            broadcastState(code);
          }
        }, 900000); // 15 minute hold

        // If disconnecting during set phase and player has unset hand,
        // auto-apply House Way so the round is never blocked.
        // This covers both the banker and regular players.
        if (g.phase === 'set' && p.hand.length > 0 && !p.handSet) {
          const { high, low } = applyHouseWay(p.hand);
          p.highHand = high;
          p.lowHand  = low;
          p.handSet  = true;
          // Check if all active players are now set → settle
          const needToSet = g.players.filter((pl, i) =>
            i === g.bankerIdx ? pl.hand.length > 0 : !pl.folded && pl.bet > 0
          );
          if (needToSet.every(pl => pl.handSet)) {
            settleRound(code);
          }
        }
      }
      broadcastState(code);
      break;
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Pai Gow server running on port ${PORT}`));
