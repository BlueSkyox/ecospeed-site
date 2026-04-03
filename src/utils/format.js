export const formatKm = (meters) => `${(meters / 1000).toFixed(1)} km`;

export const formatKwh = (wh) => `${(wh / 1000).toFixed(2)} kWh`;

export const formatDuration = (sec) => {
  const totalMin = Math.round(sec / 60);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h}h ${String(m).padStart(2, "0")}` : `${m} min`;
};

export const mono = (value, digits = 1) => {
  const num = Number(value);
  if (!Number.isFinite(num)) return "-";
  return num.toFixed(digits);
};
