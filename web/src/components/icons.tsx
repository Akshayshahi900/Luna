// Line icons, drawn to match the HUD (1.5px strokes, no fills).
import type { SVGProps } from "react";

const base = {
  width: 22,
  height: 22,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

type P = SVGProps<SVGSVGElement>;

export const MicIcon = (p: P) => (
  <svg {...base} {...p}>
    <rect x="9" y="3" width="6" height="11" rx="3" />
    <path d="M5 11a7 7 0 0 0 14 0M12 18v3M8 21h8" />
  </svg>
);
export const KeyboardIcon = (p: P) => (
  <svg {...base} {...p}>
    <rect x="2.5" y="6" width="19" height="12" rx="2" />
    <path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10" />
  </svg>
);
export const TranscriptIcon = (p: P) => (
  <svg {...base} {...p}>
    <path d="M4 5h16v11H9l-5 4z" />
    <path d="M8 9h8M8 12h5" />
  </svg>
);
export const LoopIcon = (p: P) => (
  <svg {...base} {...p}>
    <path d="M17 2l3 3-3 3" />
    <path d="M20 5H9a5 5 0 0 0-5 5v1M7 22l-3-3 3-3" />
    <path d="M4 19h11a5 5 0 0 0 5-5v-1" />
  </svg>
);
export const SpeakerIcon = ({ off, ...p }: P & { off?: boolean }) => (
  <svg {...base} {...p}>
    <path d="M4 9v6h4l5 4V5L8 9z" />
    {off ? <path d="M17 9l5 6M22 9l-5 6" /> : <path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12" />}
  </svg>
);
export const CloseIcon = (p: P) => (
  <svg {...base} {...p}>
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
);
export const SendIcon = (p: P) => (
  <svg {...base} {...p}>
    <path d="M4 12l16-8-6 16-2.5-6.5z" />
  </svg>
);
export const PlusIcon = (p: P) => (
  <svg {...base} {...p}>
    <path d="M12 5v14M5 12h14" />
  </svg>
);
export const MemoryIcon = (p: P) => (
  <svg {...base} {...p}>
    <ellipse cx="12" cy="6" rx="7" ry="2.5" />
    <path d="M5 6v12c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5V6M5 12c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5" />
  </svg>
);
