import { CLI, SHORTCUTS, VOICE_COMMANDS } from "../content";
import { Reveal, Section } from "../components/ui";

function Table({ title, rows, kind }: { title: string; rows: [string, string][]; kind: "voice" | "keys" | "code" }) {
  return (
    <Reveal className="use-card">
      <h3>{title}</h3>
      <table>
        <tbody>
          {rows.map(([a, b]) => (
            <tr key={a}>
              <th scope="row">{kind === "keys" ? <kbd>{a}</kbd> : kind === "voice" ? <span className="say">{a}</span> : <code>{a}</code>}</th>
              <td>{b}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Reveal>
  );
}

export function Usage() {
  return (
    <Section
      id="usage"
      kicker="Use it"
      title="Talk, type or tap"
      intro="Turn on WAKE in the dock and just say “Hey Luna”. Everything also works from the keyboard, or in the terminal."
      alt
    >
      <div className="use-grid">
        <Table title="Voice" rows={VOICE_COMMANDS} kind="voice" />
        <Table title="Keyboard" rows={SHORTCUTS} kind="keys" />
        <Table title="Terminal" rows={CLI} kind="code" />
      </div>
    </Section>
  );
}
