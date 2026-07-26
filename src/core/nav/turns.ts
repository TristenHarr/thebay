/**
 * Turn-by-turn instruction synthesis — PURE geometry over the CSR graph.
 *
 * v1 ships named, written turns ("Turn left onto Van Ness Avenue"). Voice guidance
 * is explicitly out of scope; the street-name dictionary that makes the text
 * possible rides along in the pack (see graph.ts → nameDict).
 */
import { FLAG_STEPS, FLAG_CROSSING, edgeMetres, edgeName, nodeLat, nodeLng, type WalkGraph } from "./graph";

export type TurnKind =
  | "straight" | "slight left" | "left" | "sharp left"
  | "slight right" | "right" | "sharp right" | "u-turn";

export interface RouteStep {
  /** The node this instruction is given at (the start of the step). */
  node: number;
  instruction: string;
  street: string;
  /** Metres walked while this instruction holds. */
  distanceM: number;
  /** Compass bearing you leave on, degrees clockwise from north. */
  bearing: number;
  turn: TurnKind | "depart" | "arrive";
  stairs: boolean;
}

const RAD = Math.PI / 180;

/** Initial great-circle bearing a→b, degrees clockwise from north in [0, 360). */
export function bearingDeg(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const φ1 = aLat * RAD, φ2 = bLat * RAD, Δλ = (bLng - aLng) * RAD;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (Math.atan2(y, x) / RAD + 360) % 360;
}

/** Signed bearing delta in (-180, 180]. Positive = turning right (clockwise). */
export function deltaDeg(from: number, to: number): number {
  let d = ((to - from + 540) % 360) - 180;
  if (d === -180) d = 180;
  return d;
}

export function classifyTurn(delta: number): TurnKind {
  const a = Math.abs(delta);
  if (a < 20) return "straight";
  if (a > 170) return "u-turn";
  const side = delta > 0 ? "right" : "left";
  if (a < 50) return `slight ${side}` as TurnKind;
  if (a < 135) return side as TurnKind;
  return `sharp ${side}` as TurnKind;
}

const POINTS = ["north", "northeast", "east", "southeast", "south", "southwest", "west", "northwest"] as const;
export function compassPoint(bearing: number): string {
  return POINTS[Math.round((((bearing % 360) + 360) % 360) / 45) % 8]!;
}

const onto = (street: string) => (street ? ` onto ${street}` : "");

/**
 * Collapse a node/arc chain into human steps. A new step starts when the street
 * name changes or the turn is sharper than `turnThreshold` degrees — the same
 * rule every consumer navigation app uses, so two blocks of the same street read
 * as one "continue for 400 m" rather than a stutter of micro-instructions.
 */
export function buildSteps(g: WalkGraph, nodes: number[], arcs: number[], turnThreshold = 20): RouteStep[] {
  if (nodes.length < 2 || arcs.length === 0) {
    return [{ node: nodes[0] ?? 0, instruction: "You're already there.", street: "", distanceM: 0, bearing: 0, turn: "arrive", stairs: false }];
  }
  const bearingOf = (i: number) => bearingDeg(nodeLat(g, nodes[i]!), nodeLng(g, nodes[i]!), nodeLat(g, nodes[i + 1]!), nodeLng(g, nodes[i + 1]!));

  const steps: RouteStep[] = [];
  let street = edgeName(g, arcs[0]!);
  let bearing = bearingOf(0);
  let startNode = nodes[0]!;
  let acc = 0;
  let stairs = (g.flags[arcs[0]!]! & FLAG_STEPS) !== 0;
  let turn: TurnKind | "depart" = "depart";

  const flush = () => {
    const base = turn === "depart"
      ? `Head ${compassPoint(bearing)}${onto(street)}`
      : turn === "straight"
        ? `Continue${onto(street)}`
        : turn === "u-turn"
          ? `Make a U-turn${onto(street)}`
          : `Turn ${turn}${onto(street)}`;
    steps.push({ node: startNode, instruction: stairs ? `${base} — take the stairs` : base, street, distanceM: Math.round(acc), bearing, turn, stairs });
  };

  for (let i = 0; i < arcs.length; i++) {
    const arc = arcs[i]!;
    const name = edgeName(g, arc);
    const b = bearingOf(i);
    if (i > 0) {
      const d = deltaDeg(bearingOf(i - 1), b);
      const nameChanged = name !== street && !(name === "" || street === "");
      // A crossing is a continuation of the walk, not an instruction of its own.
      const isCrossing = (g.flags[arc]! & FLAG_CROSSING) !== 0;
      if (Math.abs(d) >= turnThreshold || (nameChanged && !isCrossing)) {
        flush();
        turn = classifyTurn(d);
        street = name;
        bearing = b;
        startNode = nodes[i]!;
        acc = 0;
        stairs = false;
      }
    }
    if (g.flags[arc]! & FLAG_STEPS) stairs = true;
    if (!street) street = name;
    acc += edgeMetres(g, arc);
  }
  flush();
  steps.push({ node: nodes[nodes.length - 1]!, instruction: "Arrive at your destination", street: "", distanceM: 0, bearing, turn: "arrive", stairs: false });
  return steps;
}
