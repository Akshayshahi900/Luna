// The core's current look, eased toward the active phase every frame by
// <LookDriver/>. Every part of the scene reads from here.
import { Color } from "three";

export const look = {
  color: new Color("#22d8ff"),
  deep: new Color("#032a44"),
  energy: 0.2,
  /** audio features (mic while listening, Luna's voice while speaking) */
  level: 0,
  low: 0,
  mid: 0,
  high: 0,
  time: 0,
};
