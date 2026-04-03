import Card from "../ui/Card";
import { mono } from "../../utils/format";

const SegmentsTable = ({ segments }) => {
  if (!segments?.length) return null;

  return (
    <Card title="Tableau des segments" subtitle="Données détaillées segment par segment.">
      <div className="table-wrap">
        <table className="table table--compact">
          <thead>
            <tr>
              <th>Segment</th>
              <th>Distance</th>
              <th>Dénivelé</th>
              <th>T° ext</th>
              <th>Précip.</th>
              <th>Cr modifié</th>
              <th>Vitesse éco</th>
              <th>Vitesse limite</th>
              <th>Vitesse trajet</th>
              <th>HVAC</th>
              <th>Énergie estimée</th>
              <th>SOC restant</th>
            </tr>
          </thead>
          <tbody>
            {segments.map((seg) => (
              <tr key={seg.id}>
                <td className="font-mono">{seg.index}</td>
                <td className="font-mono">{mono(seg.distanceM / 1000, 2)} km</td>
                <td className="font-mono">{mono(seg.deltaH, 0)} m</td>
                <td className="font-mono">{mono(seg.tExt, 1)} °C</td>
                <td className="font-mono">{mono(seg.precip, 1)} mm/h</td>
                <td className="font-mono">{mono(seg.crModified, 4)}</td>
                <td className="font-mono">{mono(seg.speedEco, 1)} km/h</td>
                <td className="font-mono">{mono(seg.speedLimit, 0)} km/h</td>
                <td className="font-mono">{mono(seg.speedTrip, 1)} km/h</td>
                <td className="font-mono">{mono(seg.hvacW, 0)} W</td>
                <td className="font-mono">{mono(seg.energyWh / 1000, 2)} kWh</td>
                <td className="font-mono">{mono(seg.socRemaining, 1)} %</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
};

export default SegmentsTable;
