import { NavLink } from "react-router-dom";

const links = [
  { to: "/planifier", label: "Planifier" },
  { to: "/navigation", label: "Navigation" },
  { to: "/historique", label: "Historique" },
  { to: "/reglages", label: "Réglages" },
];

const TopNav = () => {
  return (
    <header className="topnav">
      <div className="topnav__inner">
        <div className="brand">
          eco<span>speed</span>
        </div>
        <nav className="tabs" aria-label="Navigation principale">
          {links.map((link) => (
            <NavLink
              key={link.to}
              to={link.to}
              className={({ isActive }) => `tab ${isActive ? "tab--active" : ""}`}
            >
              {link.label}
            </NavLink>
          ))}
        </nav>
      </div>
    </header>
  );
};

export default TopNav;
