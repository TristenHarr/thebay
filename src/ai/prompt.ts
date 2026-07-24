import { z } from "zod";
import type { CategoryDef } from "../core/models/category";
import type { TaggableEvent } from "./tagger";

export function buildSystemPrompt(categories: CategoryDef[]): string {
  const list = categories
    .map((c) => `- ${c.id}: ${c.label}`)
    .join("\n");
  const ids = categories.map((c) => c.id).join(", ");
  return [
    "You categorize technology events for a personal events dashboard.",
    "Return ONLY a JSON object, no prose.",
    "",
    "Categories (assign one or more per event; multi-select is expected):",
    list,
    "",
    "For each event also give interestScore 0-100 for a user interested in:",
    "hardware, early-stage venture capital / investors, mathematics, and software.",
    "Higher = more relevant to those interests. Never drop an event: if unsure,",
    `use "tech" with a low score.`,
    "",
    "Output shape:",
    '{ "results": [ { "id": string, "categories": string[], "interestScore": number, "reason": string } ] }',
    `Allowed category ids: ${ids}.`,
    "Include exactly one result per input event, keyed by the same id.",
  ].join("\n");
}

export function buildUserPayload(events: TaggableEvent[]): string {
  const compact = events.map((e) => ({
    id: e.id,
    title: e.title,
    description: e.description ? e.description.slice(0, 400) : undefined,
    organizer: e.organizer ?? undefined,
  }));
  return JSON.stringify(compact);
}

export const ResponseSchema = z.object({
  results: z.array(
    z.object({
      id: z.string(),
      categories: z.array(z.string()).default([]),
      interestScore: z.coerce.number().default(0),
      reason: z.string().default(""),
    }),
  ),
});
export type ParsedResponse = z.infer<typeof ResponseSchema>;
