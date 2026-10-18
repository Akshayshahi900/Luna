import { FAQ, FOOTER_LINKS, REPO } from "../content";
import { Section } from "../components/ui";
import { asset } from "../lib/asset";

export function Faq() {
  return (
    <Section id="faq" kicker="FAQ" title="Questions">
      <div className="faq">
        {FAQ.map((f) => (
          <details key={f.q}>
            <summary>{f.q}</summary>
            <p>{f.a}</p>
          </details>
        ))}
      </div>
    </Section>
  );
}

export function Footer() {
  return (
    <footer className="footer">
      <div className="wrap footer-inner">
        <div className="footer-brand">
          <img src={asset("luna.svg")} alt="" width={30} height={30} />
          <div>
            <b>LUNA</b>
            <p>Open source under the MIT License.</p>
          </div>
        </div>
        <nav aria-label="Project links">
          <ul>
            {FOOTER_LINKS.map(([label, href]) => (
              <li key={label}>
                <a href={href} target="_blank" rel="noreferrer">
                  {label}
                </a>
              </li>
            ))}
          </ul>
        </nav>
        <a href={`${REPO}/actions/workflows/ci.yml`} target="_blank" rel="noreferrer" className="badge">
          <img
            src={`${REPO}/actions/workflows/ci.yml/badge.svg`}
            alt="CI status"
            height={20}
            onError={(e) => (e.currentTarget.parentElement!.style.display = "none")}
          />
        </a>
      </div>
    </footer>
  );
}
