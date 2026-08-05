import assert from "node:assert/strict";
import { filterHodGainers, getMarketSession, toMover } from "../src/lib/market";

function testHodFilterKeepsPeaksOnly() {
  const peak = toMover({
    symbol: "PEAK",
    price: 10,
    prevClose: 8,
    dayHigh: 10,
    dayLow: 8,
    volume: 2_000_000,
  });
  const off = toMover({
    symbol: "OFF",
    price: 9,
    prevClose: 8,
    dayHigh: 10,
    dayLow: 8,
    volume: 2_000_000,
  });
  assert.ok(peak);
  assert.ok(off);
  const hits = filterHodGainers([peak!, off!], { minChangePct: 1, minVolume: 1000 });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].symbol, "PEAK");
  assert.equal(hits[0].atHod, true);
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
  const hits = filterHodGainers([down!], { minChangePct: 1 });
  assert.equal(hits.length, 0);
}

function testNearHodTolerance() {
  // Within 0.35% of high should count as HOD
  const near = toMover({
    symbol: "NEAR",
    price: 99.7,
    prevClose: 90,
    dayHigh: 100,
    dayLow: 90,
    volume: 3_000_000,
  });
  assert.ok(near?.atHod);
}

function testSessionHelper() {
  const session = getMarketSession(new Date());
  assert.ok(["premarket", "regular", "afterhours", "closed"].includes(session));
}

testHodFilterKeepsPeaksOnly();
testLoserRejected();
testNearHodTolerance();
testSessionHelper();
console.log("ok");
