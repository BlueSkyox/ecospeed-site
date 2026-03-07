import { NextRequest, NextResponse } from "next/server";
import { hvacPowerFromTemp } from "@/lib/ev";

export async function GET(req: NextRequest) {
  const city = req.nextUrl.searchParams.get("city");
  if (!city) {
    return NextResponse.json({ error: "Missing city" }, { status: 400 });
  }

  try {
    const g = await fetch(
      `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=en&format=json`,
      { cache: "no-store" },
    );
    if (!g.ok) return NextResponse.json({ error: "Geocoding failed" }, { status: 502 });
    const gj = await g.json();
    const first = gj?.results?.[0];
    if (!first) return NextResponse.json({ error: "City not found" }, { status: 404 });

    const w = await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${first.latitude}&longitude=${first.longitude}&current=temperature_2m,precipitation,rain`,
      { cache: "no-store" },
    );
    if (!w.ok) return NextResponse.json({ error: "Weather failed" }, { status: 502 });
    const wj = await w.json();
    const cur = wj?.current ?? {};
    const tempC = Number(cur.temperature_2m ?? 20);
    const rainMmH = Number(cur.rain ?? cur.precipitation ?? 0);
    const hvacDeltaKw = hvacPowerFromTemp(tempC, 20);
    const heatingKw = tempC < 20 ? hvacDeltaKw : 0;
    const coolingKw = tempC > 20 ? hvacDeltaKw : 0;

    return NextResponse.json({
      city: first.name,
      country: first.country,
      temperatureC: tempC,
      rainMmH,
      hvacDeltaKw,
      heatingKw,
      coolingKw,
    });
  } catch {
    return NextResponse.json({ error: "Weather unavailable" }, { status: 500 });
  }
}
