import Card from "../ui/Card";
import { MODE_CONFIG } from "../../utils/planner";

const modeMeta = {
  rapide: { icon: "⚡", speed: "Vitesse max segment" },
  equilibre: { icon: "◉", speed: "Compromis adaptatif" },
  eco: { icon: "🍃", speed: "Vitesse optimale physique" },
};

const ModeSelector = ({ selectedMode, onSelect }) => {
  return (
    <Card title="Mode de conduite" subtitle="Choisissez le profil d’optimisation énergétique.">
      <div className="mode-grid">
        {Object.entries(MODE_CONFIG).map(([key, value]) => (
          <button
            key={key}
            type="button"
            onClick={() => onSelect(key)}
            className={`mode-card ${selectedMode === key ? "mode-card--selected" : ""}`}
          >
            <div className="mode-card__top">
              <span className="mode-icon">{modeMeta[key].icon}</span>
              <strong>{value.label}</strong>
            </div>
            <p>{value.description}</p>
            <span className="mode-speed font-mono">{modeMeta[key].speed}</span>
          </button>
        ))}
      </div>
    </Card>
  );
};

export default ModeSelector;
