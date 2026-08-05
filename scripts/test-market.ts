import assert from "node:assert/strict";
import { filterHodGainers, getMarketSession, toMover } from "../src/lib/market";

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

testTopGainersRanksByPct();
testLoserRejected();
testSessionHelper();
console.log("ok");
