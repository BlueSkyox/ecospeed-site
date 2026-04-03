import { useEffect, useMemo, useState } from "react";
import RouteForm from "../components/planning/RouteForm";
import VehicleForm from "../components/planning/VehicleForm";
import ModeSelector from "../components/planning/ModeSelector";
import Slider from "../components/ui/Slider";
import Card from "../components/ui/Card";
import Button from "../components/ui/Button";
import CompareTable from "../components/results/CompareTable";
import SummaryCard from "../components/results/SummaryCard";
import ChargingPlanCard from "../components/results/ChargingPlanCard";
import WeatherEnergyCard from "../components/results/WeatherEnergyCard";
import AdvancedAnalysisCard from "../components/results/AdvancedAnalysisCard";
import MapView from "../components/navigation/MapView";
import { useORS } from "../hooks/useORS";
import { segmentRouteGeometry, computeAllModes, buildCompareRows } from "../utils/planner";
import { hydrateSegmentsWeather } from "../services/weather";
import { calculateHvacPower } from "../utils/physics";
import { reverseGeocode } from "../services/ors";
import { DEFAULT_EV_ID, EV_CATALOG, getEvById } from "../data/evCatalog";
import {
  buildSmartChargePlan,
  computeWeatherEnergyStats,
  mergeSummaryWithChargePlan,
  recomputeChargePlanProjection,
} from "../utils/tripEnhancer";

const STATUS_STEPS = [
  "Calcul route",
  "Récupération météo",
  "Segmentation",
  "Calcul énergétique",
  "Plan de charge",
];

const DEFAULT_EV = getEvById(DEFAULT_EV_ID);

const PlanifierPage = ({
  apiKeys,
  preferences,
  onPreferencesChange,
  onTripComputed,
  onStartNavigation,
  onSaveHistory,
  tripData,
}) => {
  const [vehicle, setVehicle] = useState({
    modelId: DEFAULT_EV.id,
    batteryKwh: DEFAULT_EV.batteryKwh,
    socPct: 78,
    baseWhKm: DEFAULT_EV.baseWhKm,
    massKg: DEFAULT_EV.massKg,
    cx: DEFAULT_EV.cx,
    areaM2: DEFAULT_EV.areaM2,
  });

  const [originQuery, setOriginQuery] = useState("");
  const [destinationQuery, setDestinationQuery] = useState("");
  const [origin, setOrigin] = useState(null);
  const [destination, setDestination] = useState(null);
  const [originSuggestions, setOriginSuggestions] = useState([]);
  const [destinationSuggestions, setDestinationSuggestions] = useState([]);

  const [cabinTemp, setCabinTemp] = useState(preferences.cabinTemp ?? 21);
  const [arrivalSocTarget, setArrivalSocTarget] = useState(preferences.arrivalSocTarget ?? 20);
  const [selectedMode, setSelectedMode] = useState(preferences.lastMode ?? "equilibre");
  const [displayMode, setDisplayMode] = useState(preferences.defaultDisplayMode ?? "simple");
  const [statusText, setStatusText] = useState("");
  const [globalError, setGlobalError] = useState("");
  const [locatingOrigin, setLocatingOrigin] = useState(false);
  const [originGeoError, setOriginGeoError] = useState("");

  const { searchPlaces, fetchRoute, loading, error } = useORS(apiKeys.orsKey);

  useEffect(() => {
    setDisplayMode(preferences.defaultDisplayMode ?? "simple");
  }, [preferences.defaultDisplayMode]);

  useEffect(() => {
    const timer = setTimeout(async () => {
      if (!originQuery || originQuery.length < 3) {
        setOriginSuggestions([]);
        return;
      }
      const results = await searchPlaces(originQuery);
      setOriginSuggestions(results);
    }, 350);
    return () => clearTimeout(timer);
  }, [originQuery, searchPlaces]);

  useEffect(() => {
    const timer = setTimeout(async () => {
      if (!destinationQuery || destinationQuery.length < 3) {
        setDestinationSuggestions([]);
        return;
      }
      const results = await searchPlaces(destinationQuery);
      setDestinationSuggestions(results);
    }, 350);
    return () => clearTimeout(timer);
  }, [destinationQuery, searchPlaces]);

  const computeEtaFromSummary = ({ durationSec = 0, chargeTimeMin = 0, chargingStops = 0 }) => {
    const totalSec =
      Number(durationSec || 0) + Number(chargeTimeMin || 0) * 60 + Number(chargingStops || 0) * 10 * 60;
    const eta = new Date(Date.now() + Math.max(0, totalSec) * 1000);
    return eta.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  };

  const avgExternalTemp = useMemo(() => {
    const segments = tripData?.selectedSegments || [];
    if (!segments.length) return 15;
    return segments.reduce((acc, s) => acc + (s.tExt || 0), 0) / segments.length;
  }, [tripData]);

  const hvacPreview = useMemo(() => calculateHvacPower(cabinTemp, avgExternalTemp), [cabinTemp, avgExternalTemp]);

  const persistPreferences = (next = {}) => {
    onPreferencesChange({
      ...preferences,
      lastMode: next.modeValue ?? selectedMode,
      cabinTemp: next.tempValue ?? cabinTemp,
      arrivalSocTarget: next.arrivalSocTarget ?? arrivalSocTarget,
      defaultDisplayMode: next.displayMode ?? displayMode,
    });
  };

  const withSummaryAddons = (summary, baseModes) => {
    if (!summary) return summary;
    const refEnergyKwh = ((baseModes?.rapide?.summary?.totalEnergyWh || summary.totalEnergyWh || 0) / 1000);
    return {
      ...summary,
      referenceEnergyKwh: refEnergyKwh,
      etaTime: computeEtaFromSummary(summary),
    };
  };

  const projectTripWithStops = ({ trip, modeKey, stops }) => {
    const modeBase = trip.baseModeResults?.[modeKey] || trip.modeResults?.[modeKey];
    if (!modeBase) return trip;

    const projection = recomputeChargePlanProjection({
      segments: modeBase.segments,
      batteryKwh: trip.vehicle.batteryKwh,
      initialSocPct: trip.vehicle.socPct,
      arrivalSocTarget: trip.arrivalSocTarget ?? arrivalSocTarget,
      stops,
    });

    const updatedSummary = withSummaryAddons(
      mergeSummaryWithChargePlan(modeBase.summary, projection),
      trip.baseModeResults || trip.modeResults
    );

    const weatherEnergyStats = computeWeatherEnergyStats({
      segments: projection.segments,
      vehicle: trip.vehicle,
      cabinTemp: trip.cabinTemp,
      routeCoords: trip.routeCoords,
    });

    const updatedModeResults = {
      ...trip.modeResults,
      [modeKey]: {
        ...modeBase,
        segments: projection.segments,
        summary: updatedSummary,
      },
    };

    return {
      ...trip,
      selectedMode: modeKey,
      selectedSummary: updatedSummary,
      selectedSegments: projection.segments,
      modeResults: updatedModeResults,
      compareRows: buildCompareRows(updatedModeResults, preferences.defaultKwhPrice || 0.45),
      chargePlanStops: projection.stops,
      weatherEnergyStats,
    };
  };

  const updateTripSelectedModeAsync = async (modeKey) => {
    setSelectedMode(modeKey);
    persistPreferences({ modeValue: modeKey });

    if (!tripData?.modeResults) return;

    setGlobalError("");
    setStatusText(STATUS_STEPS[4]);
    try {
      const modeBase = tripData.baseModeResults?.[modeKey] || tripData.modeResults?.[modeKey];
      if (!modeBase) return;

      const previousStops = tripData.selectedMode === modeKey ? tripData.chargePlanStops || [] : [];
      const smartPlan = await buildSmartChargePlan({
        segments: modeBase.segments,
        routeCoords: tripData.routeCoords,
        batteryKwh: tripData.vehicle.batteryKwh,
        initialSocPct: tripData.vehicle.socPct,
        arrivalSocTarget: tripData.arrivalSocTarget ?? arrivalSocTarget,
        apiKey: apiKeys.ocmKey,
        previousStops,
        pricePerKwh: preferences.defaultKwhPrice || 0.45,
      });

      const updatedSummary = withSummaryAddons(
        mergeSummaryWithChargePlan(modeBase.summary, smartPlan.projection),
        tripData.baseModeResults || tripData.modeResults
      );

      const weatherEnergyStats = computeWeatherEnergyStats({
        segments: smartPlan.projection.segments,
        vehicle: tripData.vehicle,
        cabinTemp: tripData.cabinTemp,
        routeCoords: tripData.routeCoords,
      });

      const updatedModeResults = {
        ...tripData.modeResults,
        [modeKey]: {
          ...modeBase,
          segments: smartPlan.projection.segments,
          summary: updatedSummary,
        },
      };

      onTripComputed({
        ...tripData,
        selectedMode: modeKey,
        selectedSummary: updatedSummary,
        selectedSegments: smartPlan.projection.segments,
        modeResults: updatedModeResults,
        compareRows: buildCompareRows(updatedModeResults, preferences.defaultKwhPrice || 0.45),
        chargePlanStops: smartPlan.projection.stops,
        corridorStations: smartPlan.corridorStations,
        weatherEnergyStats,
      });
    } catch (err) {
      setGlobalError(err.message || "Impossible de recalculer le plan de charge.");
    } finally {
      setStatusText("");
    }
  };

  const resolvePlaceFromInput = async (selectedPlace, query, cachedSuggestions = []) => {
    if (selectedPlace?.coords) return selectedPlace;
    if (!query?.trim()) return null;

    const normalizedQuery = query.trim().toLowerCase();
    const fromCache = cachedSuggestions.find((item) => item?.label?.toLowerCase().includes(normalizedQuery));
    if (fromCache?.coords) return fromCache;

    const fetched = await searchPlaces(query.trim());
    return fetched[0] || null;
  };

  const computeTrip = async () => {
    setGlobalError("");

    try {
      const resolvedOrigin = await resolvePlaceFromInput(origin, originQuery, originSuggestions);
      const resolvedDestination = await resolvePlaceFromInput(destination, destinationQuery, destinationSuggestions);

      if (!resolvedOrigin || !resolvedDestination) {
        setGlobalError("Renseignez un départ et une arrivée valides.");
        return;
      }

      setOrigin(resolvedOrigin);
      setDestination(resolvedDestination);
      setOriginQuery(resolvedOrigin.label);
      setDestinationQuery(resolvedDestination.label);
      setOriginSuggestions([]);
      setDestinationSuggestions([]);

      setStatusText(STATUS_STEPS[0]);
      const route = await fetchRoute(resolvedOrigin.coords, resolvedDestination.coords);

      setStatusText(STATUS_STEPS[2]);
      const segmented = segmentRouteGeometry(route.coords, route.routeMeta || {});

      setStatusText(STATUS_STEPS[1]);
      const weatherSegments = await hydrateSegmentsWeather(segmented);

      setStatusText(STATUS_STEPS[3]);
      const baseModeResults = computeAllModes({
        segments: weatherSegments,
        vehicle,
        cabinTemp,
        initialSocPct: vehicle.socPct,
      });

      setStatusText(STATUS_STEPS[4]);
      const smartPlan = await buildSmartChargePlan({
        segments: baseModeResults[selectedMode].segments,
        routeCoords: route.coords,
        batteryKwh: vehicle.batteryKwh,
        initialSocPct: vehicle.socPct,
        arrivalSocTarget,
        apiKey: apiKeys.ocmKey,
        pricePerKwh: preferences.defaultKwhPrice || 0.45,
      });

      const selectedSummary = withSummaryAddons(
        mergeSummaryWithChargePlan(baseModeResults[selectedMode].summary, smartPlan.projection),
        baseModeResults
      );

      const modeResults = {
        ...baseModeResults,
        [selectedMode]: {
          ...baseModeResults[selectedMode],
          segments: smartPlan.projection.segments,
          summary: selectedSummary,
        },
      };

      const compareRows = buildCompareRows(modeResults, preferences.defaultKwhPrice || 0.45);
      const weatherEnergyStats = computeWeatherEnergyStats({
        segments: smartPlan.projection.segments,
        vehicle,
        cabinTemp,
        routeCoords: route.coords,
      });

      const nextTrip = {
        createdAt: new Date().toISOString(),
        origin: resolvedOrigin,
        destination: resolvedDestination,
        routeCoords: route.coords,
        routeSummary: {
          distanceM: route.distanceM,
          durationSec: route.durationSec,
        },
        routeMeta: route.routeMeta || {},
        rawSegments: weatherSegments,
        baseModeResults,
        modeResults,
        compareRows,
        selectedMode,
        selectedSummary,
        selectedSegments: smartPlan.projection.segments,
        chargePlanStops: smartPlan.projection.stops,
        corridorStations: smartPlan.corridorStations,
        weatherEnergyStats,
        arrivalSocTarget,
        vehicle,
        vehicleModel: getEvById(vehicle.modelId),
        cabinTemp,
      };

      onTripComputed(nextTrip);
      persistPreferences({ modeValue: selectedMode });
    } catch (err) {
      setGlobalError(err.message || "Erreur lors du calcul de trajet.");
    } finally {
      setStatusText("");
    }
  };

  const handleUseCurrentLocation = async () => {
    if (!navigator.geolocation) {
      setOriginGeoError("Géolocalisation non supportée. Saisissez votre adresse manuellement.");
      return;
    }

    setLocatingOrigin(true);
    setOriginGeoError("");

    try {
      const geo = await new Promise((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(resolve, reject, {
          enableHighAccuracy: true,
          timeout: 10000,
          maximumAge: 3000,
        });
      });

      const place = await reverseGeocode({
        lat: geo.coords.latitude,
        lng: geo.coords.longitude,
        language: preferences.locale || "fr",
      });

      setOrigin(place);
      setOriginQuery(place.label);
      setOriginSuggestions([]);
    } catch {
      setOriginGeoError("Géolocalisation non autorisée. Saisissez votre adresse manuellement.");
    } finally {
      setLocatingOrigin(false);
    }
  };

  const showResults = Boolean(tripData?.compareRows?.length);

  const updateChargePlanStops = (updater, { blockIfInfeasible = false } = {}) => {
    if (!tripData) return;
    const currentStops = tripData.chargePlanStops || [];
    const nextStops = updater(currentStops);

    if (blockIfInfeasible) {
      const modeBase = tripData.baseModeResults?.[tripData.selectedMode] || tripData.modeResults?.[tripData.selectedMode];
      const projection = recomputeChargePlanProjection({
        segments: modeBase?.segments || [],
        batteryKwh: tripData.vehicle.batteryKwh,
        initialSocPct: tripData.vehicle.socPct,
        arrivalSocTarget: tripData.arrivalSocTarget ?? arrivalSocTarget,
        stops: nextStops,
      });
      const hardWarning = projection.stops.find((stop) => stop.chainWarning) || null;
      if (hardWarning) {
        setGlobalError(`Impossible : la batterie serait insuffisante pour atteindre l'étape suivante (segment ${hardWarning.segmentNumber}).`);
        return;
      }
    }

    const updatedTrip = projectTripWithStops({
      trip: tripData,
      modeKey: tripData.selectedMode,
      stops: nextStops,
    });
    setGlobalError("");
    onTripComputed(updatedTrip);
  };

  const handleToggleStopSelected = (stopId, selected) => {
    updateChargePlanStops(
      (stops) =>
        stops.map((stop) =>
          stop.id === stopId
            ? {
                ...stop,
                selected: stop.mandatory ? true : selected,
                enabled: stop.mandatory ? true : selected,
              }
            : stop
        ),
      { blockIfInfeasible: !selected }
    );
  };

  const handleToggleStopCharge = (stopId, chargeEnabled) => {
    updateChargePlanStops(
      (stops) =>
        stops.map((stop) =>
          stop.id === stopId
            ? {
                ...stop,
                chargeEnabled: stop.mandatory ? true : chargeEnabled,
              }
            : stop
        ),
      { blockIfInfeasible: !chargeEnabled }
    );
  };

  const handleTargetSocChange = (stopId, targetSoc) => {
    updateChargePlanStops((stops) =>
      stops.map((stop) => (stop.id === stopId ? { ...stop, targetSoc: Number(targetSoc) } : stop))
    );
  };

  const handleSelectStation = (stopId, stationId) => {
    updateChargePlanStops((stops) =>
      stops.map((stop) => {
        if (stop.id !== stopId) return stop;
        const station = (stop.stationCandidates || []).find((candidate) => candidate.id === stationId) || null;
        return {
          ...stop,
          station,
          detourKm: station?.distanceKm ?? stop.detourKm ?? null,
        };
      })
    );
  };

  return (
    <div className="stack-xl">
      <section>
        <p className="section-kicker">Planificateur</p>
        <h1 className="section-title">Optimisation de trajet VE</h1>
      </section>

      <RouteForm
        originQuery={originQuery}
        destinationQuery={destinationQuery}
        onOriginChange={(value) => {
          setOriginQuery(value);
          setOrigin(null);
        }}
        onDestinationChange={(value) => {
          setDestinationQuery(value);
          setDestination(null);
        }}
        originSuggestions={originSuggestions}
        destinationSuggestions={destinationSuggestions}
        onSelectOrigin={(item) => {
          setOrigin(item);
          setOriginQuery(item.label);
          setOriginSuggestions([]);
        }}
        onSelectDestination={(item) => {
          setDestination(item);
          setDestinationQuery(item.label);
          setDestinationSuggestions([]);
        }}
        onUseCurrentLocation={handleUseCurrentLocation}
        locatingOrigin={locatingOrigin}
        originGeoError={originGeoError}
      />

      <Card title="Stratégie batterie" subtitle="SOC de départ et réserve cible à l'arrivée.">
        <div className="battery-strategy-grid">
          <Slider
            label="Batterie au départ"
            min={20}
            max={100}
            value={Math.round(vehicle.socPct)}
            unit="%"
            onChange={(value) => setVehicle((prev) => ({ ...prev, socPct: Number(value) }))}
          />

          <Slider
            label="Batterie souhaitée à l'arrivée"
            min={10}
            max={40}
            value={Math.round(arrivalSocTarget)}
            unit="%"
            onChange={(value) => {
              setArrivalSocTarget(Number(value));
              persistPreferences({ arrivalSocTarget: Number(value) });
            }}
          />
        </div>
      </Card>

      <VehicleForm vehicle={vehicle} models={EV_CATALOG} onChange={setVehicle} />

      <Card title="Température de confort cabine" subtitle="Impact HVAC inclus dans le modèle énergétique.">
        <div className="temp-card">
          <div className="temp-main font-mono">{cabinTemp}°C</div>
          <Slider
            label="Température souhaitée"
            min={16}
            max={26}
            value={cabinTemp}
            unit="°C"
            onChange={(value) => {
              setCabinTemp(value);
              persistPreferences({ tempValue: value });
            }}
            hint="Le système HVAC adapte la consommation selon l’écart intérieur / extérieur."
          />
          <div className="hvac-box">
            <span>Puissance HVAC estimée</span>
            <strong className="font-mono">{Math.round(hvacPreview)} W</strong>
          </div>
        </div>
      </Card>

      <ModeSelector selectedMode={selectedMode} onSelect={updateTripSelectedModeAsync} />

      {(loading || statusText) && (
        <Card title="Statut du calcul">
          <div className="status-row">
            <span className="spinner" />
            <div>
              <p className="font-mono">{statusText || "Préparation"}</p>
              <small className="field__hint">{STATUS_STEPS.join(" · ")}</small>
            </div>
          </div>
        </Card>
      )}

      {(error || globalError) && <p className="alert-error">{globalError || error}</p>}

      <Button className="btn--full" onClick={computeTrip} disabled={loading}>
        Calculer le trajet →
      </Button>

      {showResults && (
        <div className="stack-lg">
          <div className="mode-switch-inline">
            <button
              type="button"
              className={`mode-chip ${displayMode === "simple" ? "mode-chip--active" : ""}`}
              onClick={() => {
                setDisplayMode("simple");
                persistPreferences({ displayMode: "simple" });
              }}
            >
              Navigation simple
            </button>
            <button
              type="button"
              className={`mode-chip ${displayMode === "full" ? "mode-chip--active" : ""}`}
              onClick={() => {
                setDisplayMode("full");
                persistPreferences({ displayMode: "full" });
              }}
            >
              Analyse complète
            </button>
          </div>

          <MapView
            routeCoords={tripData.routeCoords}
            plannedStops={tripData.chargePlanStops || []}
            corridorStations={tripData.corridorStations || []}
          />

          {displayMode === "simple" ? (
            <Card title="Résumé compact" subtitle="Distance · Durée · ETA · Coût · Arrêts">
              <div className="summary-rows">
                <div className="summary-row"><span>Distance</span><strong className="font-mono">{(tripData.selectedSummary?.totalDistanceM / 1000).toFixed(1)} km</strong></div>
                <div className="summary-row"><span>Durée</span><strong className="font-mono">{Math.round((tripData.selectedSummary?.durationSec || 0) / 60)} min</strong></div>
                <div className="summary-row"><span>Arrivée estimée</span><strong className="font-mono">{tripData.selectedSummary?.etaTime || "--:--"}</strong></div>
                <div className="summary-row"><span>Coût estimé</span><strong className="font-mono">{(tripData.selectedSummary?.chargeCostEur || 0).toFixed(2)} €</strong></div>
                <div className="summary-row"><span>Nb arrêts</span><strong className="font-mono">{tripData.selectedSummary?.chargingStops || 0}</strong></div>
              </div>
            </Card>
          ) : null}

          {displayMode === "full" ? <WeatherEnergyCard stats={tripData.weatherEnergyStats} /> : null}

          {displayMode === "full" ? (
            <CompareTable
              rows={tripData.compareRows}
              selectedMode={tripData.selectedMode}
              onSelectMode={updateTripSelectedModeAsync}
            />
          ) : null}

          <SummaryCard summary={tripData.selectedSummary} pricePerKwh={preferences.defaultKwhPrice || 0.45} />

          <ChargingPlanCard
            stops={tripData.chargePlanStops || []}
            onToggleStopSelected={handleToggleStopSelected}
            onToggleStopCharge={handleToggleStopCharge}
            onTargetSocChange={handleTargetSocChange}
            onSelectStation={handleSelectStation}
          />

          {displayMode === "full" ? <AdvancedAnalysisCard segments={tripData.selectedSegments || []} /> : null}

          <div className="row-actions">
            <Button onClick={() => onStartNavigation(tripData)}>Démarrer la navigation</Button>
            <Button variant="secondary" onClick={() => onSaveHistory(tripData)}>
              Sauvegarder l’historique
            </Button>
          </div>
        </div>
      )}
    </div>
  );
};

export default PlanifierPage;
