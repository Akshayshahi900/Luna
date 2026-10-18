// How a request flows: a diagram of the agents, four steps, and examples.
import { CONVERSATIONS, FLOW } from "../content";
import { Reveal, Section } from "../components/ui";

const HELPERS = [
  { x: 70, name: "Researcher", sub: "web search" },
  { x: 250, name: "Files", sub: "sandbox folder" },
  { x: 430, name: "Coder", sub: "code + shell" },
  { x: 610, name: "Assistant", sub: "mail · calendar · to-dos" },
];

function Diagram() {
  return (
    <svg className="diagram" viewBox="0 0 800 360" role="img" aria-labelledby="diagram-title">
      <title id="diagram-title">
        You talk to Luna; the main agent uses its own tools and delegates to four helper agents; risky steps come back to you for approval.
      </title>
      <defs>
        <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0 0L10 5L0 10z" className="arrowhead" />
        </marker>
      </defs>
      {/* you */}
      <g className="node you">
        <rect x="300" y="10" width="160" height="50" rx="25" />
        <text x="380" y="41">You · voice or text</text>
      </g>
      <path className="link" d="M380 60V100" markerEnd="url(#arrow)" markerStart="url(#arrow)" />
      {/* main agent */}
      <g className="node main">
        <rect x="230" y="104" width="300" height="74" rx="6" />
        <text x="380" y="134" className="strong">Main agent</text>
        <text x="380" y="158" className="sub">memory · notes · built-in &amp; MCP tools</text>
      </g>
      {HELPERS.map((h) => (
        <g key={h.name}>
          <path className="link" d={`M380 178C380 220 ${h.x + 40} 215 ${h.x + 40} 254`} markerEnd="url(#arrow)" />
          <g className="node helper">
            <rect x={h.x - 30} y="258" width="140" height="62" rx="6" />
            <text x={h.x + 40} y="284" className="strong">{h.name}</text>
            <text x={h.x + 40} y="305" className="sub">{h.sub}</text>
          </g>
        </g>
      ))}
      {/* approvals */}
      <path className="link approval" d="M722 289C764 289 764 35 466 35" markerEnd="url(#arrow)" />
      <text x="784" y="165" className="tag" transform="rotate(90 784 165)">risky step → your approval</text>
    </svg>
  );
}

export function How() {
  return (
    <Section id="how" kicker="How it works" title="From your voice to done" intro="Every model call counts against a per-message budget, so a request can't run away with your quota.">
      <Reveal>
        {/* Scrolls sideways on phones instead of shrinking the text */}
        <div className="diagram-wrap" tabIndex={0} aria-label="Diagram (scrolls sideways on small screens)">
          <Diagram />
        </div>
      </Reveal>
      <ol className="flow">
        {FLOW.map((f, i) => (
          <Reveal key={f.title} delay={i * 0.06} className="flow-step">
            <span className="flow-n">{String(i + 1).padStart(2, "0")}</span>
            <h3>{f.title}</h3>
            <p>{f.text}</p>
          </Reveal>
        ))}
      </ol>
      <h3 className="sub-title">Abilities in action</h3>
      <div className="convos">
        {CONVERSATIONS.map((c, i) => (
          <Reveal key={c.title} delay={(i % 2) * 0.06} className="convo">
            <p className="convo-title">{c.title}</p>
            {c.lines.map((l, j) => (
              <p key={j} className={`bubble ${l.who}`}>
                {l.who === "tool" ? <code>{l.text}</code> : l.text}
              </p>
            ))}
          </Reveal>
        ))}
      </div>
    </Section>
  );
}
