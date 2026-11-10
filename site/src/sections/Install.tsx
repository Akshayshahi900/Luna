import { DOCS, INSTALL } from "../content";
import { CodeBlock, Reveal, Section } from "../components/ui";

export function Install() {
  return (
    <Section
      id="install"
      kicker="Install"
      title="Up and running in five minutes"
      intro={
        <>
          You need <a href="https://nodejs.org">Node.js</a> 22.18 or newer, <a href="https://pnpm.io">pnpm</a>, and an OpenRouter or Groq key, or a local{" "}
          <a href="https://ollama.com">Ollama</a> model that supports tools.
        </>
      }
    >
      <ol className="steps">
        {INSTALL.map((s, i) => (
          <Reveal key={s.title} delay={i * 0.04} className={`step ${s.optional ? "optional" : ""}`}>
            <span className="step-n">{s.optional ? "+" : i + 1}</span>
            <div className="step-body">
              <h3>{s.title}</h3>
              <p>{s.text}</p>
              {s.code && <CodeBlock code={s.code} label={s.title} />}
            </div>
          </Reveal>
        ))}
      </ol>
      <p className="more">
        Everything else is in the <a href={DOCS}>documentation</a>.
      </p>
    </Section>
  );
}
