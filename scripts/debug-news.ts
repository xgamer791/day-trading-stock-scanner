import { getEnabledNewsSources } from "../src/lib/newsSources";
import { fetchLiveNews } from "../src/lib/liveNews";

async function main() {
  console.log("registeredSources", getEnabledNewsSources().length);
  const t0 = Date.now();
  const items = await fetchLiveNews(100);
  console.log("count", items.length, "ms", Date.now() - t0);
  console.log("newest", items[0]?.publishedAt, items[0]?.publisher, items[0]?.title?.slice(0, 60));
  console.log("oldest", items.at(-1)?.publishedAt, items.at(-1)?.title?.slice(0, 50));
  const pubs = new Map<string, number>();
  for (const n of items) pubs.set(n.publisher, (pubs.get(n.publisher) || 0) + 1);
  console.log("publishers", [...pubs.entries()].sort((a,b)=>b[1]-a[1]).slice(0,12));
  for (let i = 1; i < items.length; i++) {
    if (Date.parse(items[i - 1].publishedAt) < Date.parse(items[i].publishedAt)) {
      throw new Error("not newest-first at " + i);
    }
  }
  console.log("ok newest-first");
}
main().catch((e) => { console.error(e); process.exit(1); });
