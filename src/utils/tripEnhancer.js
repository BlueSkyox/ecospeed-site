import { findChargingStations, findChargingStationsAlongRoute } from "../services/chargemap";
import { calculateHvacPower, calculateSegmentEnergy } from "./physics";
import { getBearingDeg } from "./geo";
import { applyChargePlan, buildSuggestedStopConfigs } from "./chargingPlan";

export const PRICE_PER_KWH_ESTIMATE = 0.45;

const round = (value, digits = 2) => {
  const m = 10 ** digits;
  return Math.round((Number(value) + Number.EPSILON) * m) / m;
};

const rankStationCandidates = (candidates = []) => {
  return [...candidates].sort((a, b) => {
    const aFast = (Number(a?.powerKw) || 0) >= 50 ? 0 : 1;
    const bFast = (Number(b?.powerKw) || 0) >= 50 ? 0 : 1;
    if (aFast !== bFast) return aFast - bFast;

    const powerDiff = (Number(b?.powerKw) || 0) - (Number(a?.powerKw) || 0);
    if (powerDiff !== 0) return powerDiff;

    return (Number(a?.distanceKm) || 999) - (Number(b?.distanceKm) || 999);
  });
};

const hydrateStopStations = async (stopConfigs = [], apiKey) => {
  const hydrated = await Promise.all(
    stopConfigs.map(async (stop) => {
      if (!stop?.refCoord) {
        return { ...stop, station: null, stationCandidates: [], detourKm: null };
      }

      try {
        const candidates = await findChargingStations({
          lat: stop.refCoord.lat,
          lng: stop.refCoord.lng,
          distanceKm: 5,
          max: 12,
          apiKey,
        });
        const ranked = rankStationCandidates(candidates);
        const selected = stop.station
          ? ranked.find((c) => c.id === stop.station.id) || ranked[0] || stop.station
          : ranked[0] || null;

        return {
          ...stop,
          station: selected,
          stationCandidates: ranked,
          detourKm: selected?.distanceKm ?? stop.detourKm ?? null,
        };
      } catch {
        return {
          ...stop,
          station: null,
          stationCandidates: [],
          detourKm: null,
        };
      }
    })
  );

  return hydrated;
};

export const mergeSummaryWithChargePlan = (baseSummary, chargeResult) => {
  const enabledStops = (chargeResult?.stops || []).filter((stop) => stop.mandatory || stop.enabled);
  return {
    ...baseSummary,
    arrivalSoc: chargeResult?.arrivalSoc ?? baseSummary.arrivalSoc,
    chargingStops: enabledStops.length,
    chargeEnergyKwh: chargeResult?.totalChargeEnergyKwh ?? 0,
    chargeTimeMin: chargeResult?.totalChargeTimeMin ?? 0,
    chargeCostEur: round(chargeResult?.totalChargeCostEur ?? (chargeResult?.totalChargeEnergyKwh || 0) * PRICE_PER_KWH_ESTIMATE, 2),
    arrivalSocTarget: chargeResult?.arrivalSocTarget ?? 20,
    finalSocWarning: chargeResult?.finalSocWarning || "",
  };
};

export const recomputeChargePlanProjection = ({
  segments,
  batteryKwh,
  initialSocPct,
  stops,
  arrivalSocTarget = 20,
  pricePerKwh = PRICE_PER_KWH_ESTIMATE,
}) => {
  return applyChargePlan({
    segments,
    batteryKwh,
    initialSocPct,
    stops,
    arrivalSocTarget,
    pricePerKwh,
  });
};

export const buildSmartChargePlan = async ({
  segments,
  routeCoords,
  batteryKwh,
  initialSocPct,
  arrivalSocTarget = 20,
  apiKey,
  previousStops = [],
  pricePerKwh = PRICE_PER_KWH_ESTIMATE,
}) => {
  const suggested = buildSuggestedStopConfigs({
    segments,
    batteryKwh,
    initialSocPct,
    previousStops,
  });

  const stopsWithStations = await hydrateStopStations(suggested, apiKey);
  const projection = recomputeChargePlanProjection({
    segments,
    batteryKwh,
    initialSocPct,
    stops: stopsWithStations,
    arrivalSocTarget,
    pricePerKwh,
  });

  let corridorStations = [];
  try {
    corridorStations = await findChargingStationsAlongRoute({
      routeCoords,
      radiusKm: 3,
      maxPerSample: 6,
      maxSamples: 12,
      maxTotal: 60,
      apiKey,
    });
  } catch {
    corridorStations = [];
  }

  const plannedIds = new Set(
    projection.stops
      .map((stop) => stop.station?.id)
      .filter(Boolean)
  );

  const filteredCorridor = corridorStations.filter((station) => !plannedIds.has(station.id));

  return {
    projection,
    corridorStations: filteredCorridor,
  };
};

export const computeWeatherEnergyStats = ({ segments = [], vehicle, cabinTemp, routeCoords = [] }) => {
  if (!segments.length) {
    return {
      minTempC: null,
      maxTempC: null,
      avgPrecipMm: null,
      avgWindKmh: null,
      windTrend: "-",
      denivelePosM: 0,
      deniveleNegM: 0,
      weatherImpactKwh: 0,
      hvacAvgKw: 0,
    };
  }

  const tempValues = segments.map((s) => Number(s.tExt) || 0);
  const precipValues = segments.map((s) => Number(s.precip) || 0);
  const windValues = segments.map((s) => Number(s.windKmh) || 0);
  const windDirValues = segments.map((s) => Number(s.windDirDeg) || 0);

  const minTempC = Math.min(...tempValues);
  const maxTempC = Math.max(...tempValues);
  const avgPrecipMm = precipValues.reduce((a, b) => a + b, 0) / Math.max(1, precipValues.length);
  const avgWindKmh = windValues.reduce((a, b) => a + b, 0) / Math.max(1, windValues.length);
  const avgWindDir = windDirValues.reduce((a, b) => a + b, 0) / Math.max(1, windDirValues.length);

  const routeStart = routeCoords[0] || segments[0]?.startCoord || segments[0]?.refCoord;
  const routeEnd = routeCoords.at(-1) || segments.at(-1)?.endCoord || segments.at(-1)?.refCoord;
  const routeBearing = routeStart && routeEnd ? getBearingDeg(routeStart, routeEnd) : 0;

  const angle = Math.abs((((avgWindDir - routeBearing) % 360) + 540) % 360 - 180);
  const windTrend = angle > 110 ? "favorable" : angle < 70 ? "défavorable" : "neutre";

  const denivelePosM = segments.reduce((acc, s) => acc + Math.max(0, Number(s.deltaH) || 0), 0);
  const deniveleNegM = segments.reduce((acc, s) => acc + Math.max(0, -(Number(s.deltaH) || 0)), 0);

  const weatherImpactWh = segments.reduce((acc, seg) => {
    const hvacActual = calculateHvacPower(cabinTemp, seg.tExt);
    const actualWh = calculateSegmentEnergy({
      distM: seg.distanceM,
      deltaH: seg.deltaH,
      vKmh: seg.speedTrip,
      mass: vehicle.massKg,
      cx: vehicle.cx,
      area: vehicle.areaM2,
      tExt: seg.tExt,
      precip: seg.precip,
      hvacW: hvacActual,
    });

    const hvacIdeal = calculateHvacPower(cabinTemp, 21);
    const idealWh = calculateSegmentEnergy({
      distM: seg.distanceM,
      deltaH: seg.deltaH,
      vKmh: seg.speedTrip,
      mass: vehicle.massKg,
      cx: vehicle.cx,
      area: vehicle.areaM2,
      tExt: 21,
      precip: 0,
      hvacW: hvacIdeal,
    });

    return acc + Math.max(0, actualWh - idealWh);
  }, 0);

  const hvacAvgKw =
    segments.reduce((acc, seg) => acc + (Number(seg.hvacW) || calculateHvacPower(cabinTemp, seg.tExt)), 0) /
    Math.max(1, segments.length) /
    1000;

  return {
    minTempC: round(minTempC, 1),
    maxTempC: round(maxTempC, 1),
    avgPrecipMm: round(avgPrecipMm, 2),
    avgWindKmh: round(avgWindKmh, 1),
    windTrend,
    denivelePosM: round(denivelePosM, 0),
    deniveleNegM: round(deniveleNegM, 0),
    weatherImpactKwh: round(weatherImpactWh / 1000, 2),
    hvacAvgKw: round(hvacAvgKw, 2),
  };
};
