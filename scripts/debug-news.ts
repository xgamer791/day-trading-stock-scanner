import { fetchLiveNewsQuick } from "../src/lib/liveNews";
import { fetchLiveNewsFeedQuick } from "../src/lib/fetchLiveNewsFeed";

async function main() {
  const t0 = Date.now();
  const quick = await fetchLiveNewsQuick(100);
  console.log("quick count", quick.length, "ms", Date.now() - t0);
  console.log("newest", quick[0]?.publishedAt, quick[0]?.title?.slice(0, 60));
  const t1 = Date.now();
  const feed = await fetchLiveNewsFeedQuick();
  console.log("feedQuick count", feed.length, "ms", Date.now() - t1);
}
main().catch((e) => { console.error(e); process.exit(1); });
