// Subtle HUD cards in a bottom corner: unread mail, the next event, to-dos
// (from the built-in routines) and optionally a few Luna stats. Shown only
// when their routine has a result and the Dashboard app enables them.
// Clicking one opens the Control Center.
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";
import { api, insightLine, type DashboardPrefs, type Insights } from "../lib/control";

const KEYS = [
  ["mail_check", "mail", "MAIL"],
  ["agenda", "agenda", "CALENDAR"],
  ["todos", "todos", "TO-DO"],
] as const;

const STATS_EVERY_MS = 60_000;

interface Props {
  prefs: DashboardPrefs | null;
  insights: Insights["insights"];
  onOpen: (app: "routines" | "overview") => void;
  /** hide while a side drawer covers that corner */
  hidden?: boolean;
}

export function InsightWidgets({ prefs, insights, onOpen, hidden }: Props) {
  const [stats, setStats] = useState<{ calls: number; memories: number | null } | null>(null);
  const wantStats = !!prefs?.widgets.stats;

  useEffect(() => {
    if (!wantStats) return;
    const load = () =>
      api.stats().then(
        (s) => setStats({ calls: s.usage.days[s.usage.days.length - 1]?.model_calls ?? 0, memories: s.memory?.total ?? null }),
        () => undefined,
      );
    void load();
    const t = setInterval(load, STATS_EVERY_MS);
    return () => clearInterval(t);
  }, [wantStats]);

  if (!prefs || hidden) return null;
  const cards = KEYS.filter(([, w]) => prefs.widgets[w])
    .map(([key, , label]) => ({ key, label, line: insightLine(key, insights[key]) }))
    .filter((c) => c.line);

  return (
    <div className={`widgets ${prefs.position} ${prefs.style}`} style={{ opacity: prefs.opacity }}>
      <AnimatePresence initial={false}>
        {cards.map(({ key, label, line }) => (
          <motion.button
            key={key}
            layout
            className="widget"
            initial={{ opacity: 0, x: prefs.position === "bottom-left" ? -12 : 12 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0 }}
            onClick={() => onOpen("routines")}
            title="Open routines"
          >
            <span className="widget-kicker">{label}</span>
            <b>{line!.title}</b>
            {prefs.style === "compact" && line!.detail && <span className="widget-detail">{line!.detail}</span>}
          </motion.button>
        ))}
        {wantStats && stats && (
          <motion.button key="stats" layout className="widget" onClick={() => onOpen("overview")} title="Open overview">
            <span className="widget-kicker">LUNA</span>
            <b>
              {stats.calls} calls today{stats.memories !== null ? ` · ${stats.memories} memories` : ""}
            </b>
          </motion.button>
        )}
      </AnimatePresence>
    </div>
  );
}
