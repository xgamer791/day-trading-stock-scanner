import { NextResponse } from "next/server";
import { getScannerPayload } from "@/lib/scanner";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  const payload = await getScannerPayload();
  return NextResponse.json(payload, {
    headers: {
      "Cache-Control": "no-store, max-age=0",
    },
  });
}
