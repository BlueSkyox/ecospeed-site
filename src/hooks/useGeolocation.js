import { useCallback, useEffect, useRef, useState } from "react";

const toKmh = (ms) => ms * 3.6;

export const useGeolocation = () => {
  const watchIdRef = useRef(null);
  const lastRef = useRef(null);

  const [position, setPosition] = useState(null);
  const [speedKmh, setSpeedKmh] = useState(0);
  const [headingDeg, setHeadingDeg] = useState(0);
  const [error, setError] = useState("");
  const [isTracking, setIsTracking] = useState(false);

  const stopTracking = useCallback(() => {
    if (watchIdRef.current !== null) {
      navigator.geolocation.clearWatch(watchIdRef.current);
      watchIdRef.current = null;
    }
    setIsTracking(false);
  }, []);

  const startTracking = useCallback(() => {
    if (!navigator.geolocation) {
      setError("Géolocalisation non supportée.");
      return;
    }

    setError("");
    setIsTracking(true);

    watchIdRef.current = navigator.geolocation.watchPosition(
      (pos) => {
        const coords = {
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          timestamp: pos.timestamp,
        };

        setPosition(coords);

        if (Number.isFinite(pos.coords.speed) && pos.coords.speed >= 0) {
          setSpeedKmh(toKmh(pos.coords.speed));
        } else if (lastRef.current) {
          const dt = (pos.timestamp - lastRef.current.timestamp) / 1000;
          if (dt > 0) {
            const dx = Math.hypot(
              (coords.lat - lastRef.current.lat) * 111_320,
              (coords.lng - lastRef.current.lng) * 73_000
            );
            setSpeedKmh(toKmh(dx / dt));
          }
        }

        if (Number.isFinite(pos.coords.heading) && pos.coords.heading >= 0) {
          setHeadingDeg(pos.coords.heading);
        } else if (lastRef.current) {
          const dy = coords.lat - lastRef.current.lat;
          const dx = coords.lng - lastRef.current.lng;
          if (Math.abs(dx) + Math.abs(dy) > 1e-8) {
            const bearing = (Math.atan2(dx, dy) * 180) / Math.PI;
            setHeadingDeg((bearing + 360) % 360);
          }
        }

        lastRef.current = coords;
      },
      (geoErr) => {
        setError(geoErr.message || "Erreur de géolocalisation.");
        setIsTracking(false);
      },
      {
        enableHighAccuracy: true,
        maximumAge: 2000,
        timeout: 10000,
      }
    );
  }, []);

  useEffect(() => stopTracking, [stopTracking]);

  return {
    position,
    speedKmh,
    headingDeg,
    error,
    isTracking,
    startTracking,
    stopTracking,
  };
};
