import { PRIVACY, SPECS } from "../content";
import { Reveal, Section } from "../components/ui";
import { Icon } from "../icons";

export function Specs() {
  return (
    <Section id="specs" kicker="Specs" title="Under the hood" alt>
      <div className="specs">
        {SPECS.map((g, i) => (
          <Reveal key={g.group} delay={(i % 2) * 0.05} className="spec-group">
            <h3>{g.group}</h3>
            <dl>
              {g.rows.map(([k, v]) => (
                <div key={k}>
                  <dt>{k}</dt>
                  <dd>{v}</dd>
                </div>
              ))}
            </dl>
          </Reveal>
        ))}
      </div>
      <h3 className="sub-title">Privacy & safety</h3>
      <div className="privacy">
        {PRIVACY.map((p, i) => (
          <Reveal key={p.title} delay={i * 0.05} className="privacy-item">
            <Icon name={p.icon} />
            <div>
              <h4>{p.title}</h4>
              <p>{p.text}</p>
            </div>
          </Reveal>
        ))}
      </div>
    </Section>
  );
}
