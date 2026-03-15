"use client";

import { FormEvent, useState } from "react";

type TestHistoryItem = {
  id: string;
  dateIso: string;
  start: string;
  end: string;
  distanceKm: number;
  ecoAllInEur: number;
  limitAllInEur: number;
  savingsEur: number;
  weatherImpactEcoKwh: number;
  avgTempC: number;
  avgRainMmH: number;
};

type RouteApiResponse = {
  total_distance_km: number;
  total_eco_energy: number;
  total_limit_energy: number;
  total_eco_time_min: number;
  total_limit_time_min: number;
  total_eco_trip_cost_all_in_eur: number;
  total_limit_trip_cost_all_in_eur: number;
  toll_cost_eur: number;
  weather_avg_temp_c: number;
  weather_avg_rain_mmh: number;
  weather_avg_wind_kmh?: number;
  weather_avg_headwind_ms?: number;
  elevation_gain_m?: number;
  elevation_loss_m?: number;
  max_grade_pct?: number;
  weather_impact_eco_kwh: number;
  weather_impact_eco_eur: number;
  optimized_stop_count_eco: number;
  etat_initial?: unknown;
  feuille_de_route?: unknown;
  tableau_comparatif?: unknown;
  historique?: unknown;
};

const HISTORY_KEY = "ecospeed_test_history_v1";

function loadHistory(): TestHistoryItem[] {
  try {
    const raw = window.localStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveHistory(items: TestHistoryItem[]) {
  window.localStorage.setItem(HISTORY_KEY, JSON.stringify(items.slice(0, 100)));
}

function validateInputs(start: string, end: string, batteryStart: number, batteryEnd: number): string | null {
  if (!start.trim() || !end.trim()) return "Merci de renseigner un depart et une arrivee.";
  if (start.trim().toLowerCase() === end.trim().toLowerCase()) return "Le point de depart et d'arrivee doivent etre differents.";
  if (!Number.isFinite(batteryStart) || !Number.isFinite(batteryEnd)) return "Les niveaux de batterie doivent etre valides.";
  if (batteryStart < 5 || batteryStart > 100) return "Batterie depart: valeur attendue entre 5 et 100%.";
  if (batteryEnd < 0 || batteryEnd > 90) return "Batterie arrivee: valeur attendue entre 0 et 90%.";
  if (batteryStart <= batteryEnd) return "La batterie de depart doit etre superieure a la batterie d'arrivee.";
  return null;
}

export default function TestDriveTab() {
  const [open, setOpen] = useState(false);
  const [start, setStart] = useState("Paris");
  const [end, setEnd] = useState("Lyon");
  const [batteryStart, setBatteryStart] = useState(80);
  const [batteryEnd, setBatteryEnd] = useState(20);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<RouteApiResponse | null>(null);
  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    const validationError = validateInputs(start, end, batteryStart, batteryEnd);
    if (validationError) {
      setError(validationError);
      setResult(null);
      return;
    }

    setLoading(true);
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), 25000);
    try {
      const payload = {
        start,
        end,
        user_max_speed: 130,
        battery_start_pct: batteryStart,
        battery_end_pct: batteryEnd,
        use_climate: true,
        hvac_mode: "comfort",
        comfort_temp_c: 21,
        vehicle_profile: {
          battery_kwh: 75,
          max_charge_kw: 170,
        },
      };
      const r = await fetch("/api/route", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      const data = (await r.json()) as RouteApiResponse & { detail?: string };
      if (!r.ok) throw new Error(data.detail || "Erreur de calcul");
      setResult(data);

      const distanceKm = Number(data.total_distance_km ?? 0);
      if (distanceKm > 0) {
        const item: TestHistoryItem = {
          id: `test-${Date.now()}`,
          dateIso: new Date().toISOString(),
          start,
          end,
          distanceKm,
          ecoAllInEur: Number(data.total_eco_trip_cost_all_in_eur ?? 0),
          limitAllInEur: Number(data.total_limit_trip_cost_all_in_eur ?? 0),
          savingsEur: Number(data.total_limit_trip_cost_all_in_eur ?? 0) - Number(data.total_eco_trip_cost_all_in_eur ?? 0),
          weatherImpactEcoKwh: Number(data.weather_impact_eco_kwh ?? 0),
          avgTempC: Number(data.weather_avg_temp_c ?? 20),
          avgRainMmH: Number(data.weather_avg_rain_mmh ?? 0),
        };
        const next = [item, ...loadHistory()];
        saveHistory(next);
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        setError("Le calcul prend trop de temps. Verifie ta connexion puis relance le test.");
      } else {
        setError(err instanceof Error ? err.message : "Erreur");
      }
      setResult(null);
    } finally {
      window.clearTimeout(timeoutId);
      setLoading(false);
    }
  };

  return (
    <aside className="test-tab">
      <button className="test-tab-toggle" onClick={() => setOpen((v) => !v)} type="button">
        Test
      </button>
      {open ? (
        <div className="test-tab-panel">
          <h3>Test trajet (simulation)</h3>
          <p>Mode simulation uniquement. Ces essais ne comptent pas dans Nouveau trajet.</p>

          <form onSubmit={onSubmit} className="test-tab-form">
            <input value={start} onChange={(e) => setStart(e.target.value)} placeholder="Depart" />
            <input value={end} onChange={(e) => setEnd(e.target.value)} placeholder="Arrivee" />
            <input type="number" min={5} max={100} value={batteryStart} onChange={(e) => setBatteryStart(Number(e.target.value))} placeholder="% depart" />
            <input type="number" min={10} max={80} value={batteryEnd} onChange={(e) => setBatteryEnd(Number(e.target.value))} placeholder="% arrivee" />
            <button type="submit" disabled={loading}>{loading ? "Calcul..." : "Lancer test"}</button>
          </form>

          {error ? <p className="test-tab-error">{error}</p> : null}
          {result ? (
            <div className="test-tab-result">
              <p>Distance: {result.total_distance_km.toFixed(1)} km | Stops: {result.optimized_stop_count_eco}</p>
              <p>Cout eco (energie + recharge + peage): {result.total_eco_trip_cost_all_in_eur.toFixed(2)} EUR</p>
              <p>Cout normal speed limit (energie + recharge + peage): {result.total_limit_trip_cost_all_in_eur.toFixed(2)} EUR</p>
              <p>Peages: {result.toll_cost_eur.toFixed(2)} EUR</p>
              <p>Economies simulees: {(result.total_limit_trip_cost_all_in_eur - result.total_eco_trip_cost_all_in_eur).toFixed(2)} EUR</p>

              <div className="test-weather-box">
                <strong>Meteo et impact</strong>
                <p>Temp moyenne: {result.weather_avg_temp_c.toFixed(1)} C | Pluie moyenne: {result.weather_avg_rain_mmh.toFixed(2)} mm/h</p>
                <p>Vent moyen: {Number(result.weather_avg_wind_kmh ?? 0).toFixed(1)} km/h | Vent frontal moyen: {Number(result.weather_avg_headwind_ms ?? 0).toFixed(2)} m/s</p>
                <p>Denivele: +{Number(result.elevation_gain_m ?? 0).toFixed(0)} m / -{Number(result.elevation_loss_m ?? 0).toFixed(0)} m | Pente max: {Number(result.max_grade_pct ?? 0).toFixed(1)}%</p>
                <p>Impact meteo sur conso eco: +{result.weather_impact_eco_kwh.toFixed(2)} kWh (+{result.weather_impact_eco_eur.toFixed(2)} EUR)</p>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </aside>
  );
}
