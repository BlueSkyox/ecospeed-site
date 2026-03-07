"use client";

import { MapContainer, Polyline, TileLayer, CircleMarker, Tooltip } from "react-leaflet";

type LatLng = [number, number];

type TripMapProps = {
  optimizedPath: LatLng[];
  limitPath?: LatLng[];
  height?: number;
};

function centerFor(path: LatLng[]): LatLng {
  const sum = path.reduce(
    (acc, p) => {
      acc[0] += p[0];
      acc[1] += p[1];
      return acc;
    },
    [0, 0] as [number, number],
  );
  return [sum[0] / path.length, sum[1] / path.length];
}

export default function TripMap({ optimizedPath, limitPath, height = 320 }: TripMapProps) {
  if (!optimizedPath.length) return <div className="map-empty">No map data</div>;

  const center = centerFor(optimizedPath);
  const start = optimizedPath[0];
  const end = optimizedPath[optimizedPath.length - 1];

  return (
    <div className="map-shell" style={{ height }}>
      <MapContainer center={center} zoom={8} scrollWheelZoom className="leaflet-map">
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        {limitPath?.length ? (
          <Polyline
            positions={limitPath}
            pathOptions={{ color: "#2563eb", weight: 5, opacity: 0.55, dashArray: "10 10" }}
          />
        ) : null}
        <Polyline positions={optimizedPath} pathOptions={{ color: "#109f6e", weight: 6, opacity: 0.95 }} />

        <CircleMarker center={start} radius={7} pathOptions={{ color: "#065f46", fillColor: "#10b981", fillOpacity: 1 }}>
          <Tooltip direction="top" offset={[0, -8]} permanent>
            Start
          </Tooltip>
        </CircleMarker>
        <CircleMarker center={end} radius={7} pathOptions={{ color: "#7f1d1d", fillColor: "#ef4444", fillOpacity: 1 }}>
          <Tooltip direction="top" offset={[0, -8]} permanent>
            End
          </Tooltip>
        </CircleMarker>
      </MapContainer>
      <div className="map-legend">
        <span className="legend-line legend-opt" /> Optimized route
        <span className="legend-line legend-limit" /> Speed-limit reference
      </div>
    </div>
  );
}

