const Card = ({ title, subtitle, right, children, className = "" }) => {
  return (
    <section className={`card ${className}`}>
      {(title || subtitle || right) && (
        <header className="card__header">
          <div>
            {title ? <h3 className="card__title">{title}</h3> : null}
            {subtitle ? <p className="card__subtitle">{subtitle}</p> : null}
          </div>
          {right ? <div>{right}</div> : null}
        </header>
      )}
      {children}
    </section>
  );
};

export default Card;
