import Card from "../ui/Card";
import Slider from "../ui/Slider";
import { formatDuration, formatKm, mono } from "../../utils/format";

const ChargingPlanCard = ({
  stops = [],
  onToggleStopSelected,
  onToggleStopCharge,
  onTargetSocChange,
  onSelectStation,
}) => {
  return (
    <Card title="Plan de charge intelligent" subtitle="Arrêts sécurité 2h + contraintes SOC avec projection dynamique.">
      {!stops.length ? (
        <p className="field__hint">Aucun arrêt nécessaire (trajet court ou autonomie suffisante).</p>
      ) : (
        <div className="charge-plan-list">
          {stops.map((stop, idx) => {
            const hasStation = Boolean(stop.stationCandidates?.length);
            const isMandatory = stop.stopType === "mandatory" || stop.mandatory;
            const isRecommended = stop.stopType === "recommended";
            const isOptional = stop.stopType === "optional";
            const stopSelected = isMandatory ? true : Boolean(stop.selected ?? stop.enabled);
            const chargeEnabled = isMandatory ? true : Boolean(stop.chargeEnabled);
            const stopInactive = !stopSelected;

            const stopBadge = isMandatory
              ? { label: "Obligatoire", cls: "badge--danger" }
              : isRecommended
                ? { label: "Recommandé", cls: "badge--warn" }
                : { label: "Optionnel", cls: "badge--neutral" };

            return (
              <article key={stop.id} className="charge-stop-card">
                <header className="charge-stop-head">
                  <div>
                    <strong>Arrêt #{idx + 1}</strong>
                    <p className="field__hint">
                      Segment {stop.segmentNumber} · Pause après {formatDuration(stop.driveTimeSec)} · {formatKm(stop.distanceFromStartM)}
                    </p>
                    {stop.nearTwoHoursWindow ? <span className="badge badge--soft">Pause proche de la fenêtre 2h</span> : null}
                  </div>

                  <div className="stack-sm">
                    <span className={`badge ${stopBadge.cls}`}>{stopBadge.label}</span>
                    <label className="checkbox-inline">
                      <input
                        type="checkbox"
                        checked={stopSelected}
                        disabled={isMandatory}
                        onChange={(e) => onToggleStopSelected(stop.id, e.target.checked)}
                      />
                      Inclure cet arrêt
                    </label>
                    <label className="checkbox-inline">
                      <input
                        type="checkbox"
                        checked={chargeEnabled}
                        disabled={isMandatory || !stopSelected}
                        onChange={(e) => onToggleStopCharge(stop.id, e.target.checked)}
                      />
                      Recharger ici
                    </label>
                  </div>
                </header>

                {isMandatory ? (
                  <p className="field__hint">
                    Arrêt obligatoire : décocher ferait passer la projection sous la marge minimale de sécurité.
                  </p>
                ) : null}
                {stop.chainWarning ? <p className="alert-error">{stop.chainWarning}</p> : null}
                {stopInactive ? <p className="field__hint">Arrêt ignoré : aucun arrêt/charge appliqué à cette étape.</p> : null}

                {hasStation ? (
                  <label className="field">
                    <span className="field__label">Borne sélectionnée</span>
                    <select
                      className="input"
                      value={stop.station?.id || stop.stationCandidates[0]?.id || ""}
                      disabled={!stopSelected}
                      onChange={(e) => onSelectStation(stop.id, Number(e.target.value))}
                    >
                      {stop.stationCandidates.map((station) => (
                        <option key={station.id} value={station.id}>
                          {station.name} · {station.powerKw ? `${station.powerKw} kW` : "Puissance NC"}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : (
                  <p className="alert-error">Aucune borne trouvée sur ce segment.</p>
                )}

                <div className="charge-stop-grid">
                  <div><span>SOC à l’arrivée</span><strong className="font-mono">{mono(stop.socAtArrival, 1)}%</strong></div>
                  <div><span>Objectif min.</span><strong className="font-mono">{mono(stop.minTargetSoc, 1)}%</strong></div>
                  <div><span>Énergie min.</span><strong className="font-mono">{mono(stop.energyForMinKwh, 2)} kWh</strong></div>
                  <div><span>Temps charge min.</span><strong className="font-mono">{mono(stop.timeForMinMin, 0)} min</strong></div>
                  <div><span>Énergie cible</span><strong className="font-mono">{mono(stop.energyForTargetKwh, 2)} kWh</strong></div>
                  <div><span>Temps cible</span><strong className="font-mono">{mono(stop.timeForTargetMin, 0)} min</strong></div>
                  <div><span>SOC après charge</span><strong className="font-mono">{mono(stop.socAfterCharge, 1)}%</strong></div>
                  <div><span>SOC étape suivante</span><strong className="font-mono">{mono(stop.projectedSocNext, 1)}%</strong></div>
                  <div><span>Coût estimé</span><strong className="font-mono">{mono(stop.costEstimateEur, 2)} €</strong></div>
                  <div><span>Détour estimé</span><strong className="font-mono">{stop.detourKm != null ? `${mono(stop.detourKm, 2)} km` : "estimé"}</strong></div>
                </div>

                <Slider
                  label="Recharge souhaitée"
                  min={Math.ceil(stop.minTargetSoc || 0)}
                  max={95}
                  value={Math.round(stop.targetSoc || stop.minTargetSoc || 80)}
                  unit="%"
                  disabled={!chargeEnabled || !stopSelected}
                  onChange={(value) => onTargetSocChange(stop.id, value)}
                  hint={`Minimum requis pour l'étape suivante : ${mono(stop.minTargetSoc, 1)}%`}
                />
              </article>
            );
          })}
        </div>
      )}
    </Card>
  );
};

export default ChargingPlanCard;
