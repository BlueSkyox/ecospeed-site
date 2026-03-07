import { NextRequest, NextResponse } from "next/server";
import {
  airDensityFromTempC,
  batteryPreconditioningKw,
  haversineM,
  hvacPowerFromTemp,
  rainDensityToCrrMultiplier,
  segEnergyAndTime,
} from "@/lib/ev";
import { setRouteChargingContext, type ChargingStation } from "@/lib/charging-context";
import { FALLBACK_STATIONS, fetchOpenChargeMapStations } from "@/lib/charging-stations";

const DEFAULT_ORS_API_KEY =
  "eyJvcmciOiI1YjNjZTM1OTc4NTExMTAwMDFjZjYyNDgiLCJpZCI6IjA5MDkyNTdkYTlmNzQ5NmNhNjMxNzVjZGM1NTE0ZWYzIiwiaCI6Im11cm11cjY0In0=";

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

function orsKey() {
  return process.env.OPENROUTESERVICE_API_KEY || process.env.ORS_API_KEY || DEFAULT_ORS_API_KEY;
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
  rain_crr_multiplier: number;
  hvac_kw: number;
  eco_speed_kmh: number;
  limit_speed_kmh: number;
  eco_energy_kwh: number;
  limit_energy_kwh: number;
};

type StopOut = {
  segmentIndex: number;
  lat: number;
  lon: number;
  station: ChargingStation;
  batteryLevelAtCharge: number;
  chargingTimeMinutes: number;
  energyToCharge: number;
};

async function geocode(text: string): Promise<[number, number]> {
  const known = knownPointLookup(text);
  if (known) return known;
  const url = `https://api.openrouteservice.org/geocode/search?api_key=${encodeURIComponent(
    orsKey(),
  )}&text=${encodeURIComponent(text)}&size=1`;
  const r = await withTimeout(fetch(url, { cache: "no-store" }), 12000);
  if (!r.ok) throw new Error("Geocode failed");
  const data = await r.json();
  const coord = data?.features?.[0]?.geometry?.coordinates;
  if (!Array.isArray(coord) || coord.length < 2) throw new Error("Address not found");
  return [Number(coord[0]), Number(coord[1])];
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

async function fetchElevations(coords: [number, number][]) {
  const out = new Array(coords.length).fill(0);
  try {
    const chunkSize = 90;
    for (let i = 0; i < coords.length; i += chunkSize) {
      const chunk = coords.slice(i, i + chunkSize);
      const locations = chunk.map((c) => `${c[1]},${c[0]}`).join("|");
      const r = await withTimeout(
        fetch(`https://api.open-elevation.com/api/v1/lookup?locations=${encodeURIComponent(locations)}`, {
          cache: "no-store",
        }),
        8000,
      );
      if (!r.ok) return out;
      const j = await r.json();
      const vals = (j?.results ?? []).map((x: { elevation?: number }) => Number(x.elevation ?? 0));
      for (let k = 0; k < vals.length; k += 1) out[i + k] = vals[k];
    }
    return out;
  } catch {
    return out;
  }
}

function pickSampleIndices(totalPoints: number, maxSamples: number): number[] {
  if (totalPoints <= 0) return [];
  if (totalPoints <= maxSamples) return Array.from({ length: totalPoints }, (_, i) => i);
  const out: number[] = [];
  for (let i = 0; i < maxSamples; i += 1) out.push(Math.round((i * (totalPoints - 1)) / (maxSamples - 1)));
  return [...new Set(out)].sort((a, b) => a - b);
}

async function fetchPointWeather(lat: number, lon: number): Promise<{ tempC: number; rainMmH: number }> {
  const r = await withTimeout(
    fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,precipitation,rain`,
      { cache: "no-store" },
    ),
    7000,
  );
  if (!r.ok) throw new Error("weather fetch failed");
  const j = await r.json();
  const cur = j?.current ?? {};
  return { tempC: Number(cur.temperature_2m ?? 20), rainMmH: Number(cur.rain ?? cur.precipitation ?? 0) };
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

async function fetchRouteWeather(coords: [number, number][]) {
  try {
    const sampleIdx = pickSampleIndices(coords.length, 12);
    const samples = await Promise.all(
      sampleIdx.map(async (idx) => {
        const [lon, lat] = coords[idx];
        const w = await fetchPointWeather(lat, lon);
        return { idx, tempC: w.tempC, rainMmH: Math.max(0, w.rainMmH) };
      }),
    );
    const tempMap = new Map<number, number>();
    const rainMap = new Map<number, number>();
    for (const s of samples) {
      tempMap.set(s.idx, s.tempC);
      rainMap.set(s.idx, s.rainMmH);
    }
    const pointTemp = interpolateByIndex(tempMap, coords.length);
    const pointRain = interpolateByIndex(rainMap, coords.length);
    return {
      edgeTemp: pointTemp.slice(1).map((v, i) => (v + pointTemp[i]) / 2),
      edgeRain: pointRain.slice(1).map((v, i) => Math.max(0, (v + pointRain[i]) / 2)),
      samples: sampleIdx.length,
    };
  } catch {
    return {
      edgeTemp: new Array(Math.max(0, coords.length - 1)).fill(20),
      edgeRain: new Array(Math.max(0, coords.length - 1)).fill(0),
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

function planChargingStops(
  mode: "eco_energy" | "limit_energy",
  segments: SegmentOut[],
  coords: [number, number][],
  stepRanges: Array<{ from: number; to: number }>,
  stations: ChargingStation[],
  batteryKwh: number,
  startPct: number,
  targetEndPct: number,
  maxChargeKw: number,
): StopOut[] {
  const n = segments.length;
  if (n === 0) return [];
  const reserve = batteryKwh * (Math.max(10, targetEndPct) / 100);
  const maxCharge = batteryKwh * 0.8;
  const minChargeTarget = batteryKwh * 0.8;
  const minArrivalBuffer = Math.max(0.8, batteryKwh * 0.01);
  const prefix = new Array(n + 1).fill(0);
  for (let i = 0; i < n; i += 1) prefix[i + 1] = prefix[i] + Number(segments[i][mode] ?? 0);
  const totalEnergy = prefix[n];

  const mappedRaw = stations
    .map((st) => {
      const near = nearestPointOnRoute(st, coords);
      const segIdx = coordToSegIndex(near.coordIdx, stepRanges);
      return { st, segIdx, distKm: near.distM / 1000 };
    })
    .filter((x) => x.distKm <= 12);
  if (mappedRaw.length === 0) return [];

  const bySeg = new Map<number, { st: ChargingStation; segIdx: number; distKm: number }>();
  for (const m of mappedRaw) {
    const cur = bySeg.get(m.segIdx);
    if (!cur) {
      bySeg.set(m.segIdx, m);
      continue;
    }
    const curPower = Number(cur.st.powerKw ?? 0);
    const nextPower = Number(m.st.powerKw ?? 0);
    if (nextPower > curPower || (nextPower === curPower && m.distKm < cur.distKm)) bySeg.set(m.segIdx, m);
  }
  const mapped = [...bySeg.values()].sort((a, b) => a.segIdx - b.segIdx);
  if (mapped.length === 0) return [];

  const stops: StopOut[] = [];
  let i = 0;
  let energy = batteryKwh * (startPct / 100);
  let guard = 0;

  while (i < n && guard < n + 20) {
    guard += 1;
    const needToFinish = totalEnergy - prefix[i] + reserve;
    if (energy >= needToFinish - minArrivalBuffer) break;

    const reachable = mapped
      .filter((m) => m.segIdx > i)
      .map((m) => {
        const driveE = prefix[m.segIdx] - prefix[i];
        return { ...m, driveE };
      })
      .filter((m) => m.driveE <= Math.max(0, energy - reserve - minArrivalBuffer));
    if (reachable.length === 0) break;

    reachable.sort((a, b) => {
      if (b.segIdx !== a.segIdx) return b.segIdx - a.segIdx;
      return b.st.powerKw - a.st.powerKw;
    });
    const chosen = reachable[0];
    energy -= chosen.driveE;
    if (energy < reserve) energy = reserve;
    const remainingFromHere = totalEnergy - prefix[chosen.segIdx];
    const targetAtCharge = Math.min(maxCharge, Math.max(minChargeTarget, remainingFromHere + reserve));
    const charge = Math.max(0, targetAtCharge - energy);
    if (charge < Math.max(2, batteryKwh * 0.03)) break;
    const power = Math.max(20, Math.min(maxChargeKw, chosen.st.powerKw || 50));
    const mins = (charge / power) * 60;
    stops.push({
      segmentIndex: chosen.segIdx,
      lat: chosen.st.latitude,
      lon: chosen.st.longitude,
      station: chosen.st,
      batteryLevelAtCharge: clamp((energy / batteryKwh) * 100, 0, 100),
      chargingTimeMinutes: mins,
      energyToCharge: charge,
    });
    energy += charge;
    i = chosen.segIdx;
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
    const startCoord = await resolvePoint(body.start);
    const endCoord = await resolvePoint(body.end);
    let coordsRaw: [number, number][] = [];
    let orsSeg0: { distance?: number; duration?: number; steps?: OrsStep[] } | undefined;
    let orsSteps: OrsStep[] = [];
    let routeSource: "ors" | "synthetic" = "ors";
    try {
      const routeResp = await withTimeout(
        fetch("https://api.openrouteservice.org/v2/directions/driving-car/geojson", {
          method: "POST",
          headers: { Authorization: orsKey(), "Content-Type": "application/json" },
          body: JSON.stringify({ coordinates: [startCoord, endCoord], instructions: true }),
          cache: "no-store",
        }),
        15000,
      );
      if (!routeResp.ok) throw new Error("Route failed");
      const data = await routeResp.json();
      const feat = data?.features?.[0];
      const maybeCoords = feat?.geometry?.coordinates as [number, number][] | undefined;
      if (!Array.isArray(maybeCoords) || maybeCoords.length < 2) throw new Error("No route geometry");
      coordsRaw = maybeCoords;
      orsSeg0 = feat?.properties?.segments?.[0];
      orsSteps = (Array.isArray(orsSeg0?.steps) ? orsSeg0.steps : []) as OrsStep[];
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

    const elevations = await fetchElevations(coordsRaw);
    const weather = await fetchRouteWeather(coordsRaw);

    const userMax = clamp(Number(body.user_max_speed ?? 130), 30, 180);
    const profile = body.vehicle_profile ?? {};
    const passengers = Math.max(0, Number(body.num_passengers ?? 1));
    const avgWeight = Math.max(0, Number(body.avg_weight_kg ?? 75));
    const massKg = Math.max(800, Number(profile.empty_mass ?? 1800)) + Math.max(0, Number(profile.extra_load ?? 0)) + passengers * avgWeight;
    const cda = Math.max(0.2, Number(profile.drag_coefficient ?? 0.65) * Math.max(1, Number(profile.frontal_area ?? 2.2)));
    const crr = clamp(Number(profile.rolling_resistance ?? 0.01), 0.004, 0.02);
    const etaDrive = clamp(Number(profile.motor_efficiency ?? 0.9), 0.7, 0.99);
    const regenEff = clamp(Number(profile.regen_efficiency ?? 0.7), 0.3, 0.95);
    const auxBase = Math.max(0.5, Number(profile.aux_power_kw ?? 2));
    const climateIntensity = body.use_climate ? clamp(Number(body.climate_intensity ?? 0), 0, 100) : 0;
    const climateBoostKw = (climateIntensity / 100) * 2;
    const comfortTempC = Number(body.comfort_temp_c ?? 20);
    const rhoAir = clamp(Number(body.rho_air ?? 1.225), 0.9, 1.4);
    const maxTimePenaltyPct = clamp(Number(body.max_time_penalty_pct ?? 12), 0, 40);
    const priceEurPerKwh = Math.max(0, Number(body.electricity_price_eur_kwh ?? 0.25));
    const batteryKwh = Math.max(20, Number(profile.battery_kwh ?? 60));
    const maxChargeKw = Math.max(50, Number(profile.max_charge_kw ?? 150));
    const edgeCount = Math.max(0, coordsRaw.length - 1);
    const edgeGeom = new Array(edgeCount).fill(null).map((_, edge) => {
      const [lon1, lat1] = coordsRaw[edge];
      const [lon2, lat2] = coordsRaw[edge + 1];
      const d = haversineM(lon1, lat1, lon2, lat2);
      const slope = d > 0 ? ((elevations[edge + 1] ?? 0) - (elevations[edge] ?? 0)) / d : 0;
      return {
        distanceM: d,
        slope,
        tempC: weather.edgeTemp[edge] ?? 20,
        rain: weather.edgeRain[edge] ?? 0,
      };
    });

    const edgeEnergy = (edge: number, speed: number) => {
      const g = edgeGeom[edge];
      if (!g || g.distanceM <= 0) return { energyKwh: 0, timeH: 0 };
      const veh = {
        massKg,
        cda,
        crr: crr * rainDensityToCrrMultiplier(g.rain),
        rhoAir: airDensityFromTempC(g.tempC, rhoAir),
        etaDrive,
        regenEff,
        auxPowerKw: auxBase + climateBoostKw + hvacPowerFromTemp(g.tempC, comfortTempC),
        batteryKwh,
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
        const veh = {
          massKg,
          cda,
          crr: crr * rainDensityToCrrMultiplier(rain),
          rhoAir: airDensityFromTempC(tempC, rhoAir),
          etaDrive,
          regenEff,
          auxPowerKw: auxBase + climateBoostKw + hvacPowerFromTemp(tempC, comfortTempC),
          batteryKwh,
        };
        const out = segEnergyAndTime(d, slope, speed, veh);
        distM += d; wh += out.energyWh; timeH += out.timeH; tW += tempC * d; rW += rain * d;
      }
      return { distM, wh, timeH, avgTemp: distM > 0 ? tW / distM : 20, avgRain: distM > 0 ? rW / distM : 0 };
    };

    const segments: SegmentOut[] = [];
    const ranges: Array<{ from: number; to: number }> = [];
    const addSeg = (from: number, to: number, step?: OrsStep) => {
      if (to <= from || from < 0 || to >= coordsRaw.length) return;
      const base = evalRange(from, to, 50);
      if (base.distM <= 0) return;
      const legal = legalLimitFromStep(step, userMax, base.distM);
      let speedLimit = Math.min(legal, maneuverCap(step?.type, step?.instruction));
      speedLimit = snapToFrenchLegalLimit(clamp(speedLimit, 20, userMax), userMax);
      const limitScenario = speedLimit >= 110 ? Math.min(speedLimit, 130) : speedLimit;
      const ecoScenario = speedLimit >= 110 ? 110 : Math.max(20, speedLimit - 20);
      const ref = evalRange(from, to, limitScenario);
      const ecoRef = evalRange(from, to, ecoScenario);
      const maxAllowed = ref.timeH * (1 + maxTimePenaltyPct / 100);
      const best = ecoRef.timeH <= maxAllowed + 1e-9 ? { v: ecoScenario, ...ecoRef } : { v: ecoScenario, ...ecoRef };
      const eco = best.wh / 1000, lim = ref.wh / 1000;
      segments.push({
        idx: segments.length + 1,
        index: segments.length + 1,
        lat_start: coordsRaw[from][1],
        lon_start: coordsRaw[from][0],
        lat_end: coordsRaw[to][1],
        lon_end: coordsRaw[to][0],
        distance_m: best.distM,
        distance: best.distM,
        distance_km: best.distM / 1000,
        distanceKm: best.distM / 1000,
        way_type: guessWayType(limitScenario),
        speed_limit: limitScenario,
        speedLimit: limitScenario,
        eco_speed: Number(best.v.toFixed(1)),
        ecoSpeed: Number(best.v.toFixed(1)),
        eco_energy: eco,
        ecoEnergy: eco,
        real_energy: lim,
        limit_energy: lim,
        limitEnergy: lim,
        eco_cost_eur: eco * priceEurPerKwh,
        limit_cost_eur: lim * priceEurPerKwh,
        eco_time: best.timeH * 3600,
        real_time: ref.timeH * 3600,
        limit_time: ref.timeH * 3600,
        eco_time_min: best.timeH * 60,
        ecoTimeMin: best.timeH * 60,
        limit_time_min: ref.timeH * 60,
        limitTimeMin: ref.timeH * 60,
        temp_c_avg: best.avgTemp,
        rain_mmh_avg: best.avgRain,
        duration: best.timeH * 3600,
      });
      ranges.push({ from, to });
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

    const totalDistance = Number(orsSeg0?.distance ?? segments.reduce((s, seg) => s + seg.distance_m, 0));
    const totalDuration = Number(orsSeg0?.duration ?? segments.reduce((s, seg) => s + seg.duration, 0));
    const totalDistanceKm = totalDistance / 1000;
    const totalEcoEnergy = segments.reduce((s, seg) => s + seg.eco_energy, 0);
    const totalLimitEnergy = segments.reduce((s, seg) => s + seg.limit_energy, 0);
    const totalEcoTimeMin = segments.reduce((s, seg) => s + seg.eco_time_min, 0);
    const totalLimitTimeMin = segments.reduce((s, seg) => s + seg.limit_time_min, 0);
    const totalEcoCostEur = totalEcoEnergy * priceEurPerKwh;
    const totalLimitCostEur = totalLimitEnergy * priceEurPerKwh;

    const batteryStartPct = Number(body.battery_start_pct ?? 100);
    const batteryEndPct = Number(body.battery_end_pct ?? 20);
    const startKwh = batteryKwh * (batteryStartPct / 100);
    const targetArrivalKwh = batteryKwh * (batteryEndPct / 100);
    const rechargeNeededEcoKwh = Math.max(0, totalEcoEnergy - (startKwh - targetArrivalKwh));
    const rechargeNeededLimitKwh = Math.max(0, totalLimitEnergy - (startKwh - targetArrivalKwh));
    const co2AvoidedKg = Math.max(0, (totalLimitEnergy - totalEcoEnergy) * 0.5);
    const avgTemp = segments.length ? segments.reduce((s, seg) => s + seg.temp_c_avg, 0) / segments.length : 20;
    const avgRain = segments.length ? segments.reduce((s, seg) => s + seg.rain_mmh_avg, 0) / segments.length : 0;
    const rechargeCostEcoEur = rechargeNeededEcoKwh * priceEurPerKwh;
    const rechargeCostLimitEur = rechargeNeededLimitKwh * priceEurPerKwh;
    const totalEcoTripCostWithRechargeEur = totalEcoCostEur + rechargeCostEcoEur;
    const totalLimitTripCostWithRechargeEur = totalLimitCostEur + rechargeCostLimitEur;

    let stations: ChargingStation[] = FALLBACK_STATIONS;
    try {
      const live = await withTimeout(fetchOpenChargeMapStations(), 8000);
      if (live.length > 0) stations = live;
    } catch {}
    const ecoStops = planChargingStops("eco_energy", segments, coordsRaw, ranges, stations, batteryKwh, batteryStartPct, batteryEndPct, maxChargeKw);
    const limitStops = planChargingStops("limit_energy", segments, coordsRaw, ranges, stations, batteryKwh, batteryStartPct, batteryEndPct, maxChargeKw);
    const preconditioningEcoKwh = ecoStops.reduce((sum, stop) => {
      const seg = segments[Math.max(0, Math.min(segments.length - 1, stop.segmentIndex))];
      const kw = batteryPreconditioningKw(seg?.temp_c_avg ?? avgTemp);
      return sum + kw * (20 / 60);
    }, 0);
    const preconditioningLimitKwh = limitStops.reduce((sum, stop) => {
      const seg = segments[Math.max(0, Math.min(segments.length - 1, stop.segmentIndex))];
      const kw = batteryPreconditioningKw(seg?.temp_c_avg ?? avgTemp);
      return sum + kw * (20 / 60);
    }, 0);
    const preconditioningCostEcoEur = preconditioningEcoKwh * priceEurPerKwh;
    const preconditioningCostLimitEur = preconditioningLimitKwh * priceEurPerKwh;
    const edgeToSegment = new Array(Math.max(0, coordsRaw.length - 1)).fill(-1);
    for (let s = 0; s < ranges.length; s += 1) {
      for (let e = ranges[s].from; e < ranges[s].to; e += 1) {
        if (e >= 0 && e < edgeToSegment.length) edgeToSegment[e] = s;
      }
    }
    const weatherProfile: WeatherEdgeOut[] = edgeGeom.map((g, edgeIdx) => {
      const segPos = edgeToSegment[edgeIdx] >= 0 ? edgeToSegment[edgeIdx] : 0;
      const seg = segments[Math.min(segPos, Math.max(0, segments.length - 1))];
      const ecoSpeed = Math.max(20, Number(seg?.eco_speed ?? seg?.speed_limit ?? 50));
      const limSpeed = Math.max(20, Number(seg?.speed_limit ?? 50));
      const ecoOut = edgeEnergy(edgeIdx, ecoSpeed);
      const limOut = edgeEnergy(edgeIdx, limSpeed);
      return {
        edge_index: edgeIdx,
        distance_km: (g.distanceM ?? 0) / 1000,
        temp_c: g.tempC,
        rain_mmh: g.rain,
        rain_crr_multiplier: rainDensityToCrrMultiplier(g.rain),
        hvac_kw: auxBase + climateBoostKw + hvacPowerFromTemp(g.tempC, comfortTempC),
        eco_speed_kmh: ecoSpeed,
        limit_speed_kmh: limSpeed,
        eco_energy_kwh: ecoOut.energyKwh,
        limit_energy_kwh: limOut.energyKwh,
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
    let ecoNeutralEnergyKwh = 0;
    let limitNeutralEnergyKwh = 0;
    for (let edgeIdx = 0; edgeIdx < edgeGeom.length; edgeIdx += 1) {
      const segPos = edgeToSegment[edgeIdx] >= 0 ? edgeToSegment[edgeIdx] : 0;
      const seg = segments[Math.min(segPos, Math.max(0, segments.length - 1))];
      const ecoSpeed = Math.max(20, Number(seg?.eco_speed ?? seg?.speed_limit ?? 50));
      const limSpeed = Math.max(20, Number(seg?.speed_limit ?? 50));
      const g = edgeGeom[edgeIdx];
      if (!g || g.distanceM <= 0) continue;
      const neutralVeh = {
        massKg,
        cda,
        crr,
        rhoAir: airDensityFromTempC(comfortTempC, rhoAir),
        etaDrive,
        regenEff,
        auxPowerKw: auxBase + climateBoostKw + hvacPowerFromTemp(comfortTempC, comfortTempC),
        batteryKwh,
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
    const routeRoadmap = ecoStops.map((s, i) => ({
      stop_number: i + 1,
      segment_index: s.segmentIndex,
      station_name: s.station.name,
      station_power_kw: s.station.powerKw,
      charge_energy_kwh: s.energyToCharge,
      charge_time_min: s.chargingTimeMinutes,
      preconditioning_min: 20,
      preconditioning_kw: batteryPreconditioningKw(segments[Math.max(0, Math.min(segments.length - 1, s.segmentIndex))]?.temp_c_avg ?? avgTemp),
    }));
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
      battery_start_pct: batteryStartPct,
      battery_end_pct: batteryEndPct,
      batteryStartPct,
      batteryEndPct,
      weather_samples: weather.samples,
      weather_avg_temp_c: avgTemp,
      weather_avg_rain_mmh: avgRain,
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
          cout_total_eur: totalEcoTripCostAllEur,
          stops: ecoStops.length,
        },
        classique_limite_130: {
          energie_kwh: totalLimitEnergy,
          temps_min: totalLimitTimeMin,
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
          rolling_cost_eur: totalLimitCostEur,
          recharge_cost_eur: rechargeCostLimitEur + preconditioningCostLimitEur,
          total_cost_eur: totalLimitTripCostWithRechargeAndPrecondEur,
          stops: limitStops.length,
        },
        eco_optimized_trip: {
          energy_kwh: totalEcoEnergy,
          time_min: totalEcoTimeMin,
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
        total_eco_cost_eur: totalEcoCostEur,
        total_limit_cost_eur: totalLimitCostEur,
        total_eco_trip_cost_with_recharge_eur: totalEcoTripCostWithRechargeEur,
        total_limit_trip_cost_with_recharge_eur: totalLimitTripCostWithRechargeEur,
        weather_avg_temp_c: avgTemp,
        weather_avg_rain_mmh: avgRain,
      },
      vehicle_profile: body.vehicle_profile ?? {},
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Route unavailable";
    return NextResponse.json({ detail: msg }, { status: 500 });
  }
}
