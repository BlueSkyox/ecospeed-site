import { NextRequest, NextResponse } from "next/server";
import { getTripHistory, getTripSession, markTripActive } from "@/lib/trip-session-store";

type Body = {
  tripId: string;
  batteryPctAfter?: number;
};

function pickSampleIndices(totalPoints: number, maxSamples: number): number[] {
  if (totalPoints <= 0) return [];
  if (totalPoints <= maxSamples) return Array.from({ length: totalPoints }, (_, i) => i);
  const out: number[] = [];
  for (let i = 0; i < maxSamples; i += 1) {
    out.push(Math.round((i * (totalPoints - 1)) / (maxSamples - 1)));
  }
  return [...new Set(out)].sort((a, b) => a - b);
}

async function pointWeather(lat: number, lon: number) {
  const r = await Promise.race([
    fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,precipitation,rain`, {
      cache: "no-store",
    }),
    new Promise<Response>((_, reject) => setTimeout(() => reject(new Error("timeout")), 7000)),
  ]);
  if (!r.ok) throw new Error("weather failed");
  const j = await r.json();
  const cur = j?.current ?? {};
  return {
    tempC: Number(cur.temperature_2m ?? 20),
    rainMmH: Number(cur.rain ?? cur.precipitation ?? 0),
  };
}

export async function POST(req: NextRequest) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }
  if (!body?.tripId) return NextResponse.json({ error: "Missing tripId" }, { status: 400 });
  const session = getTripSession(body.tripId);
  if (!session) return NextResponse.json({ error: "Trip not found" }, { status: 404 });

  const updated = markTripActive(body.tripId, body.batteryPctAfter);
  if (!updated) return NextResponse.json({ error: "Resume failed" }, { status: 500 });

  try {
    const coords = updated.remainingCoords ?? [];
    const history = getTripHistory(body.tripId);
    if (coords.length < 2) return NextResponse.json({ ok: true, session: updated, weatherRefresh: null, history });
    const idx = pickSampleIndices(coords.length, 8);
    const samples = [];
    for (const i of idx) {
      const [lon, lat] = coords[i];
      const w = await pointWeather(lat, lon);
      samples.push({ index: i, lat, lon, ...w });
    }
    return NextResponse.json({ ok: true, session: updated, weatherRefresh: { samples }, history });
  } catch {
    return NextResponse.json({ ok: true, session: updated, weatherRefresh: null, history: getTripHistory(body.tripId) });
  }
}
