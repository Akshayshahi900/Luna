// Sticky top bar: logo, section anchors, GitHub. Collapses to a menu on phones.
import { useEffect, useState } from "react";
import { REPO, SECTIONS } from "../content";
import { GitHubIcon } from "../icons";
import { asset } from "../lib/asset";

export function Nav() {
  const [open, setOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const onScroll = () => setScrolled(scrollY > 12);
    onScroll();
    addEventListener("scroll", onScroll, { passive: true });
    return () => removeEventListener("scroll", onScroll);
  }, []);
  return (
    <header className={`nav ${scrolled ? "scrolled" : ""} ${open ? "open" : ""}`}>
      <div className="wrap nav-inner">
        <a className="logo" href="#top" onClick={() => setOpen(false)}>
          <img src={asset("luna.svg")} alt="" width={26} height={26} />
          <span>LUNA</span>
        </a>
        <nav aria-label="Sections">
          <ul>
            {SECTIONS.map((s) => (
              <li key={s.id}>
                <a href={`#${s.id}`} onClick={() => setOpen(false)}>
                  {s.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>
        <a className="btn ghost small gh" href={REPO} target="_blank" rel="noreferrer">
          <GitHubIcon /> <span>GitHub</span>
        </a>
        <button className="menu" aria-label="Menu" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          <i />
          <i />
          <i />
        </button>
      </div>
    </header>
  );
}
