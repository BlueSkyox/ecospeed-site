import Card from "../ui/Card";
import Input from "../ui/Input";

const Suggestions = ({ items, onSelect }) => {
  if (!items?.length) return null;
  return (
    <ul className="suggestions">
      {items.map((item, idx) => (
        <li key={`${item.label}-${idx}`}>
          <button type="button" className="suggestions__item" onClick={() => onSelect(item)}>
            {item.label}
          </button>
        </li>
      ))}
    </ul>
  );
};

const RouteForm = ({
  originQuery,
  destinationQuery,
  onOriginChange,
  onDestinationChange,
  originSuggestions,
  destinationSuggestions,
  onSelectOrigin,
  onSelectDestination,
  onUseCurrentLocation,
  locatingOrigin,
  originGeoError,
}) => {
  return (
    <Card title="Trajet" subtitle="Départ et arrivée avec autocomplétion OpenRouteService.">
      <div className="grid grid--2">
        <div className="route-field">
          <div className="origin-inline-head">
            <Input
              label="Départ"
              placeholder="Ex: Lyon Part-Dieu"
              value={originQuery}
              onChange={(e) => onOriginChange(e.target.value)}
            />
            <button
              type="button"
              className="geo-btn"
              onClick={onUseCurrentLocation}
              disabled={locatingOrigin}
              title="Utiliser ma position"
            >
              {locatingOrigin ? "…" : "📍"}
            </button>
          </div>
          {originGeoError ? <p className="field__error">{originGeoError}</p> : null}
          <Suggestions items={originSuggestions} onSelect={onSelectOrigin} />
        </div>
        <div className="route-field">
          <Input
            label="Arrivée"
            placeholder="Ex: Nice Promenade"
            value={destinationQuery}
            onChange={(e) => onDestinationChange(e.target.value)}
          />
          <Suggestions items={destinationSuggestions} onSelect={onSelectDestination} />
        </div>
      </div>
    </Card>
  );
};

export default RouteForm;
