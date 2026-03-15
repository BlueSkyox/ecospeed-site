import { NextRequest, NextResponse } from "next/server";
import { getTripHistory, getTripSession, markTripActive, saveTripSession } from "@/lib/trip-session-store";
import { HVAC_PRESETS, normalizeHvacMode, routeEnergyTimeSegmentWeather, type HvacMode, type VehicleParams } from "@/lib/ev";

type Body = {
  tripId: string;
  batteryPctAfter?: number;
  sessionSnapshot?: {
    tripId: string;
    status?: "planned" | "in_progress" | "paused" | "completed" | "abandoned";
    segmentIndex?: number;
    batteryPctBefore?: number;
    batteryPctAfter?: number;
    didRecharge?: boolean;
    remainingCoords?: [number, number][];
    remainingEcoSpeedsKmh?: number[];
    comfortTempC?: number;
    hvacMode?: HvacMode;
    climateIntensityPct?: number;
    vehicleProfile?: {
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
    route?: {
      total_distance_km?: number;
    };
  };
};

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number) {
  return await Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error("timeout")), timeoutMs)),
  ]);
}

function pickSampleIndices(totalPoints: number, maxSamples: number): number[] {
  if (totalPoints <= 0) return [];
  if (totalPoints <= maxSamples) return Array.from({ length: totalPoints }, (_, i) => i);
  const out: number[] = [];
  for (let i = 0; i < maxSamples; i += 1) {
    out.push(Math.round((i * (totalPoints - 1)) / (maxSamples - 1)));
  }
  return [...new Set(out)].sort((a, b) => a - b);
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

async function pointWeather(lat: number, lon: number) {
  const providers = [
    async () => {
      const r = await withTimeout(
        fetch(
          `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,precipitation,rain,wind_speed_10m,wind_direction_10m`,
          {
            cache: "no-store",
          },
        ),
        7000,
      );
      if (!r.ok) throw new Error("weather failed");
      const j = await r.json();
      const cur = j?.current ?? {};
      return {
        tempC: Number(cur.temperature_2m ?? 20),
        rainMmH: Number(cur.rain ?? cur.precipitation ?? 0),
        windKmh: Math.max(0, Number(cur.wind_speed_10m ?? 0)),
        windDirFromDeg: ((Number(cur.wind_direction_10m ?? 0) % 360) + 360) % 360,
      };
    },
    async () => {
      const r = await withTimeout(
        fetch(`https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=${lat}&lon=${lon}`, {
          cache: "no-store",
          headers: {
            "User-Agent": "EcoSpeed/1.0 (resume weather fallback)",
          },
        }),
        7000,
      );
      if (!r.ok) throw new Error("weather failed");
      const j = await r.json();
      const series = Array.isArray(j?.properties?.timeseries) ? j.properties.timeseries[0] : null;
      const instant = series?.data?.instant?.details ?? {};
      const nextHour = series?.data?.next_1_hours?.details ?? {};
      return {
        tempC: Number(instant.air_temperature ?? 20),
        rainMmH: Math.max(0, Number(nextHour.precipitation_amount ?? 0)),
        windKmh: Math.max(0, Number(instant.wind_speed ?? 0) * 3.6),
        windDirFromDeg: ((Number(instant.wind_from_direction ?? 0) % 360) + 360) % 360,
      };
    },
  ];

  let lastError: Error | null = null;
  for (const provider of providers) {
    try {
      return await provider();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error("weather failed");
    }
  }
  throw lastError ?? new Error("weather failed");
}

function bearingRadFromNorth(lon1: number, lat1: number, lon2: number, lat2: number) {
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const p1 = (lat1 * Math.PI) / 180;
  const p2 = (lat2 * Math.PI) / 180;
  const y = Math.sin(dLon) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dLon);
  return Math.atan2(y, x);
}

function smoothElevations(elevations: number[]) {
  if (elevations.length <= 2) return elevations;
  return elevations.map((value, index) => {
    const prev = elevations[index - 1] ?? value;
    const next = elevations[index + 1] ?? value;
    return (prev + value + next) / 3;
  });
}

async function fetchElevationChunk(coords: [number, number][]) {
  const latCsv = coords.map((c) => c[1].toFixed(6)).join(",");
  const lonCsv = coords.map((c) => c[0].toFixed(6)).join(",");
  try {
    const r = await withTimeout(
      fetch(`https://api.open-meteo.com/v1/elevation?latitude=${latCsv}&longitude=${lonCsv}`, {
        cache: "no-store",
      }),
      8000,
    );
    if (r.ok) {
      const j = await r.json();
      const elevations: number[] = Array.isArray(j?.elevation) ? j.elevation.map((v: unknown) => Number(v)) : [];
      if (elevations.length === coords.length && elevations.every((v) => Number.isFinite(v))) return elevations;
    }
  } catch {}

  const locations = coords.map((c) => `${c[1]},${c[0]}`).join("|");
  const r = await withTimeout(
    fetch(`https://api.open-elevation.com/api/v1/lookup?locations=${encodeURIComponent(locations)}`, {
      cache: "no-store",
    }),
    8000,
  );
  if (!r.ok) throw new Error("elevation failed");
  const j = await r.json();
  const elevations = (j?.results ?? []).map((v: { elevation?: number }) => Number(v.elevation ?? 0));
  if (elevations.length !== coords.length || elevations.some((v: number) => !Number.isFinite(v))) {
    throw new Error("elevation invalid");
  }
  return elevations;
}

async function fetchElevations(coords: [number, number][]) {
  if (coords.length === 0) return [];
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

async function fetchRouteWeather(coords: [number, number][]) {
  if (coords.length < 2) {
    return {
      samples: [] as Array<{
        index: number;
        lat: number;
        lon: number;
        tempC: number;
        rainMmH: number;
        windKmh: number;
        windDirFromDeg: number;
      }>,
      edgeTemp: [] as number[],
      edgeRain: [] as number[],
      edgeHeadwindMs: [] as number[],
    };
  }
  const idx = pickSampleIndices(coords.length, Math.min(12, coords.length));
  const settled = await Promise.allSettled(
    idx.map(async (index) => {
      const [lon, lat] = coords[index];
      const weather = await pointWeather(lat, lon);
      return { index, lat, lon, ...weather };
    }),
  );
  const samples = settled
    .filter(
      (
        res,
      ): res is PromiseFulfilledResult<{
        index: number;
        lat: number;
        lon: number;
        tempC: number;
        rainMmH: number;
        windKmh: number;
        windDirFromDeg: number;
      }> => res.status === "fulfilled",
    )
    .map((res) => res.value);
  if (samples.length === 0) {
    return {
      samples: [] as Array<{
        index: number;
        lat: number;
        lon: number;
        tempC: number;
        rainMmH: number;
        windKmh: number;
        windDirFromDeg: number;
      }>,
      edgeTemp: new Array(Math.max(0, coords.length - 1)).fill(20),
      edgeRain: new Array(Math.max(0, coords.length - 1)).fill(0),
      edgeHeadwindMs: new Array(Math.max(0, coords.length - 1)).fill(0),
    };
  }
  const tempMap = new Map<number, number>();
  const rainMap = new Map<number, number>();
  const windUxMap = new Map<number, number>();
  const windUyMap = new Map<number, number>();
  for (const sample of samples) {
    tempMap.set(sample.index, sample.tempC);
    rainMap.set(sample.index, Math.max(0, sample.rainMmH));
    const windToRad = (((sample.windDirFromDeg + 180) % 360) * Math.PI) / 180;
    const windMs = sample.windKmh / 3.6;
    windUxMap.set(sample.index, windMs * Math.sin(windToRad));
    windUyMap.set(sample.index, windMs * Math.cos(windToRad));
  }
  const pointTemp = interpolateByIndex(tempMap, coords.length);
  const pointRain = interpolateByIndex(rainMap, coords.length);
  const pointWindUx = interpolateByIndex(windUxMap, coords.length);
  const pointWindUy = interpolateByIndex(windUyMap, coords.length);
  return {
    samples,
    edgeTemp: pointTemp.slice(1).map((v, i) => (v + pointTemp[i]) / 2),
    edgeRain: pointRain.slice(1).map((v, i) => Math.max(0, (v + pointRain[i]) / 2)),
    edgeHeadwindMs: coords.slice(1).map((coord, index) => {
      const [lon1, lat1] = coords[index];
      const [lon2, lat2] = coord;
      const bearing = bearingRadFromNorth(lon1, lat1, lon2, lat2);
      const dirX = Math.sin(bearing);
      const dirY = Math.cos(bearing);
      const ux = (pointWindUx[index + 1] + pointWindUx[index]) / 2;
      const uy = (pointWindUy[index + 1] + pointWindUy[index]) / 2;
      const tailwindMs = ux * dirX + uy * dirY;
      return -tailwindMs;
    }),
  };
}

function profileToVehicleParams(profile: {
  empty_mass?: number;
  extra_load?: number;
  drag_coefficient?: number;
  frontal_area?: number;
  rolling_resistance?: number;
  motor_efficiency?: number;
  regen_efficiency?: number;
  aux_power_kw?: number;
  battery_kwh?: number;
}): VehicleParams {
  const rawDrag = Number(profile.drag_coefficient ?? 0.26);
  const frontalArea = Math.max(1, Number(profile.frontal_area ?? 2.2));
  const cda = rawDrag > 0.4 ? Math.max(0.2, rawDrag) : Math.max(0.2, rawDrag * frontalArea);
  return {
    massKg: Math.max(800, Number(profile.empty_mass ?? 1850)) + Math.max(0, Number(profile.extra_load ?? 0)),
    cda,
    crr: clamp(Number(profile.rolling_resistance ?? 0.01), 0.004, 0.02),
    rhoAir: 1.225,
    etaDrive: clamp(Number(profile.motor_efficiency ?? 0.9), 0.7, 0.99),
    regenEff: clamp(Number(profile.regen_efficiency ?? 0.7), 0.3, 0.95),
    auxPowerKw: Math.max(0.5, Number(profile.aux_power_kw ?? 2)),
    batteryKwh: Math.max(20, Number(profile.battery_kwh ?? 60)),
    regenMaxKw: 70,
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

  const existingSession = await getTripSession(body.tripId);
  const hydratedSession =
    existingSession ??
    (body.sessionSnapshot
      ? await saveTripSession({
          tripId: body.sessionSnapshot.tripId,
          status: body.sessionSnapshot.status ?? "paused",
          pausedAt: new Date().toISOString(),
          segmentIndex: body.sessionSnapshot.segmentIndex,
          batteryPctBefore: body.sessionSnapshot.batteryPctBefore,
          batteryPctAfter: body.sessionSnapshot.batteryPctAfter,
          didRecharge: body.sessionSnapshot.didRecharge,
          remainingCoords: body.sessionSnapshot.remainingCoords,
          remainingEcoSpeedsKmh: body.sessionSnapshot.remainingEcoSpeedsKmh,
          comfortTempC: body.sessionSnapshot.comfortTempC,
          hvacMode: normalizeHvacMode(body.sessionSnapshot.hvacMode, body.sessionSnapshot.climateIntensityPct),
          vehicleProfile: body.sessionSnapshot.vehicleProfile ?? {},
          distanceKm: Number(body.sessionSnapshot.route?.total_distance_km ?? 0),
        })
      : null);
  if (!hydratedSession) return NextResponse.json({ error: "Trip not found" }, { status: 404 });

  const updated = await markTripActive(body.tripId, body.batteryPctAfter);
  if (!updated) return NextResponse.json({ error: "Resume failed" }, { status: 500 });

  try {
    const coords = updated.remainingCoords ?? [];
    const history = await getTripHistory(body.tripId);
    if (coords.length < 2) return NextResponse.json({ ok: true, session: updated, weatherRefresh: null, history });
    const weather = await fetchRouteWeather(coords);
    const edgeCount = coords.length - 1;
    const elevations = smoothElevations(await fetchElevations(coords));
    const profile = updated.vehicleProfile ?? {};
    const comfortTempC = Number(updated.comfortTempC ?? 20);
    const legacyClimateIntensityPct = Number(body.sessionSnapshot?.climateIntensityPct ?? Number.NaN);
    const hvacMode = normalizeHvacMode(updated.hvacMode, legacyClimateIntensityPct);
    const climateEnabled =
      updated.hvacMode !== undefined || body.sessionSnapshot?.hvacMode !== undefined
        ? true
        : Number.isFinite(legacyClimateIntensityPct)
          ? legacyClimateIntensityPct > 0
          : true;
    const vehicle = profileToVehicleParams(profile);
    const remainingEcoSpeeds = Array.isArray(updated.remainingEcoSpeedsKmh)
      ? updated.remainingEcoSpeedsKmh.map((v) => Number(v))
      : [];
    const speedProfile: number[] = [];
    for (let i = 0; i < edgeCount; i += 1) {
      const speed = remainingEcoSpeeds[i];
      if (Number.isFinite(speed)) {
        speedProfile.push(Math.max(20, Number(speed)));
      } else {
        speedProfile.push(i > 0 ? speedProfile[i - 1] : 90);
      }
    }

    const recalculated = routeEnergyTimeSegmentWeather(
      coords,
      elevations,
      speedProfile,
      vehicle,
      weather.edgeTemp,
      weather.edgeRain,
      {
        comfortC: comfortTempC,
        climateEnabled,
        climateBoostKw: climateEnabled ? HVAC_PRESETS[hvacMode] : 0,
        segmentHeadwindMs: weather.edgeHeadwindMs,
        startBatteryPct: Number(updated.batteryPctAfter ?? updated.batteryPctBefore ?? body.batteryPctAfter ?? 50),
      },
    );
    const remainingEnergyKwh = recalculated.energyWh / 1000;
    const remainingTimeMin = recalculated.timeH * 60;
    const startPct = clamp(Number(updated.batteryPctAfter ?? updated.batteryPctBefore ?? body.batteryPctAfter ?? 50), 0, 100);
    const availableKwh = vehicle.batteryKwh * (startPct / 100);
    const projectedEndBatteryPct = clamp(((availableKwh - remainingEnergyKwh) / vehicle.batteryKwh) * 100, 0, 100);

    return NextResponse.json({
      ok: true,
      session: updated,
      weather_updated: true,
      weatherRefresh: { samples: weather.samples },
      recalculated_remaining_energy_kwh: remainingEnergyKwh,
      recalculated_remaining_time_min: remainingTimeMin,
      projected_end_battery_pct: projectedEndBatteryPct,
      history,
    });
  } catch {
    return NextResponse.json({ ok: true, session: updated, weatherRefresh: null, history: await getTripHistory(body.tripId) });
  }
}
