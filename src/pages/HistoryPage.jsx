import Card from "../components/ui/Card";
import Button from "../components/ui/Button";
import { formatDuration, formatKm, formatKwh, mono } from "../utils/format";

const HistoryPage = ({ history, onClearHistory }) => {
  return (
    <div className="stack-lg">
      <section>
        <p className="section-kicker">Historique</p>
        <h1 className="section-title">Trajets sauvegardés</h1>
      </section>

      <Card
        title="Journal des trajets"
        subtitle="Stockage local (localStorage)"
        right={
          <Button variant="secondary" onClick={onClearHistory}>
            Vider
          </Button>
        }
      >
        {!history?.length ? (
          <p className="field__hint">Aucun trajet sauvegardé pour le moment.</p>
        ) : (
          <div className="table-wrap">
            <table className="table table--compact">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Origine</th>
                  <th>Destination</th>
                  <th>Distance</th>
                  <th>Énergie</th>
                  <th>Conso moy.</th>
                  <th>Arrêts</th>
                  <th>SOC départ</th>
                  <th>SOC arrivée</th>
                  <th>Temp moyenne</th>
                  <th>HVAC</th>
                  <th>Mode</th>
                </tr>
              </thead>
              <tbody>
                {history.map((item) => (
                  <tr key={item.id}>
                    <td>{new Date(item.datetime).toLocaleString()}</td>
                    <td>{item.origin}</td>
                    <td>{item.destination}</td>
                    <td className="font-mono">{formatKm(item.distanceTotalM)}</td>
                    <td className="font-mono">{formatKwh(item.energyTotalWh)}</td>
                    <td className="font-mono">{mono(item.avgWhKm, 1)} Wh/km</td>
                    <td className="font-mono">{item.chargingStops}</td>
                    <td className="font-mono">{mono(item.socStart, 1)} %</td>
                    <td className="font-mono">{mono(item.socArrival, 1)} %</td>
                    <td className="font-mono">{mono(item.avgTempC, 1)} °C</td>
                    <td className="font-mono">{mono(item.hvacCabinTemp, 0)} °C</td>
                    <td>{item.selectedMode}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {history?.[0]?.segments?.length ? (
        <Card title="Dernier trajet (détail segments)" subtitle={formatDuration(history[0].segments.length * 600)}>
          <pre className="history-json">{JSON.stringify(history[0].segments, null, 2)}</pre>
        </Card>
      ) : null}
    </div>
  );
};

export default HistoryPage;
