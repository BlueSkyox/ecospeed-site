import { NextRequest, NextResponse } from "next/server";

type Body = { coords: [number, number][] };

function pickSampleIndices(totalPoints: number, maxSamples: number): number[] {
  if (totalPoints <= 0) return [];
  if (totalPoints <= maxSamples) return Array.from({ length: totalPoints }, (_, i) => i);
  const out: number[] = [];
  for (let i = 0; i < maxSamples; i += 1) {
    out.push(Math.round((i * (totalPoints - 1)) / (maxSamples - 1)));
  }
  return [...new Set(out)].sort((a, b) => a - b);
}

async function fetchPointWeather(lat: number, lon: number): Promise<{ tempC: number; rainMmH: number }> {
  const r = await fetch(
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,precipitation,rain`,
    { cache: "no-store" },
  );
  if (!r.ok) throw new Error("weather fetch failed");
  const j = await r.json();
  const cur = j?.current ?? {};
  return {
    tempC: Number(cur.temperature_2m ?? 20),
    rainMmH: Number(cur.rain ?? cur.precipitation ?? 0),
  };
}

function interpolateByIndex(valuesBySample: Map<number, number>, length: number): number[] {
  if (length <= 0) return [];
  const keys = [...valuesBySample.keys()].sort((a, b) => a - b);
  if (keys.length === 0) return new Array(length).fill(0);
  const out = new Array<number>(length).fill(valuesBySample.get(keys[0]) ?? 0);
  for (let i = 0; i < keys.length - 1; i += 1) {
    const a = keys[i];
    const b = keys[i + 1];
    const va = valuesBySample.get(a) ?? 0;
    const vb = valuesBySample.get(b) ?? va;
    const span = Math.max(1, b - a);
    for (let k = a; k <= b; k += 1) {
      const t = (k - a) / span;
      out[k] = va + (vb - va) * t;
    }
  }
  const lastKey = keys[keys.length - 1];
  const lastVal = valuesBySample.get(lastKey) ?? 0;
  for (let i = lastKey; i < length; i += 1) out[i] = lastVal;
  return out;
}

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
    const sampleIdx = pickSampleIndices(coords.length, 12);
    const tempMap = new Map<number, number>();
    const rainMap = new Map<number, number>();

    for (const idx of sampleIdx) {
      const [lon, lat] = coords[idx];
      const w = await fetchPointWeather(lat, lon);
      tempMap.set(idx, w.tempC);
      rainMap.set(idx, Math.max(0, w.rainMmH));
    }

    const pointTemp = interpolateByIndex(tempMap, coords.length);
    const pointRain = interpolateByIndex(rainMap, coords.length);
    const segmentTemps = pointTemp.slice(1).map((v, i) => (v + pointTemp[i]) / 2);
    const segmentRains = pointRain.slice(1).map((v, i) => Math.max(0, (v + pointRain[i]) / 2));

    return NextResponse.json({
      pointTempsC: pointTemp,
      pointRainsMmH: pointRain,
      segmentTempsC: segmentTemps,
      segmentRainsMmH: segmentRains,
      samples: sampleIdx.length,
    });
  } catch {
    return NextResponse.json(
      {
        pointTempsC: new Array(coords.length).fill(20),
        pointRainsMmH: new Array(coords.length).fill(0),
        segmentTempsC: new Array(Math.max(0, coords.length - 1)).fill(20),
        segmentRainsMmH: new Array(Math.max(0, coords.length - 1)).fill(0),
        samples: 0,
      },
      { status: 200 },
    );
  }
}

