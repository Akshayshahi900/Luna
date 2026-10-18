// Small shared pieces: section frame, reveal-on-scroll, code block, screenshot.
import { motion, useReducedMotion } from "motion/react";
import { type ReactNode, useState } from "react";
import { asset } from "../lib/asset";
import { commandsOnly, copyText } from "../lib/clipboard";

export function Section(p: { id: string; kicker: string; title: string; intro?: ReactNode; children: ReactNode; alt?: boolean }) {
  return (
    <section id={p.id} className={`section ${p.alt ? "alt" : ""}`} aria-labelledby={`${p.id}-title`}>
      <div className="wrap">
        <Reveal>
          <p className="kicker">{p.kicker}</p>
          <h2 id={`${p.id}-title`}>{p.title}</h2>
          {p.intro && <p className="intro">{p.intro}</p>}
        </Reveal>
        {p.children}
      </div>
    </section>
  );
}

export function Reveal({ children, delay = 0, className }: { children: ReactNode; delay?: number; className?: string }) {
  const reduce = useReducedMotion();
  return (
    <motion.div
      className={className}
      initial={reduce ? false : { opacity: 0, y: 18 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-60px" }}
      transition={{ duration: 0.5, delay, ease: "easeOut" }}
    >
      {children}
    </motion.div>
  );
}

export function CodeBlock({ code, label }: { code: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="code">
      <pre>
        <code>
          {code.split("\n").map((line, i) => (
            <span key={i} className={line.trim().startsWith("#") ? "comment" : undefined}>
              {line.trim().startsWith("#") ? line : <><i className="prompt">$ </i>{line}</>}
              {"\n"}
            </span>
          ))}
        </code>
      </pre>
      <button
        className="copy"
        aria-label={`Copy ${label ?? "commands"}`}
        onClick={async () => {
          if (await copyText(commandsOnly(code))) {
            setCopied(true);
            setTimeout(() => setCopied(false), 1600);
          }
        }}
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

export function Screenshot({ src, alt, mobile }: { src: string; alt: string; mobile?: boolean }) {
  return (
    <figure className={`shot ${mobile ? "mobile" : ""}`}>
      <div className="shot-bar" aria-hidden>
        <i />
        <i />
        <i />
        <span>Luna</span>
      </div>
      <img src={asset(src)} alt={alt} loading="lazy" width={mobile ? 390 : 1440} height={mobile ? 844 : 900} />
    </figure>
  );
}
