import { NextRequest, NextResponse } from "next/server";

type Body = { coords: [number, number][] };

export async function POST(req: NextRequest) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }

  const coords = body?.coords ?? [];
  if (!Array.isArray(coords) || coords.length < 2) {
    return NextResponse.json({ error: "Missing coords" }, { status: 400 });
  }

  try {
    const chunkSize = 90;
    const out: number[] = [];
    for (let i = 0; i < coords.length; i += chunkSize) {
      const chunk = coords.slice(i, i + chunkSize);
      const locations = chunk.map((c) => `${c[1]},${c[0]}`).join("|");
      const r = await fetch(`https://api.open-elevation.com/api/v1/lookup?locations=${encodeURIComponent(locations)}`, {
        cache: "no-store",
      });
      if (!r.ok) throw new Error("elevation failed");
      const j = await r.json();
      const vals = (j?.results ?? []).map((x: { elevation?: number }) => Number(x.elevation ?? 0));
      out.push(...vals);
    }
    if (out.length !== coords.length) {
      return NextResponse.json({ elevations: new Array(coords.length).fill(0) });
    }
    return NextResponse.json({ elevations: out });
  } catch {
    return NextResponse.json({ elevations: new Array(coords.length).fill(0) });
  }
}

