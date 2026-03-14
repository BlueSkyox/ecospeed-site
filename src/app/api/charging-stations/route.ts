import { NextRequest, NextResponse } from "next/server";
import { getRouteChargingContext, type ChargingStation } from "@/lib/charging-context";
import { FALLBACK_STATIONS, fetchOpenChargeMapStations, fetchOverpassStations } from "@/lib/charging-stations";

let cache: { ts: number; data: ChargingStation[] } | null = null;
const STATIONS_CACHE_TTL_MS = 2 * 60_000;

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number) {
  const toRad = (x: number) => (x * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return 6371 * c;
}

function filterAround(stations: ChargingStation[], lat?: number, lon?: number, radiusKm = 20) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return stations;
  const out = stations
    .map((s) => ({
      ...s,
      distanceKm: haversineKm(lat as number, lon as number, s.latitude, s.longitude),
    }))
    .filter((s) => s.distanceKm <= radiusKm)
    .sort((a, b) => {
      if ((a.distanceKm ?? 9999) !== (b.distanceKm ?? 9999)) return (a.distanceKm ?? 9999) - (b.distanceKm ?? 9999);
      return (b.powerKw ?? 0) - (a.powerKw ?? 0);
    });
  return out;
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return await Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error("timeout")), ms)),
  ]);
}

async function loadStations(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && cache && now - cache.ts < STATIONS_CACHE_TTL_MS && cache.data.length > 0) {
    return cache.data;
  }

  let out: ChargingStation[] = cache?.data?.length ? cache.data : FALLBACK_STATIONS;
  const liveSources = await Promise.allSettled([
    withTimeout(fetchOpenChargeMapStations(), 8000),
    withTimeout(fetchOverpassStations(), 9000),
  ]);
  const merged = liveSources
    .filter((result): result is PromiseFulfilledResult<ChargingStation[]> => result.status === "fulfilled")
    .flatMap((result) => result.value);
  if (merged.length > 0) {
    const dedup = new Map<string, ChargingStation>();
    for (const station of merged) {
      dedup.set(`${station.name}|${station.latitude.toFixed(4)}|${station.longitude.toFixed(4)}`, station);
    }
    out = [...dedup.values()];
  }
  cache = { ts: now, data: out };
  return out;
}

export async function GET(req: NextRequest) {
  const latRaw = req.nextUrl.searchParams.get("lat");
  const lonRaw = req.nextUrl.searchParams.get("lon");
  const latParam = latRaw === null ? Number.NaN : Number(latRaw);
  const lonParam = lonRaw === null ? Number.NaN : Number(lonRaw);
  const radiusKm = Math.max(1, Math.min(100, Number(req.nextUrl.searchParams.get("radius_km") ?? 10)));
  const forceRefresh = req.nextUrl.searchParams.get("refresh") === "1";

  try {
    const stations = await loadStations(forceRefresh);

    const routeScoped = getRouteChargingContext();
    if (routeScoped && routeScoped.length > 0) {
      let out = [...routeScoped];
      if (Number.isFinite(latParam) && Number.isFinite(lonParam)) {
        const aroundUser = filterAround(stations, latParam, lonParam, radiusKm);
        const dedup = new Map<string, ChargingStation>();
        for (const st of [...out, ...aroundUser]) {
          dedup.set(`${st.name}|${st.latitude.toFixed(4)}|${st.longitude.toFixed(4)}`, st);
        }
        out = [...dedup.values()];
      }
      return NextResponse.json(out);
    }

    return NextResponse.json(filterAround(stations, latParam, lonParam, radiusKm));
  } catch {
    return NextResponse.json(filterAround(FALLBACK_STATIONS, latParam, lonParam, radiusKm));
  }
}
