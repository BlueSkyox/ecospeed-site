import Card from "../ui/Card";

const CompareTable = ({ rows, selectedMode, onSelectMode }) => {
  const byKey = Object.fromEntries((rows || []).map((row) => [row.key, row]));

  const metrics = [
    {
      label: "Durée trajet",
      render: (row) => `${row.durationMin} min`,
    },
    {
      label: "Énergie totale",
      render: (row) => `${row.energyKwh} kWh`,
    },
    {
      label: "Coût estimé",
      render: (row) => `${row.costEur?.toFixed?.(2) ?? row.costEur} €`,
    },
    {
      label: "Nb arrêts recharge",
      render: (row) => `${row.stops}`,
    },
    {
      label: "Temps de charge",
      render: (row) => `${row.chargeTimeMin || 0} min`,
    },
    {
      label: "CO₂ évité (vs thermique)",
      render: (row) => `${row.co2AvoidedKg ?? "-"} kg`,
      single: true,
    },
  ];

  return (
    <Card title="Comparatif des modes" subtitle="Vue latérale Rapide / Équilibré / Éco.">
      <div className="table-wrap compare-side-table">
        <table className="table table--compact">
          <thead>
            <tr>
              <th>Métrique</th>
              <th>Rapide</th>
              <th>Équilibré</th>
              <th>Éco</th>
            </tr>
          </thead>
          <tbody>
            {metrics.map((metric) => (
              <tr key={metric.label}>
                <td>{metric.label}</td>
                <td className="font-mono">{metric.render(byKey.rapide || {})}</td>
                <td className="font-mono">{metric.render(byKey.equilibre || {})}</td>
                <td className="font-mono">{metric.render(byKey.eco || {})}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mode-switch-inline">
        {rows.map((row) => (
          <button
            key={row.key}
            type="button"
            className={`mode-chip ${selectedMode === row.key ? "mode-chip--active" : ""}`}
            onClick={() => onSelectMode(row.key)}
          >
            {row.mode}
          </button>
        ))}
      </div>
    </Card>
  );
};

export default CompareTable;
