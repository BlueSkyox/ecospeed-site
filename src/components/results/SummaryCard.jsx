import Card from "../ui/Card";
import { formatDuration, formatKm, formatKwh, mono } from "../../utils/format";

const SummaryCard = ({ summary }) => {
  if (!summary) return null;

  const energyKwh = (summary.totalEnergyWh || 0) / 1000;
  const savedEnergyKwh = Math.max(0, (summary.referenceEnergyKwh || energyKwh) - energyKwh);
  const savedMoneyEur = savedEnergyKwh * 0.45;
  const savedChargeMin = savedEnergyKwh > 0 ? (savedEnergyKwh / 50) * 60 : 0;
  const recoveredRangeKm = summary.avgWhKm > 0 ? (savedEnergyKwh * 1000) / summary.avgWhKm : 0;
  const co2AvoidedKg = 0.12 * (summary.totalDistanceM || 0) / 1000;

  const rows = [
    ["Distance totale", formatKm(summary.totalDistanceM)],
    ["Durée estimée", formatDuration(summary.durationSec)],
    ["Énergie totale", formatKwh(summary.totalEnergyWh)],
    ["Coût recharge estimé", `${mono(summary.chargeCostEur ?? energyKwh * 0.45, 2)} €`],
    ["Consommation moyenne", `${mono(summary.avgWhKm, 1)} Wh/km`],
    ["Puissance HVAC moyenne", `${mono(summary.avgHvac, 0)} W`],
    ["SOC à l’arrivée", `${mono(summary.arrivalSoc, 1)} %`],
  ];

  const kpis = [
    {
      label: "CO₂ évité",
      value: `${mono(co2AvoidedKg, 2)} kg`,
      eq: `≈ ${mono(co2AvoidedKg * 5, 0)} km à vélo`,
      positive: true,
    },
    {
      label: "Énergie économisée",
      value: `${mono(savedEnergyKwh, 2)} kWh`,
      eq: `≈ ${mono(recoveredRangeKm, 0)} km récupérés`,
      positive: true,
    },
    {
      label: "Économie financière",
      value: `${mono(savedMoneyEur, 2)} €`,
      eq: `≈ ${mono(savedEnergyKwh / 7, 1)} h de charge domicile`,
      positive: true,
    },
    {
      label: "Temps de charge évité",
      value: `${mono(savedChargeMin, 0)} min`,
      eq: "réf. borne 50 kW",
    },
  ];

  return (
    <Card title="Résumé du mode sélectionné" subtitle="Synthèse énergétique, coûts et impacts concrets.">
      <div className="summary-rows">
        {rows.map(([label, value]) => (
          <div key={label} className="summary-row">
            <span>{label}</span>
            <strong className="font-mono">{value}</strong>
          </div>
        ))}
      </div>

      <div className="kpi-grid">
        {kpis.map((kpi) => (
          <article key={kpi.label} className="kpi-card">
            <span>{kpi.label}</span>
            <strong className={`font-mono ${kpi.positive ? "value-positive" : ""}`.trim()}>{kpi.value}</strong>
            <small>{kpi.eq}</small>
          </article>
        ))}
      </div>

      {summary.finalSocWarning ? <p className="alert-error">{summary.finalSocWarning}</p> : null}
    </Card>
  );
};

export default SummaryCard;
