"use client";

type WeatherPoint = {
  edge_index: number;
  distance_km: number;
  temp_c: number;
  rain_mmh: number;
  wind_kmh?: number;
};

type WeatherTrendChartProps = {
  data: WeatherPoint[];
  locale: "fr" | "en";
};

function buildPath(values: number[], height: number, padding: number) {
  if (values.length === 0) return "";
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = Math.max(1e-6, max - min);
  const width = 100;
  return values
    .map((value, index) => {
      const x = values.length === 1 ? width / 2 : (index / (values.length - 1)) * width;
      const y = padding + ((max - value) / range) * (height - padding * 2);
      return `${index === 0 ? "M" : "L"} ${x.toFixed(2)} ${y.toFixed(2)}`;
    })
    .join(" ");
}

export default function WeatherTrendChart({ data, locale }: WeatherTrendChartProps) {
  if (data.length === 0) {
    return <div className="ecospeed-empty-state">{locale === "fr" ? "Aucune courbe meteo disponible pour ce trajet." : "No weather chart is available for this trip."}</div>;
  }

  const points = data.filter((item, index) => index % Math.max(1, Math.ceil(data.length / 18)) === 0 || index === data.length - 1);
  const tempValues = points.map((item) => Number(item.temp_c ?? 0));
  const rainValues = points.map((item) => Number(item.rain_mmh ?? 0));
  const windValues = points.map((item) => Number(item.wind_kmh ?? 0));
  const tempPath = buildPath(tempValues, 120, 14);
  const rainPath = buildPath(rainValues, 120, 14);
  const windPath = buildPath(windValues, 120, 14);
  const totalDistanceKm = data.reduce((sum, item) => sum + Number(item.distance_km ?? 0), 0);

  return (
    <div className="ecospeed-weather-chart">
      <svg
        viewBox="0 0 100 120"
        preserveAspectRatio="none"
        aria-label={locale === "fr" ? "Evolution de la temperature, de la pluie et du vent" : "Temperature, rain and wind trend"}
      >
        <line x1="0" y1="106" x2="100" y2="106" stroke="rgba(23,49,37,0.12)" strokeWidth="0.8" />
        <path d={rainPath} fill="none" stroke="#2d74c4" strokeWidth="2.4" strokeLinejoin="round" strokeLinecap="round" />
        <path d={windPath} fill="none" stroke="#2f8f5b" strokeWidth="2.4" strokeLinejoin="round" strokeLinecap="round" />
        <path d={tempPath} fill="none" stroke="#d88b29" strokeWidth="2.4" strokeLinejoin="round" strokeLinecap="round" />
      </svg>
      <div className="ecospeed-chart-legend">
        <span>
          <i className="ecospeed-chart-swatch ecospeed-chart-swatch--temp" />
          {locale === "fr" ? "Temperature" : "Temperature"}
        </span>
        <span>
          <i className="ecospeed-chart-swatch ecospeed-chart-swatch--rain" />
          {locale === "fr" ? "Pluie" : "Rain"}
        </span>
        <span>
          <i className="ecospeed-chart-swatch ecospeed-chart-swatch--wind" />
          {locale === "fr" ? "Vent" : "Wind"}
        </span>
        <span>{totalDistanceKm.toFixed(0)} km {locale === "fr" ? "traces" : "tracked"}</span>
      </div>
    </div>
  );
}
