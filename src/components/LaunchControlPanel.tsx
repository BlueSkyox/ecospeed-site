"use client";

import { FormEvent, useMemo, useState } from "react";

type StationStop = {
  segmentIndex: number;
  batteryLevelAtCharge: number;
  chargingTimeMinutes: number;
  energyToCharge: number;
  station: {
    name: string;
    powerKw: number;
    status: string;
  };
};

type RouteApiResponse = {
  segments: Array<{ idx: number; eco_time_min: number }>;
  route_coordinates: Array<[number, number]>;
  routeChargingStations: StationStop[];
  total_distance_km: number;
  total_eco_energy: number;
  total_limit_energy: number;
  total_eco_time_min: number;
  total_limit_time_min: number;
  total_eco_cost_eur: number;
  total_limit_cost_eur: number;
  recharge_needed_eco_kwh: number;
  recharge_needed_limit_kwh: number;
  recharge_cost_eco_eur: number;
  recharge_cost_limit_eur: number;
  weather_avg_temp_c: number;
  weather_avg_rain_mmh: number;
  weather_profile_edges?: Array<{
    edge_index: number;
    distance_km: number;
    temp_c: number;
    rain_mmh: number;
    rain_crr_multiplier: number;
    hvac_kw: number;
    eco_speed_kmh: number;
    limit_speed_kmh: number;
    eco_energy_kwh: number;
    limit_energy_kwh: number;
  }>;
  co2_equivalents?: { message?: string };
};

export default function LaunchControlPanel() {
  const [start, setStart] = useState("Paris");
  const [end, setEnd] = useState("Nice");
  const [batteryStart, setBatteryStart] = useState(70);
  const [batteryEnd, setBatteryEnd] = useState(20);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [route, setRoute] = useState<RouteApiResponse | null>(null);
  const [tripId, setTripId] = useState("");
  const [stopSegment, setStopSegment] = useState(1);
  const [batteryBefore, setBatteryBefore] = useState(35);
  const [didRecharge, setDidRecharge] = useState(true);
  const [batteryAfter, setBatteryAfter] = useState(80);
  const [pauseMsg, setPauseMsg] = useState("");
  const [resumeMsg, setResumeMsg] = useState("");
  const [weatherRefresh, setWeatherRefresh] = useState<string>("");

  const totalTripCostEco = useMemo(() => {
    if (!route) return 0;
    return route.total_eco_cost_eur + route.recharge_cost_eco_eur;
  }, [route]);

  const totalTripCostLimit = useMemo(() => {
    if (!route) return 0;
    return route.total_limit_cost_eur + route.recharge_cost_limit_eur;
  }, [route]);

  const savingsEur = useMemo(() => totalTripCostLimit - totalTripCostEco, [totalTripCostEco, totalTripCostLimit]);

  const submitRoute = async (e: FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError("");
    setPauseMsg("");
    setResumeMsg("");
    setWeatherRefresh("");
    try {
      const payload = {
        start,
        end,
        battery_start_pct: batteryStart,
        battery_end_pct: batteryEnd,
        use_climate: true,
        climate_intensity: 50,
        comfort_temp_c: 20,
        vehicle_profile: { battery_kwh: 75, max_charge_kw: 170 },
      };
      let r: Response | null = null;
      let lastErr = "";
      for (let i = 0; i < 3; i += 1) {
        try {
          r = await fetch("/api/route", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });
          if (r.ok) break;
        } catch (err) {
          lastErr = err instanceof Error ? err.message : "fetch failed";
        }
      }
      if (!r) throw new Error(lastErr || "fetch failed");
      const data = (await r.json()) as RouteApiResponse & { detail?: string };
      if (!r.ok) throw new Error(data.detail || "Route API error");
      setRoute(data);
      setTripId(`trip-${Date.now()}`);
      setStopSegment(1);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erreur de calcul");
      setRoute(null);
    } finally {
      setLoading(false);
    }
  };

  const pauseTrip = async () => {
    if (!route || !tripId) return;
    const s = Math.max(1, Math.min(stopSegment, route.segments.length));
    const pointIdx = Math.max(0, Math.min(route.route_coordinates.length - 1, s));
    const remaining = route.route_coordinates.slice(pointIdx).map(([lat, lon]) => [lon, lat] as [number, number]);
    const r = await fetch("/api/trip/stop", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tripId,
        segmentIndex: s,
        batteryPctBefore: batteryBefore,
        didRecharge,
        batteryPctAfter: didRecharge ? batteryAfter : batteryBefore,
        notes: didRecharge ? "Recharge effectuee par l utilisateur." : "Arret sans recharge.",
        remainingCoords: remaining,
      }),
    });
    const data = await r.json();
    if (!r.ok) {
      setPauseMsg(`Pause impossible: ${data?.error || "erreur"}`);
      return;
    }
    setPauseMsg(`Trajet en pause au segment ${s}. Batterie apres arret: ${didRecharge ? batteryAfter : batteryBefore}%`);
  };

  const resumeTrip = async () => {
    if (!tripId) return;
    const r = await fetch("/api/trip/resume", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tripId, batteryPctAfter: batteryAfter }),
    });
    const data = await r.json();
    if (!r.ok) {
      setResumeMsg(`Reprise impossible: ${data?.error || "erreur"}`);
      return;
    }
    const samples = Array.isArray(data?.weatherRefresh?.samples) ? data.weatherRefresh.samples.length : 0;
    setResumeMsg("Trajet relance avec nouvelles conditions.");
    setWeatherRefresh(samples > 0 ? `${samples} echantillons meteo mis a jour.` : "Pas de meteo additionnelle disponible.");
  };

  return (
    <section className="launch-panel">
      <h2>Launch Control</h2>
      <form onSubmit={submitRoute} className="launch-form">
        <input value={start} onChange={(e) => setStart(e.target.value)} placeholder="Depart" />
        <input value={end} onChange={(e) => setEnd(e.target.value)} placeholder="Arrivee" />
        <input type="number" value={batteryStart} min={5} max={100} onChange={(e) => setBatteryStart(Number(e.target.value))} placeholder="% depart" />
        <input type="number" value={batteryEnd} min={5} max={80} onChange={(e) => setBatteryEnd(Number(e.target.value))} placeholder="% arrivee" />
        <button type="submit" disabled={loading}>{loading ? "Calcul..." : "Calculer trajet optimise"}</button>
      </form>

      {error ? <p className="lp-error">{error}</p> : null}

      {route ? (
        <div className="lp-grid">
          <div className="lp-card">
            <h3>Comparaison eco vs normal</h3>
            <p>Distance: {route.total_distance_km.toFixed(1)} km</p>
            <p>Energie eco: {route.total_eco_energy.toFixed(2)} kWh | normal: {route.total_limit_energy.toFixed(2)} kWh</p>
            <p>Temps eco: {route.total_eco_time_min.toFixed(1)} min | normal: {route.total_limit_time_min.toFixed(1)} min</p>
            <p>Cout roulage eco: {route.total_eco_cost_eur.toFixed(2)} EUR | normal: {route.total_limit_cost_eur.toFixed(2)} EUR</p>
            <p>Recharge eco: {route.recharge_needed_eco_kwh.toFixed(2)} kWh ({route.recharge_cost_eco_eur.toFixed(2)} EUR)</p>
            <p>Recharge normale: {route.recharge_needed_limit_kwh.toFixed(2)} kWh ({route.recharge_cost_limit_eur.toFixed(2)} EUR)</p>
            <p className="lp-strong">Cout total eco: {totalTripCostEco.toFixed(2)} EUR | Cout total normal: {totalTripCostLimit.toFixed(2)} EUR</p>
            <p className="lp-strong">Gain total estime: {savingsEur.toFixed(2)} EUR</p>
            <div className="lp-inline lp-topline">
              <input type="number" value={stopSegment} min={1} max={route.segments.length} onChange={(e) => setStopSegment(Number(e.target.value))} placeholder="Segment arret" />
              <input type="number" value={batteryBefore} min={1} max={100} onChange={(e) => setBatteryBefore(Number(e.target.value))} placeholder="% avant" />
              <label className="lp-check"><input type="checkbox" checked={didRecharge} onChange={(e) => setDidRecharge(e.target.checked)} /> Recharge</label>
              <input type="number" value={batteryAfter} min={1} max={100} onChange={(e) => setBatteryAfter(Number(e.target.value))} placeholder="% apres" />
              <button type="button" onClick={pauseTrip}>Stop trajet</button>
              <button type="button" onClick={resumeTrip}>Reprendre</button>
            </div>
            {pauseMsg ? <p>{pauseMsg}</p> : null}
            {resumeMsg ? <p>{resumeMsg}</p> : null}
            {weatherRefresh ? <p>{weatherRefresh}</p> : null}
          </div>

          <div className="lp-card">
            <h3>Arrets recharge optimises</h3>
            {route.routeChargingStations.length === 0 ? <p>Aucun arret requis.</p> : null}
            {route.routeChargingStations.map((s, idx) => (
              <p key={`${s.segmentIndex}-${s.station.name}`}>
                {idx + 1}. {s.station.name} (seg {s.segmentIndex}) - {s.station.powerKw} kW - recharge {s.energyToCharge.toFixed(1)} kWh ({s.chargingTimeMinutes.toFixed(0)} min)
              </p>
            ))}
          </div>

          <div className="lp-card">
            <h3>Meteo et physique par point</h3>
            <p>Calcul reel fait point par point avec temperature, pluie, densite pluie-roulement et HVAC.</p>
            <p>CO2 equivalent: {route.co2_equivalents?.message || "N/A"}</p>
            {(route.weather_profile_edges ?? []).slice(0, 8).map((w) => (
              <p key={w.edge_index}>
                pt {w.edge_index}: {w.temp_c.toFixed(1)} C, pluie {w.rain_mmh.toFixed(2)} mm/h, coeff pluie {w.rain_crr_multiplier.toFixed(2)}, HVAC {w.hvac_kw.toFixed(2)} kW, E eco {w.eco_energy_kwh.toFixed(3)} kWh, E normal {w.limit_energy_kwh.toFixed(3)} kWh
              </p>
            ))}
            {(route.weather_profile_edges?.length ?? 0) > 8 ? <p>... {route.weather_profile_edges!.length - 8} points supplementaires.</p> : null}
          </div>
        </div>
      ) : null}
    </section>
  );
}
