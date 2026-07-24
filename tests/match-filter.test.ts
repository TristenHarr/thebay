import { describe, it, expect } from "vitest";
import { filterDeck } from "../web/src/features/match/filterDeck";

const deck = [
  { id: "a", technical: true, hasIdea: true, commitment: "10h/wk" },
  { id: "b", technical: true, hasIdea: false, commitment: "full-time" },
  { id: "c", technical: false, hasIdea: true, commitment: "5h/wk" },
];

describe("co-founder deck filters (make the chips functional)", () => {
  it("no filters → full deck", () => {
    expect(filterDeck(deck, {}).map((c) => c.id)).toEqual(["a", "b", "c"]);
  });
  it("technical filter keeps only technical candidates", () => {
    expect(filterDeck(deck, { technical: true }).map((c) => c.id)).toEqual(["a", "b"]);
  });
  it("hasIdea filter keeps only those with an idea", () => {
    expect(filterDeck(deck, { hasIdea: true }).map((c) => c.id)).toEqual(["a", "c"]);
  });
  it("combined filters AND together", () => {
    expect(filterDeck(deck, { technical: true, hasIdea: true }).map((c) => c.id)).toEqual(["a"]);
  });
  it("commitment is a case-insensitive substring match", () => {
    expect(filterDeck(deck, { commitment: "FULL" }).map((c) => c.id)).toEqual(["b"]);
    expect(filterDeck(deck, { commitment: "h/wk" }).map((c) => c.id)).toEqual(["a", "c"]);
  });
});
