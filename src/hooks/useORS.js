import { useCallback, useState } from "react";
import { autocompletePlaces, getRoute } from "../services/ors";

export const useORS = (apiKey) => {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const searchPlaces = useCallback(
    async (query) => {
      try {
        setError("");
        return await autocompletePlaces(query, apiKey);
      } catch (err) {
        setError(err.message || "Erreur ORS");
        return [];
      }
    },
    [apiKey]
  );

  const fetchRoute = useCallback(
    async (start, end) => {
      setLoading(true);
      setError("");
      try {
        return await getRoute(start, end, apiKey);
      } catch (err) {
        setError(err.message || "Erreur de calcul d'itinéraire");
        throw err;
      } finally {
        setLoading(false);
      }
    },
    [apiKey]
  );

  return { searchPlaces, fetchRoute, loading, error };
};
