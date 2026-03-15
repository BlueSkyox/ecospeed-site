export type Coord = [number, number, number?];

export type RouteStep = {
  distance: number;
  duration: number;
  instruction?: string;
  type?: number;
  way_points?: [number, number];
};

export type WayTypeRange = {
  from: number;
  to: number;
  wayType: number;
};

export type HvacMode = "eco" | "comfort" | "intensive" | "max";

export type VehicleParams = {
  massKg: number;
  cda: number;
  crr: number;
  rhoAir: number;
  etaDrive: number;
  regenEff: number;
  auxPowerKw: number;
  batteryKwh: number;
  windHeadMs?: number;
  regenMaxKw?: number;
  currentSocPct?: number;
};

export type TripResult = {
  speed: number;
  avgSpeed: number;
  energyWh: number;
  energyKwh: number;
  timeH: number;
  distKm: number;
  chargingStops: number;
  chargingTimeMin: number;
  totalTimeMin: number;
};

export const CHARGING_STOP_DURATION_MIN = 20;
export const HVAC_PRESETS: Record<HvacMode, number> = {
  eco: 0,
  comfort: 1.1,
  intensive: 2.5,
  max: 4.5,
};
const G = 9.81;

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

export function normalizeHvacMode(hvacMode?: string | null, legacyClimateIntensityPct?: number | null): HvacMode {
  if (hvacMode === "eco" || hvacMode === "comfort" || hvacMode === "intensive" || hvacMode === "max") {
    return hvacMode;
  }

  if (!Number.isFinite(legacyClimateIntensityPct)) return "comfort";

  const legacyBoostKw = (clamp(Number(legacyClimateIntensityPct), 0, 100) / 100) * 2;
  let bestMode: HvacMode = "comfort";
  let bestDiff = Number.POSITIVE_INFINITY;
  for (const [mode, boostKw] of Object.entries(HVAC_PRESETS) as Array<[HvacMode, number]>) {
    const diff = Math.abs(boostKw - legacyBoostKw);
    if (diff < bestDiff) {
      bestMode = mode;
      bestDiff = diff;
    }
  }
  return bestMode;
}

export function haversineM(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const R = 6371000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function rainDensityToCrrMultiplier(rainMmH: number): number {
  const r = Math.max(rainMmH, 0);
  if (r <= 0.05) return 1;
  if (r <= 1) return 1 + 0.08 * r;
  if (r <= 10) return 1.08 + 0.07 * ((r - 1) / 9);
  return 1.2;
}

export function rollingResistanceTempMultiplier(tempC: number): number {
  if (tempC >= 20) return 1;
  if (tempC <= -15) return 1.22;
  return 1 + (20 - tempC) * 0.0063;
}

export function calculateChargingStops(
  batteryKwh: number,
  energyNeededKwh: number,
  startPct: number,
  endPct: number,
): { numStops: number } {
  const usableStart = batteryKwh * (startPct / 100);
  const targetEnd = batteryKwh * (endPct / 100);
  const safety = batteryKwh * 0.1;
  const usableLeg = batteryKwh - safety;
  if (usableLeg <= 0) return { numStops: 999 };
  const available = usableStart - Math.max(safety, targetEnd);
  if (energyNeededKwh <= available) return { numStops: 0 };
  return { numStops: Math.max(0, Math.ceil((energyNeededKwh - available) / usableLeg)) };
}

export function estimateChargingMinutesFromEnergy(
  currentEnergyKwh: number,
  targetEnergyKwh: number,
  batteryKwh: number,
  vehicleMaxChargeKw: number,
  stationPowerKw: number,
): number {
  const usablePowerKw = Math.max(20, Math.min(vehicleMaxChargeKw, stationPowerKw || 50));
  const current = Math.max(0, currentEnergyKwh);
  const target = Math.max(current, targetEnergyKwh);
  const soc80 = batteryKwh * 0.8;
  const soc95 = batteryKwh * 0.95;

  let minutes = 0;
  const fastEnd = Math.min(target, soc80);
  if (fastEnd > current) {
    minutes += ((fastEnd - current) / usablePowerKw) * 60;
  }

  const taperStart = Math.max(current, soc80);
  const taperEnd = Math.min(target, soc95);
  if (taperEnd > taperStart) {
    minutes += ((taperEnd - taperStart) / Math.max(15, usablePowerKw * 0.55)) * 60;
  }

  if (target > soc95) {
    minutes += ((target - soc95) / Math.max(8, usablePowerKw * 0.25)) * 60;
  }

  return minutes;
}

export function estimateChargingMinutesFromSoc(
  currentPct: number,
  targetPct: number,
  batteryKwh: number,
  vehicleMaxChargeKw: number,
  stationPowerKw: number,
): number {
  const currentEnergyKwh = batteryKwh * (Math.max(0, Math.min(currentPct, 100)) / 100);
  const targetEnergyKwh = batteryKwh * (Math.max(0, Math.min(targetPct, 95)) / 100);
  return estimateChargingMinutesFromEnergy(
    currentEnergyKwh,
    targetEnergyKwh,
    batteryKwh,
    vehicleMaxChargeKw,
    stationPowerKw,
  );
}

export function segEnergyAndTime(
  distanceM: number,
  slope: number,
  speedKmh: number,
  v: VehicleParams,
): { energyWh: number; timeH: number } {
  if (distanceM <= 0 || speedKmh <= 0) return { energyWh: 0, timeH: 0 };
  const safeSlope = Math.max(-0.2, Math.min(0.2, slope));
  const speedMs = Math.max(speedKmh, 1e-3) * (1000 / 3600);
  const windHeadMs = Number.isFinite(v.windHeadMs) ? Number(v.windHeadMs) : 0;
  const airSpeedMs = Math.max(0.1, speedMs + windHeadMs);
  const fAero = 0.5 * v.rhoAir * v.cda * airSpeedMs * airSpeedMs;
  const fRoll = v.crr * v.massKg * G * Math.cos(Math.atan(safeSlope));
  const fGrade = v.massKg * G * safeSlope;
  const fTot = fAero + fRoll + fGrade;
  const timeH = distanceM / speedMs / 3600;
  const mechWh = (fTot * distanceM) / 3600;
  const auxWh = v.auxPowerKw * 1000 * timeH;
  const regenMaxKw = Math.max(20, Number(v.regenMaxKw ?? 70));
  const regenCapWh = regenMaxKw * 1000 * timeH;
  const regenSpeedFactor = Math.max(0, Math.min(1, (speedKmh - 10) / 25));
  const regenSocFactor = Number.isFinite(v.currentSocPct)
    ? clamp((95 - Number(v.currentSocPct)) / 15, 0, 1)
    : 1;

  let elecWh = 0;
  if (mechWh >= 0) {
    elecWh = mechWh / Math.max(v.etaDrive, 1e-3) + auxWh;
  } else {
    const recoveredWh = Math.min(
      Math.abs(mechWh) * Math.max(v.regenEff, 0),
      regenCapWh * regenSpeedFactor * regenSocFactor,
    );
    elecWh = auxWh - recoveredWh;
  }
  return { energyWh: elecWh, timeH };
}

export function routeEnergyTime(
  coords: Coord[],
  elevations: number[],
  speedKmhOrPerSeg: number | number[],
  vehicle: VehicleParams,
): { energyWh: number; timeH: number; distKm: number; avgSpeed: number } {
  let totalWh = 0;
  let totalH = 0;
  let totalM = 0;
  let speedWeighted = 0;
  let rollingSocPct = Number.isFinite(vehicle.currentSocPct) ? clamp(Number(vehicle.currentSocPct), 0, 100) : Number.NaN;
  for (let i = 1; i < coords.length; i += 1) {
    const [lon1, lat1] = coords[i - 1];
    const [lon2, lat2] = coords[i];
    const d = haversineM(lon1, lat1, lon2, lat2);
    if (d <= 0) continue;
    const e1 = elevations[i - 1] ?? 0;
    const e2 = elevations[i] ?? e1;
    const slope = (e2 - e1) / d;
    const s = Array.isArray(speedKmhOrPerSeg)
      ? Math.max(speedKmhOrPerSeg[Math.min(i - 1, speedKmhOrPerSeg.length - 1)] ?? 30, 1)
      : speedKmhOrPerSeg;
    const seg = segEnergyAndTime(d, slope, s, {
      ...vehicle,
      currentSocPct: Number.isFinite(rollingSocPct) ? rollingSocPct : vehicle.currentSocPct,
    });
    totalWh += seg.energyWh;
    totalH += seg.timeH;
    totalM += d;
    speedWeighted += s * d;
    if (Number.isFinite(rollingSocPct) && vehicle.batteryKwh > 0) {
      rollingSocPct = clamp(rollingSocPct - (seg.energyWh / 1000 / vehicle.batteryKwh) * 100, 0, 100);
    }
  }
  return {
    energyWh: totalWh,
    timeH: totalH,
    distKm: totalM / 1000,
    avgSpeed: totalM > 0 ? speedWeighted / totalM : 0,
  };
}

export function hvacPowerFromTemp(tempC: number, comfortC = 20): number {
  const delta = Math.abs(tempC - comfortC);
  const baseVentilationKw = 0.3;
  if (delta < 2) return baseVentilationKw;
  if (tempC < comfortC) {
    return baseVentilationKw + Math.min(7, 0.12 * delta + 0.004 * delta * delta);
  }
  return baseVentilationKw + Math.min(3, 0.1 * delta);
}

export function airDensityFromTempC(tempC: number, baseRho = 1.225, baseTempC = 15, altitudeM = 0): number {
  const tBase = Math.max(180, baseTempC + 273.15);
  const tNow = Math.max(180, tempC + 273.15);
  const altitudeFactor = Math.exp(-Math.max(0, altitudeM) / 8500);
  return Math.max(0.75, Math.min(1.4, baseRho * (tBase / tNow) * altitudeFactor));
}

export function batteryPreconditioningKw(tempC: number): number {
  if (tempC >= 10) return 0;
  const delta = 10 - tempC;
  return Math.max(0, Math.min(6, 1.5 + delta * 0.2));
}

export function routeEnergyTimeSegmentWeather(
  coords: Coord[],
  elevations: number[],
  speedKmhOrPerSeg: number | number[],
  vehicleBase: VehicleParams,
  segmentTempsC: number[],
  segmentRainMmH: number[],
  comfortOrOptions:
    | number
    | {
        comfortC?: number;
        climateEnabled?: boolean;
        climateBoostKw?: number;
        segmentHeadwindMs?: number[];
        startBatteryPct?: number;
      } = 20,
): { energyWh: number; timeH: number; distKm: number; avgSpeed: number } {
  const options = typeof comfortOrOptions === "number" ? { comfortC: comfortOrOptions } : comfortOrOptions;
  const comfortC = Number(options.comfortC ?? 20);
  const climateEnabled = options.climateEnabled ?? true;
  const climateBoostKw = Math.max(0, Number(options.climateBoostKw ?? 0));
  const segmentHeadwindMs = options.segmentHeadwindMs ?? [];
  let rollingSocPct = Number.isFinite(options.startBatteryPct)
    ? clamp(Number(options.startBatteryPct), 0, 100)
    : Number.isFinite(vehicleBase.currentSocPct)
      ? clamp(Number(vehicleBase.currentSocPct), 0, 100)
      : Number.NaN;
  let totalWh = 0;
  let totalH = 0;
  let totalM = 0;
  let speedWeighted = 0;
  const nSeg = Math.max(0, coords.length - 1);
  for (let i = 1; i < coords.length; i += 1) {
    const [lon1, lat1] = coords[i - 1];
    const [lon2, lat2] = coords[i];
    const d = haversineM(lon1, lat1, lon2, lat2);
    if (d <= 0) continue;
    const e1 = elevations[i - 1] ?? 0;
    const e2 = elevations[i] ?? e1;
    const slope = (e2 - e1) / d;
    const segIdx = Math.min(i - 1, nSeg - 1);
    const speed = Array.isArray(speedKmhOrPerSeg)
      ? Math.max(speedKmhOrPerSeg[Math.min(segIdx, speedKmhOrPerSeg.length - 1)] ?? 30, 1)
      : speedKmhOrPerSeg;

    const temp = segmentTempsC[Math.min(segIdx, segmentTempsC.length - 1)] ?? comfortC;
    const rain = segmentRainMmH[Math.min(segIdx, segmentRainMmH.length - 1)] ?? 0;
    const headwindMs = segmentHeadwindMs[Math.min(segIdx, segmentHeadwindMs.length - 1)] ?? 0;
    const avgAltitudeM = (e1 + e2) / 2;
    const segVehicle: VehicleParams = {
      ...vehicleBase,
      crr: vehicleBase.crr * rainDensityToCrrMultiplier(rain) * rollingResistanceTempMultiplier(temp),
      rhoAir: airDensityFromTempC(temp, vehicleBase.rhoAir, 15, avgAltitudeM),
      auxPowerKw:
        vehicleBase.auxPowerKw +
        climateBoostKw +
        (climateEnabled ? hvacPowerFromTemp(temp, comfortC) : hvacPowerFromTemp(comfortC, comfortC)) +
        batteryPreconditioningKw(temp),
      windHeadMs: headwindMs,
      currentSocPct: Number.isFinite(rollingSocPct) ? rollingSocPct : vehicleBase.currentSocPct,
    };

    const seg = segEnergyAndTime(d, slope, speed, segVehicle);
    totalWh += seg.energyWh;
    totalH += seg.timeH;
    totalM += d;
    speedWeighted += speed * d;
    if (Number.isFinite(rollingSocPct) && vehicleBase.batteryKwh > 0) {
      rollingSocPct = clamp(rollingSocPct - (seg.energyWh / 1000 / vehicleBase.batteryKwh) * 100, 0, 100);
    }
  }
  return {
    energyWh: totalWh,
    timeH: totalH,
    distKm: totalM / 1000,
    avgSpeed: totalM > 0 ? speedWeighted / totalM : 0,
  };
}

export function wayTypeToSpeedLimit(wayType: number): number {
  const map: Record<number, number> = {
    0: 50,
    1: 130,
    2: 110,
    3: 90,
    4: 50,
    5: 30,
    6: 30,
    7: 20,
    8: 10,
    9: 40,
    10: 30,
  };
  return map[wayType] ?? 50;
}

export function wayTypeToMinSpeed(wayType: number): number {
  const map: Record<number, number> = {
    1: 80,
    2: 80,
    3: 60,
  };
  return map[wayType] ?? 0;
}

function buildSegmentSpeedBounds(
  coordsLen: number,
  waytypes: WayTypeRange[],
  userSpeedLimit: number,
): { limitSpeedPerSeg: number[]; minSpeedPerSeg: number[] } {
  const segCount = Math.max(coordsLen - 1, 0);
  const boundedUserLimit = Math.max(1, userSpeedLimit);
  const limitSpeedPerSeg = new Array(segCount).fill(boundedUserLimit);
  const minSpeedPerSeg = new Array(segCount).fill(0);
  for (const w of waytypes) {
    const lim = Math.min(wayTypeToSpeedLimit(w.wayType), boundedUserLimit);
    const minSpeed = Math.min(lim, wayTypeToMinSpeed(w.wayType));
    for (let i = Math.max(0, w.from); i <= Math.min(segCount - 1, w.to); i += 1) {
      limitSpeedPerSeg[i] = lim;
      minSpeedPerSeg[i] = Math.max(minSpeedPerSeg[i], minSpeed);
    }
  }
  return { limitSpeedPerSeg, minSpeedPerSeg };
}

function applyIntersectionSpeedReduction(
  speeds: number[],
  minSpeedPerSeg: number[],
  steps: RouteStep[],
): number[] {
  const adjusted = [...speeds];
  for (const step of steps) {
    const txt = (step.instruction ?? "").toLowerCase();
    if (!(txt.includes("turn") || txt.includes("roundabout") || txt.includes("left") || txt.includes("right"))) continue;
    if (!step.way_points) continue;
    const idx = Math.max(0, Math.min(adjusted.length - 1, step.way_points[0]));
    adjusted[idx] = Math.max(minSpeedPerSeg[idx] ?? 0, adjusted[idx] * 0.7);
  }
  return adjusted;
}

function projectArrivalSocPct(vehicle: VehicleParams, startSocPct: number, energyWh: number) {
  if (vehicle.batteryKwh <= 0 || !Number.isFinite(startSocPct)) return Number.NaN;
  return clamp(startSocPct - (energyWh / 1000 / vehicle.batteryKwh) * 100, 0, 100);
}

export function optimalSpeedForSegment(
  distanceM: number,
  slope: number,
  limitKmh: number,
  minSpeedKmh: number,
  energyBudgetWh: number,
  vehicle: VehicleParams,
): number {
  const upper = Math.max(1, limitKmh);
  const lower = clamp(Math.max(minSpeedKmh, 1), 1, upper);
  if (distanceM <= 0) return upper;

  const toleranceWh = 0.5;
  const minEnergyWh = segEnergyAndTime(distanceM, slope, lower, vehicle).energyWh;
  if (minEnergyWh > energyBudgetWh + toleranceWh) return lower;

  const limitEnergyWh = segEnergyAndTime(distanceM, slope, upper, vehicle).energyWh;
  if (limitEnergyWh <= energyBudgetWh + toleranceWh) return upper;
  if (limitEnergyWh < minEnergyWh) {
    return limitEnergyWh <= energyBudgetWh + toleranceWh ? upper : lower;
  }

  let low = lower;
  let high = upper;
  let best = lower;
  for (let iter = 0; iter < 20; iter += 1) {
    const mid = (low + high) / 2;
    const energyWh = segEnergyAndTime(distanceM, slope, mid, vehicle).energyWh;
    if (Math.abs(energyWh - energyBudgetWh) <= toleranceWh) return mid;
    if (energyWh <= energyBudgetWh) {
      best = mid;
      low = mid;
    } else {
      high = mid;
    }
  }
  return clamp(best, lower, upper);
}

export function buildSegmentSpeedsOptimal(
  coords: Coord[],
  elevations: number[],
  waytypes: WayTypeRange[],
  vehicle: VehicleParams,
  availableEnergyWh: number,
  userSpeedLimitKmh: number,
  steps: RouteStep[],
): { speeds: number[]; projectedSocPct: number; feasible: boolean } {
  const segCount = Math.max(coords.length - 1, 0);
  const startSocPct = Number.isFinite(vehicle.currentSocPct) ? clamp(Number(vehicle.currentSocPct), 0, 100) : Number.NaN;
  if (segCount === 0) {
    return { speeds: [], projectedSocPct: startSocPct, feasible: true };
  }

  const { limitSpeedPerSeg, minSpeedPerSeg } = buildSegmentSpeedBounds(coords.length, waytypes, userSpeedLimitKmh);
  const energyAtLimit = routeEnergyTime(coords, elevations, limitSpeedPerSeg, vehicle).energyWh;
  const usableEnergyWh = Math.max(0, availableEnergyWh);

  if (energyAtLimit <= usableEnergyWh + 0.5) {
    const directSpeeds = applyIntersectionSpeedReduction(limitSpeedPerSeg, minSpeedPerSeg, steps);
    const directProjection = routeEnergyTime(coords, elevations, directSpeeds, vehicle);
    return {
      speeds: directSpeeds,
      projectedSocPct: projectArrivalSocPct(vehicle, startSocPct, directProjection.energyWh),
      feasible: true,
    };
  }

  const distancesM = new Array(segCount).fill(0);
  const slopes = new Array(segCount).fill(0);
  const limitEnergyPerSegWh = new Array(segCount).fill(0);
  const minLegalEnergyPerSegWh = new Array(segCount).fill(0);
  for (let i = 1; i < coords.length; i += 1) {
    const [lon1, lat1] = coords[i - 1];
    const [lon2, lat2] = coords[i];
    const d = haversineM(lon1, lat1, lon2, lat2);
    const e1 = elevations[i - 1] ?? 0;
    const e2 = elevations[i] ?? e1;
    const edgeIdx = i - 1;
    const limit = limitSpeedPerSeg[edgeIdx] ?? Math.max(1, userSpeedLimitKmh);
    const minSpeed = minSpeedPerSeg[edgeIdx] ?? 0;
    distancesM[i - 1] = d;
    slopes[i - 1] = d > 0 ? (e2 - e1) / d : 0;
    limitEnergyPerSegWh[edgeIdx] = Math.max(0, segEnergyAndTime(d, slopes[i - 1], limit, vehicle).energyWh);
    minLegalEnergyPerSegWh[edgeIdx] = segEnergyAndTime(d, slopes[i - 1], minSpeed, vehicle).energyWh;
  }

  const baseSpeeds = new Array(segCount).fill(0);
  let rollingSocPct = startSocPct;
  for (let edgeIdx = 0; edgeIdx < segCount; edgeIdx += 1) {
    const distM = distancesM[edgeIdx] ?? 0;
    const slope = slopes[edgeIdx] ?? 0;
    const limit = limitSpeedPerSeg[edgeIdx] ?? Math.max(1, userSpeedLimitKmh);
    const minSpeed = minSpeedPerSeg[edgeIdx] ?? 0;
    const energyAtLimitSegWh = limitEnergyPerSegWh[edgeIdx] ?? 0;
    const proportionalBudgetWh = energyAtLimit > 0 ? usableEnergyWh * (energyAtLimitSegWh / energyAtLimit) : usableEnergyWh / segCount;
    const energyBudgetSegWh = Math.max(minLegalEnergyPerSegWh[edgeIdx] ?? 0, proportionalBudgetWh);
    const speed = optimalSpeedForSegment(distM, slope, limit, 1, energyBudgetSegWh, {
      ...vehicle,
      currentSocPct: Number.isFinite(rollingSocPct) ? rollingSocPct : vehicle.currentSocPct,
    });
    const displayedSpeed = Math.max(minSpeed, speed);
    baseSpeeds[edgeIdx] = displayedSpeed;

    if (Number.isFinite(rollingSocPct) && vehicle.batteryKwh > 0 && distM > 0) {
      const seg = segEnergyAndTime(distM, slope, displayedSpeed, {
        ...vehicle,
        currentSocPct: rollingSocPct,
      });
      rollingSocPct = clamp(rollingSocPct - (seg.energyWh / 1000 / vehicle.batteryKwh) * 100, 0, 100);
    }
  }

  const speeds = applyIntersectionSpeedReduction(baseSpeeds, minSpeedPerSeg, steps);
  const projected = routeEnergyTime(coords, elevations, speeds, vehicle);
  const minLegalSpeeds = limitSpeedPerSeg.map((limit, index) => clamp(Math.max(minSpeedPerSeg[index] ?? 0, 1), 1, limit));
  const minimumProjection = routeEnergyTime(coords, elevations, minLegalSpeeds, vehicle);
  return {
    speeds,
    projectedSocPct: projectArrivalSocPct(vehicle, startSocPct, projected.energyWh),
    feasible: minimumProjection.energyWh <= usableEnergyWh + 0.5,
  };
}

export function buildSegmentSpeeds(
  coordsLen: number,
  waytypes: WayTypeRange[],
  candidateSpeed: number,
  userSpeedLimit: number,
  minDelta: number,
  steps: RouteStep[],
): number[] {
  const perSeg = new Array(Math.max(coordsLen - 1, 0)).fill(candidateSpeed);
  const minSpeedPerSeg = new Array(Math.max(coordsLen - 1, 0)).fill(0);
  for (const w of waytypes) {
    const lim = Math.min(wayTypeToSpeedLimit(w.wayType), userSpeedLimit);
    const minSpeed = Math.min(lim, wayTypeToMinSpeed(w.wayType));
    const low = Math.max(minSpeed, lim - minDelta);
    const v = Math.max(low, Math.min(candidateSpeed, lim));
    for (let i = Math.max(0, w.from); i <= Math.min(perSeg.length - 1, w.to); i += 1) {
      perSeg[i] = v;
      minSpeedPerSeg[i] = Math.max(minSpeedPerSeg[i], minSpeed);
    }
  }
  for (const step of steps) {
    const txt = (step.instruction ?? "").toLowerCase();
    if (!(txt.includes("turn") || txt.includes("roundabout") || txt.includes("left") || txt.includes("right"))) continue;
    if (!step.way_points) continue;
    const idx = Math.max(0, Math.min(perSeg.length - 1, step.way_points[0]));
    perSeg[idx] = Math.max(minSpeedPerSeg[idx], Math.max(25, perSeg[idx] * 0.7));
  }
  return perSeg;
}
