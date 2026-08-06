import assert from "node:assert/strict";
import {
  etWallTimeToUtc,
  filterHodGainers,
  getMarketCountdown,
  getMarketSession,
  nextRegularOpen,
  sessionBoardTradingDayKey,
  toMover,
} from "../src/lib/market";

function testTopGainersRanksByPct() {
  const a = toMover({
    symbol: "BIG",
    price: 10,
    prevClose: 5,
    dayHigh: 12,
    dayLow: 5,
    volume: 100,
  });
  const b = toMover({
    symbol: "MID",
    price: 9,
    prevClose: 8,
    dayHigh: 10,
    dayLow: 8,
    volume: 50,
  });
  assert.ok(a);
  assert.ok(b);
  // Both kept even if off HOD / low volume — top % only
  const hits = filterHodGainers([b!, a!], { minChangePct: 0 });
  assert.equal(hits.length, 2);
  assert.equal(hits[0].symbol, "BIG");
  assert.equal(hits[1].symbol, "MID");
}

function testLoserRejected() {
  const down = toMover({
    symbol: "DOWN",
    price: 9.9,
    prevClose: 10,
    dayHigh: 10,
    dayLow: 9,
    volume: 5_000_000,
  });
  assert.ok(down);
  const hits = filterHodGainers([down!], { minChangePct: 0 });
  assert.equal(hits.length, 0);
}

function testSessionHelper() {
  const session = getMarketSession(new Date());
  assert.ok(["premarket", "regular", "afterhours", "closed"].includes(session));
}

function testCountdownDuringRegular() {
  // Wednesday 2026-08-05 13:30:00 ET — regular session, 2h30m to close
  const now = etWallTimeToUtc(2026, 8, 5, 13, 30, 0);
  assert.equal(getMarketSession(now), "regular");
  const cd = getMarketCountdown(now);
  assert.equal(cd.kind, "closes");
  assert.equal(cd.clock, "2:30:00");
  assert.equal(cd.label, "CLOSES IN 2:30:00");
}

function testCountdownNearClose() {
  const now = etWallTimeToUtc(2026, 8, 5, 15, 57, 28);
  const cd = getMarketCountdown(now);
  assert.equal(cd.kind, "closes");
  assert.equal(cd.clock, "02:32");
  assert.equal(cd.label, "CLOSES IN 02:32");
}

function testCountdownPremarketOpens() {
  const now = etWallTimeToUtc(2026, 8, 5, 8, 0, 0);
  assert.equal(getMarketSession(now), "premarket");
  const cd = getMarketCountdown(now);
  assert.equal(cd.kind, "opens");
  assert.equal(cd.clock, "1:30:00");
  assert.equal(cd.label, "OPENS IN 1:30:00");
}

function testCountdownWeekendToMonday() {
  // Saturday Aug 8 2026 → next open Monday Aug 10 09:30 ET
  const now = etWallTimeToUtc(2026, 8, 8, 12, 0, 0);
  assert.equal(getMarketSession(now), "closed");
  const open = nextRegularOpen(now);
  const expected = etWallTimeToUtc(2026, 8, 10, 9, 30, 0);
  assert.equal(open.getTime(), expected.getTime());
  const cd = getMarketCountdown(now);
  assert.equal(cd.kind, "opens");
  assert.match(cd.label, /^OPENS IN /);
}

function testSessionBoardDayKeyRollsAtPremarket() {
  // Tue 3:59 AM ET — still prior trading day (Mon)
  const before = etWallTimeToUtc(2026, 8, 4, 3, 59, 0);
  assert.equal(getMarketSession(before), "closed");
  assert.equal(sessionBoardTradingDayKey(before), "2026-08-03");

  // Tue 4:00 AM ET — new premarket day; overnight holds must not match this key
  const open = etWallTimeToUtc(2026, 8, 4, 4, 0, 0);
  assert.equal(getMarketSession(open), "premarket");
  assert.equal(sessionBoardTradingDayKey(open), "2026-08-04");

  // Monday regular still keyed to Monday
  const regular = etWallTimeToUtc(2026, 8, 3, 12, 0, 0);
  assert.equal(getMarketSession(regular), "regular");
  assert.equal(sessionBoardTradingDayKey(regular), "2026-08-03");
}

/** RTH hold key must match the morning premarket write key (same calendar day). */
function testPremarketHoldKeySurvivesRegularSession() {
  const pre = etWallTimeToUtc(2026, 8, 6, 8, 0, 0);
  const rth = etWallTimeToUtc(2026, 8, 6, 11, 0, 0);
  assert.equal(getMarketSession(pre), "premarket");
  assert.equal(getMarketSession(rth), "regular");
  assert.equal(sessionBoardTradingDayKey(pre), sessionBoardTradingDayKey(rth));
  assert.equal(sessionBoardTradingDayKey(rth), "2026-08-06");
}

/** Gainers + AH holds share the same trading-day key through afterhours and overnight closed. */
function testAllSessionHoldKeysAlignThroughClose() {
  const regular = etWallTimeToUtc(2026, 8, 6, 12, 0, 0);
  const ah = etWallTimeToUtc(2026, 8, 6, 17, 0, 0);
  const closed = etWallTimeToUtc(2026, 8, 6, 21, 0, 0);
  assert.equal(getMarketSession(regular), "regular");
  assert.equal(getMarketSession(ah), "afterhours");
  assert.equal(getMarketSession(closed), "closed");
  const key = sessionBoardTradingDayKey(regular);
  assert.equal(sessionBoardTradingDayKey(ah), key);
  assert.equal(sessionBoardTradingDayKey(closed), key);
  assert.equal(key, "2026-08-06");
}

testTopGainersRanksByPct();
testLoserRejected();
testSessionHelper();
testCountdownDuringRegular();
testCountdownNearClose();
testCountdownPremarketOpens();
testCountdownWeekendToMonday();
testSessionBoardDayKeyRollsAtPremarket();
testPremarketHoldKeySurvivesRegularSession();
testAllSessionHoldKeysAlignThroughClose();
console.log("ok");
