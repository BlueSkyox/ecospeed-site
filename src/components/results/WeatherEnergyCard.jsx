import Card from "../ui/Card";
import { mono } from "../../utils/format";

const WeatherEnergyCard = ({ stats }) => {
  if (!stats) return null;

  const items = [
    { label: "T° min", value: stats.minTempC != null ? `${mono(stats.minTempC, 1)} °C` : "-" },
    { label: "T° max", value: stats.maxTempC != null ? `${mono(stats.maxTempC, 1)} °C` : "-" },
    { label: "Précipitations moy.", value: `${mono(stats.avgPrecipMm, 2)} mm` },
    { label: "Vent moyen", value: `${mono(stats.avgWindKmh, 1)} km/h (${stats.windTrend || "-"})` },
    { label: "Dénivelé +", value: `${mono(stats.denivelePosM, 0)} m` },
    { label: "Dénivelé -", value: `${mono(stats.deniveleNegM, 0)} m` },
    { label: "Impact météo", value: `+${mono(stats.weatherImpactKwh, 2)} kWh` },
    { label: "HVAC moyen", value: `${mono(stats.hvacAvgKw, 2)} kW` },
  ];

  return (
    <Card title="Météo & Énergie" subtitle="Lecture synthétique des facteurs externes sur le trajet.">
      <div className="weather-tags">
        {items.map((item) => (
          <div key={item.label} className="weather-tag">
            <span>{item.label}</span>
            <strong className="font-mono">{item.value}</strong>
          </div>
        ))}
      </div>
    </Card>
  );
};

export default WeatherEnergyCard;
