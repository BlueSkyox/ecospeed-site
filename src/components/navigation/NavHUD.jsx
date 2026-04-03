const getSpeedColorClass = (speedKmh, ecoKmh, limitKmh) => {
  if (speedKmh <= ecoKmh) return "hud-value--ok";
  if (speedKmh <= limitKmh) return "hud-value--warn";
  return "hud-value--danger";
};

const getDirectionArrow = (instruction) => {
  const i = (instruction || "").toLowerCase();
  if (i.includes("gauche")) return "↰";
  if (i.includes("droite")) return "↱";
  if (i.includes("demi-tour") || i.includes("u-turn")) return "↶";
  return "↑";
};

const getSocClass = (socPct) => {
  if (socPct < 15) return "soc-bar--danger";
  if (socPct < 30) return "soc-bar--warn";
  return "soc-bar--ok";
};

const NavHUD = ({
  speedKmh,
  ecoKmh,
  limitKmh,
  socPct,
  nextStop,
  showApproachBanner,
  guidance,
  remainingDistanceKm,
  etaTime,
}) => {
  const instruction = guidance?.instruction || "Continuez tout droit";
  const distanceToManeuverM = Math.max(0, Math.round(guidance?.distanceToManeuverM || 0));

  return (
    <>
      {showApproachBanner && nextStop ? (
        <div className="nav-stop-banner">🔌 Borne dans {nextStop.distanceKm.toFixed(1)} km — {nextStop.nameShort}</div>
      ) : null}

      <div className="nav-guidance-bar">
        <div className="nav-guidance-arrow">{getDirectionArrow(instruction)}</div>
        <div>
          <strong>{instruction}</strong>
          <p className="field__hint">dans {distanceToManeuverM} m</p>
        </div>
        <span className="speed-badge speed-badge--red font-mono">{Math.round(limitKmh)}</span>
      </div>

      <div className="nav-hud-compact">
        <div className="nav-hud-line nav-hud-line--1">
          <strong className={`nav-speed-main ${getSpeedColorClass(speedKmh, ecoKmh, limitKmh)} font-mono`}>
            {Math.round(speedKmh)}
          </strong>
          <span className="nav-speed-unit">km/h</span>
          <span className="nav-chip nav-chip--eco">Éco {Math.round(ecoKmh)}</span>
          <span className="nav-chip nav-chip--limit">Limite {Math.round(limitKmh)}</span>
        </div>

        <div className="nav-hud-line nav-hud-line--2">
          <div className="soc-inline">
            <span className="hud-label">SOC</span>
            <strong className="font-mono">{socPct.toFixed(1)}%</strong>
            <div className={`soc-bar ${getSocClass(socPct)}`}>
              <div style={{ width: `${Math.max(0, Math.min(100, socPct))}%` }} />
            </div>
          </div>

          <span className="nav-chip">Reste {Math.max(0, remainingDistanceKm || 0).toFixed(1)} km</span>
          <span className="nav-chip">ETA {etaTime || "--:--"}</span>
          {nextStop ? <span className="nav-chip">🔌 {nextStop.nameShort} · {nextStop.distanceKm.toFixed(1)} km</span> : null}
        </div>
      </div>
    </>
  );
};

export default NavHUD;
