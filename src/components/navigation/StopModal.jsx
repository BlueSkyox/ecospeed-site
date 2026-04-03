import { useMemo, useState } from "react";
import Button from "../ui/Button";
import Slider from "../ui/Slider";
import { findChargingStations } from "../../services/chargemap";

const StopModal = ({
  open,
  onClose,
  position,
  searchPosition,
  searchPositionSource,
  apiKey,
  onConfirm,
  currentSegmentIndex,
}) => {
  const [step, setStep] = useState(1);
  const [loading, setLoading] = useState(false);
  const [stations, setStations] = useState([]);
  const [selectedStationId, setSelectedStationId] = useState(null);
  const [targetSoc, setTargetSoc] = useState(80);
  const [error, setError] = useState("");

  const selectedStation = useMemo(
    () => stations.find((s) => s.id === selectedStationId) || null,
    [stations, selectedStationId]
  );

  const reset = () => {
    setStep(1);
    setLoading(false);
    setStations([]);
    setSelectedStationId(null);
    setTargetSoc(80);
    setError("");
  };

  const close = () => {
    reset();
    onClose();
  };

  const handleNeedCharge = async () => {
    const resolved = searchPosition || position;
    if (!resolved) {
      setError("Position GPS indisponible.");
      return;
    }
    setLoading(true);
    setError("");
    try {
      const results = await findChargingStations({
        lat: resolved.lat,
        lng: resolved.lng,
        distanceKm: 5,
        max: 10,
        apiKey,
      });
      setStations(results);
      if (results[0]) setSelectedStationId(results[0].id);
      setStep(2);
    } catch (err) {
      setError(err.message || "Erreur de recherche de bornes.");
    } finally {
      setLoading(false);
    }
  };

  const handleConfirm = async () => {
    await onConfirm({
      targetSoc,
      currentSegmentIndex,
      selectedStation,
    });
    close();
  };

  if (!open) return null;

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className="modal">
        <header className="modal__header">
          <h3>Arrêt imprévu</h3>
          <button type="button" className="ghost-close" onClick={close}>
            ✕
          </button>
        </header>

        {step === 1 ? (
          <div className="modal__content">
            <p>Souhaitez-vous rechercher une borne de recharge à proximité (5 km) ?</p>
            {searchPositionSource && searchPositionSource !== "gps" ? (
              <p className="field__hint">Position utilisée : {searchPositionSource}.</p>
            ) : null}
            {error ? <p className="field__error">{error}</p> : null}
            <div className="row-actions">
              <Button variant="secondary" onClick={close}>
                Non
              </Button>
              <Button onClick={handleNeedCharge} disabled={loading}>
                {loading ? "Recherche..." : "Oui, rechercher"}
              </Button>
            </div>
          </div>
        ) : (
          <div className="modal__content">
            <h4>Bornes proches</h4>
            {stations.length === 0 ? (
              <p className="field__hint">Aucune borne trouvée dans ce rayon.</p>
            ) : (
              <ul className="station-list">
                {stations.map((station) => (
                  <li key={station.id}>
                    <label className="station-item">
                      <input
                        type="radio"
                        name="station"
                        checked={selectedStationId === station.id}
                        onChange={() => setSelectedStationId(station.id)}
                      />
                      <div>
                        <strong>{station.name}</strong>
                        <p>{station.address}</p>
                        <small className="font-mono">
                          {station.powerKw ? `${station.powerKw} kW` : "Puissance NC"} · {station.connector}
                        </small>
                      </div>
                    </label>
                  </li>
                ))}
              </ul>
            )}

            <Slider
              label="Recharger jusqu’à"
              min={20}
              max={100}
              value={targetSoc}
              onChange={setTargetSoc}
              unit="%"
            />

            <div className="row-actions">
              <Button variant="secondary" onClick={close}>
                Annuler
              </Button>
              <Button onClick={handleConfirm}>Confirmer et recalculer</Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default StopModal;
