import { NextRequest, NextResponse } from "next/server";

const DEFAULT_ORS_API_KEY =
  "eyJvcmciOiI1YjNjZTM1OTc4NTExMTAwMDFjZjYyNDgiLCJpZCI6IjA5MDkyNTdkYTlmNzQ5NmNhNjMxNzVjZGM1NTE0ZWYzIiwiaCI6Im11cm11cjY0In0=";

function orsKey() {
  return process.env.OPENROUTESERVICE_API_KEY || process.env.ORS_API_KEY || DEFAULT_ORS_API_KEY;
}

export async function GET(req: NextRequest) {
  const text = req.nextUrl.searchParams.get("text");
  if (!text) return NextResponse.json({ error: "Missing text" }, { status: 400 });

  try {
    const url = `https://api.openrouteservice.org/geocode/search?api_key=${encodeURIComponent(
      orsKey(),
    )}&text=${encodeURIComponent(text)}&size=1`;
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) return NextResponse.json({ error: "Geocode failed" }, { status: 502 });
    const data = await r.json();
    const coord = data?.features?.[0]?.geometry?.coordinates;
    if (!coord) return NextResponse.json({ error: "Address not found" }, { status: 404 });
    return NextResponse.json({ coord });
  } catch {
    return NextResponse.json({ error: "Geocode unavailable" }, { status: 500 });
  }
}

