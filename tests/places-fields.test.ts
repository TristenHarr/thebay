import { describe, it, expect } from "vitest";
import { parseFields, coerceAttrs, slugifyKindId, parseAttrs, serializeFields } from "../src/core/places/fields";

/**
 * `fields_json` is the mechanism that lets the crowd invent a place kind and get
 * a working form, storage and detail sheet without a deploy. So the two things
 * that must hold are: a malformed proposal can never break readers of that kind,
 * and nothing a client posts can land under a key the kind never declared.
 */

describe("parseFields", () => {
  it("accepts a well-formed spec and round-trips it", () => {
    const spec = [
      { key: "type", label: "Type", type: "enum", options: ["street", "garage"] },
      { key: "evCharging", label: "EV charging", type: "bool" },
      { key: "maxHeight", label: "Max height (ft)", type: "int" },
      { key: "priceHint", label: "Price", type: "text" },
    ];
    const parsed = parseFields(JSON.stringify(spec));
    expect(parsed).toEqual(spec);
    expect(parseFields(serializeFields(parsed))).toEqual(parsed);
  });

  it("drops junk instead of throwing — one bad field can't break the kind", () => {
    const parsed = parseFields([
      { key: "ok", label: "OK", type: "text" },
      { key: "9bad", label: "Bad key", type: "text" }, // key must start with a letter
      { key: "noType", label: "?" },
      { key: "weird", label: "?", type: "geometry" },
      { key: "emptyEnum", label: "?", type: "enum", options: [] }, // unfillable
      "not an object",
      null,
      { key: "ok", label: "dupe", type: "int" }, // duplicate key
    ]);
    expect(parsed.map((f) => f.key)).toEqual(["ok"]);
  });

  it("survives unparseable / non-array input", () => {
    expect(parseFields("{not json")).toEqual([]);
    expect(parseFields(null)).toEqual([]);
    expect(parseFields({ key: "x" })).toEqual([]);
    expect(parseFields(undefined)).toEqual([]);
  });

  it("caps the field count so a proposal can't be a denial-of-service", () => {
    const many = Array.from({ length: 50 }, (_, i) => ({ key: `f${i}`, label: `F${i}`, type: "text" }));
    expect(parseFields(many).length).toBeLessThanOrEqual(12);
  });

  it("falls back to the key as the label", () => {
    expect(parseFields([{ key: "sweepDay", type: "text" }])[0]!.label).toBe("sweepDay");
  });
});

describe("coerceAttrs", () => {
  const fields = parseFields([
    { key: "type", label: "Type", type: "enum", options: ["street", "garage", "lot"] },
    { key: "evCharging", label: "EV", type: "bool" },
    { key: "maxHeight", label: "H", type: "int" },
    { key: "priceHint", label: "$", type: "text" },
  ]);

  it("keeps only declared keys — a client cannot invent storage", () => {
    const out = coerceAttrs(fields, { type: "street", isAdmin: true, __proto__: "nope", rogue: 1 });
    expect(out).toEqual({ type: "street" });
  });

  it("coerces each declared type from the sloppy shapes a form sends", () => {
    expect(coerceAttrs(fields, { evCharging: "true", maxHeight: "6 ft", priceHint: "  $3.50/hr  " })).toEqual({
      evCharging: true,
      maxHeight: 6,
      priceHint: "$3.50/hr",
    });
    expect(coerceAttrs(fields, { evCharging: 0 })).toEqual({ evCharging: false });
  });

  it("normalises enum case and drops values outside the vocabulary", () => {
    expect(coerceAttrs(fields, { type: "GARAGE" })).toEqual({ type: "garage" });
    expect(coerceAttrs(fields, { type: "helipad" })).toEqual({});
  });

  it("skips empty and unusable values rather than storing blanks", () => {
    expect(coerceAttrs(fields, { priceHint: "", maxHeight: "abc", evCharging: "maybe", type: null })).toEqual({});
  });

  it("truncates long text and handles non-object input", () => {
    const long = "x".repeat(500);
    expect((coerceAttrs(fields, { priceHint: long }).priceHint as string).length).toBe(120);
    expect(coerceAttrs(fields, null)).toEqual({});
    expect(coerceAttrs([], { anything: 1 })).toEqual({});
  });
});

describe("slugifyKindId / parseAttrs", () => {
  it("turns a human label into a stable id", () => {
    expect(slugifyKindId("Dog water bowl")).toBe("dog_water_bowl");
    expect(slugifyKindId("  EV Charging!! ")).toBe("ev_charging");
    expect(slugifyKindId("🚰")).toBe("");
    expect(slugifyKindId("a".repeat(80)).length).toBe(32);
  });

  it("parseAttrs never throws on a stored blob", () => {
    expect(parseAttrs('{"a":1}')).toEqual({ a: 1 });
    expect(parseAttrs("[1,2]")).toEqual({});
    expect(parseAttrs("nope")).toEqual({});
    expect(parseAttrs(null)).toEqual({});
  });
});
