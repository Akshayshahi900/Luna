import { CAPABILITIES } from "../content";
import { Reveal, Section } from "../components/ui";
import { Icon } from "../icons";

export function Capabilities() {
  return (
    <Section
      id="capabilities"
      kicker="Capabilities"
      title="One assistant. Many hands."
      intro="Luna does quick things herself and hands bigger jobs to helper agents. She asks before anything that changes the world outside."
    >
      <div className="cards">
        {CAPABILITIES.map((c, i) => (
          <Reveal key={c.title} delay={(i % 3) * 0.06} className="card">
            <span className="card-icon">
              <Icon name={c.icon} />
            </span>
            <h3>{c.title}</h3>
            <p>{c.text}</p>
            <ul>
              {c.points.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </Reveal>
        ))}
      </div>
    </Section>
  );
}
