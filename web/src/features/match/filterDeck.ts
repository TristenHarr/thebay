/**
 * Pure co-founder deck filter. The deck arrives with each candidate's attributes
 * (technical / hasIdea / commitment); these filters narrow which candidates you
 * see — so the "My Co-Founder Filters" chips actually do something. Unit-tested.
 */
export interface Candidate {
  id: string;
  technical?: boolean;
  hasIdea?: boolean;
  commitment?: string | null;
  [k: string]: unknown;
}
export interface DeckFilters {
  technical?: boolean;
  hasIdea?: boolean;
  commitment?: string;
}

export function filterDeck<T extends Candidate>(deck: T[], f: DeckFilters): T[] {
  const want = (f.commitment || "").trim().toLowerCase();
  return deck.filter(
    (c) =>
      (!f.technical || c.technical === true) &&
      (!f.hasIdea || c.hasIdea === true) &&
      (!want || (c.commitment || "").toLowerCase().includes(want)),
  );
}
