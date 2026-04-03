const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

const round = (value, digits = 1) => {
  const m = 10 ** digits;
  return Math.round((Number(value) + Number.EPSILON) * m) / m;
};

const toRad = (deg) => (deg * Math.PI) / 180;

const haversineDistanceM = (a, b) => {
  if (!a || !b) return 0;
  const R = 6371000;
  const dLat = toRad((b.lat ?? 0) - (a.lat ?? 0));
  const dLng = toRad((b.lng ?? 0) - (a.lng ?? 0));
  const lat1 = toRad(a.lat ?? 0);
  const lat2 = toRad(b.lat ?? 0);
  const x =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.sin(dLng / 2) * Math.sin(dLng / 2) * Math.cos(lat1) * Math.cos(lat2);
  const c = 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
  return R * c;
};

const fallbackPricePerKwhByPower = (powerKw) => {
  const p = Number(powerKw) || 0;
  if (p > 150) return 0.55;
  if (p >= 50) return 0.45;
  return 0.4;
};

const resolveStationPricePerKwh = (station, defaultPricePerKwh) => {
  const fromOperator = Number(station?.pricePerKwh);
  if (Number.isFinite(fromOperator) && fromOperator > 0) return fromOperator;
  return fallbackPricePerKwhByPower(station?.powerKw) || defaultPricePerKwh;
};

const getSegmentDurationSec = (segment) => {
  const speedKmh = Math.max(1, Number(segment?.speedTrip) || Number(segment?.speedLimit) || 1);
  const distanceKm = (Number(segment?.distanceM) || 0) / 1000;
  return (distanceKm / speedKmh) * 3600;
};

const sumDurationSec = (segments, startIndex, endIndexInclusive) => {
  if (!segments?.length || startIndex > endIndexInclusive) return 0;
  let total = 0;
  for (let i = startIndex; i <= endIndexInclusive; i += 1) total += getSegmentDurationSec(segments[i]);
  return total;
};

const sumEnergyWh = (segments, startIndex, endIndexInclusive) => {
  if (!segments?.length || startIndex > endIndexInclusive) return 0;
  let total = 0;
  for (let i = startIndex; i <= endIndexInclusive; i += 1) {
    total += Math.max(0, Number(segments[i]?.energyWh) || 0);
  }
  return total;
};

const findStageEndIndex = (segments, startIndex, maxDrivingSec = 7200) => {
  if (startIndex >= segments.length - 1) return segments.length - 1;

  let elapsed = 0;
  for (let i = startIndex; i < segments.length; i += 1) {
    elapsed += getSegmentDurationSec(segments[i]);
    if (elapsed >= maxDrivingSec) return i;
  }
  return segments.length - 1;
};

const simulateSocRange = (segments, startIndex, endIndexInclusive, startSoc, batteryWh) => {
  let soc = Number(startSoc);
  let breachIndex = null;

  for (let i = startIndex; i <= endIndexInclusive; i += 1) {
    const energyPct = (Math.max(0, Number(segments[i]?.energyWh) || 0) / batteryWh) * 100;
    soc = Math.max(0, soc - energyPct);
    if (soc < 20 && breachIndex === null) breachIndex = i;
  }

  return {
    endSoc: soc,
    breachIndex,
  };
};

export const computeTotalDrivingSec = (segments = []) => segments.reduce((acc, seg) => acc + getSegmentDurationSec(seg), 0);

export const buildSuggestedStopConfigs = ({
  segments = [],
  initialSocPct,
  batteryKwh,
  previousStops = [],
  maxDrivingSec = 7200,
}) => {
  if (!segments.length) return [];

  const totalDrivingSec = computeTotalDrivingSec(segments);
  if (totalDrivingSec <= maxDrivingSec) return [];

  const batteryWh = Math.max(1, (Number(batteryKwh) || 0) * 1000);
  const previousByIndex = new Map(previousStops.map((stop) => [stop.segmentIndex, stop]));

  const stops = [];
  let stageStart = 0;
  let currentSoc = Number(initialSocPct);
  let safety = 0;

  while (stageStart < segments.length - 1 && safety < segments.length + 20) {
    safety += 1;
    const stageEnd = findStageEndIndex(segments, stageStart, maxDrivingSec);
    const isFinalLeg = stageEnd >= segments.length - 1;
    const projection = simulateSocRange(segments, stageStart, stageEnd, currentSoc, batteryWh);

    let stopIndex = null;
    let mandatory = false;

    if (projection.breachIndex !== null) {
      stopIndex = projection.breachIndex;
      mandatory = true;
    } else if (!isFinalLeg) {
      stopIndex = stageEnd;
      mandatory = false;
    } else {
      break;
    }

    const previous = previousByIndex.get(stopIndex);
    const targetSoc = Number(previous?.targetSoc ?? 80);
    const stageDriveSec = sumDurationSec(segments, stageStart, stopIndex);
    const nearTwoHoursWindow = stageDriveSec >= 105 * 60 && stageDriveSec <= 180 * 60;

    let stopType = "optional";
    if (mandatory) stopType = "mandatory";
    else if (nearTwoHoursWindow || projection.endSoc < 30) stopType = "recommended";

    const selectedDefault = stopType !== "optional";
    const selected = mandatory ? true : previous?.selected ?? previous?.enabled ?? selectedDefault;
    const chargeEnabled = mandatory ? true : previous?.chargeEnabled ?? previous?.enabled ?? selectedDefault;

    stops.push({
      id: previous?.id || `stop-${stopIndex}-${stops.length + 1}`,
      segmentIndex: stopIndex,
      segmentId: segments[stopIndex]?.id,
      refCoord: segments[stopIndex]?.refCoord || null,
      stopType,
      mandatory,
      selected,
      enabled: selected,
      chargeEnabled,
      nearTwoHoursWindow,
      targetSoc,
      station: previous?.station || null,
      stationCandidates: previous?.stationCandidates || [],
      detourKm: previous?.detourKm ?? null,
    });

    const toStop = simulateSocRange(segments, stageStart, stopIndex, currentSoc, batteryWh);
    currentSoc = toStop.endSoc;
    if (mandatory || (selected && chargeEnabled)) {
      currentSoc = Math.min(100, Math.max(currentSoc, targetSoc));
    }
    stageStart = stopIndex + 1;
  }

  return stops;
};

export const applyChargePlan = ({
  segments = [],
  batteryKwh,
  initialSocPct,
  stops = [],
  arrivalSocTarget = 20,
  pricePerKwh = 0.45,
}) => {
  if (!segments.length) {
    return {
      segments: [],
      stops: [],
      arrivalSoc: Number(initialSocPct) || 0,
      totalChargeEnergyKwh: 0,
      totalChargeTimeMin: 0,
    };
  }

  const batteryWh = Math.max(1, (Number(batteryKwh) || 0) * 1000);
  const sortedStops = [...stops].sort((a, b) => a.segmentIndex - b.segmentIndex);
  const stopByIndex = new Map(sortedStops.map((stop) => [stop.segmentIndex, stop]));
  const activeStops = sortedStops.filter((stop) =>
    Boolean(stop?.mandatory || stop?.selected || stop?.enabled)
  );

  let cumulativeDriveSec = 0;
  let soc = Number(initialSocPct);
  if (!Number.isFinite(soc)) soc = 0;
  let totalChargeEnergyKwh = 0;
  let totalChargeTimeMin = 0;
  let totalChargeCostEur = 0;

  const projectedSegments = [];
  const detailedStops = [];

  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i];
    const durationSec = getSegmentDurationSec(segment);
    cumulativeDriveSec += durationSec;

    const energyWh = Math.max(0, Number(segment.energyWh) || 0);
    const energyPct = (energyWh / batteryWh) * 100;
    soc = Math.max(0, soc - energyPct);

    projectedSegments.push({
      ...segment,
      socRemaining: round(soc, 1),
    });

    const stopBase = stopByIndex.get(i);
    if (!stopBase) continue;

    const stop = {
      ...stopBase,
      selected: stopBase.mandatory ? true : Boolean(stopBase.selected ?? stopBase.enabled),
      chargeEnabled: stopBase.mandatory ? true : Boolean(stopBase.chargeEnabled ?? stopBase.enabled),
    };

    const isActiveStop = Boolean(stop.mandatory || stop.selected);

    const nextStop = activeStops.find((candidate) => candidate.segmentIndex > i);
    const nextStageIndex = nextStop?.segmentIndex ?? segments.length - 1;
    const energyToNextWh = sumEnergyWh(segments, i + 1, nextStageIndex);
    const requiredSocToNext = (energyToNextWh / batteryWh) * 100 + 20;
    const minTargetSoc = clamp(Math.max(soc, requiredSocToNext), soc, 95);

    const stationPowerKw = Math.max(10, Number(stop.station?.powerKw) || 50);
    const stationPricePerKwh = resolveStationPricePerKwh(stop.station, pricePerKwh);
    const targetSoc = clamp(Number(stop.targetSoc) || 80, minTargetSoc, 95);
    const applyCharge = isActiveStop && Boolean(stop.mandatory || stop.chargeEnabled);
    const appliedTargetSoc = applyCharge ? targetSoc : soc;

    const detourKm =
      Number.isFinite(stop?.station?.lat) && Number.isFinite(stop?.station?.lng) && segment?.refCoord
        ? round(haversineDistanceM(segment.refCoord, stop.station) / 1000, 2)
        : stop.detourKm ?? null;
    const detourSpeedKmh = Math.max(25, Number(segment?.speedTrip) || Number(segment?.speedLimit) || 60);
    const detourTimeSec = isActiveStop && Number(detourKm) > 2 ? (Number(detourKm) / detourSpeedKmh) * 3600 : 0;
    const driveTimeWithDetourSec = cumulativeDriveSec + detourTimeSec;

    const energyForMinKwh = Math.max(0, ((minTargetSoc - soc) / 100) * batteryWh / 1000);
    const timeForMinMin = energyForMinKwh > 0 ? (energyForMinKwh / stationPowerKw) * 60 : 0;

    const energyForTargetKwh = Math.max(0, ((appliedTargetSoc - soc) / 100) * batteryWh / 1000);
    const timeForTargetMin = energyForTargetKwh > 0 ? (energyForTargetKwh / stationPowerKw) * 60 : 0;

    const projectedSocNext = Math.max(0, appliedTargetSoc - (energyToNextWh / batteryWh) * 100);

    if (applyCharge) {
      totalChargeEnergyKwh += energyForTargetKwh;
      totalChargeTimeMin += timeForTargetMin;
      totalChargeCostEur += energyForTargetKwh * stationPricePerKwh;
    }

    if (detourTimeSec > 0) {
      cumulativeDriveSec += detourTimeSec;
    }

    const chainWarning = projectedSocNext < 20
      ? `Impossible : la batterie serait insuffisante pour atteindre l'étape suivante (${round(projectedSocNext, 1)}%).`
      : "";

    detailedStops.push({
      ...stop,
      enabled: stop.selected,
      isActiveStop,
      chargeEnabled: Boolean(stop.mandatory || stop.chargeEnabled),
      targetSoc: round(targetSoc, 1),
      minTargetSoc: round(minTargetSoc, 1),
      socAtArrival: round(soc, 1),
      socAfterCharge: round(appliedTargetSoc, 1),
      distanceFromStartM: Number(segment.endDistM) || 0,
      driveTimeSec: cumulativeDriveSec,
      driveTimeWithDetourSec: round(driveTimeWithDetourSec, 0),
      detourTimeSec: round(detourTimeSec, 0),
      energyForMinKwh: round(energyForMinKwh, 2),
      timeForMinMin: round(timeForMinMin, 0),
      energyForTargetKwh: round(energyForTargetKwh, 2),
      timeForTargetMin: round(timeForTargetMin, 0),
      projectedSocNext: round(projectedSocNext, 1),
      costEstimateEur: round(energyForTargetKwh * stationPricePerKwh, 2),
      pricePerKwh: round(stationPricePerKwh, 2),
      nextStageSegmentIndex: nextStageIndex,
      nextStageSegmentNumber: segments[nextStageIndex]?.index ?? null,
      segmentNumber: segment.index,
      stationPowerKw,
      chainWarning,
      detourKm,
    });

    soc = appliedTargetSoc;
  }

  const finalSocWarning = soc < arrivalSocTarget
    ? `SOC final insuffisant (${round(soc, 1)}% < ${round(arrivalSocTarget, 1)}%).`
    : "";

  return {
    segments: projectedSegments,
    stops: detailedStops,
    arrivalSoc: round(soc, 1),
    totalChargeEnergyKwh: round(totalChargeEnergyKwh, 2),
    totalChargeTimeMin: round(totalChargeTimeMin, 0),
    totalChargeCostEur: round(totalChargeCostEur, 2),
    arrivalSocTarget: round(arrivalSocTarget, 1),
    finalSocWarning,
  };
};
