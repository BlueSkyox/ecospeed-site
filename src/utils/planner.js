import {
  calculateHvacPower,
  calculateOptimalEcoSpeed,
  calculateSegmentEnergy,
  getAirDensity,
  getRollingCoeff,
} from "./physics";
import { haversineDistanceM } from "./geo";

export const MODE_CONFIG = {
  rapide: {
    label: "Rapide",
    description: "Priorité au temps de trajet.",
    indicativeSpeed: "Limite",
  },
  equilibre: {
    label: "Équilibré",
    description: "Compromis autonomie / temps.",
    indicativeSpeed: "Mix route",
  },
  eco: {
    label: "Éco",
    description: "Rendement énergétique maximal.",
    indicativeSpeed: "Optimisée",
  },
};

const round = (value, d = 2) => {
  const m = 10 ** d;
  return Math.round((value + Number.EPSILON) * m) / m;
};

const PRICE_PER_KWH = 0.45;

const getEcoFloorByLimit = (speedLimit) => {
  const v = Number(speedLimit) || 0;
  if (v >= 120) return 100;
  if (v >= 100) return 80;
  if (v >= 80) return 65;
  if (v >= 50) return 40;
  return 30;
};

const buildSpeedCandidates = (speedLimit) => {
  const limit = Math.max(30, Number(speedLimit) || 50);
  const floor = Math.min(limit, getEcoFloorByLimit(limit));
  const start = Math.max(30, Math.floor(floor / 5) * 5);
  const out = [];
  for (let v = start; v <= limit; v += 5) out.push(v);
  return out.length ? out : [limit];
};

const sum = (arr) => arr.reduce((acc, v) => acc + v, 0);

export const summarizeSegments = (segments = [], fallbackSoc = 0) => {
  const totalDistanceM = sum(segments.map((s) => s.distanceM || 0));
  const totalEnergyWh = sum(segments.map((s) => s.energyWh || 0));
  const totalTimeH = sum(segments.map((s) => (s.distanceM || 0) / 1000 / Math.max(1, s.speedTrip || 1)));
  const avgSpeed = totalTimeH > 0 ? totalDistanceM / 1000 / totalTimeH : 0;
  const avgWhKm = totalDistanceM > 0 ? totalEnergyWh / (totalDistanceM / 1000) : 0;
  const avgHvac = segments.length ? sum(segments.map((s) => s.hvacW || 0)) / segments.length : 0;
  const arrivalSoc = segments.length ? segments.at(-1).socRemaining : fallbackSoc;

  return {
    totalDistanceM,
    durationSec: totalTimeH * 3600,
    totalEnergyWh,
    avgSpeed,
    avgWhKm,
    avgHvac,
    arrivalSoc,
    chargingStops: segments.filter((s) => (s.socRemaining ?? 100) < 20).length,
  };
};

const inferSpeedLimitFromStep = (step = {}) => {
  const avgSpeedKmh = step.durationSec > 0 ? (step.distanceM / step.durationSec) * 3.6 : 0;
  const name = (step.name || "").toLowerCase();

  if (/motorway|autoroute|freeway|autobahn|trunk|\ba\d+/.test(name) || avgSpeedKmh >= 105) {
    return 130;
  }

  if (/primary|secondary|national|departmental|route/.test(name) || avgSpeedKmh >= 65) {
    return 80;
  }

  return 50;
};

const deriveSegmentSpeedLimit = ({ segment, steps = [] }) => {
  if (!steps.length) {
    const avgSpeedKmh = Number(segment.avgSpeedKmh) || 0;
    if (avgSpeedKmh >= 105) return 130;
    if (avgSpeedKmh >= 65) return 80;
    return 50;
  }

  const weighted = steps.reduce(
    (acc, step) => {
      const limit = inferSpeedLimitFromStep(step);
      const weight = Math.max(1, Number(step.distanceM) || 0);
      acc.sum += limit * weight;
      acc.weight += weight;
      return acc;
    },
    { sum: 0, weight: 0 }
  );

  const result = weighted.weight > 0 ? weighted.sum / weighted.weight : 50;
  if (result >= 110) return 130;
  if (result >= 70) return 80;
  return 50;
};

/**
 * Segmente un tracé ORS en blocs homogènes ~10 km.
 */
export const segmentRouteGeometry = (coords, routeMeta = {}, chunkDistanceM = 10000) => {
  if (!Array.isArray(coords) || coords.length < 2) return [];

  const totalDistanceM = coords.reduce((acc, point, idx) => {
    if (idx === 0) return 0;
    return acc + haversineDistanceM(coords[idx - 1], point);
  }, 0);

  const stepMeta = Array.isArray(routeMeta?.steps) ? routeMeta.steps : [];

  const segments = [];
  let current = {
    points: [coords[0]],
    distanceM: 0,
    deltaH: 0,
    startDistM: 0,
    endDistM: 0,
    startCoordIdx: 0,
    endCoordIdx: 0,
    totalDurationSec: 0,
  };
  let cumulativeDist = 0;

  for (let i = 1; i < coords.length; i += 1) {
    const prev = coords[i - 1];
    const point = coords[i];

    const legDist = haversineDistanceM(prev, point);
    const prevEle = Number.isFinite(prev.ele) ? prev.ele : 0;
    const ele = Number.isFinite(point.ele) ? point.ele : prevEle;
    const legDeltaH = ele - prevEle;

    current.points.push(point);
    current.distanceM += legDist;
    current.deltaH += legDeltaH;
    cumulativeDist += legDist;
    current.endDistM = cumulativeDist;
    current.endCoordIdx = i;

    const stepMatch = stepMeta.find(
      (step) => Number.isFinite(step.fromIdx) && Number.isFinite(step.toIdx) && i >= step.fromIdx && i <= step.toIdx
    );
    if (stepMatch?.distanceM > 0 && stepMatch?.durationSec > 0) {
      const ratio = Math.min(1, legDist / stepMatch.distanceM);
      current.totalDurationSec += stepMatch.durationSec * ratio;
    }

    const isLast = i === coords.length - 1;
    const isUrbanEdge = cumulativeDist < 15000 || cumulativeDist > Math.max(0, totalDistanceM - 15000);
    const dynamicChunkDistanceM = isUrbanEdge ? 2500 : chunkDistanceM;

    if (current.distanceM >= dynamicChunkDistanceM || isLast) {
      const midIdx = Math.floor(current.points.length / 2);
      const ref = current.points[midIdx] || point;

      const overlappingSteps = stepMeta.filter(
        (step) =>
          Number.isFinite(step.fromIdx) &&
          Number.isFinite(step.toIdx) &&
          step.toIdx >= current.startCoordIdx &&
          step.fromIdx <= current.endCoordIdx
      );

      const avgSpeedKmh =
        current.totalDurationSec > 0 ? (current.distanceM / current.totalDurationSec) * 3.6 : 0;

      const baseSegment = {
        id: `seg-${segments.length + 1}`,
        index: segments.length + 1,
        distanceM: current.distanceM,
        deltaH: current.deltaH,
        refCoord: { lat: ref.lat, lng: ref.lng },
        startCoord: {
          lat: current.points[0].lat,
          lng: current.points[0].lng,
        },
        endCoord: { lat: point.lat, lng: point.lng },
        startDistM: current.startDistM,
        endDistM: current.endDistM,
        avgSpeedKmh,
      };

      segments.push({
        ...baseSegment,
        speedLimit: deriveSegmentSpeedLimit({ segment: baseSegment, steps: overlappingSteps }),
      });

      current = {
        points: [point],
        distanceM: 0,
        deltaH: 0,
        startDistM: cumulativeDist,
        endDistM: cumulativeDist,
        startCoordIdx: i,
        endCoordIdx: i,
        totalDurationSec: 0,
      };
    }
  }

  return segments.map((segment) => ({
    ...segment,
    speedLimit: Number(segment.speedLimit) || 50,
    tExt: 15,
    precip: 0,
    windKmh: 0,
    windDirDeg: 0,
  }));
};

const getModeSpeed = ({ mode, speedLimit, ecoSpeed }) => {
  if (mode === "rapide") return speedLimit;
  if (mode === "eco") return ecoSpeed;
  return Math.min(speedLimit, ecoSpeed + (speedLimit - ecoSpeed) * 0.4);
};

const chooseRealisticEcoSpeed = ({ segment, vehicle, hvacW }) => {
  const speedLimit = Number(segment.speedLimit) || 90;
  const candidates = buildSpeedCandidates(speedLimit);
  const floor = getEcoFloorByLimit(speedLimit);

  const absoluteEco = calculateOptimalEcoSpeed(
    vehicle.massKg,
    getRollingCoeff(segment.precip),
    getAirDensity(segment.tExt),
    vehicle.cx,
    vehicle.areaM2,
    speedLimit
  );

  const weighted = candidates.map((vKmh) => {
    const energyWh = calculateSegmentEnergy({
      distM: segment.distanceM,
      deltaH: segment.deltaH,
      vKmh,
      mass: vehicle.massKg,
      cx: vehicle.cx,
      area: vehicle.areaM2,
      tExt: segment.tExt,
      precip: segment.precip,
      hvacW,
    });

    const durationSec = (Math.max(1, Number(segment.distanceM) || 0) / 1000 / Math.max(1, vKmh)) * 3600;
    const fastRoadPenalty = speedLimit >= 110 ? 0.15 : speedLimit >= 90 ? 0.1 : 0.06;
    const score = energyWh + durationSec * fastRoadPenalty;
    return { vKmh, score, energyWh };
  });

  const best = weighted.reduce((acc, cur) => (cur.score < acc.score ? cur : acc), weighted[0]);
  const realisticEco = Math.max(floor, Math.min(speedLimit, best.vKmh));

  return {
    absoluteEco: round(absoluteEco, 1),
    realisticEco: round(realisticEco, 1),
  };
};

export const computeModeSegments = ({ segments, vehicle, cabinTemp, mode, initialSocPct }) => {
  const batteryWh = Math.max(1, (vehicle.batteryKwh || 0) * 1000);
  let soc = Number(initialSocPct);

  const rows = segments.map((segment) => {
    const cr = getRollingCoeff(segment.precip);
    const hvacW = calculateHvacPower(cabinTemp, segment.tExt);
    const ecoSpeeds = chooseRealisticEcoSpeed({ segment, vehicle, hvacW });
    const speedKmh = getModeSpeed({ mode, speedLimit: segment.speedLimit, ecoSpeed: ecoSpeeds.realisticEco });

    const modelWh = calculateSegmentEnergy({
      distM: segment.distanceM,
      deltaH: segment.deltaH,
      vKmh: speedKmh,
      mass: vehicle.massKg,
      cx: vehicle.cx,
      area: vehicle.areaM2,
      tExt: segment.tExt,
      precip: segment.precip,
      hvacW,
    });

    const baseWh = (vehicle.baseWhKm || 0) * (segment.distanceM / 1000);
    const energyWh = Math.max(0, modelWh * 0.7 + baseWh * 0.3);

    soc = Math.max(0, soc - (energyWh / batteryWh) * 100);

    return {
      ...segment,
      crModified: round(cr, 4),
      speedEco: ecoSpeeds.realisticEco,
      speedEcoAbsolute: ecoSpeeds.absoluteEco,
      speedTrip: round(speedKmh, 1),
      hvacW: round(hvacW, 0),
      energyWh: round(energyWh, 1),
      socRemaining: round(soc, 1),
    };
  });

  return {
    mode,
    segments: rows,
    summary: summarizeSegments(rows, initialSocPct),
  };
};

export const computeAllModes = ({ segments, vehicle, cabinTemp, initialSocPct }) => {
  const rapide = computeModeSegments({ segments, vehicle, cabinTemp, mode: "rapide", initialSocPct });
  const equilibre = computeModeSegments({ segments, vehicle, cabinTemp, mode: "equilibre", initialSocPct });
  const eco = computeModeSegments({ segments, vehicle, cabinTemp, mode: "eco", initialSocPct });

  return { rapide, equilibre, eco };
};

export const buildCompareRows = (modeResults, pricePerKwh = PRICE_PER_KWH) => {
  const co2AvoidedKg = 0.12 * (Object.values(modeResults)[0]?.summary?.totalDistanceM || 0) / 1000;

  return Object.values(modeResults).map((result) => ({
    mode: MODE_CONFIG[result.mode].label,
    key: result.mode,
    durationMin: round(result.summary.durationSec / 60, 0),
    avgSpeed: round(result.summary.avgSpeed, 1),
    energyKwh: round(result.summary.totalEnergyWh / 1000, 2),
    costEur: round((result.summary.totalEnergyWh / 1000) * pricePerKwh, 2),
    avgWhKm: round(result.summary.avgWhKm, 1),
    hvacW: round(result.summary.avgHvac, 0),
    socArrival: round(result.summary.arrivalSoc, 1),
    stops: result.summary.chargingStops,
    chargeTimeMin: round(result.summary.chargeTimeMin || 0, 0),
    co2AvoidedKg: round(co2AvoidedKg, 2),
  }));
};

export const findCriticalSocPoint = (modeSegments, threshold = 20) => {
  return modeSegments.find((s) => s.socRemaining < threshold) || null;
};
