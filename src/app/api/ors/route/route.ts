import { NextRequest, NextResponse } from "next/server";

function orsKey() {
  const key = process.env.OPENROUTESERVICE_API_KEY || process.env.ORS_API_KEY;
  if (!key) {
    throw new Error("Missing OPENROUTESERVICE_API_KEY or ORS_API_KEY");
  }
  return key;
}

type Body = {
  start: [number, number];
  end: [number, number];
};

export async function POST(req: NextRequest) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }
  if (!body?.start || !body?.end) {
    return NextResponse.json({ error: "Missing start/end" }, { status: 400 });
  }

  try {
    const r = await fetch("https://api.openrouteservice.org/v2/directions/driving-car/geojson", {
      method: "POST",
      headers: {
        Authorization: orsKey(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        coordinates: [body.start, body.end],
        instructions: true,
        elevation: false,
        extra_info: ["waytype"],
      }),
      cache: "no-store",
    });

    if (!r.ok) return NextResponse.json({ error: "Route failed" }, { status: 502 });
    const data = await r.json();
    const feat = data?.features?.[0];
    const coords = feat?.geometry?.coordinates;
    const seg0 = feat?.properties?.segments?.[0];
    const steps = seg0?.steps ?? [];
    const wayVals = feat?.properties?.extra_info?.waytype?.values ?? [];
    const waytypes = wayVals.map((v: [number, number, number]) => ({
      from: v[0],
      to: v[1],
      wayType: v[2],
    }));

    if (!Array.isArray(coords) || coords.length < 2) {
      return NextResponse.json({ error: "No route geometry" }, { status: 404 });
    }

    return NextResponse.json({
      coords,
      lengthM: Number(seg0?.distance ?? 0),
      durationS: Number(seg0?.duration ?? 0),
      steps,
      waytypes,
    });
  } catch {
    return NextResponse.json({ error: "Route unavailable" }, { status: 500 });
  }
}

