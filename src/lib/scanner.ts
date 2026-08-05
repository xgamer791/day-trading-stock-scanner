import { getDemoScanner } from "@/lib/demo";
import { fetchLiveScanner, hasPolygonKey } from "@/lib/polygon";
import type { ScannerPayload } from "@/lib/types";

export async function getScannerPayload(): Promise<ScannerPayload> {
  if (!hasPolygonKey()) {
    return getDemoScanner();
  }
  try {
    return await fetchLiveScanner();
  } catch (err) {
    console.error("Polygon fetch failed, falling back to demo:", err);
    const demo = getDemoScanner();
    return { ...demo, source: "demo" };
  }
}
