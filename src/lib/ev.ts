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

export type VehicleParams = {
  massKg: number;
  cda: number;
  crr: number;
  rhoAir: number;
  etaDrive: number;
  regenEff: number;
  auxPowerKw: number;
  batteryKwh: number;
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
const G = 9.81;

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
  if (r <= 10) return 1.15;
  return 1.2;
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

export function segEnergyAndTime(
  distanceM: number,
  slope: number,
  speedKmh: number,
  v: VehicleParams,
): { energyWh: number; timeH: number } {
  if (distanceM <= 0 || speedKmh <= 0) return { energyWh: 0, timeH: 0 };
  const safeSlope = Math.max(-0.5, Math.min(0.5, slope));
  const speedMs = Math.max(speedKmh, 1e-3) * (1000 / 3600);
  const fAero = 0.5 * v.rhoAir * v.cda * speedMs * speedMs;
  const fRoll = v.crr * v.massKg * G * Math.cos(Math.atan(safeSlope));
  const fGrade = v.massKg * G * safeSlope;
  const fTot = fAero + fRoll + fGrade;
  const timeH = distanceM / speedMs / 3600;
  const mechWh = (fTot * distanceM) / 3600;
  const auxWh = v.auxPowerKw * 1000 * timeH;

  let elecWh = 0;
  if (mechWh >= 0) {
    elecWh = mechWh / Math.max(v.etaDrive, 1e-3) + auxWh;
  } else {
    elecWh = mechWh * Math.max(v.regenEff, 0) + auxWh;
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
    const seg = segEnergyAndTime(d, slope, s, vehicle);
    totalWh += seg.energyWh;
    totalH += seg.timeH;
    totalM += d;
    speedWeighted += s * d;
  }
  return {
    energyWh: totalWh,
    timeH: totalH,
    distKm: totalM / 1000,
    avgSpeed: totalM > 0 ? speedWeighted / totalM : 0,
  };
}

export function hvacPowerFromTemp(tempC: number, comfortC = 20): number {
  const k = 0.18;
  const delta = Math.abs(tempC - comfortC);
  return k * delta;
}

export function airDensityFromTempC(tempC: number, baseRho = 1.225, baseTempC = 15): number {
  const tBase = Math.max(180, baseTempC + 273.15);
  const tNow = Math.max(180, tempC + 273.15);
  return Math.max(0.9, Math.min(1.4, baseRho * (tBase / tNow)));
}

export function batteryPreconditioningKw(tempC: number): number {
  const delta = Math.abs(tempC - 21);
  return Math.max(3, Math.min(7, 3 + delta * 0.12));
}

export function routeEnergyTimeSegmentWeather(
  coords: Coord[],
  elevations: number[],
  speedKmhOrPerSeg: number | number[],
  vehicleBase: VehicleParams,
  segmentTempsC: number[],
  segmentRainMmH: number[],
  comfortC = 20,
): { energyWh: number; timeH: number; distKm: number; avgSpeed: number } {
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
    const segVehicle: VehicleParams = {
      ...vehicleBase,
      crr: vehicleBase.crr * rainDensityToCrrMultiplier(rain),
      auxPowerKw: vehicleBase.auxPowerKw + hvacPowerFromTemp(temp, comfortC),
    };

    const seg = segEnergyAndTime(d, slope, speed, segVehicle);
    totalWh += seg.energyWh;
    totalH += seg.timeH;
    totalM += d;
    speedWeighted += speed * d;
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

export function buildSegmentSpeeds(
  coordsLen: number,
  waytypes: WayTypeRange[],
  candidateSpeed: number,
  userSpeedLimit: number,
  minDelta: number,
  steps: RouteStep[],
): number[] {
  const perSeg = new Array(Math.max(coordsLen - 1, 0)).fill(candidateSpeed);
  for (const w of waytypes) {
    const lim = Math.min(wayTypeToSpeedLimit(w.wayType), userSpeedLimit);
    const low = Math.max(20, lim - minDelta);
    const v = Math.max(low, Math.min(candidateSpeed, lim));
    for (let i = Math.max(0, w.from); i <= Math.min(perSeg.length - 1, w.to); i += 1) perSeg[i] = v;
  }
  for (const step of steps) {
    const txt = (step.instruction ?? "").toLowerCase();
    if (!(txt.includes("turn") || txt.includes("roundabout") || txt.includes("left") || txt.includes("right"))) continue;
    if (!step.way_points) continue;
    const idx = Math.max(0, Math.min(perSeg.length - 1, step.way_points[0]));
    perSeg[idx] = Math.max(25, perSeg[idx] * 0.7);
  }
  return perSeg;
}
