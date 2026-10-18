// Tabbed screenshots of the real app (captured from a demo with fake data).
import { AnimatePresence, motion } from "motion/react";
import { useState } from "react";
import { SHOTS } from "../content";
import { Screenshot, Section } from "../components/ui";

export function Showcase() {
  const [current, setCurrent] = useState(SHOTS[0].id);
  const shot = SHOTS.find((s) => s.id === current)!;
  return (
    <Section id="showcase" kicker="Tour" title="See it in action" intro="Real screens from Luna, filled with demo data." alt>
      <div className="tabs" role="tablist" aria-label="Screens">
        {SHOTS.map((s) => (
          <button
            key={s.id}
            role="tab"
            id={`tab-${s.id}`}
            aria-selected={s.id === current}
            aria-controls="shot-panel"
            className={s.id === current ? "on" : ""}
            onClick={() => setCurrent(s.id)}
          >
            {s.label}
          </button>
        ))}
      </div>
      <div id="shot-panel" role="tabpanel" aria-labelledby={`tab-${shot.id}`} className="showcase">
        <AnimatePresence mode="wait">
          <motion.div key={shot.id} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }}>
            <Screenshot src={shot.src} alt={shot.caption} mobile={shot.mobile} />
            <p className="caption">{shot.caption}</p>
          </motion.div>
        </AnimatePresence>
      </div>
    </Section>
  );
}
