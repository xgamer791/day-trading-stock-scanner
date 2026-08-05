import { ScannerBoard } from "@/components/ScannerBoard";
import { getScannerPayload } from "@/lib/scanner";

export const dynamic = "force-dynamic";

export default async function Home() {
  const initial = await getScannerPayload();
  return <ScannerBoard initial={initial} />;
}
