import Card from "../ui/Card";
import SegmentsTable from "./SegmentsTable";

const AdvancedAnalysisCard = ({ segments = [] }) => {
  return (
    <Card title="Analyse avancée" subtitle="Tableau technique détaillé segment par segment.">
      <SegmentsTable segments={segments} />
    </Card>
  );
};

export default AdvancedAnalysisCard;
