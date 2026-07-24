import type { Category } from "../core/models/category";

export interface TaggableEvent {
  id: string;
  title: string;
  description: string | null;
  organizer: string | null;
}

export interface TagResult {
  id: string;
  categories: Category[];
  interestScore: number; // 0-100
  reason: string;
}

export interface Tagger {
  readonly name: "ai" | "keyword";
  tag(events: TaggableEvent[]): Promise<TagResult[]>;
}
