const OCM_BASE = "https://api.openchargemap.io/v3/poi/";

const parseOperatorPricePerKwh = (rawCost) => {
  if (!rawCost || typeof rawCost !== "string") return null;

  const normalized = rawCost.replace(/,/g, ".").toLowerCase();
  const perKwhMatch = normalized.match(/(\d+(?:\.\d+)?)\s*€?\s*(?:\/|par\s*)\s*kwh/);
  if (perKwhMatch) return Number(perKwhMatch[1]);

  const euroNumber = normalized.match(/(\d+(?:\.\d+)?)\s*€?/);
  return euroNumber ? Number(euroNumber[1]) : null;
};

const haversineDistanceM = (a, b) => {
  if (!a || !b) return 0;
  const toRad = (deg) => (deg * Math.PI) / 180;
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

const normalizeStation = (s) => ({
  id: s.ID,
  name: s.AddressInfo?.Title || "Borne sans nom",
  address: s.AddressInfo?.AddressLine1 || s.AddressInfo?.Town || "Adresse inconnue",
  operatorName: s.OperatorInfo?.Title || "",
  usageCost: s.UsageCost || "",
  pricePerKwh: parseOperatorPricePerKwh(s.UsageCost),
  powerKw: s.Connections?.[0]?.PowerKW ?? null,
  connector: s.Connections?.[0]?.ConnectionType?.Title || "Type inconnu",
  lat: s.AddressInfo?.Latitude,
  lng: s.AddressInfo?.Longitude,
  distanceKm: Number.isFinite(s.AddressInfo?.Distance) ? Number(s.AddressInfo.Distance) : null,
});

export const findChargingStations = async ({ lat, lng, distanceKm = 5, max = 8, apiKey }) => {
  const params = new URLSearchParams({
    output: "json",
    latitude: String(lat),
    longitude: String(lng),
    distance: String(distanceKm),
    distanceunit: "KM",
    maxresults: String(max),
    compact: "true",
    verbose: "false",
  });

  const res = await fetch(`${OCM_BASE}?${params.toString()}`, {
    headers: apiKey
      ? {
          "X-API-Key": apiKey,
        }
      : {},
  });

  if (!res.ok) {
    throw new Error("Erreur OpenChargeMap.");
  }

  const data = await res.json();
  return (Array.isArray(data) ? data : []).map(normalizeStation);
};

const sampleRouteCoords = (routeCoords = [], samples = 10) => {
  if (!routeCoords.length) return [];
  if (routeCoords.length <= samples) return routeCoords;

  const step = Math.max(1, Math.floor(routeCoords.length / samples));
  const points = [];

  for (let i = 0; i < routeCoords.length; i += step) {
    points.push(routeCoords[i]);
  }

  const last = routeCoords[routeCoords.length - 1];
  if (!points.length || points[points.length - 1] !== last) points.push(last);
  return points;
};

export const findChargingStationsAlongRoute = async ({
  routeCoords = [],
  radiusKm = 3,
  maxPerSample = 6,
  maxSamples = 10,
  maxTotal = 40,
  apiKey,
}) => {
  const sampledPoints = sampleRouteCoords(routeCoords, maxSamples);
  if (!sampledPoints.length) return [];

  const allResults = await Promise.all(
    sampledPoints.map((point) =>
      findChargingStations({
        lat: point.lat,
        lng: point.lng,
        distanceKm: radiusKm,
        max: maxPerSample,
        apiKey,
      }).catch(() => [])
    )
  );

  const seen = new Map();

  allResults.flat().forEach((station) => {
    if (!station?.id || !Number.isFinite(station.lat) || !Number.isFinite(station.lng)) return;

    let minDetourKm = Number.POSITIVE_INFINITY;
    routeCoords.forEach((coord) => {
      const dKm = haversineDistanceM(coord, station) / 1000;
      if (dKm < minDetourKm) minDetourKm = dKm;
    });

    const withDetour = {
      ...station,
      detourKm: Number.isFinite(minDetourKm) ? Number(minDetourKm.toFixed(2)) : null,
      markerType: "corridor",
    };

    const existing = seen.get(station.id);
    if (!existing || (withDetour.detourKm ?? 999) < (existing.detourKm ?? 999)) {
      seen.set(station.id, withDetour);
    }
  });

  return Array.from(seen.values())
    .sort((a, b) => (a.detourKm ?? 999) - (b.detourKm ?? 999))
    .slice(0, maxTotal);
};
