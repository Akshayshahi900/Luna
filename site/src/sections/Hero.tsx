// First screen: what Luna is, two calls to action, the HUD screenshot.
import { motion, useReducedMotion } from "motion/react";
import { HERO, REPO } from "../content";
import { Screenshot } from "../components/ui";
import { GitHubIcon } from "../icons";

export function Hero() {
  const reduce = useReducedMotion();
  const enter = (delay: number) =>
    reduce ? {} : { initial: { opacity: 0, y: 16 }, animate: { opacity: 1, y: 0 }, transition: { duration: 0.6, delay } };
  return (
    <section className="hero" id="top">
      <div className="hero-glow" aria-hidden />
      <div className="wrap hero-inner">
        <motion.p className="kicker" {...enter(0)}>
          {HERO.kicker}
        </motion.p>
        <motion.h1 {...enter(0.08)}>
          <span className="wordmark">L·U·N·A</span>
          {HERO.title}
        </motion.h1>
        <motion.p className="pitch" {...enter(0.16)}>
          {HERO.pitch}
        </motion.p>
        <motion.div className="cta" {...enter(0.24)}>
          <a className="btn primary" href="#install">
            Get started
          </a>
          <a className="btn ghost" href={REPO} target="_blank" rel="noreferrer">
            <GitHubIcon /> View on GitHub
          </a>
        </motion.div>
        <motion.ul className="hero-stats" {...enter(0.32)}>
          {HERO.stats.map((s) => (
            <li key={s.label}>
              <b>{s.value}</b>
              <span>{s.label}</span>
            </li>
          ))}
        </motion.ul>
        <motion.div className="hero-shot" {...(reduce ? {} : { initial: { opacity: 0, y: 40 }, animate: { opacity: 1, y: 0 }, transition: { duration: 0.8, delay: 0.35 } })}>
          <Screenshot src="screens/hud.webp" alt="Luna's voice HUD with the glowing core, activity panel, subsystems and the dock" />
        </motion.div>
      </div>
    </section>
  );
}
