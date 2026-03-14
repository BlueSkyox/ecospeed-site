"use client";

import { useEffect, useEffectEvent, useMemo, useState } from "react";
import type { ChargingStation } from "@/lib/charging-context";

type NearbyStationsPanelProps = {
  routeStations?: ChargingStation[];
  locale: "fr" | "en";
};

function formatDistance(distanceKm?: number) {
  if (!Number.isFinite(Number(distanceKm ?? Number.NaN))) return null;
  return `${Number(distanceKm).toFixed(1)} km`;
}

export default function NearbyStationsPanel({ routeStations = [], locale }: NearbyStationsPanelProps) {
  const [radiusKm, setRadiusKm] = useState(10);
  const [minPowerKw, setMinPowerKw] = useState(100);
  const [operatorFilter, setOperatorFilter] = useState("all");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [stations, setStations] = useState<ChargingStation[]>(routeStations);
  const [coords, setCoords] = useState<{ lat: number; lon: number } | null>(null);

  useEffect(() => {
    if (routeStations.length > 0) setStations(routeStations);
  }, [routeStations]);

  useEffect(() => {
    if (!coords) return;
    void fetchNearby(coords);
  }, [coords, radiusKm]);

  const operators = useMemo(() => {
    const out = new Set<string>();
    for (const station of stations) {
      if (station.operator) out.add(station.operator);
    }
    return ["all", ...Array.from(out).sort((a, b) => a.localeCompare(b))];
  }, [stations]);

  const visibleStations = useMemo(() => {
    return stations
      .filter((station) => Number(station.powerKw ?? 0) >= minPowerKw)
      .filter((station) => operatorFilter === "all" || station.operator === operatorFilter)
      .slice(0, 8);
  }, [minPowerKw, operatorFilter, stations]);

  const fetchNearby = useEffectEvent(async (nextCoords: { lat: number; lon: number }) => {
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams({
        lat: nextCoords.lat.toFixed(6),
        lon: nextCoords.lon.toFixed(6),
        radius_km: String(radiusKm),
        refresh: "1",
      });
      const response = await fetch(`/api/charging-stations?${params.toString()}`, { cache: "no-store" });
      const data = (await response.json()) as ChargingStation[] | { error?: string };
      if (!response.ok || !Array.isArray(data)) {
        throw new Error(!Array.isArray(data) && data.error ? data.error : locale === "fr" ? "Bornes indisponibles" : "Chargers unavailable");
      }
      setStations(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : locale === "fr" ? "Impossible de charger les bornes" : "Unable to load chargers");
    } finally {
      setLoading(false);
    }
  });

  const geolocate = () => {
    if (!("geolocation" in navigator)) {
      setError(locale === "fr" ? "La geolocalisation n est pas disponible sur ce navigateur." : "Geolocation is not available in this browser.");
      return;
    }
    setLoading(true);
    setError("");
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const nextCoords = {
          lat: position.coords.latitude,
          lon: position.coords.longitude,
        };
        setCoords(nextCoords);
      },
      () => {
        setLoading(false);
        setError(locale === "fr" ? "Autorisation de position refusee ou indisponible." : "Location permission denied or unavailable.");
      },
      {
        enableHighAccuracy: false,
        maximumAge: 10 * 60 * 1000,
        timeout: 6000,
      },
    );
  };

  return (
    <section className="ecospeed-nearby">
      <div className="ecospeed-nearby__header">
        <div>
          <span className="ecospeed-section-label">{locale === "fr" ? "Bornes a proximite" : "Nearby chargers"}</span>
          <h3>{locale === "fr" ? `Consulter les bornes dans un rayon de ${radiusKm} km` : `Browse chargers within a ${radiusKm} km radius`}</h3>
          <p>
            {locale === "fr"
              ? "Le panneau combine les bornes du trajet courant avec une recherche autour de votre position, en agregeant OpenChargeMap et OpenStreetMap."
              : "This panel combines chargers from the current trip with a location-based search aggregated from OpenChargeMap and OpenStreetMap."}
          </p>
        </div>
        <div className="ecospeed-nearby__actions">
          <button type="button" className="ecospeed-button--ghost" onClick={geolocate} disabled={loading}>
            {loading ? (locale === "fr" ? "Recherche..." : "Searching...") : locale === "fr" ? "Ma position" : "My location"}
          </button>
        </div>
      </div>

      <div className="ecospeed-inline-grid" style={{ marginTop: 18 }}>
        <div className="ecospeed-inline-field">
          <label htmlFor="nearby-radius">{locale === "fr" ? "Rayon de recherche" : "Search radius"}</label>
          <input
            id="nearby-radius"
            className="ecospeed-range"
            type="range"
            min={1}
            max={80}
            value={radiusKm}
            onChange={(event) => setRadiusKm(Number(event.target.value))}
          />
          <span>{radiusKm} km</span>
        </div>

        <div className="ecospeed-inline-field">
          <label htmlFor="nearby-operator">{locale === "fr" ? "Operateur" : "Operator"}</label>
          <select id="nearby-operator" value={operatorFilter} onChange={(event) => setOperatorFilter(event.target.value)}>
            {operators.map((operator) => (
              <option key={operator} value={operator}>
                {operator === "all" ? (locale === "fr" ? "Tous les operateurs" : "All operators") : operator}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="ecospeed-filter-row" style={{ marginTop: 14 }}>
        {[50, 100, 150, 250].map((power) => (
          <button
            key={power}
            type="button"
            className={`ecospeed-pill-button ${minPowerKw === power ? "is-active" : ""}`}
            onClick={() => setMinPowerKw(power)}
          >
            {power}+ kW
          </button>
        ))}
      </div>

      {coords ? (
        <p className="ecospeed-footnote">
          {locale === "fr" ? "Position utilisee" : "Location used"}: {coords.lat.toFixed(3)}, {coords.lon.toFixed(3)}
        </p>
      ) : null}

      {error ? <div className="ecospeed-feedback ecospeed-feedback--error">{error}</div> : null}

      {visibleStations.length === 0 ? (
        <div className="ecospeed-empty-state">{locale === "fr" ? "Aucune borne ne correspond aux filtres actuels." : "No charger matches the current filters."}</div>
      ) : (
        <div className="ecospeed-nearby__list">
          {visibleStations.map((station) => (
            <article key={`${station.name}-${station.latitude}-${station.longitude}`} className="ecospeed-nearby__item">
              <div className="ecospeed-stop__title">
                <strong>{station.name}</strong>
                <span className="ecospeed-chip">{station.status}</span>
              </div>
              <div className="ecospeed-nearby__meta">
                <span className="ecospeed-chip">{station.powerKw} kW</span>
                {station.operator ? <span className="ecospeed-chip">{station.operator}</span> : null}
                {station.price ? <span className="ecospeed-chip">{station.price}</span> : null}
                {formatDistance(station.distanceKm) ? <span className="ecospeed-chip">{formatDistance(station.distanceKm)}</span> : null}
              </div>
              {station.address ? <p className="ecospeed-footnote">{station.address}</p> : null}
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
