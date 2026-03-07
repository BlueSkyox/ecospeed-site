import { NextRequest, NextResponse } from "next/server";
import { saveTripSession } from "@/lib/trip-session-store";

type Body = {
  tripId: string;
  segmentIndex?: number;
  batteryPctBefore?: number;
  didRecharge?: boolean;
  batteryPctAfter?: number;
  notes?: string;
  remainingCoords?: [number, number][];
  distanceKm?: number;
  logbook?: Array<{
    id_segment: number;
    distance_km: number;
    conso_reelle_kwh?: number;
    conso_theorique_kwh?: number;
    cout_eur?: number;
    meteo?: { temperature_c?: number; pluie_mmh?: number };
  }>;
};

export async function POST(req: NextRequest) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }
  if (!body?.tripId) return NextResponse.json({ error: "Missing tripId" }, { status: 400 });

  const session = saveTripSession({
    tripId: body.tripId,
    status: "paused",
    pausedAt: new Date().toISOString(),
    segmentIndex: body.segmentIndex,
    batteryPctBefore: body.batteryPctBefore,
    batteryPctAfter: body.batteryPctAfter,
    didRecharge: body.didRecharge,
    notes: body.notes,
    remainingCoords: body.remainingCoords,
    distanceKm: Number(body.distanceKm ?? 0),
    logbook: Array.isArray(body.logbook) ? body.logbook : [],
  });

  return NextResponse.json({ ok: true, session });
}
