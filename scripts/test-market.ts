import assert from "node:assert/strict";
import {
  currentTradingDayStartEt,
  etWallTimeToUtc,
  filterHodGainers,
  getMarketCountdown,
  getMarketSession,
  nextRegularOpen,
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


/* ---------------------------------------------------------------- *
 * Trading-day boundary — this is what clears all three boards.
 * A trading day runs 04:00 ET → next 04:00 ET, weekends roll back to
 * Friday so Friday's final boards persist through the weekend.
 * ---------------------------------------------------------------- */

function testTradingDayMidSession() {
  // Wed Aug 5 2026, 11:00 ET — mid regular session.
  const now = etWallTimeToUtc(2026, 8, 5, 11, 0, 0);
  assert.equal(
    currentTradingDayStartEt(now).getTime(),
    etWallTimeToUtc(2026, 8, 5, 4, 0, 0).getTime(),
  );
}

function testTradingDayAfterHoursStillToday() {
  // Wed 20:30 ET — after-hours has ended but the day has not rolled.
  const now = etWallTimeToUtc(2026, 8, 5, 20, 30, 0);
  assert.equal(
    currentTradingDayStartEt(now).getTime(),
    etWallTimeToUtc(2026, 8, 5, 4, 0, 0).getTime(),
  );
}

function testTradingDayBeforePremarketRollsBack() {
  // Thu 03:59 ET — still Wednesday's trading day; boards must not have cleared.
  const before = etWallTimeToUtc(2026, 8, 6, 3, 59, 0);
  assert.equal(
    currentTradingDayStartEt(before).getTime(),
    etWallTimeToUtc(2026, 8, 5, 4, 0, 0).getTime(),
  );
  // Thu 04:00 ET — new premarket opens, boards clear.
  const after = etWallTimeToUtc(2026, 8, 6, 4, 0, 0);
  assert.equal(
    currentTradingDayStartEt(after).getTime(),
    etWallTimeToUtc(2026, 8, 6, 4, 0, 0).getTime(),
  );
}

function testTradingDayWeekendHoldsFriday() {
  // Fri Aug 7 2026 is a weekday; Sat/Sun must both resolve back to Friday 04:00.
  const friday = etWallTimeToUtc(2026, 8, 7, 4, 0, 0);
  for (const now of [
    etWallTimeToUtc(2026, 8, 8, 12, 0, 0), // Saturday
    etWallTimeToUtc(2026, 8, 9, 23, 0, 0), // Sunday night
    etWallTimeToUtc(2026, 8, 10, 3, 30, 0), // Monday pre-04:00
  ]) {
    assert.equal(currentTradingDayStartEt(now).getTime(), friday.getTime());
  }
  // Monday 04:00 ET — new week's premarket, boards clear.
  assert.equal(
    currentTradingDayStartEt(etWallTimeToUtc(2026, 8, 10, 4, 0, 0)).getTime(),
    etWallTimeToUtc(2026, 8, 10, 4, 0, 0).getTime(),
  );
}

testTopGainersRanksByPct();
testLoserRejected();
testSessionHelper();
testCountdownDuringRegular();
testCountdownNearClose();
testCountdownPremarketOpens();
testCountdownWeekendToMonday();
testTradingDayMidSession();
testTradingDayAfterHoursStillToday();
testTradingDayBeforePremarketRollsBack();
testTradingDayWeekendHoldsFriday();
console.log("ok");
