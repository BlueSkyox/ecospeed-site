import { NextRequest, NextResponse } from "next/server";

function orsKey() {
  const key = process.env.OPENROUTESERVICE_API_KEY || process.env.ORS_API_KEY;
  if (!key) {
    throw new Error("Missing OPENROUTESERVICE_API_KEY or ORS_API_KEY");
  }
  return key;
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

