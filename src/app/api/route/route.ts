import { NextRequest, NextResponse } from "next/server";
import { createHash } from "crypto";
import { promises as fs } from "fs";
import path from "path";
import {
  airDensityFromTempC,
  batteryPreconditioningKw,
  estimateChargingMinutesFromEnergy,
  haversineM,
  hvacPowerFromTemp,
  rainDensityToCrrMultiplier,
  rollingResistanceTempMultiplier,
  segEnergyAndTime,
} from "@/lib/ev";
import { setRouteChargingContext, type ChargingStation } from "@/lib/charging-context";
import { FALLBACK_STATIONS, fetchOpenChargeMapStations, fetchOverpassStations } from "@/lib/charging-stations";

const KNOWN_POINTS: Record<string, [number, number]> = {
  paris: [2.3522, 48.8566],
  lyon: [4.8357, 45.764],
  nice: [7.262, 43.7102],
  marseille: [5.3698, 43.2965],
  toulouse: [1.4442, 43.6047],
  bordeaux: [-0.5792, 44.8378],
  nantes: [-1.5536, 47.2184],
  strasbourg: [7.7521, 48.5734],
  lille: [3.0573, 50.6292],
  montpellier: [3.8767, 43.6119],
  rennes: [-1.6778, 48.1173],
  dijon: [5.0415, 47.322],
};

type TimedCacheEntry<T> = {
  value: T;
  expiresAt: number;
};

const geocodeCache = new Map<string, TimedCacheEntry<[number, number]>>();
const weatherPointCache = new Map<
  string,
  TimedCacheEntry<{ tempC: number; rainMmH: number; windKmh: number; windDirFromDeg: number }>
>();
const elevationChunkCache = new Map<string, TimedCacheEntry<number[]>>();
const elevationRouteCache = new Map<string, TimedCacheEntry<number[]>>();
const routeGeometryCache = new Map<
  string,
  TimedCacheEntry<{
    coordsRaw: [number, number][];
    elevations?: number[];
    ascentM?: number;
    descentM?: number;
    orsSeg0: { distance?: number; duration?: number; steps?: OrsStep[] };
    orsSteps: OrsStep[];
  }>
>();
let stationsCache: TimedCacheEntry<ChargingStation[]> | null = null;
const MIN_REALISTIC_CHARGE_STOP_MIN = 8;
const CO2_FRANCE_KG_PER_KWH = 0.048;
const PERSISTENT_CACHE_ROOT = path.join(process.cwd(), ".next", "cache", "ecospeed");

function hasUsableOrsRouteGeometry(value: {
  coordsRaw?: [number, number][];
  ascentM?: number;
  descentM?: number;
} | null | undefined) {
  if (!value || !Array.isArray(value.coordsRaw) || value.coordsRaw.length < 2) return false;
  return Number.isFinite(Number(value.ascentM ?? Number.NaN)) && Number.isFinite(Number(value.descentM ?? Number.NaN));
}

function cacheGet<T>(cache: Map<string, TimedCacheEntry<T>>, key: string): T | null {
  const now = Date.now();
  const hit = cache.get(key);
  if (!hit) return null;
  if (hit.expiresAt <= now) {
    cache.delete(key);
    return null;
  }
  return hit.value;
}

function cacheSet<T>(cache: Map<string, TimedCacheEntry<T>>, key: string, value: T, ttlMs: number) {
  cache.set(key, { value, expiresAt: Date.now() + ttlMs });
}

function safeCacheFileKey(key: string) {
  return key.replace(/[^a-z0-9_-]/gi, "_");
}

async function readPersistentJsonCache<T>(bucket: string, key: string, ttlMs: number): Promise<T | null> {
  const file = path.join(PERSISTENT_CACHE_ROOT, bucket, `${safeCacheFileKey(key)}.json`);
  try {
    const stat = await fs.stat(file);
    if (Date.now() - stat.mtimeMs > ttlMs) return null;
    const raw = await fs.readFile(file, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function writePersistentJsonCache<T>(bucket: string, key: string, value: T) {
  const dir = path.join(PERSISTENT_CACHE_ROOT, bucket);
  const file = path.join(dir, `${safeCacheFileKey(key)}.json`);
  try {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(file, JSON.stringify(value), "utf8");
  } catch {}
}

function orsKey() {
  const key = process.env.OPENROUTESERVICE_API_KEY || process.env.ORS_API_KEY;
  if (!key) {
    throw new Error("Missing OPENROUTESERVICE_API_KEY or ORS_API_KEY");
  }
  return key;
}

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return await Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error("timeout")), ms)),
  ]);
}

function parseLatLonText(text: string): [number, number] | null {
  const m = text.trim().match(/^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/);
  if (!m) return null;
  const lat = Number(m[1]);
  const lon = Number(m[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return [lon, lat];
}

function normalizePlace(input: string) {
  return input
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function knownPointLookup(input: string): [number, number] | null {
  const n = normalizePlace(input);
  if (KNOWN_POINTS[n]) return KNOWN_POINTS[n];
  for (const [k, v] of Object.entries(KNOWN_POINTS)) {
    if (n.includes(k)) return v;
  }
  return null;
}

function interpolateLineCoords(start: [number, number], end: [number, number], steps: number): [number, number][] {
  const out: [number, number][] = [];
  const n = Math.max(2, steps);
  for (let i = 0; i < n; i += 1) {
    const t = i / (n - 1);
    out.push([start[0] + (end[0] - start[0]) * t, start[1] + (end[1] - start[1]) * t]);
  }
  return out;
}

type RouteBody = {
  start: string;
  end: string;
  user_max_speed?: number;
  battery_start_pct?: number;
  battery_end_pct?: number;
  num_passengers?: number;
  avg_weight_kg?: number;
  use_climate?: boolean;
  climate_intensity?: number;
  max_time_penalty_pct?: number;
  rho_air?: number;
  electricity_price_eur_kwh?: number;
  comfort_temp_c?: number;
  vehicle_profile?: {
    empty_mass?: number;
    extra_load?: number;
    drag_coefficient?: number;
    frontal_area?: number;
    rolling_resistance?: number;
    motor_efficiency?: number;
    regen_efficiency?: number;
    aux_power_kw?: number;
    battery_kwh?: number;
    max_charge_kw?: number;
  };
};

type OrsStep = {
  distance?: number;
  duration?: number;
  type?: number;
  instruction?: string;
  name?: string;
  way_points?: [number, number];
};

type SegmentOut = {
  idx: number;
  index: number;
  lat_start: number;
  lon_start: number;
  lat_end: number;
  lon_end: number;
  distance_m: number;
  distance: number;
  distance_km: number;
  distanceKm: number;
  way_type: number;
  speed_limit: number;
  speedLimit: number;
  eco_speed: number;
  ecoSpeed: number;
  eco_energy: number;
  ecoEnergy: number;
  real_energy: number;
  limit_energy: number;
  limitEnergy: number;
  eco_cost_eur: number;
  limit_cost_eur: number;
  eco_time: number;
  real_time: number;
  limit_time: number;
  eco_time_min: number;
  ecoTimeMin: number;
  limit_time_min: number;
  limitTimeMin: number;
  temp_c_avg: number;
  rain_mmh_avg: number;
  duration: number;
};

type WeatherEdgeOut = {
  edge_index: number;
  distance_km: number;
  temp_c: number;
  rain_mmh: number;
  wind_kmh: number;
  headwind_ms: number;
  rain_crr_multiplier: number;
  hvac_kw: number;
  eco_speed_kmh: number;
  limit_speed_kmh: number;
  eco_energy_kwh: number;
  limit_energy_kwh: number;
  eco_time_min?: number;
};

type StopOut = {
  segmentIndex: number;
  lat: number;
  lon: number;
  station: ChargingStation;
  distKmFromRoute?: number;
  stationScore?: number;
  batteryLevelAtCharge: number;
  driveTimeFromPreviousStopMin?: number;
  driveDistanceFromPreviousStopKm?: number;
  minimumEnergyToCharge: number;
  minimumTargetBatteryPct: number;
  minimumChargingTimeMinutes: number;
  minimumChargingTimeMinutesRaw?: number;
  targetBatteryPct?: number;
  batteryPctAfterCharge?: number;
  chargingTimeMinutes: number;
  chargingTimeMinutesRaw?: number;
  chargingTimeIsMinimum?: boolean;
  energyToCharge: number;
  estimatedChargeCostEur?: number;
};

type RouteRange = {
  from: number;
  to: number;
};

type PlanningSegmentCandidate = {
  speed: number;
  energyKwh: number;
  timeMin: number;
  avgTemp: number;
  avgRain: number;
  edgeEnergyKwh: number[];
  edgeTimeMin: number[];
};

type PlanningSegmentBase = {
  from: number;
  to: number;
  lat_start: number;
  lon_start: number;
  lat_end: number;
  lon_end: number;
  distance_m: number;
  way_type: number;
  speed_limit: number;
  avgTemp: number;
  avgRain: number;
  limitEnergyKwh: number;
  limitTimeMin: number;
  candidates: PlanningSegmentCandidate[];
};

type MappedRouteStation = {
  st: ChargingStation;
  coordIdx: number;
  distKm: number;
};

function mergeSegmentPair(a: SegmentOut, b: SegmentOut): SegmentOut {
  const totalDistanceM = a.distance_m + b.distance_m;
  const weightedTemp =
    totalDistanceM > 0 ? (a.temp_c_avg * a.distance_m + b.temp_c_avg * b.distance_m) / totalDistanceM : a.temp_c_avg;
  const weightedRain =
    totalDistanceM > 0 ? (a.rain_mmh_avg * a.distance_m + b.rain_mmh_avg * b.distance_m) / totalDistanceM : a.rain_mmh_avg;
  const mergedEcoSpeed =
    totalDistanceM > 0 ? (a.eco_speed * a.distance_m + b.eco_speed * b.distance_m) / totalDistanceM : a.eco_speed;

  return {
    ...a,
    lat_end: b.lat_end,
    lon_end: b.lon_end,
    distance_m: totalDistanceM,
    distance: totalDistanceM,
    distance_km: totalDistanceM / 1000,
    distanceKm: totalDistanceM / 1000,
    eco_speed: Number(mergedEcoSpeed.toFixed(1)),
    ecoSpeed: Number(mergedEcoSpeed.toFixed(1)),
    eco_energy: a.eco_energy + b.eco_energy,
    ecoEnergy: a.ecoEnergy + b.ecoEnergy,
    real_energy: a.real_energy + b.real_energy,
    limit_energy: a.limit_energy + b.limit_energy,
    limitEnergy: a.limitEnergy + b.limitEnergy,
    eco_cost_eur: a.eco_cost_eur + b.eco_cost_eur,
    limit_cost_eur: a.limit_cost_eur + b.limit_cost_eur,
    eco_time: a.eco_time + b.eco_time,
    real_time: a.real_time + b.real_time,
    limit_time: a.limit_time + b.limit_time,
    eco_time_min: a.eco_time_min + b.eco_time_min,
    ecoTimeMin: a.ecoTimeMin + b.ecoTimeMin,
    limit_time_min: a.limit_time_min + b.limit_time_min,
    limitTimeMin: a.limitTimeMin + b.limitTimeMin,
    temp_c_avg: weightedTemp,
    rain_mmh_avg: weightedRain,
    duration: a.duration + b.duration,
  };
}

function normalizeSegments(
  segments: SegmentOut[],
  ranges: Array<{ from: number; to: number }>,
): { segments: SegmentOut[]; ranges: Array<{ from: number; to: number }> } {
  if (segments.length <= 1 || segments.length !== ranges.length) return { segments, ranges };

  const mergedSegments: SegmentOut[] = [];
  const mergedRanges: Array<{ from: number; to: number }> = [];

  for (let i = 0; i < segments.length; i += 1) {
    let accSeg = { ...segments[i] };
    let accRange = { ...ranges[i] };

    while (i + 1 < segments.length) {
      const nextSeg = segments[i + 1];
      const nextRange = ranges[i + 1];
      const sameRoadClass = Math.abs(accSeg.speed_limit - nextSeg.speed_limit) <= 10 && accSeg.way_type === nextSeg.way_type;
      const tooSmall = accSeg.distance_km < 0.15 || accSeg.eco_time_min < 0.25;
      const nextTooSmall = nextSeg.distance_km < 0.15 || nextSeg.eco_time_min < 0.25;
      if (!(sameRoadClass && (tooSmall || nextTooSmall))) break;
      accSeg = mergeSegmentPair(accSeg, nextSeg);
      accRange = { from: accRange.from, to: nextRange.to };
      i += 1;
    }

    mergedSegments.push({
      ...accSeg,
      idx: mergedSegments.length + 1,
      index: mergedSegments.length + 1,
    });
    mergedRanges.push(accRange);
  }

  return { segments: mergedSegments, ranges: mergedRanges };
}

async function geocode(text: string): Promise<[number, number]> {
  const known = knownPointLookup(text);
  if (known) return known;
  const cacheKey = normalizePlace(text);
  const cached = cacheGet(geocodeCache, cacheKey);
  if (cached) return cached;
  const url = `https://api.openrouteservice.org/geocode/search?api_key=${encodeURIComponent(
    orsKey(),
  )}&text=${encodeURIComponent(text)}&size=1`;
  const r = await withTimeout(fetch(url, { cache: "no-store" }), 12000);
  if (!r.ok) throw new Error("Geocode failed");
  const data = await r.json();
  const coord = data?.features?.[0]?.geometry?.coordinates;
  if (!Array.isArray(coord) || coord.length < 2) throw new Error("Address not found");
  const out: [number, number] = [Number(coord[0]), Number(coord[1])];
  cacheSet(geocodeCache, cacheKey, out, 30 * 60 * 1000);
  return out;
}

async function resolvePoint(input: string): Promise<[number, number]> {
  const parsed = parseLatLonText(input);
  if (parsed) return parsed;
  try {
    return await geocode(input);
  } catch {
    const known = knownPointLookup(input);
    if (known) return known;
    throw new Error(`Address not found: ${input}`);
  }
}

function elevationCoordsKey(coords: [number, number][]) {
  const h = createHash("sha1");
  for (const [lon, lat] of coords) h.update(`${lon.toFixed(5)},${lat.toFixed(5)};`);
  return `${coords.length}:${h.digest("hex")}`;
}

function routeGeometryKey(start: [number, number], end: [number, number]) {
  const h = createHash("sha1");
  h.update(`${start[0].toFixed(5)},${start[1].toFixed(5)}->${end[0].toFixed(5)},${end[1].toFixed(5)}`);
  return h.digest("hex");
}

function elevationVariationScore(elevations: number[]) {
  let score = 0;
  for (let i = 1; i < elevations.length; i += 1) {
    const a = Number(elevations[i - 1] ?? 0);
    const b = Number(elevations[i] ?? a);
    score += Math.abs(b - a);
  }
  return score;
}

function smoothElevations(elevations: number[]) {
  if (elevations.length <= 2) return elevations;
  return elevations.map((value, idx) => {
    const prev = elevations[idx - 1] ?? value;
    const next = elevations[idx + 1] ?? value;
    return (prev + value + next) / 3;
  });
}

async function fetchElevationChunk(coords: [number, number][]) {
  const cacheKey = elevationCoordsKey(coords);
  const cached = cacheGet(elevationChunkCache, cacheKey);
  if (cached && cached.length === coords.length) return cached;

  const latCsv = coords.map((c) => c[1].toFixed(6)).join(",");
  const lonCsv = coords.map((c) => c[0].toFixed(6)).join(",");
  let lastError: Error | null = null;
  const providers = [
    async () => {
      const r = await withTimeout(
        fetch(`https://api.open-meteo.com/v1/elevation?latitude=${latCsv}&longitude=${lonCsv}`, {
          cache: "no-store",
        }),
        8000,
      );
      if (!r.ok) throw new Error(`open-meteo elevation failed: ${r.status}`);
      const j = await r.json();
      const vals = Array.isArray(j?.elevation) ? j.elevation.map((x: unknown) => Number(x)) : [];
      if (vals.length !== coords.length || vals.some((x: number) => !Number.isFinite(x))) {
        throw new Error("open-meteo elevation invalid");
      }
      return vals;
    },
    async () => {
      const locations = coords.map((c) => `${c[1]},${c[0]}`).join("|");
      const r = await withTimeout(
        fetch(`https://api.open-elevation.com/api/v1/lookup?locations=${encodeURIComponent(locations)}`, {
          cache: "no-store",
        }),
        8000,
      );
      if (!r.ok) throw new Error(`open-elevation failed: ${r.status}`);
      const j = await r.json();
      const vals = (j?.results ?? []).map((x: { elevation?: number }) => Number(x.elevation ?? 0));
      if (vals.length !== coords.length || vals.some((x: number) => !Number.isFinite(x))) {
        throw new Error("open-elevation invalid");
      }
      return vals;
    },
  ];

  for (const provider of providers) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const vals = await provider();
        cacheSet(elevationChunkCache, cacheKey, vals, 12 * 60 * 60 * 1000);
        return vals;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error("elevation chunk failed");
      }
    }
  }
  throw lastError ?? new Error("elevation chunk failed");
}

async function fetchElevationsOnce(coords: [number, number][]) {
  const out: number[] = [];
  const chunkSize = 90;
  for (let i = 0; i < coords.length; i += chunkSize) {
    const chunk = coords.slice(i, i + chunkSize);
    const vals = await fetchElevationChunk(chunk);
    out.push(...vals);
  }
  if (out.length !== coords.length) throw new Error("elevation profile incomplete");
  return out;
}

async function fetchElevations(coords: [number, number][]) {
  if (coords.length === 0) return [];
  const routeKey = elevationCoordsKey(coords);
  const cached = cacheGet(elevationRouteCache, routeKey);
  if (cached && cached.length === coords.length) return cached;
  const persisted = await readPersistentJsonCache<number[]>("elevation-route", routeKey, 12 * 60 * 60 * 1000);
  if (persisted && persisted.length === coords.length) {
    cacheSet(elevationRouteCache, routeKey, persisted, 12 * 60 * 60 * 1000);
    return persisted;
  }

  let best: number[] | null = null;
  let bestScore = -1;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const vals = await fetchElevationsOnce(coords);
      const score = elevationVariationScore(vals);
      if (score > bestScore) {
        best = vals;
        bestScore = score;
      }
      if (score > 50) break;
    } catch {}
  }

  if (best && best.length === coords.length) {
    cacheSet(elevationRouteCache, routeKey, best, 12 * 60 * 60 * 1000);
    await writePersistentJsonCache("elevation-route", routeKey, best);
    return best;
  }
  return cached ?? persisted ?? new Array(coords.length).fill(0);
}

async function fetchRouteGeometry(
  startCoord: [number, number],
  endCoord: [number, number],
): Promise<{
  coordsRaw: [number, number][];
  elevations: number[];
  ascentM: number;
  descentM: number;
  orsSeg0: { distance?: number; duration?: number; steps?: OrsStep[] };
  orsSteps: OrsStep[];
  routeSource: "ors";
}> {
  const cacheKey = routeGeometryKey(startCoord, endCoord);
  const cached = cacheGet(routeGeometryCache, cacheKey);
  if (hasUsableOrsRouteGeometry(cached)) {
    const cachedRoute = cached as {
      coordsRaw: [number, number][];
      elevations?: number[];
      ascentM: number;
      descentM: number;
      orsSeg0: { distance?: number; duration?: number; steps?: OrsStep[] };
      orsSteps: OrsStep[];
    };
    return {
      coordsRaw: cachedRoute.coordsRaw,
      elevations: Array.isArray(cachedRoute.elevations) ? cachedRoute.elevations : [],
      ascentM: Number(cachedRoute.ascentM),
      descentM: Number(cachedRoute.descentM),
      orsSeg0: cachedRoute.orsSeg0,
      orsSteps: cachedRoute.orsSteps,
      routeSource: "ors" as const,
    };
  }
  if (cached) routeGeometryCache.delete(cacheKey);
  const persisted = await readPersistentJsonCache<{
    coordsRaw: [number, number][];
    elevations?: number[];
    ascentM?: number;
    descentM?: number;
    orsSeg0: { distance?: number; duration?: number; steps?: OrsStep[] };
    orsSteps: OrsStep[];
  }>("route-geometry", cacheKey, 30 * 60 * 1000);
  if (hasUsableOrsRouteGeometry(persisted)) {
    const persistedRoute = persisted as {
      coordsRaw: [number, number][];
      elevations?: number[];
      ascentM: number;
      descentM: number;
      orsSeg0: { distance?: number; duration?: number; steps?: OrsStep[] };
      orsSteps: OrsStep[];
    };
    cacheSet(routeGeometryCache, cacheKey, persistedRoute, 30 * 60 * 1000);
    return {
      coordsRaw: persistedRoute.coordsRaw,
      elevations: Array.isArray(persistedRoute.elevations) ? persistedRoute.elevations : [],
      ascentM: persistedRoute.ascentM,
      descentM: persistedRoute.descentM,
      orsSeg0: persistedRoute.orsSeg0,
      orsSteps: persistedRoute.orsSteps,
      routeSource: "ors" as const,
    };
  }

  let lastError: Error | null = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const routeResp = await withTimeout(
        fetch("https://api.openrouteservice.org/v2/directions/driving-car/geojson", {
          method: "POST",
          headers: { Authorization: orsKey(), "Content-Type": "application/json" },
          body: JSON.stringify({ coordinates: [startCoord, endCoord], instructions: true, elevation: true }),
          cache: "no-store",
        }),
        15000,
      );
      if (!routeResp.ok) throw new Error(`Route failed: ${routeResp.status}`);
      const data = await routeResp.json();
      const feat = data?.features?.[0];
      const maybeCoords = feat?.geometry?.coordinates as [number, number, number?][] | undefined;
      if (!Array.isArray(maybeCoords) || maybeCoords.length < 2) throw new Error("No route geometry");
      const coordsRaw = maybeCoords.map((coord) => [Number(coord[0]), Number(coord[1])] as [number, number]);
      const elevations = maybeCoords.map((coord) => Number(coord[2] ?? 0));
      const ascentM = Number(feat?.properties?.ascent ?? Number.NaN);
      const descentM = Number(feat?.properties?.descent ?? Number.NaN);
      const orsSeg0 = feat?.properties?.segments?.[0] as { distance?: number; duration?: number; steps?: OrsStep[] };
      const orsSteps = (Array.isArray(orsSeg0?.steps) ? orsSeg0.steps : []) as OrsStep[];
      const value = { coordsRaw, elevations, ascentM, descentM, orsSeg0, orsSteps };
      cacheSet(routeGeometryCache, cacheKey, value, 30 * 60 * 1000);
      await writePersistentJsonCache("route-geometry", cacheKey, value);
      return { ...value, routeSource: "ors" as const };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error("Route failed");
    }
  }

  throw lastError ?? new Error("Route failed");
}

function pickSampleIndices(totalPoints: number, maxSamples: number): number[] {
  if (totalPoints <= 0) return [];
  if (totalPoints <= maxSamples) return Array.from({ length: totalPoints }, (_, i) => i);
  const out: number[] = [];
  for (let i = 0; i < maxSamples; i += 1) out.push(Math.round((i * (totalPoints - 1)) / (maxSamples - 1)));
  return [...new Set(out)].sort((a, b) => a - b);
}

async function fetchPointWeather(
  lat: number,
  lon: number,
): Promise<{ tempC: number; rainMmH: number; windKmh: number; windDirFromDeg: number }> {
  const cacheKey = `${lat.toFixed(3)},${lon.toFixed(3)}`;
  const cached = cacheGet(weatherPointCache, cacheKey);
  if (cached) return cached;
  const r = await withTimeout(
    fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,precipitation,rain,wind_speed_10m,wind_direction_10m`,
      { cache: "no-store" },
    ),
    7000,
  );
  if (!r.ok) throw new Error("weather fetch failed");
  const j = await r.json();
  const cur = j?.current ?? {};
  const out = {
    tempC: Number(cur.temperature_2m ?? 20),
    rainMmH: Number(cur.rain ?? cur.precipitation ?? 0),
    windKmh: Math.max(0, Number(cur.wind_speed_10m ?? 0)),
    windDirFromDeg: ((Number(cur.wind_direction_10m ?? 0) % 360) + 360) % 360,
  };
  cacheSet(weatherPointCache, cacheKey, out, 10 * 60 * 1000);
  return out;
}

async function getStationsCached(): Promise<ChargingStation[]> {
  const now = Date.now();
  if (stationsCache && stationsCache.expiresAt > now && stationsCache.value.length > 0) return stationsCache.value;
  const mergeStations = (base: ChargingStation[], extra: ChargingStation[]) => {
    const dedup = new Map<string, ChargingStation>();
    for (const st of [...base, ...extra]) {
      const key = `${st.name}|${Number(st.latitude).toFixed(4)}|${Number(st.longitude).toFixed(4)}`;
      if (!dedup.has(key)) dedup.set(key, st);
    }
    return [...dedup.values()];
  };
  try {
    const liveSources = await Promise.allSettled([
      withTimeout(fetchOpenChargeMapStations(), 8000),
      withTimeout(fetchOverpassStations(), 9000),
    ]);
    const live = liveSources
      .filter((result): result is PromiseFulfilledResult<ChargingStation[]> => result.status === "fulfilled")
      .flatMap((result) => result.value);
    if (live.length > 0) {
      const merged = mergeStations(live, FALLBACK_STATIONS);
      stationsCache = { value: merged, expiresAt: now + 10 * 60 * 1000 };
      return merged;
    }
  } catch {}
  const fallback = FALLBACK_STATIONS;
  stationsCache = { value: fallback, expiresAt: now + 2 * 60 * 1000 };
  return fallback;
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
    for (let k = a; k <= b; k += 1) out[k] = va + (vb - va) * ((k - a) / span);
  }
  const lastKey = keys[keys.length - 1];
  const lastVal = valuesBySample.get(lastKey) ?? 0;
  for (let i = lastKey; i < length; i += 1) out[i] = lastVal;
  return out;
}

function bearingRadFromNorth(lon1: number, lat1: number, lon2: number, lat2: number) {
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const p1 = (lat1 * Math.PI) / 180;
  const p2 = (lat2 * Math.PI) / 180;
  const y = Math.sin(dLon) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dLon);
  return Math.atan2(y, x);
}

async function fetchRouteWeather(coords: [number, number][]) {
  try {
    const sampleIdx = pickSampleIndices(coords.length, 12);
    const settled = await Promise.allSettled(
      sampleIdx.map(async (idx) => {
        const [lon, lat] = coords[idx];
        const w = await fetchPointWeather(lat, lon);
        return {
          idx,
          tempC: w.tempC,
          rainMmH: Math.max(0, w.rainMmH),
          windKmh: Math.max(0, w.windKmh),
          windDirFromDeg: w.windDirFromDeg,
        };
      }),
    );
    const samples = settled
      .filter((res): res is PromiseFulfilledResult<{
        idx: number;
        tempC: number;
        rainMmH: number;
        windKmh: number;
        windDirFromDeg: number;
      }> => res.status === "fulfilled")
      .map((res) => res.value);
    if (samples.length === 0) throw new Error("weather samples unavailable");
    const tempMap = new Map<number, number>();
    const rainMap = new Map<number, number>();
    const windUxMap = new Map<number, number>();
    const windUyMap = new Map<number, number>();
    for (const s of samples) {
      tempMap.set(s.idx, s.tempC);
      rainMap.set(s.idx, s.rainMmH);
      const windToRad = (((s.windDirFromDeg + 180) % 360) * Math.PI) / 180;
      const windMs = s.windKmh / 3.6;
      windUxMap.set(s.idx, windMs * Math.sin(windToRad));
      windUyMap.set(s.idx, windMs * Math.cos(windToRad));
    }
    const pointTemp = interpolateByIndex(tempMap, coords.length);
    const pointRain = interpolateByIndex(rainMap, coords.length);
    const pointWindUx = interpolateByIndex(windUxMap, coords.length);
    const pointWindUy = interpolateByIndex(windUyMap, coords.length);
    const edgeWindMs = pointWindUx
      .slice(1)
      .map((ux, i) => Math.sqrt(((ux + pointWindUx[i]) / 2) ** 2 + ((pointWindUy[i + 1] + pointWindUy[i]) / 2) ** 2));
    const edgeHeadwindMs = coords.slice(1).map((c, i) => {
      const [lon1, lat1] = coords[i];
      const [lon2, lat2] = c;
      const b = bearingRadFromNorth(lon1, lat1, lon2, lat2);
      const dirX = Math.sin(b);
      const dirY = Math.cos(b);
      const ux = (pointWindUx[i + 1] + pointWindUx[i]) / 2;
      const uy = (pointWindUy[i + 1] + pointWindUy[i]) / 2;
      const tailwindMs = ux * dirX + uy * dirY;
      return -tailwindMs;
    });
    return {
      edgeTemp: pointTemp.slice(1).map((v, i) => (v + pointTemp[i]) / 2),
      edgeRain: pointRain.slice(1).map((v, i) => Math.max(0, (v + pointRain[i]) / 2)),
      edgeWindMs,
      edgeHeadwindMs,
      samples: samples.length,
    };
  } catch {
    return {
      edgeTemp: new Array(Math.max(0, coords.length - 1)).fill(20),
      edgeRain: new Array(Math.max(0, coords.length - 1)).fill(0),
      edgeWindMs: new Array(Math.max(0, coords.length - 1)).fill(0),
      edgeHeadwindMs: new Array(Math.max(0, coords.length - 1)).fill(0),
      samples: 0,
    };
  }
}

function maneuverCap(type?: number, instruction?: string) {
  const txt = (instruction ?? "").toLowerCase();
  if (type === 7 || type === 8 || txt.includes("roundabout")) return 30;
  if (type === 0 || type === 1 || type === 2 || type === 3 || type === 4 || type === 5 || type === 9) return 50;
  if (type === 12 || type === 13 || txt.includes("keep")) return 110;
  return 130;
}

function guessWayType(speedLimitKmh: number) {
  if (speedLimitKmh >= 100) return 1;
  if (speedLimitKmh >= 80) return 2;
  if (speedLimitKmh >= 60) return 3;
  return 4;
}

function legalLimitFromStep(stepHint: OrsStep | undefined, userMax: number, distM: number) {
  const nameTxt = String(stepHint?.name ?? "").toLowerCase();
  const instr = String(stepHint?.instruction ?? "").toLowerCase();
  const type = Number(stepHint?.type ?? NaN);
  const isMotorway =
    /\b(a|m|e)\d+\b/.test(nameTxt) || nameTxt.includes("autoroute") || nameTxt.includes("motorway");
  const isUrban =
    nameTxt.includes("rue") || nameTxt.includes("avenue") || nameTxt.includes("boulevard") || nameTxt.includes("street");
  let legal = 80;
  if (isMotorway) legal = 130;
  else if (type === 7 || type === 8 || instr.includes("roundabout")) legal = 30;
  else if (type === 0 || type === 1 || type === 2 || type === 3 || type === 4 || type === 5 || type === 9) legal = 50;
  else if (type === 12 || type === 13 || instr.includes("keep")) legal = distM > 3000 ? 110 : 90;
  else if (isUrban || distM < 900) legal = 50;
  else if (distM > 6000) legal = 110;
  return clamp(legal, 25, userMax);
}

function snapToFrenchLegalLimit(limit: number, userMax: number) {
  const allowed = [20, 30, 50, 70, 80, 90, 110, 130].filter((v) => v <= userMax);
  let best = allowed[0] ?? userMax;
  let bestDiff = Math.abs(limit - best);
  for (let i = 1; i < allowed.length; i += 1) {
    const d = Math.abs(limit - allowed[i]);
    if (d < bestDiff) {
      best = allowed[i];
      bestDiff = d;
    }
  }
  return best;
}

function roundSpeedToNearestStep(speedKmh: number, stepKmh: number) {
  return Math.max(stepKmh, Math.round(speedKmh / stepKmh) * stepKmh);
}

function buildEcoSpeedCandidates(speedLimit: number) {
  const stepKmh = 5;
  const roundedLimit = roundSpeedToNearestStep(speedLimit, stepKmh);
  const motorwayFloor = 100;
  const ecoFloor =
    roundedLimit >= 130
      ? motorwayFloor
      : roundedLimit >= 110
        ? motorwayFloor
        : roundedLimit >= 90
          ? 55
          : roundedLimit >= 80
            ? 50
            : roundedLimit >= 70
              ? 45
              : roundedLimit >= 50
                ? 30
                : Math.max(20, roundedLimit - 20);
  const out: number[] = [];
  for (let v = roundedLimit; v >= ecoFloor; v -= stepKmh) out.push(v);
  if (!out.includes(ecoFloor)) out.push(ecoFloor);
  return [...new Set(out)].sort((a, b) => b - a);
}

function cabinClimateAuxKw(tempC: number, comfortTempC: number, climateEnabled: boolean) {
  const baseVentilationKw = hvacPowerFromTemp(comfortTempC, comfortTempC);
  return climateEnabled ? hvacPowerFromTemp(tempC, comfortTempC) : baseVentilationKw;
}

function co2Equivalents(co2Kg: number) {
  const safe = Math.max(0, co2Kg);
  const bikeKm = safe / 0.021;
  const smartphoneDays = safe / 0.00822;
  const naturalGasM3 = safe / 2.03;
  return {
    gasoline_liters: safe / 2.31,
    thermal_car_km: safe / 0.192,
    smartphone_charges: safe / 0.00822,
    bike_km_equivalent: bikeKm,
    smartphone_days_equivalent: smartphoneDays,
    natural_gas_m3_equivalent: naturalGasM3,
    tree_months: safe / (21 / 12),
    message: `${safe.toFixed(1)} kg CO2 ~= ${(safe / 2.31).toFixed(1)} L essence ou ${(safe / 0.192).toFixed(0)} km en voiture thermique`,
  };
}

function coordToSegIndex(coordIdx: number, ranges: Array<{ from: number; to: number }>) {
  for (let i = 0; i < ranges.length; i += 1) {
    if (coordIdx >= ranges[i].from && coordIdx <= ranges[i].to) return i;
  }
  return Math.max(0, Math.min(ranges.length - 1, 0));
}

function nearestPointOnRoute(st: ChargingStation, coords: [number, number][]) {
  let bestDist = Number.POSITIVE_INFINITY;
  let bestIdx = 0;
  for (let i = 0; i < coords.length; i += 4) {
    const [lon, lat] = coords[i];
    const d = haversineM(lon, lat, st.longitude, st.latitude);
    if (d < bestDist) {
      bestDist = d;
      bestIdx = i;
    }
  }
  return { distM: bestDist, coordIdx: bestIdx };
}

function listStationsNearRoute(
  stations: ChargingStation[],
  coords: [number, number][],
  maxDistKm = 20,
  maxResults = 220,
) {
  const near = stations
    .map((st) => {
      const n = nearestPointOnRoute(st, coords);
      return { st, distKm: n.distM / 1000 };
    })
    .filter((x) => x.distKm <= maxDistKm);
  near.sort((a, b) => {
    if (a.distKm !== b.distKm) return a.distKm - b.distKm;
    return (b.st.powerKw ?? 0) - (a.st.powerKw ?? 0);
  });
  const dedup = new Map<string, ChargingStation>();
  for (const x of near) {
    const key = `${x.st.name}|${x.st.latitude.toFixed(4)}|${x.st.longitude.toFixed(4)}`;
    if (!dedup.has(key)) dedup.set(key, { ...x.st, distanceKm: x.distKm });
    if (dedup.size >= maxResults) break;
  }
  return [...dedup.values()];
}

function listStationsNearPoint(stations: ChargingStation[], lon: number, lat: number, maxDistKm = 20, maxResults = 80) {
  const near = stations
    .map((st) => ({
      st,
      distKm: haversineM(lon, lat, st.longitude, st.latitude) / 1000,
    }))
    .filter((x) => x.distKm <= maxDistKm)
    .sort((a, b) => {
      if (a.distKm !== b.distKm) return a.distKm - b.distKm;
      return (b.st.powerKw ?? 0) - (a.st.powerKw ?? 0);
    })
    .slice(0, maxResults);
  return near.map((x) => ({ ...x.st, distanceKm: x.distKm }));
}

function mapStationsToRoute(stations: ChargingStation[], coords: [number, number][], maxDistKm = 25) {
  return stations
    .map((st) => {
      const near = nearestPointOnRoute(st, coords);
      return { st, coordIdx: near.coordIdx, distKm: near.distM / 1000 };
    })
    .filter((item) => item.distKm <= maxDistKm)
    .sort((a, b) => {
      if (a.coordIdx !== b.coordIdx) return a.coordIdx - b.coordIdx;
      if (a.distKm !== b.distKm) return a.distKm - b.distKm;
      return Number(b.st.powerKw ?? 0) - Number(a.st.powerKw ?? 0);
    });
}

function estimateChargingMinutes(
  currentEnergyKwh: number,
  targetEnergyKwh: number,
  batteryKwh: number,
  vehicleMaxChargeKw: number,
  stationPowerKw: number,
) {
  return estimateChargingMinutesFromEnergy(
    currentEnergyKwh,
    targetEnergyKwh,
    batteryKwh,
    vehicleMaxChargeKw,
    stationPowerKw,
  );
}

function estimateStationPriceEurPerKwh(station: ChargingStation) {
  const raw = String(station.price ?? "").replace(",", ".").replace(/[€$]/g, "");
  const match = raw.match(/(\d+(?:\.\d+)?)\s*(?:eur)?\s*\/\s*kwh/i);
  if (match) return Math.max(0, Number(match[1]));
  const powerKw = Number(station.powerKw ?? 0);
  if (powerKw >= 300) return 0.69;
  if (powerKw >= 200) return 0.62;
  if (powerKw >= 150) return 0.56;
  if (powerKw >= 100) return 0.49;
  if (powerKw >= 50) return 0.43;
  return 0.35;
}

function stationQualityScore(station: ChargingStation, distKmFromRoute: number, segIdx: number) {
  const powerScore = Math.min(400, Number(station.powerKw ?? 0)) / 400;
  const distancePenalty = Math.min(1, Math.max(0, distKmFromRoute) / 12);
  const operator = String(station.operator ?? "").toLowerCase();
  const operatorBonus =
    operator.includes("ionity") || operator.includes("tesla") || operator.includes("fastned")
      ? 0.08
      : operator.includes("electra") || operator.includes("total")
        ? 0.04
        : 0;
  return segIdx * 2 + powerScore + operatorBonus - distancePenalty;
}

function planChargingStops(
  mappedStations: MappedRouteStation[],
  coords: [number, number][],
  displayRanges: RouteRange[],
  coordEnergyPrefix: number[],
  coordTimePrefix: number[],
  batteryKwh: number,
  startPct: number,
  targetEndPct: number,
  maxChargeKw: number,
): StopOut[] {
  if (coords.length < 2 || coordEnergyPrefix.length !== coords.length || coordTimePrefix.length !== coords.length) return [];
  const finalReserve = batteryKwh * (Math.max(10, targetEndPct) / 100);
  const legReserve = batteryKwh * 0.1;
  const maxChargeSoc = 0.95;
  const maxCharge = batteryKwh * maxChargeSoc;
  const minArrivalBuffer = Math.max(0.8, batteryKwh * 0.01);
  const departureBuffer = Math.max(2, batteryKwh * 0.06);
  const totalEnergy = coordEnergyPrefix[coordEnergyPrefix.length - 1];
  const targetRestMinutes = 120;
  const preferredRestMin = 95;
  const preferredRestMax = 145;
  const mapped = mappedStations;
  if (mapped.length === 0) return [];

  type CandidateStop = MappedRouteStation & {
    driveE: number;
    driveTimeMin: number;
    driveDistanceKm: number;
  };

  const canContinueFrom = (coordIdx: number) => {
    const remainingFromStop = totalEnergy - coordEnergyPrefix[coordIdx];
    if (maxCharge >= remainingFromStop + finalReserve + minArrivalBuffer) return true;
    return mapped.some((nextStop) => {
      if (nextStop.coordIdx <= coordIdx) return false;
      const eToNext = coordEnergyPrefix[nextStop.coordIdx] - coordEnergyPrefix[coordIdx];
      return eToNext <= Math.max(0, maxCharge - minArrivalBuffer);
    });
  };

  const buildReachableCandidates = (fromCoordIdx: number, availableEnergyKwh: number): CandidateStop[] =>
    mapped
      .filter((m) => m.coordIdx > fromCoordIdx)
      .map((m) => {
        const driveE = coordEnergyPrefix[m.coordIdx] - coordEnergyPrefix[fromCoordIdx];
        const driveTimeMin = coordTimePrefix[m.coordIdx] - coordTimePrefix[fromCoordIdx];
        const [fromLon, fromLat] = coords[fromCoordIdx];
        const [toLon, toLat] = coords[m.coordIdx];
        return {
          ...m,
          driveE,
          driveTimeMin,
          driveDistanceKm: haversineM(fromLon, fromLat, toLon, toLat) / 1000,
        };
      })
      .filter((m) => m.driveE <= Math.max(0, availableEnergyKwh - minArrivalBuffer));

  const strategicScore = (candidate: CandidateStop) => {
    const pauseDiff = Math.abs(candidate.driveTimeMin - targetRestMinutes);
    const pauseScore =
      candidate.driveTimeMin >= preferredRestMin && candidate.driveTimeMin <= preferredRestMax
        ? 1.6 - pauseDiff / 45
        : -Math.max(0, preferredRestMin - candidate.driveTimeMin) / 55 - Math.max(0, candidate.driveTimeMin - preferredRestMax) / 90;
    const detourPenalty = Math.max(0, candidate.distKm) * 0.65;
    const powerBonus = Math.min(1.1, Number(candidate.st.powerKw ?? 0) / 180);
    const progressBonus = Math.min(2.2, candidate.driveDistanceKm / 85);
    const corridorScore = stationQualityScore(
      candidate.st,
      candidate.distKm,
      candidate.coordIdx / Math.max(1, coords.length - 1),
    );
    return pauseScore + progressBonus + powerBonus + corridorScore * 0.12 - detourPenalty;
  };

  const pickStrategicCandidate = (fromCoordIdx: number, availableEnergyKwh: number) => {
    const reachable = buildReachableCandidates(fromCoordIdx, availableEnergyKwh);
    if (reachable.length === 0) return null;
    const viable = reachable.filter((candidate) => canContinueFrom(candidate.coordIdx));
    const pool = viable.length > 0 ? viable : reachable;
    return pool.reduce<CandidateStop | null>((best, candidate) => {
      if (!best) return candidate;
      const score = strategicScore(candidate);
      const bestScore = strategicScore(best);
      if (score !== bestScore) return score > bestScore ? candidate : best;
      if (candidate.coordIdx !== best.coordIdx) return candidate.coordIdx > best.coordIdx ? candidate : best;
      if ((candidate.st.powerKw ?? 0) !== (best.st.powerKw ?? 0)) {
        return (candidate.st.powerKw ?? 0) > (best.st.powerKw ?? 0) ? candidate : best;
      }
      return candidate.distKm < best.distKm ? candidate : best;
    }, null);
  };

  const stops: StopOut[] = [];
  let currentCoordIdx = 0;
  let energy = batteryKwh * (startPct / 100);
  let guard = 0;

  while (currentCoordIdx < coords.length - 1 && guard < coords.length + 20) {
    guard += 1;
    const needToFinish = totalEnergy - coordEnergyPrefix[currentCoordIdx] + finalReserve;
    if (energy >= needToFinish - minArrivalBuffer) break;

    const chosen = pickStrategicCandidate(currentCoordIdx, energy);
    if (!chosen) break;

    energy = Math.max(minArrivalBuffer, energy - chosen.driveE);
    const remainingFromHere = totalEnergy - coordEnergyPrefix[chosen.coordIdx];
    const canFinishFromChosen = maxCharge >= remainingFromHere + finalReserve + minArrivalBuffer;
    let minimumTargetEnergyKwh = canFinishFromChosen
      ? Math.min(maxCharge, Math.max(remainingFromHere + finalReserve, legReserve + departureBuffer))
      : maxCharge;

    if (!canFinishFromChosen) {
      const nextCandidate = pickStrategicCandidate(chosen.coordIdx, maxCharge);
      if (nextCandidate) {
        minimumTargetEnergyKwh = Math.min(
          maxCharge,
          Math.max(nextCandidate.driveE + minArrivalBuffer, legReserve + departureBuffer),
        );
      }
    }

    const minimumChargeKwh = Math.max(0, minimumTargetEnergyKwh - energy);
    const power = Math.max(20, Math.min(maxChargeKw, chosen.st.powerKw || 50));
    const minsRaw = estimateChargingMinutes(energy, minimumTargetEnergyKwh, batteryKwh, maxChargeKw, power);
    const mins = Math.max(MIN_REALISTIC_CHARGE_STOP_MIN, minsRaw);
    const score = stationQualityScore(chosen.st, chosen.distKm, chosen.coordIdx / Math.max(1, coords.length - 1));
    const batteryPctAfterCharge = clamp((minimumTargetEnergyKwh / batteryKwh) * 100, 0, 100);
    stops.push({
      lat: chosen.st.latitude,
      lon: chosen.st.longitude,
      station: chosen.st,
      distKmFromRoute: chosen.distKm,
      stationScore: score,
      batteryLevelAtCharge: clamp((energy / batteryKwh) * 100, 0, 100),
      driveTimeFromPreviousStopMin: Math.max(0, chosen.driveTimeMin),
      driveDistanceFromPreviousStopKm: Math.max(0, chosen.driveDistanceKm),
      minimumEnergyToCharge: minimumChargeKwh,
      minimumTargetBatteryPct: batteryPctAfterCharge,
      minimumChargingTimeMinutes: mins,
      minimumChargingTimeMinutesRaw: minsRaw,
      targetBatteryPct: batteryPctAfterCharge,
      batteryPctAfterCharge,
      segmentIndex: coordToSegIndex(chosen.coordIdx, displayRanges) + 1,
      chargingTimeMinutes: mins,
      chargingTimeMinutesRaw: minsRaw,
      chargingTimeIsMinimum: minsRaw < MIN_REALISTIC_CHARGE_STOP_MIN,
      energyToCharge: minimumChargeKwh,
      estimatedChargeCostEur: minimumChargeKwh * estimateStationPriceEurPerKwh(chosen.st),
    });
    energy = minimumTargetEnergyKwh;
    currentCoordIdx = chosen.coordIdx;
  }
  return stops;
}

export async function POST(req: NextRequest) {
  let body: RouteBody;
  try {
    body = (await req.json()) as RouteBody;
  } catch {
    return NextResponse.json({ detail: "Invalid payload" }, { status: 400 });
  }
  if (!body?.start || !body?.end) return NextResponse.json({ detail: "Missing start/end" }, { status: 400 });

  try {
    const requestedBatteryEndPct = Number(body.battery_end_pct ?? 20);
    const startCoord = await resolvePoint(body.start);
    const endCoord = await resolvePoint(body.end);
    let coordsRaw: [number, number][] = [];
    let routeElevations: number[] = [];
    let routeAscentM = Number.NaN;
    let routeDescentM = Number.NaN;
    let orsSeg0: { distance?: number; duration?: number; steps?: OrsStep[] } | undefined;
    let orsSteps: OrsStep[] = [];
    let routeSource: "ors" | "synthetic" = "ors";
    try {
      const routeData = await fetchRouteGeometry(startCoord, endCoord);
      coordsRaw = routeData.coordsRaw;
      routeElevations = Array.isArray(routeData.elevations) ? routeData.elevations : [];
      routeAscentM = Number(routeData.ascentM ?? Number.NaN);
      routeDescentM = Number(routeData.descentM ?? Number.NaN);
      orsSeg0 = routeData.orsSeg0;
      orsSteps = routeData.orsSteps;
      routeSource = routeData.routeSource;
    } catch {
      routeSource = "synthetic";
      coordsRaw = interpolateLineCoords(startCoord, endCoord, 72);
      let syntheticDist = 0;
      for (let i = 1; i < coordsRaw.length; i += 1) {
        syntheticDist += haversineM(coordsRaw[i - 1][0], coordsRaw[i - 1][1], coordsRaw[i][0], coordsRaw[i][1]);
      }
      const syntheticDuration = (syntheticDist / 1000 / 90) * 3600;
      orsSeg0 = {
        distance: syntheticDist,
        duration: syntheticDuration,
        steps: [{ distance: syntheticDist, duration: syntheticDuration, type: 13, instruction: "Synthetic route", way_points: [0, coordsRaw.length - 1] }],
      };
      orsSteps = (orsSeg0.steps ?? []) as OrsStep[];
    }

    const elevations =
      routeSource === "ors"
        ? routeElevations.length === coordsRaw.length
          ? routeElevations
          : await fetchElevations(coordsRaw)
        : new Array(coordsRaw.length).fill(0);
    const smoothedElevations = smoothElevations(elevations);
    const weather = await fetchRouteWeather(coordsRaw);

    const userMax = clamp(Number(body.user_max_speed ?? 130), 30, 180);
    const profile = body.vehicle_profile ?? {};
    const passengers = Math.max(0, Number(body.num_passengers ?? 1));
    const avgWeight = Math.max(0, Number(body.avg_weight_kg ?? 75));
    const massKg = Math.max(800, Number(profile.empty_mass ?? 1850)) + Math.max(0, Number(profile.extra_load ?? 0)) + passengers * avgWeight;
    const rawDrag = Number(profile.drag_coefficient ?? 0.26);
    const frontalArea = Math.max(1, Number(profile.frontal_area ?? 2.2));
    const cda =
      rawDrag > 0.4
        ? Math.max(0.2, rawDrag)
        : Math.max(0.2, rawDrag * frontalArea);
    const crr = clamp(Number(profile.rolling_resistance ?? 0.01), 0.004, 0.02);
    const etaDrive = clamp(Number(profile.motor_efficiency ?? 0.9), 0.7, 0.99);
    const regenEff = clamp(Number(profile.regen_efficiency ?? 0.7), 0.3, 0.95);
    const auxBase = Math.max(0.5, Number(profile.aux_power_kw ?? 2));
    const climateEnabled = Boolean(body.use_climate);
    const climateIntensity = climateEnabled ? clamp(Number(body.climate_intensity ?? 0), 0, 100) : 0;
    const climateBoostKw = (climateIntensity / 100) * 2;
    const comfortTempC = Number(body.comfort_temp_c ?? 20);
    const rhoAirReference = clamp(Number(process.env.DEFAULT_RHO_AIR_REF ?? 1.225), 0.9, 1.4);
    const rhoAirInput = Number(body.rho_air);
    const hasFixedRhoAir = Number.isFinite(rhoAirInput);
    const fixedRhoAir = hasFixedRhoAir ? clamp(rhoAirInput, 0.9, 1.4) : rhoAirReference;
    const maxTimePenaltyPct = clamp(Number(body.max_time_penalty_pct ?? 15), 0, 40);
    const priceEurPerKwh = Math.max(0, Number(body.electricity_price_eur_kwh ?? 0.25));
    const batteryKwh = Math.max(20, Number(profile.battery_kwh ?? 60));
    const maxChargeKw = Math.max(50, Number(profile.max_charge_kw ?? 150));
    const regenMaxKw = Math.max(20, Number(process.env.DEFAULT_REGEN_MAX_KW ?? 70));
    const edgeCount = Math.max(0, coordsRaw.length - 1);
    const edgeGeom = new Array(edgeCount).fill(null).map((_, edge) => {
      const [lon1, lat1] = coordsRaw[edge];
      const [lon2, lat2] = coordsRaw[edge + 1];
      const d = haversineM(lon1, lat1, lon2, lat2);
      const slope = d > 0 ? ((smoothedElevations[edge + 1] ?? 0) - (smoothedElevations[edge] ?? 0)) / d : 0;
      return {
        distanceM: d,
        slope,
        tempC: weather.edgeTemp[edge] ?? 20,
        rain: weather.edgeRain[edge] ?? 0,
        windMs: weather.edgeWindMs[edge] ?? 0,
        headwindMs: weather.edgeHeadwindMs[edge] ?? 0,
      };
    });
    const rawElevationGainM = edgeGeom.reduce((sum, g, edge) => {
      const delta = (smoothedElevations[edge + 1] ?? 0) - (smoothedElevations[edge] ?? 0);
      return sum + Math.max(0, delta);
    }, 0);
    const rawElevationLossM = edgeGeom.reduce((sum, g, edge) => {
      const delta = (smoothedElevations[edge + 1] ?? 0) - (smoothedElevations[edge] ?? 0);
      return sum + Math.max(0, -delta);
    }, 0);
    const elevationGainM = routeSource === "ors" && Number.isFinite(routeAscentM) ? routeAscentM : rawElevationGainM;
    const elevationLossM = routeSource === "ors" && Number.isFinite(routeDescentM) ? routeDescentM : rawElevationLossM;
    const maxGradePct =
      edgeGeom.length > 0
        ? Math.max(
            ...edgeGeom.map((g) => {
              if ((g.distanceM ?? 0) < 50) return 0;
              return Math.min(12, Math.abs((g.slope ?? 0) * 100));
            }),
          )
        : 0;

    const edgeEnergy = (edge: number, speed: number) => {
      const g = edgeGeom[edge];
      if (!g || g.distanceM <= 0) return { energyKwh: 0, timeH: 0 };
      const veh = {
        massKg,
        cda,
        crr: crr * rainDensityToCrrMultiplier(g.rain) * rollingResistanceTempMultiplier(g.tempC),
        rhoAir: hasFixedRhoAir ? fixedRhoAir : airDensityFromTempC(g.tempC, rhoAirReference),
        etaDrive,
        regenEff,
          auxPowerKw: auxBase + climateBoostKw + cabinClimateAuxKw(g.tempC, comfortTempC, climateEnabled),
        batteryKwh,
        windHeadMs: g.headwindMs,
        regenMaxKw,
      };
      const out = segEnergyAndTime(g.distanceM, g.slope, speed, veh);
      return { energyKwh: out.energyWh / 1000, timeH: out.timeH };
    };

    const evalRange = (from: number, to: number, speed: number) => {
      let distM = 0, wh = 0, timeH = 0, tW = 0, rW = 0;
      for (let i = from + 1; i <= to; i += 1) {
        const edge = i - 1;
        const g = edgeGeom[edge];
        const d = g?.distanceM ?? 0;
        if (d <= 0) continue;
        const slope = g?.slope ?? 0;
        const tempC = g?.tempC ?? 20;
        const rain = g?.rain ?? 0;
        const headwindMs = g?.headwindMs ?? 0;
        const veh = {
          massKg,
          cda,
          crr: crr * rainDensityToCrrMultiplier(rain) * rollingResistanceTempMultiplier(tempC),
          rhoAir: hasFixedRhoAir ? fixedRhoAir : airDensityFromTempC(tempC, rhoAirReference),
          etaDrive,
          regenEff,
          auxPowerKw: auxBase + climateBoostKw + cabinClimateAuxKw(tempC, comfortTempC, climateEnabled),
          batteryKwh,
          windHeadMs: headwindMs,
          regenMaxKw,
        };
        const out = segEnergyAndTime(d, slope, speed, veh);
        distM += d; wh += out.energyWh; timeH += out.timeH; tW += tempC * d; rW += rain * d;
      }
      return { distM, wh, timeH, avgTemp: distM > 0 ? tW / distM : 20, avgRain: distM > 0 ? rW / distM : 0 };
    };

    const evaluateRangeCandidate = (from: number, to: number, speed: number): PlanningSegmentCandidate | null => {
      if (to <= from || from < 0 || to >= coordsRaw.length) return null;
      const edgeEnergyKwh: number[] = [];
      const edgeTimeMin: number[] = [];
      let distM = 0;
      let totalEnergyKwh = 0;
      let totalTimeMin = 0;
      let tempWeighted = 0;
      let rainWeighted = 0;
      for (let coordIdx = from + 1; coordIdx <= to; coordIdx += 1) {
        const edgeIdx = coordIdx - 1;
        const g = edgeGeom[edgeIdx];
        const d = g?.distanceM ?? 0;
        if (d <= 0) {
          edgeEnergyKwh.push(0);
          edgeTimeMin.push(0);
          continue;
        }
        const out = edgeEnergy(edgeIdx, speed);
        const energyKwh = out.energyKwh;
        const timeMin = out.timeH * 60;
        edgeEnergyKwh.push(energyKwh);
        edgeTimeMin.push(timeMin);
        distM += d;
        totalEnergyKwh += energyKwh;
        totalTimeMin += timeMin;
        tempWeighted += (g?.tempC ?? 20) * d;
        rainWeighted += (g?.rain ?? 0) * d;
      }
      if (distM <= 0) return null;
      return {
        speed,
        energyKwh: totalEnergyKwh,
        timeMin: totalTimeMin,
        avgTemp: tempWeighted / distM,
        avgRain: rainWeighted / distM,
        edgeEnergyKwh,
        edgeTimeMin,
      };
    };

    const buildSegmentOut = (base: PlanningSegmentBase, candidate: PlanningSegmentCandidate, index: number): SegmentOut => ({
      idx: index + 1,
      index: index + 1,
      lat_start: base.lat_start,
      lon_start: base.lon_start,
      lat_end: base.lat_end,
      lon_end: base.lon_end,
      distance_m: base.distance_m,
      distance: base.distance_m,
      distance_km: base.distance_m / 1000,
      distanceKm: base.distance_m / 1000,
      way_type: base.way_type,
      speed_limit: base.speed_limit,
      speedLimit: base.speed_limit,
      eco_speed: Number(candidate.speed.toFixed(1)),
      ecoSpeed: Number(candidate.speed.toFixed(1)),
      eco_energy: candidate.energyKwh,
      ecoEnergy: candidate.energyKwh,
      real_energy: candidate.energyKwh,
      limit_energy: base.limitEnergyKwh,
      limitEnergy: base.limitEnergyKwh,
      eco_cost_eur: candidate.energyKwh * priceEurPerKwh,
      limit_cost_eur: base.limitEnergyKwh * priceEurPerKwh,
      eco_time: candidate.timeMin * 60,
      real_time: candidate.timeMin * 60,
      limit_time: base.limitTimeMin * 60,
      eco_time_min: candidate.timeMin,
      ecoTimeMin: candidate.timeMin,
      limit_time_min: base.limitTimeMin,
      limitTimeMin: base.limitTimeMin,
      temp_c_avg: candidate.avgTemp,
      rain_mmh_avg: candidate.avgRain,
      duration: candidate.timeMin * 60,
    });

    const planningBases: PlanningSegmentBase[] = [];
    const planningRanges: RouteRange[] = [];
    const addSeg = (from: number, to: number, step?: OrsStep) => {
      if (to <= from || from < 0 || to >= coordsRaw.length) return;
      const probe = evalRange(from, to, 50);
      if (probe.distM <= 0) return;
      const legal = legalLimitFromStep(step, userMax, probe.distM);
      let speedLimit = Math.min(legal, maneuverCap(step?.type, step?.instruction));
      speedLimit = snapToFrenchLegalLimit(clamp(speedLimit, 20, userMax), userMax);
      const limitScenario = speedLimit >= 110 ? Math.min(speedLimit, 130) : speedLimit;
      const candidates = buildEcoSpeedCandidates(limitScenario)
        .map((speed) => evaluateRangeCandidate(from, to, speed))
        .filter((candidate): candidate is PlanningSegmentCandidate => candidate !== null);
      if (candidates.length === 0) return;
      const limitCandidate = candidates[0];
      planningBases.push({
        from,
        to,
        lat_start: coordsRaw[from][1],
        lon_start: coordsRaw[from][0],
        lat_end: coordsRaw[to][1],
        lon_end: coordsRaw[to][0],
        distance_m: probe.distM,
        way_type: guessWayType(limitScenario),
        speed_limit: limitScenario,
        avgTemp: limitCandidate.avgTemp,
        avgRain: limitCandidate.avgRain,
        limitEnergyKwh: limitCandidate.energyKwh,
        limitTimeMin: limitCandidate.timeMin,
        candidates,
      });
      planningRanges.push({ from, to });
    };

    if (orsSteps.length > 0) {
      for (const st of orsSteps) {
        const from = clamp(Number(st.way_points?.[0] ?? 0), 0, coordsRaw.length - 1);
        const to = clamp(Number(st.way_points?.[1] ?? from + 1), 0, coordsRaw.length - 1);
        addSeg(from, to, st);
      }
    } else {
      const segCount = coordsRaw.length - 1;
      const chunk = Math.max(1, Math.ceil(segCount / 90));
      for (let s = 0; s < segCount; s += chunk) addSeg(s, Math.min(segCount, s + chunk));
    }

    const batteryStartPct = clamp(Number(body.battery_start_pct ?? 100), 5, 100);
    const batteryEndPct = clamp(requestedBatteryEndPct, 10, 80);
    const warnings: string[] = [];
    if (requestedBatteryEndPct < 10) {
      warnings.push("La batterie d'arrivee a ete relevee a 10% minimum pour garder une marge de securite realiste.");
    }
    if (routeSource !== "ors") {
      warnings.push("Le calcul d'itineraire detaille n'etait pas disponible. Un trace de secours a ete utilise, avec une precision de recharge plus faible.");
    }
    const startKwh = batteryKwh * (batteryStartPct / 100);
    const targetArrivalKwh = batteryKwh * (batteryEndPct / 100);
    const stations = await getStationsCached();
    const mappedStations = mapStationsToRoute(stations, coordsRaw);

    const buildExactProfile = (choiceIndices: number[]) => {
      const edgeEnergyKwh = new Array(edgeCount).fill(0);
      const edgeTimeMin = new Array(edgeCount).fill(0);
      const edgeSpeedKmh = new Array(edgeCount).fill(0);
      for (let segmentIdx = 0; segmentIdx < planningBases.length; segmentIdx += 1) {
        const base = planningBases[segmentIdx];
        const candidate =
          base.candidates[Math.max(0, Math.min(choiceIndices[segmentIdx] ?? 0, base.candidates.length - 1))] ?? base.candidates[0];
        for (let localEdgeIdx = 0; localEdgeIdx < candidate.edgeEnergyKwh.length; localEdgeIdx += 1) {
          const edgeIdx = base.from + localEdgeIdx;
          if (edgeIdx < 0 || edgeIdx >= edgeCount) continue;
          edgeEnergyKwh[edgeIdx] = candidate.edgeEnergyKwh[localEdgeIdx];
          edgeTimeMin[edgeIdx] = candidate.edgeTimeMin[localEdgeIdx];
          edgeSpeedKmh[edgeIdx] = candidate.speed;
        }
      }
      const coordEnergyPrefix = new Array(coordsRaw.length).fill(0);
      const coordTimePrefix = new Array(coordsRaw.length).fill(0);
      for (let coordIdx = 1; coordIdx < coordsRaw.length; coordIdx += 1) {
        coordEnergyPrefix[coordIdx] = coordEnergyPrefix[coordIdx - 1] + Number(edgeEnergyKwh[coordIdx - 1] ?? 0);
        coordTimePrefix[coordIdx] = coordTimePrefix[coordIdx - 1] + Number(edgeTimeMin[coordIdx - 1] ?? 0);
      }
      return { edgeEnergyKwh, edgeTimeMin, edgeSpeedKmh, coordEnergyPrefix, coordTimePrefix };
    };

    const evaluateProfile = (choiceIndices: number[]) => {
      const planningSegments = planningBases.map((base, index) =>
        buildSegmentOut(
          base,
          base.candidates[Math.max(0, Math.min(choiceIndices[index] ?? 0, base.candidates.length - 1))] ?? base.candidates[0],
          index,
        ),
      );
      const normalized = normalizeSegments(
        planningSegments.map((segment) => ({ ...segment })),
        planningRanges.map((range) => ({ ...range })),
      );
      const exact = buildExactProfile(choiceIndices);
      const chargingStops = planChargingStops(
        mappedStations,
        coordsRaw,
        normalized.ranges,
        exact.coordEnergyPrefix,
        exact.coordTimePrefix,
        batteryKwh,
        batteryStartPct,
        batteryEndPct,
        maxChargeKw,
      );
      const totalEnergyKwh = exact.coordEnergyPrefix[exact.coordEnergyPrefix.length - 1] ?? 0;
      const totalDriveTimeMin = exact.coordTimePrefix[exact.coordTimePrefix.length - 1] ?? 0;
      const totalCostEur = totalEnergyKwh * priceEurPerKwh;
      const rechargeNeededKwh = Math.max(0, totalEnergyKwh - (startKwh - targetArrivalKwh));
      const totalStopEnergyKwh = chargingStops.reduce((sum, stop) => sum + Number(stop.energyToCharge ?? 0), 0);
      const unmetRechargeKwh = Math.max(0, rechargeNeededKwh - totalStopEnergyKwh);
      const rechargeCostFromStopsEur = chargingStops.reduce(
        (sum, stop) => sum + Number(stop.estimatedChargeCostEur ?? stop.energyToCharge * priceEurPerKwh),
        0,
      );
      const rechargeCostEur = rechargeCostFromStopsEur + unmetRechargeKwh * priceEurPerKwh;
      const totalChargeTimeMin = chargingStops.reduce((sum, stop) => sum + Number(stop.chargingTimeMinutes ?? 0), 0);
      const avgTemp =
        normalized.segments.length > 0
          ? normalized.segments.reduce((sum, segment) => sum + Number(segment.temp_c_avg ?? 0), 0) / normalized.segments.length
          : 20;
      const preconditioning = chargingStops.reduce(
        (acc, stop) => {
          const segment = normalized.segments[Math.max(0, Math.min(normalized.segments.length - 1, stop.segmentIndex - 1))];
          const kw = batteryPreconditioningKw(segment?.temp_c_avg ?? avgTemp);
          if (kw <= 0) return acc;
          return { kwh: acc.kwh + kw * (20 / 60), timeMin: acc.timeMin + 20 };
        },
        { kwh: 0, timeMin: 0 },
      );
      const preconditioningCostEur = preconditioning.kwh * priceEurPerKwh;
      const totalTripCostWithRechargeEur = totalCostEur + rechargeCostEur;
      const totalTripCostWithRechargeAndPreconditioningEur = totalTripCostWithRechargeEur + preconditioningCostEur;
      return {
        segments: normalized.segments,
        ranges: normalized.ranges,
        chargingStops,
        edgeEnergyKwh: exact.edgeEnergyKwh,
        edgeTimeMin: exact.edgeTimeMin,
        edgeSpeedKmh: exact.edgeSpeedKmh,
        totalEnergyKwh,
        totalDriveTimeMin,
        totalChargeTimeMin,
        totalPreconditioningTimeMin: preconditioning.timeMin,
        totalTimeMin: totalDriveTimeMin + totalChargeTimeMin + preconditioning.timeMin,
        totalCostEur,
        rechargeNeededKwh,
        totalStopEnergyKwh,
        unmetRechargeKwh,
        rechargeCostEur,
        preconditioningEnergyKwh: preconditioning.kwh,
        preconditioningCostEur,
        totalTripCostWithRechargeEur,
        totalTripCostWithRechargeAndPreconditioningEur,
      };
    };

    const limitChoiceIndices = planningBases.map(() => 0);
    const limitEval = evaluateProfile(limitChoiceIndices);
    const allowedEcoTotalTimeMin = limitEval.totalTimeMin * (1 + maxTimePenaltyPct / 100);
    const maxMoves = planningBases.reduce((sum, base) => sum + Math.max(0, base.candidates.length - 1), 0);
    let ecoChoiceIndices = [...limitChoiceIndices];
    let ecoEval = limitEval;
    let optimizerMoves = 0;
    let optimizerEvaluations = 0;

    for (let move = 0; move < maxMoves; move += 1) {
      let bestMove: { choiceIndices: number[]; evaluation: ReturnType<typeof evaluateProfile> } | null = null;
      for (let segmentIdx = 0; segmentIdx < planningBases.length; segmentIdx += 1) {
        const currentCandidateIdx = ecoChoiceIndices[segmentIdx] ?? 0;
        for (let candidateIdx = currentCandidateIdx + 1; candidateIdx < planningBases[segmentIdx].candidates.length; candidateIdx += 1) {
          const nextChoiceIndices = [...ecoChoiceIndices];
          nextChoiceIndices[segmentIdx] = candidateIdx;
          const nextEvaluation = evaluateProfile(nextChoiceIndices);
          optimizerEvaluations += 1;
          if (nextEvaluation.totalTimeMin > allowedEcoTotalTimeMin + 1e-6) continue;
          if (nextEvaluation.totalEnergyKwh >= ecoEval.totalEnergyKwh - 1e-6) continue;
          const isBetter =
            !bestMove ||
            nextEvaluation.totalEnergyKwh < bestMove.evaluation.totalEnergyKwh - 1e-6 ||
            (Math.abs(nextEvaluation.totalEnergyKwh - bestMove.evaluation.totalEnergyKwh) <= 1e-6 &&
              (nextEvaluation.totalTimeMin < bestMove.evaluation.totalTimeMin - 1e-6 ||
                (Math.abs(nextEvaluation.totalTimeMin - bestMove.evaluation.totalTimeMin) <= 1e-6 &&
                  nextEvaluation.chargingStops.length < bestMove.evaluation.chargingStops.length)));
          if (isBetter) {
            bestMove = { choiceIndices: nextChoiceIndices, evaluation: nextEvaluation };
          }
        }
      }
      if (!bestMove) break;
      ecoChoiceIndices = bestMove.choiceIndices;
      ecoEval = bestMove.evaluation;
      optimizerMoves += 1;
    }

    const segments = ecoEval.segments;
    const totalDistance = Number(orsSeg0?.distance ?? segments.reduce((sum, segment) => sum + segment.distance_m, 0));
    const totalDuration = Number(orsSeg0?.duration ?? segments.reduce((sum, segment) => sum + segment.duration, 0));
    const totalDistanceKm = totalDistance / 1000;
    const totalEcoEnergy = ecoEval.totalEnergyKwh;
    const totalLimitEnergy = limitEval.totalEnergyKwh;
    const totalEcoDriveTimeMin = ecoEval.totalDriveTimeMin;
    const totalLimitDriveTimeMin = limitEval.totalDriveTimeMin;
    const totalEcoCostEur = ecoEval.totalCostEur;
    const totalLimitCostEur = limitEval.totalCostEur;
    const rechargeNeededEcoKwh = ecoEval.rechargeNeededKwh;
    const rechargeNeededLimitKwh = limitEval.rechargeNeededKwh;
    const totalEcoStopEnergyKwh = ecoEval.totalStopEnergyKwh;
    const totalLimitStopEnergyKwh = limitEval.totalStopEnergyKwh;
    const unmetEcoRechargeKwh = ecoEval.unmetRechargeKwh;
    const unmetLimitRechargeKwh = limitEval.unmetRechargeKwh;
    const rechargeCostEcoEur = ecoEval.rechargeCostEur;
    const rechargeCostLimitEur = limitEval.rechargeCostEur;
    const ecoStops = ecoEval.chargingStops;
    const limitStops = limitEval.chargingStops;
    if (unmetEcoRechargeKwh > 0.5) {
      warnings.push(
        `Le plan de recharge eco couvre ${totalEcoStopEnergyKwh.toFixed(1)} kWh sur ${rechargeNeededEcoKwh.toFixed(1)} kWh necessaires.`,
      );
    }
    if (unmetLimitRechargeKwh > 0.5) {
      warnings.push(
        `Le plan de recharge limite couvre ${totalLimitStopEnergyKwh.toFixed(1)} kWh sur ${rechargeNeededLimitKwh.toFixed(1)} kWh necessaires.`,
      );
    }
    const totalEcoTripCostWithRechargeEur = ecoEval.totalTripCostWithRechargeEur;
    const totalLimitTripCostWithRechargeEur = limitEval.totalTripCostWithRechargeEur;
    const totalEcoChargeTimeMin = ecoEval.totalChargeTimeMin;
    const totalLimitChargeTimeMin = limitEval.totalChargeTimeMin;
    const preconditioningEcoKwh = ecoEval.preconditioningEnergyKwh;
    const preconditioningLimitKwh = limitEval.preconditioningEnergyKwh;
    const preconditioningCostEcoEur = ecoEval.preconditioningCostEur;
    const preconditioningCostLimitEur = limitEval.preconditioningCostEur;
    const totalEcoPreconditioningTimeMin = ecoEval.totalPreconditioningTimeMin;
    const totalLimitPreconditioningTimeMin = limitEval.totalPreconditioningTimeMin;
    const totalEcoTimeMin = ecoEval.totalTimeMin;
    const totalLimitTimeMin = limitEval.totalTimeMin;
    const gridCo2KgPerKwh = clamp(Number(process.env.DEFAULT_GRID_CO2_KG_PER_KWH ?? CO2_FRANCE_KG_PER_KWH), 0.01, 1.2);
    const co2AvoidedKg = Math.max(0, (totalLimitEnergy - totalEcoEnergy) * gridCo2KgPerKwh);
    const avgTemp = segments.length ? segments.reduce((sum, segment) => sum + segment.temp_c_avg, 0) / segments.length : 20;
    const avgRain = segments.length ? segments.reduce((sum, segment) => sum + segment.rain_mmh_avg, 0) / segments.length : 0;
    const weatherProfile: WeatherEdgeOut[] = edgeGeom.map((g, edgeIdx) => {
      const ecoSpeed = Math.max(20, Number(ecoEval.edgeSpeedKmh[edgeIdx] ?? 50));
      const limSpeed = Math.max(20, Number(limitEval.edgeSpeedKmh[edgeIdx] ?? ecoSpeed));
      return {
        edge_index: edgeIdx,
        distance_km: (g.distanceM ?? 0) / 1000,
        temp_c: g.tempC,
        rain_mmh: g.rain,
        wind_kmh: (g.windMs ?? 0) * 3.6,
        headwind_ms: g.headwindMs ?? 0,
        rain_crr_multiplier: rainDensityToCrrMultiplier(g.rain),
        hvac_kw: auxBase + climateBoostKw + cabinClimateAuxKw(g.tempC, comfortTempC, climateEnabled),
        eco_speed_kmh: ecoSpeed,
        limit_speed_kmh: limSpeed,
        eco_energy_kwh: Number(ecoEval.edgeEnergyKwh[edgeIdx] ?? 0),
        limit_energy_kwh: Number(limitEval.edgeEnergyKwh[edgeIdx] ?? 0),
        eco_time_min: Number(ecoEval.edgeTimeMin[edgeIdx] ?? 0),
      };
    });
    const nearbyStations = listStationsNearRoute(stations, coordsRaw, 20, 260);
    const nearStart20km = listStationsNearPoint(stations, startCoord[0], startCoord[1], 20, 120);
    const nearEnd20km = listStationsNearPoint(stations, endCoord[0], endCoord[1], 20, 120);
    const contextStations =
      nearbyStations.length > 0
        ? [...nearbyStations, ...nearStart20km, ...nearEnd20km]
        : [...ecoStops, ...limitStops].map((s) => s.station);
    if (contextStations.length > 0) {
      const dedup = new Map<string, ChargingStation>();
      for (const st of contextStations) dedup.set(`${st.name}|${st.latitude.toFixed(4)}|${st.longitude.toFixed(4)}`, st);
      setRouteChargingContext([...dedup.values()]);
    }
    const rainPoints = weatherProfile.filter((w) => w.rain_mmh > 0.05);
    const rainDistanceKm = rainPoints.reduce((sum, w) => sum + w.distance_km, 0);
    const tempMinC = weatherProfile.length > 0 ? Math.min(...weatherProfile.map((w) => w.temp_c)) : avgTemp;
    const tempMaxC = weatherProfile.length > 0 ? Math.max(...weatherProfile.map((w) => w.temp_c)) : avgTemp;
    const windAvgKmh =
      weatherProfile.length > 0 ? weatherProfile.reduce((sum, w) => sum + Number(w.wind_kmh ?? 0), 0) / weatherProfile.length : 0;
    const headwindAvgMs =
      weatherProfile.length > 0 ? weatherProfile.reduce((sum, w) => sum + Number(w.headwind_ms ?? 0), 0) / weatherProfile.length : 0;
    let ecoNeutralEnergyKwh = 0;
    let limitNeutralEnergyKwh = 0;
    for (let edgeIdx = 0; edgeIdx < edgeGeom.length; edgeIdx += 1) {
      const ecoSpeed = Math.max(20, Number(ecoEval.edgeSpeedKmh[edgeIdx] ?? 50));
      const limSpeed = Math.max(20, Number(limitEval.edgeSpeedKmh[edgeIdx] ?? ecoSpeed));
      const g = edgeGeom[edgeIdx];
      if (!g || g.distanceM <= 0) continue;
      const neutralVeh = {
        massKg,
        cda,
        crr: crr * rollingResistanceTempMultiplier(comfortTempC),
        rhoAir: hasFixedRhoAir ? fixedRhoAir : airDensityFromTempC(comfortTempC, rhoAirReference),
        etaDrive,
        regenEff,
        auxPowerKw: auxBase + climateBoostKw + cabinClimateAuxKw(comfortTempC, comfortTempC, climateEnabled),
        batteryKwh,
        windHeadMs: 0,
        regenMaxKw,
      };
      ecoNeutralEnergyKwh += segEnergyAndTime(g.distanceM, g.slope, ecoSpeed, neutralVeh).energyWh / 1000;
      limitNeutralEnergyKwh += segEnergyAndTime(g.distanceM, g.slope, limSpeed, neutralVeh).energyWh / 1000;
    }
    const weatherImpactEcoKwh = Math.max(0, totalEcoEnergy - ecoNeutralEnergyKwh);
    const weatherImpactLimitKwh = Math.max(0, totalLimitEnergy - limitNeutralEnergyKwh);
    const weatherImpactEcoEur = weatherImpactEcoKwh * priceEurPerKwh;
    const weatherImpactLimitEur = weatherImpactLimitKwh * priceEurPerKwh;
    const totalEcoTripCostWithRechargeAndPrecondEur = totalEcoTripCostWithRechargeEur + preconditioningCostEcoEur;
    const totalLimitTripCostWithRechargeAndPrecondEur = totalLimitTripCostWithRechargeEur + preconditioningCostLimitEur;
    const fossilFuelPriceEurPerL = Math.max(0, Number(process.env.DEFAULT_FOSSIL_FUEL_EUR_PER_L ?? 1.95));
    const thermalConsumptionLPer100 = 6.8;
    const thermalTripCostEur = totalDistanceKm * (thermalConsumptionLPer100 / 100) * fossilFuelPriceEurPerL;
    const motorwayDistanceKm = segments
      .filter((s) => Number(s.speed_limit ?? 0) >= 110)
      .reduce((sum, s) => sum + Number(s.distance_km ?? 0), 0);
    const tollRateMotorwayEurPerKm = Math.max(0, Number(process.env.TOLL_RATE_EUR_PER_KM ?? 0.11));
    const tollCostEur = motorwayDistanceKm * tollRateMotorwayEurPerKm;
    const totalEcoTripCostAllEur = totalEcoTripCostWithRechargeAndPrecondEur + tollCostEur;
    const totalLimitTripCostAllEur = totalLimitTripCostWithRechargeAndPrecondEur + tollCostEur;
    const routeRoadmap = ecoStops.map((s, i) => {
      const preconditioningKw = batteryPreconditioningKw(
        segments[Math.max(0, Math.min(segments.length - 1, s.segmentIndex - 1))]?.temp_c_avg ?? avgTemp,
      );
      const preconditioningMin = preconditioningKw > 0 ? 20 : 0;
      return {
        stop_number: i + 1,
        segment_index: s.segmentIndex,
        station_name: s.station.name,
        station_operator: s.station.operator,
        station_status: s.station.status,
        station_address: s.station.address,
        station_power_kw: s.station.powerKw,
        station_price_eur_kwh: estimateStationPriceEurPerKwh(s.station),
        detour_from_route_km: s.distKmFromRoute,
        station_score: s.stationScore,
        battery_pct_before_charge: s.batteryLevelAtCharge,
        drive_time_from_previous_stop_min: s.driveTimeFromPreviousStopMin,
        drive_distance_from_previous_stop_km: s.driveDistanceFromPreviousStopKm,
        minimum_charge_energy_kwh: s.minimumEnergyToCharge,
        minimum_battery_pct_after_charge: s.minimumTargetBatteryPct,
        minimum_charge_time_min: s.minimumChargingTimeMinutes,
        minimum_charge_time_min_raw: s.minimumChargingTimeMinutesRaw,
        battery_pct_after_charge: s.batteryPctAfterCharge,
        charge_energy_kwh: s.energyToCharge,
        charge_time_min: s.chargingTimeMinutes,
        charge_time_min_raw: s.chargingTimeMinutesRaw,
        charge_time_minimum_applied: Boolean(s.chargingTimeIsMinimum),
        charge_cost_eur: s.estimatedChargeCostEur,
        preconditioning_min: preconditioningMin,
        preconditioning_kw: preconditioningKw,
      };
    });
    const segmentLogbook = segments.map((seg) => ({
      id_segment: seg.idx,
      distance_km: seg.distance_km,
      conso_reelle_kwh: seg.eco_energy,
      conso_theorique_kwh: seg.limit_energy,
      cout_eur: seg.eco_cost_eur,
      meteo: {
        temperature_c: seg.temp_c_avg,
        pluie_mmh: seg.rain_mmh_avg,
      },
    }));

    return NextResponse.json({
      start_location: body.start,
      end_location: body.end,
      start: body.start,
      end: body.end,
      route_coordinates: coordsRaw.map(([lon, lat]) => [lat, lon]),
      segments,
      routeChargingStations: ecoStops,
      limitChargingStations: limitStops,
      nearbyChargingStations: nearbyStations,
      total_distance: totalDistance,
      totalDistance: totalDistance,
      total_distance_km: totalDistanceKm,
      totalDistanceKm,
      total_duration: totalDuration,
      totalDuration: totalDuration,
      total_eco_energy: totalEcoEnergy,
      totalEcoEnergy: totalEcoEnergy,
      total_limit_energy: totalLimitEnergy,
      totalLimitEnergy: totalLimitEnergy,
      total_eco_time_min: totalEcoTimeMin,
      totalEcoTimeMin: totalEcoTimeMin,
      total_limit_time_min: totalLimitTimeMin,
      totalLimitTimeMin: totalLimitTimeMin,
      total_eco_drive_time_min: totalEcoDriveTimeMin,
      total_limit_drive_time_min: totalLimitDriveTimeMin,
      total_eco_charge_time_min: totalEcoChargeTimeMin,
      total_limit_charge_time_min: totalLimitChargeTimeMin,
      total_eco_preconditioning_time_min: totalEcoPreconditioningTimeMin,
      total_limit_preconditioning_time_min: totalLimitPreconditioningTimeMin,
      total_eco_cost_eur: totalEcoCostEur,
      totalEcoCostEur: totalEcoCostEur,
      total_limit_cost_eur: totalLimitCostEur,
      totalLimitCostEur: totalLimitCostEur,
      cost_saved_vs_limit_eur: totalLimitCostEur - totalEcoCostEur,
      recharge_needed_eco_kwh: rechargeNeededEcoKwh,
      recharge_needed_limit_kwh: rechargeNeededLimitKwh,
      recharge_cost_eco_eur: rechargeCostEcoEur,
      recharge_cost_limit_eur: rechargeCostLimitEur,
      preconditioning_energy_eco_kwh: preconditioningEcoKwh,
      preconditioning_energy_limit_kwh: preconditioningLimitKwh,
      preconditioning_cost_eco_eur: preconditioningCostEcoEur,
      preconditioning_cost_limit_eur: preconditioningCostLimitEur,
      total_eco_trip_cost_with_recharge_eur: totalEcoTripCostWithRechargeEur,
      total_limit_trip_cost_with_recharge_eur: totalLimitTripCostWithRechargeEur,
      total_eco_trip_cost_with_recharge_and_preconditioning_eur: totalEcoTripCostWithRechargeAndPrecondEur,
      total_limit_trip_cost_with_recharge_and_preconditioning_eur: totalLimitTripCostWithRechargeAndPrecondEur,
      toll_cost_eur: tollCostEur,
      toll_rate_motorway_eur_per_km: tollRateMotorwayEurPerKm,
      motorway_distance_km: motorwayDistanceKm,
      total_eco_trip_cost_all_in_eur: totalEcoTripCostAllEur,
      total_limit_trip_cost_all_in_eur: totalLimitTripCostAllEur,
      trip_cost_eco_with_recharge_eur: totalEcoTripCostWithRechargeEur,
      trip_cost_normal_with_recharge_eur: totalLimitTripCostWithRechargeEur,
      total_trip_savings_vs_limit_eur: totalLimitTripCostWithRechargeEur - totalEcoTripCostWithRechargeEur,
      optimized_stop_count_eco: ecoStops.length,
      optimized_stop_count_limit: limitStops.length,
      warnings,
      planning_assumptions: {
        route_source: routeSource,
        max_time_penalty_pct: maxTimePenaltyPct,
        eco_speed_solver: "full_trip_energy_minimization_under_total_time_constraint",
        eco_speed_constraint_basis: "drive_time_plus_charging_time_plus_preconditioning",
        eco_speed_candidate_step_kmh: 5,
        motorway_min_eco_speed_kmh_normal_conditions: 100,
        reference_total_trip_time_min: limitEval.totalTimeMin,
        allowed_total_trip_time_min: allowedEcoTotalTimeMin,
        optimizer_moves_applied: optimizerMoves,
        optimizer_profile_evaluations: optimizerEvaluations,
        use_climate: climateEnabled,
        climate_intensity_pct: climateIntensity,
        min_arrival_soc_pct: 10,
        requested_arrival_soc_pct: requestedBatteryEndPct,
        effective_arrival_soc_pct: batteryEndPct,
        safety_reserve_kwh: targetArrivalKwh,
        preconditioning_minutes_per_stop: 20,
        preconditioning_minutes_per_stop_max: 20,
        preconditioning_activation_temp_c: 10,
        charging_soc_soft_cap_pct: 95,
        weather_sample_count: Number(weather.samples ?? 0),
      },
      battery_end_pct_requested: requestedBatteryEndPct,
      battery_end_pct_effective: batteryEndPct,
      battery_start_pct: batteryStartPct,
      battery_end_pct: batteryEndPct,
      batteryStartPct,
      batteryEndPct,
      weather_samples: Number(weather.samples ?? 0),
      weather_avg_temp_c: avgTemp,
      weather_avg_rain_mmh: avgRain,
      weather_avg_wind_kmh: windAvgKmh,
      weather_avg_headwind_ms: headwindAvgMs,
      elevation_gain_m: elevationGainM,
      elevation_loss_m: elevationLossM,
      max_grade_pct: maxGradePct,
      weather_temperature_min_c: tempMinC,
      weather_temperature_max_c: tempMaxC,
      rain_present: rainPoints.length > 0,
      rain_points_count: rainPoints.length,
      rain_distance_km: rainDistanceKm,
      weather_profile_edges: weatherProfile,
      weather_impact_eco_kwh: weatherImpactEcoKwh,
      weather_impact_limit_kwh: weatherImpactLimitKwh,
      weather_impact_eco_eur: weatherImpactEcoEur,
      weather_impact_limit_eur: weatherImpactLimitEur,
      route_source: routeSource,
      co2_avoided_kg: co2AvoidedKg,
      co2_equivalents: co2Equivalents(co2AvoidedKg),
      etat_initial: {
        modele: body.vehicle_profile ?? {},
        batterie_kwh: batteryKwh,
        soc_depart_pct: batteryStartPct,
        soc_arrivee_cible_pct: batteryEndPct,
        meteo_depart: {
          temperature_c: weatherProfile[0]?.temp_c ?? avgTemp,
          pluie_mmh: weatherProfile[0]?.rain_mmh ?? avgRain,
        },
      },
      feuille_de_route: {
        stops_optimises: routeRoadmap,
        cout_estime_electrique_eur: totalEcoTripCostAllEur,
        recharge_estimee_kwh: rechargeNeededEcoKwh + preconditioningEcoKwh,
      },
      tableau_comparatif: {
        electrique_eco_110: {
          energie_kwh: totalEcoEnergy,
          temps_min: totalEcoTimeMin,
          temps_conduite_min: totalEcoDriveTimeMin,
          temps_recharge_min: totalEcoChargeTimeMin,
          temps_preconditionnement_min: totalEcoPreconditioningTimeMin,
          cout_total_eur: totalEcoTripCostAllEur,
          stops: ecoStops.length,
        },
        classique_limite_130: {
          energie_kwh: totalLimitEnergy,
          temps_min: totalLimitTimeMin,
          temps_conduite_min: totalLimitDriveTimeMin,
          temps_recharge_min: totalLimitChargeTimeMin,
          temps_preconditionnement_min: totalLimitPreconditioningTimeMin,
          cout_total_eur: totalLimitTripCostAllEur,
          stops: limitStops.length,
        },
        thermique_reference: {
          carburant_l_100km: thermalConsumptionLPer100,
          prix_carburant_eur_l: fossilFuelPriceEurPerL,
          cout_total_eur: thermalTripCostEur,
        },
      },
      historique: {
        distance_validee_km: totalDistanceKm,
        segments_valides: totalDistanceKm > 0 ? segmentLogbook : [],
      },
      comparison_vs_normal: {
        normal_speed_limit_trip: {
          energy_kwh: totalLimitEnergy,
          time_min: totalLimitTimeMin,
          drive_time_min: totalLimitDriveTimeMin,
          charge_time_min: totalLimitChargeTimeMin,
          preconditioning_time_min: totalLimitPreconditioningTimeMin,
          rolling_cost_eur: totalLimitCostEur,
          recharge_cost_eur: rechargeCostLimitEur + preconditioningCostLimitEur,
          total_cost_eur: totalLimitTripCostWithRechargeAndPrecondEur,
          stops: limitStops.length,
        },
        eco_optimized_trip: {
          energy_kwh: totalEcoEnergy,
          time_min: totalEcoTimeMin,
          drive_time_min: totalEcoDriveTimeMin,
          charge_time_min: totalEcoChargeTimeMin,
          preconditioning_time_min: totalEcoPreconditioningTimeMin,
          rolling_cost_eur: totalEcoCostEur,
          recharge_cost_eur: rechargeCostEcoEur + preconditioningCostEcoEur,
          total_cost_eur: totalEcoTripCostWithRechargeAndPrecondEur,
          stops: ecoStops.length,
        },
      },
      summary: {
        battery_start_pct: batteryStartPct,
        battery_end_pct: batteryEndPct,
        total_distance_km: totalDistanceKm,
        total_eco_energy: totalEcoEnergy,
        total_limit_energy: totalLimitEnergy,
        total_eco_time_min: totalEcoTimeMin,
        total_limit_time_min: totalLimitTimeMin,
        total_eco_drive_time_min: totalEcoDriveTimeMin,
        total_limit_drive_time_min: totalLimitDriveTimeMin,
        total_eco_charge_time_min: totalEcoChargeTimeMin,
        total_limit_charge_time_min: totalLimitChargeTimeMin,
        total_eco_preconditioning_time_min: totalEcoPreconditioningTimeMin,
        total_limit_preconditioning_time_min: totalLimitPreconditioningTimeMin,
        total_eco_cost_eur: totalEcoCostEur,
        total_limit_cost_eur: totalLimitCostEur,
        total_eco_trip_cost_with_recharge_eur: totalEcoTripCostWithRechargeEur,
        total_limit_trip_cost_with_recharge_eur: totalLimitTripCostWithRechargeEur,
        weather_avg_temp_c: avgTemp,
        weather_avg_rain_mmh: avgRain,
        weather_avg_wind_kmh: windAvgKmh,
        weather_avg_headwind_ms: headwindAvgMs,
        elevation_gain_m: elevationGainM,
        elevation_loss_m: elevationLossM,
        max_grade_pct: maxGradePct,
        warnings_count: warnings.length,
      },
      vehicle_profile: body.vehicle_profile ?? {},
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Route unavailable";
    return NextResponse.json({ detail: msg }, { status: 500 });
  }
}
