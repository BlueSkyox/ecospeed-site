import { CircleMarker, MapContainer, Polyline, Popup, TileLayer, Tooltip, useMap } from "react-leaflet";
import { useEffect } from "react";

const getHeadingEndpoint = (position, headingDeg, distanceM = 35) => {
  if (!position || !Number.isFinite(headingDeg)) return null;
  const headingRad = (headingDeg * Math.PI) / 180;
  const dLat = (distanceM * Math.cos(headingRad)) / 111320;
  const dLng = (distanceM * Math.sin(headingRad)) / (111320 * Math.cos((position.lat * Math.PI) / 180));
  return {
    lat: position.lat + dLat,
    lng: position.lng + dLng,
  };
};

const RecenterMap = ({ center }) => {
  const map = useMap();

  useEffect(() => {
    if (center?.lat && center?.lng) {
      map.setView([center.lat, center.lng], Math.max(map.getZoom(), 12), {
        animate: true,
      });
    }
  }, [center, map]);

  return null;
};

const MapView = ({
  routeCoords = [],
  userPosition,
  headingDeg = 0,
  plannedStops = [],
  corridorStations = [],
  fullscreen = false,
  showLegend = true,
}) => {
  const center = userPosition || routeCoords[0] || { lat: 48.8566, lng: 2.3522 };
  const polyline = routeCoords.map((p) => [p.lat, p.lng]);
  const activeStops = plannedStops.filter((stop) => stop.mandatory || stop.selected || stop.enabled);
  const headingPoint = userPosition ? getHeadingEndpoint(userPosition, headingDeg) : null;

  return (
    <div className={`map-wrap ${fullscreen ? "map-wrap--fullscreen" : ""}`.trim()}>
      <MapContainer center={[center.lat, center.lng]} zoom={fullscreen ? 14 : 11} className={`leaflet-map ${fullscreen ? "leaflet-map--fullscreen" : ""}`.trim()}>
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; CARTO'
          url="https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png"
        />

        {polyline.length > 1 ? <Polyline positions={polyline} pathOptions={{ color: "#166534", weight: 5 }} /> : null}

        {routeCoords[0] ? (
          <CircleMarker center={[routeCoords[0].lat, routeCoords[0].lng]} radius={7} pathOptions={{ color: "#16a34a", fillColor: "#16a34a", fillOpacity: 1 }}>
            <Tooltip>Départ</Tooltip>
          </CircleMarker>
        ) : null}

        {routeCoords.at(-1) ? (
          <CircleMarker
            center={[routeCoords.at(-1).lat, routeCoords.at(-1).lng]}
            radius={7}
            pathOptions={{ color: "#dc2626", fillColor: "#dc2626", fillOpacity: 1 }}
          >
            <Tooltip>Arrivée</Tooltip>
          </CircleMarker>
        ) : null}

        {activeStops.map((stop) => {
          const station = stop.station;
          if (!station || !Number.isFinite(station.lat) || !Number.isFinite(station.lng)) return null;

          return (
            <CircleMarker
              key={`planned-${stop.id}-${station.id}`}
              center={[station.lat, station.lng]}
              radius={10}
              pathOptions={{ color: "#16a34a", fillColor: "#16a34a", fillOpacity: 0.95, weight: 2 }}
            >
              <Tooltip direction="top" offset={[0, -8]} permanent>
                🔌
              </Tooltip>
              <Popup>
                <div>
                  <strong>{station.name}</strong>
                  <br />
                  {station.powerKw ? `${station.powerKw} kW` : "Puissance NC"}
                  <br />
                  Statut : {stop.stopType === "mandatory" ? "Obligatoire" : stop.stopType === "recommended" ? "Recommandé" : "Optionnel"}
                  <br />
                  Énergie : {stop.energyForTargetKwh ?? "-"} kWh · Temps : {stop.timeForTargetMin ?? "-"} min
                  <br />
                  SOC arrivée: {stop.socAtArrival ?? "-"}% → cible {stop.targetSoc ?? "-"}% → suivante {stop.projectedSocNext ?? "-"}%
                </div>
              </Popup>
            </CircleMarker>
          );
        })}

        {corridorStations.map((station) => (
          <CircleMarker
            key={`corridor-${station.id}`}
            center={[station.lat, station.lng]}
            radius={6}
            pathOptions={{ color: "#16a34a", fillColor: "transparent", fillOpacity: 0, weight: 2 }}
          >
            <Popup>
              <div>
                <strong>{station.name}</strong>
                <br />
                {station.powerKw ? `${station.powerKw} kW` : "Puissance NC"}
                <br />
                Statut : Borne à proximité
              </div>
            </Popup>
          </CircleMarker>
        ))}

        {userPosition ? (
          <>
            {headingPoint ? (
              <Polyline
                positions={[
                  [userPosition.lat, userPosition.lng],
                  [headingPoint.lat, headingPoint.lng],
                ]}
                pathOptions={{ color: "#1d4ed8", weight: 4, opacity: 0.95 }}
              />
            ) : null}
            <CircleMarker
              center={[userPosition.lat, userPosition.lng]}
              radius={20}
              pathOptions={{ color: "#3b82f6", fillColor: "#3b82f6", fillOpacity: 0.15, weight: 1, className: "pulse-ring" }}
            />
            <CircleMarker
              center={[userPosition.lat, userPosition.lng]}
              radius={7}
              pathOptions={{ color: "#1d4ed8", fillColor: "#3b82f6", fillOpacity: 1, weight: 2 }}
            >
              <Tooltip>Votre position</Tooltip>
            </CircleMarker>
          </>
        ) : null}

        <RecenterMap center={center} />
      </MapContainer>

      {showLegend ? (
        <div className="map-legend">
          <span><strong>●</strong> Trajet optimisé</span>
          <span><strong>●</strong> Arrêt de charge</span>
          <span><strong>○</strong> Borne à proximité</span>
        </div>
      ) : null}
    </div>
  );
};

export default MapView;
