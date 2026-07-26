import { z } from "zod";

/**
 * Request shapes for the crowd city map. Zod, like every other boundary in the
 * repo — malformed data can't reach a handler.
 *
 * Two deliberate asymmetries:
 *
 *  - **Writes carry TWO positions.** `lat`/`lng` is where the *device* is (the
 *    Bay-GPS gate, same as POST /api/notes); `pinLat`/`pinLng` is where the pin
 *    goes, and defaults to your feet. The route enforces that they're within
 *    walking distance, which is what makes "you have to actually be there" real.
 *  - **The import item schema is LOOSE on purpose.** House source convention:
 *    skip a bad item, never abort the run. A strict item schema would 400 the
 *    whole 30k-row DataSF push because one meter lacks coordinates.
 */

export const PlaceVerdictSchema = z.enum(["confirm", "dispute", "update", "tip"]);
export type PlaceVerdict = z.infer<typeof PlaceVerdictSchema>;

/** The declarative form schema a proposed kind ships with. Validated again (and
 *  more strictly) by `parseFields` — this only bounds the payload size. */
export const FieldSpecSchema = z.object({
  key: z.string().max(32),
  label: z.string().max(60).optional(),
  type: z.string().max(12),
  options: z.array(z.string().max(40)).max(20).optional(),
});

export const PlaceKindProposeSchema = z.object({
  label: z.string().min(2).max(60),
  /** Not optional: the emoji IS the map icon system. */
  emoji: z.string().min(1).max(8),
  color: z.string().max(24).optional(),
  category: z.string().max(40).optional(),
  /** How fast this kind's confirmations rot. Capped at ten years. */
  halfLifeHours: z.number().int().positive().max(87_600).optional(),
  fields: z.array(FieldSpecSchema).max(12).optional(),
});
export type PlaceKindPropose = z.infer<typeof PlaceKindProposeSchema>;

export const PlaceCreateSchema = z.object({
  kindId: z.string().min(1).max(40),
  name: z.string().max(120).optional(),
  address: z.string().max(200).optional(),
  attrs: z.record(z.unknown()).optional(),
  /** Where YOU are (the GPS gate). */
  lat: z.number(),
  lng: z.number(),
  /** Where the pin goes. Defaults to your position. */
  pinLat: z.number().optional(),
  pinLng: z.number().optional(),
});
export type PlaceCreate = z.infer<typeof PlaceCreateSchema>;

export const PlaceReportSchema = z.object({
  verdict: PlaceVerdictSchema,
  attrs: z.record(z.unknown()).optional(),
  body: z.string().max(500).optional(),
  /** Where you are standing — proximity-gated against the pin. */
  lat: z.number(),
  lng: z.number(),
});
export type PlaceReport = z.infer<typeof PlaceReportSchema>;

export const FlagReasonSchema = z.enum(["spam", "off_topic", "abuse", "duplicate", "broken", "other"]);
export const PlaceFlagSchema = z.object({ reason: FlagReasonSchema.optional() });

/** Loose by design — see the module doc. The repo skips and counts bad items. */
export const PlaceImportItemSchema = z
  .object({
    externalRef: z.string().max(200).optional(),
    kindId: z.string().max(40).optional(),
    name: z.string().max(200).nullish(),
    lat: z.number().optional(),
    lng: z.number().optional(),
    address: z.string().max(300).nullish(),
    attrs: z.record(z.unknown()).nullish(),
  })
  .passthrough();

export const PlacesImportSchema = z.object({
  places: z.array(PlaceImportItemSchema).min(1).max(5000),
});
export type PlacesImport = z.infer<typeof PlacesImportSchema>;
