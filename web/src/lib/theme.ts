// What Luna is doing right now, and how each mode looks.

export type Phase =
  | "boot"
  | "offline"
  | "idle"
  | "standby"
  | "listening"
  | "thinking"
  | "speaking"
  | "waiting"
  | "error";

export interface PhaseLook {
  label: string;
  /** main glow color */
  color: string;
  /** deep secondary color for the orb's body */
  deep: string;
  /** 0..1: how fast and restless the core is */
  energy: number;
}

export const LOOKS: Record<Phase, PhaseLook> = {
  boot: { label: "INITIALIZING", color: "#2ad8ff", deep: "#04223a", energy: 0.2 },
  offline: { label: "LINK OFFLINE", color: "#4a6a86", deep: "#0a1622", energy: 0.05 },
  idle: { label: "STANDING BY", color: "#22d8ff", deep: "#032a44", energy: 0.18 },
  // hands-free: the mic is open, waiting for "Hey Luna"
  standby: { label: "SAY “HEY LUNA”", color: "#22d8ff", deep: "#032a44", energy: 0.22 },
  listening: { label: "LISTENING", color: "#3dfcff", deep: "#004a5a", energy: 0.45 },
  thinking: { label: "PROCESSING", color: "#8a6bff", deep: "#1a0a4a", energy: 1 },
  speaking: { label: "RESPONDING", color: "#7ff3ff", deep: "#073c5c", energy: 0.6 },
  waiting: { label: "AUTHORIZATION REQUIRED", color: "#ffb52e", deep: "#3a2200", energy: 0.4 },
  error: { label: "FAULT DETECTED", color: "#ff3d6a", deep: "#3a0414", energy: 0.5 },
};

/** Codenames for the helper subagents shown in the HUD. */
export const HELPER_CODENAMES: Record<string, string> = {
  researcher: "RECON",
  files: "ARCHIVE",
  coder: "FORGE",
  assistant: "OPS",
};

export function codename(helper: string): string {
  return HELPER_CODENAMES[helper] ?? helper.toUpperCase();
}
