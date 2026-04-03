const toRad = (deg) => (deg * Math.PI) / 180;

export const haversineDistanceM = (a, b) => {
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

export const getBearingDeg = (a, b) => {
  if (!a || !b) return 0;
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const dLng = toRad(b.lng - a.lng);

  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);

  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
};

export const findNearestPointIndex = (path, target) => {
  if (!Array.isArray(path) || path.length === 0 || !target) return 0;

  let bestIdx = 0;
  let bestDist = Number.POSITIVE_INFINITY;

  path.forEach((p, idx) => {
    const d = haversineDistanceM(p, target);
    if (d < bestDist) {
      bestDist = d;
      bestIdx = idx;
    }
  });

  return bestIdx;
};

export const projectPathDistance = (path, index) => {
  if (!Array.isArray(path) || path.length < 2) return 0;
  const safeIndex = Math.max(0, Math.min(index, path.length - 1));
  let total = 0;
  for (let i = 1; i <= safeIndex; i += 1) {
    total += haversineDistanceM(path[i - 1], path[i]);
  }
  return total;
};

export const distanceToPathM = (path, target) => {
  if (!Array.isArray(path) || path.length === 0 || !target) return Number.POSITIVE_INFINITY;
  let best = Number.POSITIVE_INFINITY;
  path.forEach((p) => {
    const d = haversineDistanceM(p, target);
    if (d < best) best = d;
  });
  return best;
};
