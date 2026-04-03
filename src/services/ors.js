const ORS_BASE = "https://api.openrouteservice.org";

const NOMINATIM_BASE = "https://nominatim.openstreetmap.org";

const safeJson = async (response) => {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
};

export const autocompletePlaces = async (query, apiKey) => {
  if (!apiKey) throw new Error("Clé OpenRouteService manquante. Ajoutez-la dans Réglages.");
  if (!query?.trim()) return [];

  const url = `${ORS_BASE}/geocode/autocomplete?api_key=${encodeURIComponent(apiKey)}&text=${encodeURIComponent(
    query
  )}&size=5`;

  const res = await fetch(url);
  const data = await safeJson(res);

  if (!res.ok) {
    throw new Error(data?.error?.message || "Erreur ORS autocomplete");
  }

  return (data.features || []).map((feature) => ({
    label: feature.properties?.label || feature.properties?.name || "Lieu",
    coords: {
      lng: feature.geometry?.coordinates?.[0],
      lat: feature.geometry?.coordinates?.[1],
    },
  }));
};

export const reverseGeocode = async ({ lat, lng, language = "fr" }) => {
  const params = new URLSearchParams({
    format: "jsonv2",
    lat: String(lat),
    lon: String(lng),
    addressdetails: "1",
    "accept-language": language,
  });

  const res = await fetch(`${NOMINATIM_BASE}/reverse?${params.toString()}`, {
    headers: {
      "Accept-Language": language,
    },
  });
  const data = await safeJson(res);

  if (!res.ok) {
    throw new Error("Échec du reverse geocoding.");
  }

  return {
    label: data.display_name || `${lat.toFixed(5)}, ${lng.toFixed(5)}`,
    coords: { lat, lng },
  };
};

const getDominantWaytypeCode = (waytypeValues = [], fromIdx, toIdx) => {
  if (!Array.isArray(waytypeValues) || !waytypeValues.length) return null;
  const scoreByType = new Map();
  waytypeValues.forEach(([start, end, value]) => {
    const overlap = Math.max(0, Math.min(end, toIdx) - Math.max(start, fromIdx));
    if (overlap <= 0) return;
    scoreByType.set(value, (scoreByType.get(value) || 0) + overlap);
  });
  return Array.from(scoreByType.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
};

export const getRoute = async (start, end, apiKey) => {
  if (!apiKey) throw new Error("Clé OpenRouteService manquante. Ajoutez-la dans Réglages.");

  const res = await fetch(`${ORS_BASE}/v2/directions/driving-car/geojson`, {
    method: "POST",
    headers: {
      Authorization: apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      coordinates: [
        [start.lng, start.lat],
        [end.lng, end.lat],
      ],
      elevation: true,
      instructions: true,
      extra_info: ["waytype", "surface"],
    }),
  });

  const data = await safeJson(res);

  if (!res.ok) {
    throw new Error(data?.error?.message || "Erreur ORS routing");
  }

  const feature = data.features?.[0];
  if (!feature) throw new Error("Aucun itinéraire retourné par ORS.");

  const coords = (feature.geometry?.coordinates || []).map((p) => ({
    lng: p[0],
    lat: p[1],
    ele: Number.isFinite(p[2]) ? p[2] : 0,
  }));

  const summary = feature.properties?.summary || {};
  const segments = feature.properties?.segments || [];
  const waytypeValues = feature.properties?.extras?.waytype?.values || [];

  const steps = [];
  segments.forEach((segment) => {
    (segment.steps || []).forEach((step) => {
      const [fromIdx, toIdx] = step.way_points || [];
      const dominantWaytype = Number.isFinite(fromIdx) && Number.isFinite(toIdx)
        ? getDominantWaytypeCode(waytypeValues, fromIdx, toIdx)
        : null;

      steps.push({
        fromIdx,
        toIdx,
        distanceM: Number(step.distance) || 0,
        durationSec: Number(step.duration) || 0,
        instructionType: step.type,
        name: step.name || "",
        waytypeCode: dominantWaytype,
      });
    });
  });

  return {
    coords,
    distanceM: summary.distance || 0,
    durationSec: summary.duration || 0,
    routeMeta: {
      steps,
    },
  };
};
