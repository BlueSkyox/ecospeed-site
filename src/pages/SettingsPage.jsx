import { useState } from "react";
import Card from "../components/ui/Card";
import Input from "../components/ui/Input";
import Button from "../components/ui/Button";

const SettingsPage = ({ apiKeys, onSave }) => {
  const [form, setForm] = useState(apiKeys);
  const [ok, setOk] = useState(false);

  const setField = (key, value) => {
    setOk(false);
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const submit = (e) => {
    e.preventDefault();
    onSave(form);
    setOk(true);
  };

  return (
    <div className="stack-lg">
      <section>
        <p className="section-kicker">Réglages</p>
        <h1 className="section-title">Clés API</h1>
      </section>

      <Card title="Configuration des services" subtitle="Les clés sont stockées localement (localStorage).">
        <form className="stack-md" onSubmit={submit}>
          <Input
            label="Clé OpenRouteService"
            value={form.orsKey || ""}
            onChange={(e) => setField("orsKey", e.target.value)}
            placeholder="Collez votre clé ORS"
          />
          <Input
            label="Clé OpenChargeMap"
            value={form.ocmKey || ""}
            onChange={(e) => setField("ocmKey", e.target.value)}
            placeholder="Collez votre clé OpenChargeMap"
          />

          <div className="row-actions">
            <Button type="submit">Enregistrer</Button>
          </div>
          {ok ? <p className="alert-ok">Clés API enregistrées avec succès.</p> : null}
        </form>
      </Card>
    </div>
  );
};

export default SettingsPage;
