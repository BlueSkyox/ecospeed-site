const Slider = ({ label, value, min, max, step = 1, onChange, unit = "", hint, disabled = false }) => {
  return (
    <div className="slider-wrap">
      <div className="slider-wrap__head">
        <span className="field__label">{label}</span>
        <span className="slider-value font-mono">
          {value}
          {unit}
        </span>
      </div>
      <input
        className="slider"
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      {hint ? <p className="field__hint">{hint}</p> : null}
    </div>
  );
};

export default Slider;
