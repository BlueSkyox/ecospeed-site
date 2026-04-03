import { Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { useCallback, useEffect, useState } from "react";
import TopNav from "./components/layout/TopNav";
import PageContainer from "./components/layout/PageContainer";
import PlanifierPage from "./pages/PlanifierPage";
import NavigationPage from "./pages/NavigationPage";
import HistoryPage from "./pages/HistoryPage";
import SettingsPage from "./pages/SettingsPage";
import {
  getApiKeys,
  getPreferences,
  getTripHistory,
  pushHistoryEntry,
  saveApiKeys,
  savePreferences,
  saveTripHistory,
} from "./utils/storage";
import { buildCompareRows, computeAllModes } from "./utils/planner";
import { hydrateSegmentsWeather } from "./services/weather";
import {
  buildSmartChargePlan,
  computeWeatherEnergyStats,
  mergeSummaryWithChargePlan,
} from "./utils/tripEnhancer";

const App = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const isNavigationRoute = location.pathname === "/navigation";

  const [apiKeys, setApiKeys] = useState(() => getApiKeys());
  const [preferences, setPreferences] = useState(() => getPreferences());
  const [history, setHistory] = useState(() => getTripHistory());

  const [tripData, setTripData] = useState(null);
  const [navigationData, setNavigationData] = useState(null);
  const [sharedGpsPosition, setSharedGpsPosition] = useState(null);

  useEffect(() => {
    document.body.classList.toggle("dark", preferences.theme === "dark");
  }, [preferences.theme]);

  const handleSaveSettings = useCallback((keys) => {
    setApiKeys(keys);
    saveApiKeys(keys);
  }, []);

  const handlePreferenceChange = useCallback((nextPreferences) => {
    setPreferences(nextPreferences);
    savePreferences(nextPreferences);
  }, []);

  const handleTripComputed = useCallback((trip) => {
    setTripData(trip);
    if (trip) setNavigationData(trip);
  }, []);

  const handleStartNavigation = useCallback(
    (trip) => {
      if (!trip) return;
      setNavigationData(trip);
      navigate("/navigation");
    },
    [navigate]
  );

  const handleSaveHistory = useCallback(
    (trip) => {
      if (!trip) return;

      const summary = trip.selectedSummary;
      const segments = trip.selectedSegments || [];
      const avgTemp =
        segments.length > 0
          ? segments.reduce((acc, seg) => acc + (seg.tExt || 0), 0) / Math.max(1, segments.length)
          : 0;

      const entry = {
        id: `${Date.now()}`,
        datetime: new Date().toISOString(),
        origin: trip.origin?.label || "-",
        destination: trip.destination?.label || "-",
        distanceTotalM: summary.totalDistanceM,
        energyTotalWh: summary.totalEnergyWh,
        avgWhKm: summary.avgWhKm,
        chargingStops: summary.chargingStops,
        socStart: trip.vehicle.socPct,
        socArrival: summary.arrivalSoc,
        avgTempC: avgTemp,
        hvacCabinTemp: trip.cabinTemp,
        selectedMode: trip.selectedMode,
        segments,
      };

      const next = pushHistoryEntry(entry);
      setHistory(next);
    },
    [setHistory]
  );

  const handleClearHistory = useCallback(() => {
    setHistory([]);
    saveTripHistory([]);
  }, []);

  const handleStopReplan = useCallback(
    async ({ targetSoc, currentSegmentIndex, selectedStation }) => {
      if (!navigationData) return;

      const fromIdx = Math.max(0, currentSegmentIndex || 0);
      const remainingBase = navigationData.rawSegments.slice(fromIdx);
      const weatherSegments = await hydrateSegmentsWeather(remainingBase);

      const allModes = computeAllModes({
        segments: weatherSegments,
        vehicle: navigationData.vehicle,
        cabinTemp: navigationData.cabinTemp,
        initialSocPct: targetSoc,
      });

      const selectedMode = navigationData.selectedMode;
      const selectedModeBase = allModes[selectedMode];

      const smartPlan = await buildSmartChargePlan({
        segments: selectedModeBase.segments,
        routeCoords: navigationData.routeCoords,
        batteryKwh: navigationData.vehicle.batteryKwh,
        initialSocPct: targetSoc,
        arrivalSocTarget: navigationData.arrivalSocTarget ?? 20,
        apiKey: apiKeys.ocmKey,
        pricePerKwh: preferences.defaultKwhPrice || 0.45,
      });

      const selectedSummary = {
        ...mergeSummaryWithChargePlan(selectedModeBase.summary, smartPlan.projection),
        referenceEnergyKwh: (allModes.rapide?.summary?.totalEnergyWh || selectedModeBase.summary.totalEnergyWh || 0) / 1000,
      };
      const updatedModes = {
        ...allModes,
        [selectedMode]: {
          ...selectedModeBase,
          segments: smartPlan.projection.segments,
          summary: selectedSummary,
        },
      };

      const compareRows = buildCompareRows(updatedModes, preferences.defaultKwhPrice || 0.45);
      const weatherEnergyStats = computeWeatherEnergyStats({
        segments: smartPlan.projection.segments,
        vehicle: navigationData.vehicle,
        cabinTemp: navigationData.cabinTemp,
        routeCoords: navigationData.routeCoords,
      });

      const updatedTrip = {
        ...navigationData,
        vehicle: {
          ...navigationData.vehicle,
          socPct: targetSoc,
        },
        rawSegments: weatherSegments,
        baseModeResults: allModes,
        modeResults: updatedModes,
        compareRows,
        selectedSummary,
        selectedSegments: smartPlan.projection.segments,
        chargePlanStops: smartPlan.projection.stops,
        corridorStations: smartPlan.corridorStations,
        weatherEnergyStats,
        arrivalSocTarget: navigationData.arrivalSocTarget ?? 20,
        resumeEvent: {
          at: new Date().toISOString(),
          targetSoc,
          station: selectedStation || null,
        },
      };

      setNavigationData(updatedTrip);
      setTripData(updatedTrip);
    },
    [apiKeys.ocmKey, navigationData, preferences.defaultKwhPrice]
  );

  return (
    <>
      {!isNavigationRoute ? <TopNav /> : null}
      <PageContainer className={isNavigationRoute ? "page-container--navigation" : ""}>
        <Routes>
          <Route
            path="/"
            element={<Navigate to="/planifier" replace />}
          />
          <Route
            path="/planifier"
            element={
              <PlanifierPage
                apiKeys={apiKeys}
                preferences={preferences}
                onPreferencesChange={handlePreferenceChange}
                onTripComputed={handleTripComputed}
                onStartNavigation={handleStartNavigation}
                onSaveHistory={handleSaveHistory}
                tripData={tripData}
              />
            }
          />
          <Route
            path="/navigation"
            element={
              <NavigationPage
                tripData={navigationData}
                apiKeys={apiKeys}
                onStopReplan={handleStopReplan}
                onSaveHistory={handleSaveHistory}
                sharedGpsPosition={sharedGpsPosition}
                onGpsPositionUpdate={setSharedGpsPosition}
              />
            }
          />
          <Route
            path="/historique"
            element={<HistoryPage history={history} onClearHistory={handleClearHistory} />}
          />
          <Route
            path="/reglages"
            element={
              <SettingsPage
                apiKeys={apiKeys}
                preferences={preferences}
                onSave={handleSaveSettings}
                onPreferencesChange={handlePreferenceChange}
              />
            }
          />
        </Routes>
      </PageContainer>
    </>
  );
};

export default App;
