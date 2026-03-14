"use client";

import { CircleMarker, MapContainer, Polyline, TileLayer, Tooltip } from "react-leaflet";
import type { ChargingStation } from "@/lib/charging-context";

type LatLng = [number, number];

type StationStop = {
  segmentIndex: number;
  energyToCharge: number;
  chargingTimeMinutes: number;
  station: ChargingStation;
};

type TripMapProps = {
  optimizedPath: LatLng[];
  chargingStops?: StationStop[];
  nearbyStations?: ChargingStation[];
  height?: number;
  locale: "fr" | "en";
};

function centerFor(path: LatLng[]): LatLng {
  const sum = path.reduce(
    (acc, point) => {
      acc[0] += point[0];
      acc[1] += point[1];
      return acc;
    },
    [0, 0] as [number, number],
  );
  return [sum[0] / path.length, sum[1] / path.length];
}

export default function TripMap({
  optimizedPath,
  chargingStops = [],
  nearbyStations = [],
  height = 420,
  locale,
}: TripMapProps) {
  if (optimizedPath.length === 0) {
    return <div className="ecospeed-empty-state">{locale === "fr" ? "La carte s affichera ici apres calcul du trajet." : "The map will appear here after the trip is calculated."}</div>;
  }

  const center = centerFor(optimizedPath);
  const start = optimizedPath[0];
  const end = optimizedPath[optimizedPath.length - 1];

  return (
    <div className="ecospeed-map" style={{ height }}>
      <MapContainer center={center} zoom={7} scrollWheelZoom className="leaflet-map">
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />

        <Polyline positions={optimizedPath} pathOptions={{ color: "#2f8f5b", weight: 5, opacity: 0.95 }} />

        <CircleMarker center={start} radius={7} pathOptions={{ color: "#145a38", fillColor: "#52b778", fillOpacity: 1 }}>
          <Tooltip direction="top">{locale === "fr" ? "Depart" : "Start"}</Tooltip>
        </CircleMarker>

        <CircleMarker center={end} radius={7} pathOptions={{ color: "#904433", fillColor: "#cf7d57", fillOpacity: 1 }}>
          <Tooltip direction="top">{locale === "fr" ? "Arrivee" : "Destination"}</Tooltip>
        </CircleMarker>

        {chargingStops.map((stop, index) => (
          <CircleMarker
            key={`${stop.station.name}-${stop.segmentIndex}-${index}`}
            center={[stop.station.latitude, stop.station.longitude]}
            radius={6}
            pathOptions={{ color: "#0e5c8d", fillColor: "#4aa5dd", fillOpacity: 0.95 }}
          >
            <Tooltip direction="top">
              {`${index + 1}. ${stop.station.name} - ${stop.energyToCharge.toFixed(1)} kWh / ${stop.chargingTimeMinutes.toFixed(0)} min`}
            </Tooltip>
          </CircleMarker>
        ))}

        {nearbyStations.slice(0, 12).map((station) => (
          <CircleMarker
            key={`${station.name}-${station.latitude}-${station.longitude}`}
            center={[station.latitude, station.longitude]}
            radius={4.5}
            pathOptions={{ color: "#ad6b1e", fillColor: "#efb046", fillOpacity: 0.75 }}
          >
            <Tooltip direction="top">
              {`${station.name} - ${station.powerKw} kW${station.operator ? ` / ${station.operator}` : ""}`}
            </Tooltip>
          </CircleMarker>
        ))}
      </MapContainer>
    </div>
  );
}
