import { describe, it, expect } from "vitest";
import { getPath, asString } from "../src/util/object";

describe("getPath — dotted path resolver (backbone of generic-json + adapters)", () => {
  const obj = { a: { b: { c: 42 } }, list: [{ x: 1 }, { x: 2 }], nullish: null };
  it("resolves nested paths and array indices", () => {
    expect(getPath(obj, "a.b.c")).toBe(42);
    expect(getPath(obj, "list.1.x")).toBe(2);
    expect(getPath(obj, "")).toBe(obj); // empty path → the object itself
  });
  it("is null-safe: a missing or null segment yields undefined, never throws", () => {
    expect(getPath(obj, "a.z.c")).toBeUndefined();
    expect(getPath(obj, "nullish.deep")).toBeUndefined();
    expect(getPath(null, "a.b")).toBeUndefined();
    expect(getPath(undefined, "a")).toBeUndefined();
  });
});

describe("asString — safe scalar coercion", () => {
  it("passes strings, stringifies numbers/booleans, drops everything else", () => {
    expect(asString("hi")).toBe("hi");
    expect(asString(7)).toBe("7");
    expect(asString(0)).toBe("0");
    expect(asString(true)).toBe("true");
    expect(asString(null)).toBeUndefined();
    expect(asString(undefined)).toBeUndefined();
    expect(asString({ a: 1 })).toBeUndefined();
    expect(asString(["x"])).toBeUndefined();
  });
});
