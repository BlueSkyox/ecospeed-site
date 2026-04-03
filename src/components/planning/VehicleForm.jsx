import Card from "../ui/Card";

const VehicleForm = ({ vehicle, models, onChange }) => {
  const handleModelChange = (modelId) => {
    const selected = models.find((model) => model.id === modelId);
    if (!selected) return;

    onChange({
      ...vehicle,
      modelId: selected.id,
      batteryKwh: selected.batteryKwh,
      baseWhKm: selected.baseWhKm,
      massKg: selected.massKg,
      cx: selected.cx,
      areaM2: selected.areaM2,
    });
  };

  return (
    <Card title="Véhicule" subtitle="Choisissez un modèle, les caractéristiques sont appliquées automatiquement.">
      <label className="field">
        <span className="field__label">Modèle de voiture électrique</span>
        <select
          className="input"
          value={vehicle.modelId || models[0]?.id || ""}
          onChange={(e) => handleModelChange(e.target.value)}
        >
          {models.map((model) => (
            <option key={model.id} value={model.id}>
              {model.label}
            </option>
          ))}
        </select>
        <span className="field__hint">Masse, Cx, surface frontale, batterie et conso moyenne sont préremplis.</span>
      </label>

      <div className="vehicle-specs-grid">
        <div className="vehicle-spec">
          <span>Batterie</span>
          <strong className="font-mono">{vehicle.batteryKwh} kWh</strong>
        </div>
        <div className="vehicle-spec">
          <span>Conso de base</span>
          <strong className="font-mono">{vehicle.baseWhKm} Wh/km</strong>
        </div>
        <div className="vehicle-spec">
          <span>Masse à vide</span>
          <strong className="font-mono">{vehicle.massKg} kg</strong>
        </div>
        <div className="vehicle-spec">
          <span>Cx</span>
          <strong className="font-mono">{vehicle.cx}</strong>
        </div>
        <div className="vehicle-spec">
          <span>Surface frontale</span>
          <strong className="font-mono">{vehicle.areaM2} m²</strong>
        </div>
      </div>
    </Card>
  );
};

export default VehicleForm;
