import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import MapView from "../components/navigation/MapView";
import NavHUD from "../components/navigation/NavHUD";
import StopModal from "../components/navigation/StopModal";
import Card from "../components/ui/Card";
import Button from "../components/ui/Button";
import { useGeolocation } from "../hooks/useGeolocation";
import { findNearestPointIndex, projectPathDistance } from "../utils/geo";

const NavigationPage = ({ tripData, apiKeys, onStopReplan }) => {
  const navigate = useNavigate();
  const [showStopModal, setShowStopModal] = useState(false);
  const { position, speedKmh, headingDeg, error, startTracking, stopTracking, isTracking } = useGeolocation();

  useEffect(() => {
    if (tripData && !isTracking) startTracking();
    return stopTracking;
  }, [tripData, isTracking, startTracking, stopTracking]);

  const navMetrics = useMemo(() => {
    if (!tripData?.routeCoords?.length || !tripData?.selectedSegments?.length) {
      return null;
    }

    const nearestPointIndex = position ? findNearestPointIndex(tripData.routeCoords, position) : 0;
    const progressM = projectPathDistance(tripData.routeCoords, nearestPointIndex);
    const currentSegment =
      tripData.selectedSegments.find((s) => progressM >= s.startDistM && progressM <= s.endDistM) ||
      tripData.selectedSegments[tripData.selectedSegments.length - 1];

    const currentRawIndex = tripData.rawSegments.findIndex((s) => s.id === currentSegment.id);

    return {
      currentSegment,
      currentRawIndex: Math.max(0, currentRawIndex),
      progressM,
    };
  }, [position, tripData]);

  const remainingDistanceKm = useMemo(() => {
    const totalM = tripData?.routeSummary?.distanceM || projectPathDistance(tripData?.routeCoords || [], (tripData?.routeCoords || []).length - 1);
    const doneM = navMetrics?.progressM || 0;
    return Math.max(0, (totalM - doneM) / 1000);
  }, [navMetrics?.progressM, tripData?.routeCoords, tripData?.routeSummary?.distanceM]);

  const etaTime = useMemo(() => {
    const speed = Math.max(1, speedKmh || navMetrics?.currentSegment?.speedTrip || 0);
    const remainingHours = remainingDistanceKm / speed;
    const eta = new Date(Date.now() + remainingHours * 3600 * 1000);
    return eta.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }, [remainingDistanceKm, speedKmh, navMetrics?.currentSegment?.speedTrip]);

  const nextStop = useMemo(() => {
    if (!tripData?.chargePlanStops?.length) return null;

    const progressM = navMetrics?.progressM || 0;
    const upcoming = tripData.chargePlanStops
      .filter((stop) => (stop.mandatory || stop.selected || stop.enabled) && stop.station)
      .sort((a, b) => a.distanceFromStartM - b.distanceFromStartM)
      .find((stop) => stop.distanceFromStartM > progressM + 50);

    if (!upcoming) return null;

    return {
      id: upcoming.id,
      nameShort: (upcoming.station?.name || "Borne").slice(0, 34),
      distanceKm: Math.max(0, (upcoming.distanceFromStartM - progressM) / 1000),
      socAtArrival: upcoming.socAtArrival,
    };
  }, [navMetrics?.progressM, tripData?.chargePlanStops]);

  const guidance = useMemo(() => {
    const seg = navMetrics?.currentSegment;
    if (!seg) {
      return {
        instruction: "Continuez sur l'itinéraire",
        distanceToManeuverM: 0,
      };
    }

    const stopDistanceM = nextStop ? nextStop.distanceKm * 1000 : null;
    if (stopDistanceM != null && stopDistanceM < 1000) {
      return {
        instruction: `Préparez l'arrêt recharge : ${nextStop.nameShort}`,
        distanceToManeuverM: stopDistanceM,
      };
    }

    return {
      instruction: seg.speedLimit >= 100 ? "Restez sur voie principale" : "Continuez tout droit",
      distanceToManeuverM: Math.max(0, Number(seg.endDistM || 0) - Number(navMetrics?.progressM || 0)),
    };
  }, [navMetrics?.currentSegment, navMetrics?.progressM, nextStop]);

  const showApproachBanner = Boolean(nextStop && nextStop.distanceKm <= 5);

  if (!tripData) {
    return (
      <Card title="Navigation" subtitle="Aucun trajet actif.">
        <p className="field__hint">Calculez d’abord un trajet depuis la vue Planifier.</p>
      </Card>
    );
  }

  return (
    <div className="nav-page nav-page--fullscreen">
      <MapView
        routeCoords={tripData.routeCoords}
        userPosition={position}
        headingDeg={headingDeg}
        plannedStops={tripData.chargePlanStops || []}
        corridorStations={tripData.corridorStations || []}
        fullscreen
        showLegend={false}
      />

      {error ? <p className="alert-error nav-error-overlay">{error}</p> : null}

      <div className="nav-overlay">
        <NavHUD
          speedKmh={speedKmh || 0}
          ecoKmh={navMetrics?.currentSegment?.speedEco || 0}
          limitKmh={navMetrics?.currentSegment?.speedLimit || 0}
          socPct={navMetrics?.currentSegment?.socRemaining ?? tripData.selectedSummary.arrivalSoc}
          nextStop={nextStop}
          showApproachBanner={showApproachBanner}
          guidance={guidance}
          remainingDistanceKm={remainingDistanceKm}
          etaTime={etaTime}
        />
      </div>

      <button className="nav-reduce-btn" type="button" onClick={() => navigate("/planifier")}>Réduire</button>

      <button className="stop-fab" type="button" onClick={() => setShowStopModal(true)}>
        STOP
      </button>

      <StopModal
        open={showStopModal}
        onClose={() => setShowStopModal(false)}
        position={position}
        apiKey={apiKeys.ocmKey}
        currentSegmentIndex={navMetrics?.currentRawIndex || 0}
        onConfirm={onStopReplan}
      />

      {tripData.resumeEvent ? (
        <Card title="Reprise après arrêt" subtitle="Dernière mise à jour de trajectoire." className="nav-resume-card">
          <p className="field__hint">
            Recalcul effectué à {new Date(tripData.resumeEvent.at).toLocaleTimeString()} avec SOC cible
            <strong className="font-mono"> {tripData.resumeEvent.targetSoc}%</strong>.
          </p>
        </Card>
      ) : null}

      <div className="row-actions nav-actions-row">
        <Button variant="secondary" onClick={stopTracking}>
          Stop GPS
        </Button>
        <Button onClick={startTracking}>Relancer GPS</Button>
      </div>
    </div>
  );
};

export default NavigationPage;
