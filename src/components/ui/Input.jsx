const Input = ({ label, mono = false, hint, error, ...props }) => {
  return (
    <label className="field">
      {label ? <span className="field__label">{label}</span> : null}
      <input className={`input ${mono ? "font-mono" : ""}`} {...props} />
      {hint ? <span className="field__hint">{hint}</span> : null}
      {error ? <span className="field__error">{error}</span> : null}
    </label>
  );
};

export default Input;
