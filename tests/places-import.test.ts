import { describe, it, expect } from "vitest";
import { pickDataset, extractCoords, meterToPlace, offStreetToPlace, sweepingToPlace, mapRows, DATASF_SOURCES } from "../src/core/places/datasf";
import { harvestAll, harvestSource, resolveDataset, pushPlaces } from "../src/cli/import-places";
import { canIParkHere } from "../src/core/places/parking";

/**
 * DataSF → the map. Fixtures below are verbatim rows from the live endpoints
 * (columns were read off the API, not guessed), so a schema change upstream
 * shows up here as a failing mapper rather than a silently empty import.
 *
 * The two behaviours that matter most: dataset ids are RESOLVED (never
 * hardcoded, because Socrata four-by-fours change), and a bad row is SKIPPED,
 * never a reason to abort the run — the house `SourceAdapter` convention.
 */

/* ── verbatim fixtures ─────────────────────────────────────────────────────── */

const METER = {
  objectid: "16448189",
  post_id: "596-00180",
  active_meter_flag: "M",
  cap_color: "Grey",
  street_name: "OTIS ST",
  street_num: "18",
  longitude: "-122.4192517975",
  latitude: "37.772757300100004",
  shape: { type: "Point", coordinates: [-122.419251798, 37.7727573] },
};

const GARAGE = {
  the_geom: { type: "Point", coordinates: [-122.402721878953, 37.791291694643] },
  objectid: "5",
  owner: "Private",
  globalid: "{BBBC805D-852B-4BFE-AC8E-879714EE8576}",
  address_1: "235 MONTGOMERY ST",
  name2_1: "AMPCO",
  g_l_1: "G",
  onehr_1: "14",
  dailymax_1: "31",
  monopen: "500",
  monclose: "2000",
  lotgone: "0",
};

const SWEEP = {
  cnn: "8508000",
  corridor: "Lower Great Hwy",
  limits: "Lincoln Way  -  Irving St",
  blockside: "West",
  fullname: "Tue 1st, 3rd, 5th",
  weekday: "Tues",
  fromhour: "13",
  tohour: "15",
  week1: "1", week2: "0", week3: "1", week4: "0", week5: "1",
  holidays: "0",
  blocksweepid: "1645051",
  line: {
    type: "LineString",
    coordinates: [
      [-122.509833064656, 37.763969286684],
      [-122.509817375382, 37.763728972831],
      [-122.509760348572, 37.763500000000],
    ],
  },
};

const CATALOG = {
  results: [
    { resource: { id: "vqzx-t7c4", name: "SFMTA Managed Off-street Parking" }, page_views: { page_views_total: 900 } },
    { resource: { id: "mizu-nf6z", name: "SFMTA - Off-Street Parking Locations (Lots and Parking Garages)" }, page_views: { page_views_total: 4000 } },
    { resource: { id: "8vzz-qzz9", name: "Parking Meters" }, page_views: { page_views_total: 71321 } },
    { resource: { id: "yhqp-riqs", name: "Street Sweeping Schedule" }, page_views: { page_views_total: 30000 } },
  ],
};

/** A fetch double: routes by URL, records every call. */
function fakeFetch(routes: Array<[RegExp, unknown | (() => unknown)]>) {
  const calls: string[] = [];
  const f = (async (url: string) => {
    calls.push(String(url));
    for (const [re, body] of routes) {
      if (re.test(String(url))) {
        const value = typeof body === "function" ? (body as () => unknown)() : body;
        if (value instanceof Error) throw value;
        return { ok: true, status: 200, statusText: "OK", json: async () => value } as unknown as Response;
      }
    }
    return { ok: false, status: 404, statusText: "Not Found", json: async () => ({}) } as unknown as Response;
  }) as unknown as typeof fetch;
  return { f, calls };
}

/* ── the pure mappers ──────────────────────────────────────────────────────── */

describe("pickDataset — ids are resolved, never hardcoded", () => {
  it("picks the dataset whose name we actually asked for", () => {
    expect(pickDataset(CATALOG.results, "Parking Meters")!.id).toBe("8vzz-qzz9");
    expect(pickDataset(CATALOG.results, "Street Sweeping Schedule")!.id).toBe("yhqp-riqs");
    // "SFMTA Managed Off-street Parking" also mentions off-street parking; only
    // the Locations dataset carries the word we require.
    expect(pickDataset(CATALOG.results, "Off-Street Parking Locations")!.id).toBe("mizu-nf6z");
  });

  it("returns null rather than importing whatever ranked first", () => {
    expect(pickDataset(CATALOG.results, "Bicycle Parking Racks")).toBeNull();
    expect(pickDataset([], "Parking Meters")).toBeNull();
    expect(pickDataset(null, "Parking Meters")).toBeNull();
    expect(pickDataset([{ resource: { id: "not-an-id", name: "Parking Meters" } }], "Parking Meters")).toBeNull();
  });
});

describe("extractCoords", () => {
  it("reads the three geometry shapes these datasets actually use", () => {
    expect(extractCoords(METER)).toEqual({ lat: 37.772757300100004, lng: -122.4192517975 });
    expect(extractCoords(GARAGE)).toEqual({ lat: 37.791291694643, lng: -122.402721878953 });
    const mid = extractCoords(SWEEP)!; // LineString → a vertex on the block
    expect(mid.lat).toBeCloseTo(37.7637, 3);
    expect(mid.lng).toBeCloseTo(-122.5098, 3);
  });

  it("returns null for missing or out-of-region geometry", () => {
    expect(extractCoords({})).toBeNull();
    expect(extractCoords({ latitude: "abc", longitude: "def" })).toBeNull();
    expect(extractCoords({ latitude: "40.71", longitude: "-74.00" })).toBeNull(); // New York
    expect(extractCoords({ shape: { type: "Point", coordinates: [] } })).toBeNull();
  });
});

describe("row → place mappers", () => {
  it("maps an active general-purpose meter", () => {
    const p = meterToPlace(METER)!;
    expect(p).toMatchObject({ externalRef: "datasf:meter:596-00180", kindId: "parking", address: "18 Otis St" });
    expect(p.name).toBe("18 Otis St (meter)");
    expect(p.attrs).toEqual({ type: "street" });
  });

  it("skips meters a founder can't use — inactive, or a coloured cap", () => {
    expect(meterToPlace({ ...METER, active_meter_flag: "U" })).toBeNull();
    expect(meterToPlace({ ...METER, cap_color: "Red" })).toBeNull(); // bus zone
    expect(meterToPlace({ ...METER, cap_color: "Blue" })).toBeNull(); // accessible only
    expect(meterToPlace({ ...METER, post_id: "" })).toBeNull();
    expect(meterToPlace({ ...METER, latitude: undefined, longitude: undefined, shape: undefined })).toBeNull();
  });

  it("maps a garage with its hours and price hint", () => {
    const p = offStreetToPlace(GARAGE)!;
    expect(p.externalRef).toBe("datasf:offstreet:{BBBC805D-852B-4BFE-AC8E-879714EE8576}");
    expect(p.name).toBe("Ampco");
    expect(p.address).toBe("235 Montgomery St");
    expect(p.attrs).toEqual({ type: "garage", hours: "05:00-20:00", priceHint: "$14/hr · $31/day" });
    // and the mapped attrs feed straight into the legality engine
    const shut = canIParkHere({ attrs: p.attrs as any }, "2026-07-27T09:00:00.000Z"); // 02:00 PDT
    expect(shut.legal).toBe(false);
    expect(shut.reason).toMatch(/closed/i);
  });

  it("marks a lot as a lot, drops a lot that's gone, and copes with missing prices", () => {
    expect(offStreetToPlace({ ...GARAGE, g_l_1: "L" })!.attrs!.type).toBe("lot");
    expect(offStreetToPlace({ ...GARAGE, lotgone: "1" })).toBeNull();
    const bare = offStreetToPlace({ ...GARAGE, onehr_1: "0", dailymax_1: "0", monopen: "0", monclose: "0" })!;
    expect(bare.attrs).toEqual({ type: "garage" });
  });

  it("maps a swept block-side, including the 1st/3rd/5th week schedule", () => {
    const p = sweepingToPlace(SWEEP)!;
    expect(p.externalRef).toBe("datasf:sweep:1645051");
    expect(p.name).toBe("Lower Great Hwy · West side");
    expect(p.attrs).toEqual({ type: "street", sweepDay: "Tues", sweepWindow: "13:00-15:00", sweepWeeks: [1, 3, 5] });
    // 2026-07-14 is the 2nd Tuesday → not swept, so parking is legal mid-window
    expect(canIParkHere({ attrs: p.attrs as any }, "2026-07-14T21:00:00.000Z").legal).toBe(true);
    // 2026-07-07 is the 1st Tuesday → swept
    expect(canIParkHere({ attrs: p.attrs as any }, "2026-07-07T21:00:00.000Z").legal).toBe(false);
  });

  it("omits sweepWeeks when every week is swept (absent ⇒ weekly)", () => {
    const weekly = sweepingToPlace({ ...SWEEP, week1: "1", week2: "1", week3: "1", week4: "1", week5: "1" })!;
    expect(weekly.attrs!.sweepWeeks).toBeUndefined();
  });

  it("skips a sweeping row with no usable schedule or geometry", () => {
    expect(sweepingToPlace({ ...SWEEP, fromhour: "", tohour: "" })).toBeNull();
    expect(sweepingToPlace({ ...SWEEP, weekday: "" })).toBeNull();
    expect(sweepingToPlace({ ...SWEEP, line: undefined })).toBeNull();
    expect(sweepingToPlace({ ...SWEEP, blocksweepid: "", cnn: "" })).toBeNull();
  });

  it("mapRows counts skips instead of throwing, even on a hostile row", () => {
    const meters = DATASF_SOURCES.find((s) => s.key === "meters")!;
    const res = mapRows(meters, [METER, {}, { post_id: "x" }, null as any]);
    expect(res.items.length).toBe(1);
    expect(res.skipped).toBe(3);
  });
});

/* ── the harvest, driven by a fetch double ─────────────────────────────────── */

describe("harvest", () => {
  const meters = DATASF_SOURCES.find((s) => s.key === "meters")!;

  it("resolves the dataset id from the catalog at runtime", async () => {
    const { f, calls } = fakeFetch([[/api\/catalog/, CATALOG]]);
    const ds = await resolveDataset(meters, { fetchImpl: f });
    expect(ds).toEqual({ id: "8vzz-qzz9", name: "Parking Meters" });
    expect(calls[0]).toContain("data.sfgov.org");
    expect(calls[0]).not.toContain("8vzz-qzz9"); // the id came from the catalog, not from us
  });

  it("pages until the source runs out and never hardcodes an id", async () => {
    let page = 0;
    const { f } = fakeFetch([
      [/resource\/8vzz-qzz9/, () => (page++ === 0 ? [METER, METER, { ...METER, post_id: "596-00181" }] : [])],
    ]);
    const res = await harvestSource(meters, "8vzz-qzz9", { fetchImpl: f, pageSize: 3, limit: 6 });
    expect(res.items.length).toBe(3);
    expect(res.skipped).toBe(0);
  });

  it("one unreachable source never sinks the run", async () => {
    const { f } = fakeFetch([
      [/api\/catalog.*meters/, CATALOG],
      [/api\/catalog/, () => new Error("ECONNRESET")],
      [/resource\/8vzz-qzz9/, [METER]],
    ]);
    const report = await harvestAll({ fetchImpl: f, pageSize: 500, limit: 500 });
    expect(report.items.length).toBe(1);
    expect(report.bySource.meters).toMatchObject({ dataset: "8vzz-qzz9", got: 1 });
    expect(report.failed).toContain("sweeping");
    expect(report.bySource.sweeping!.error).toBeTruthy();
  });

  it("de-dupes external_refs across sources so one payload can't self-conflict", async () => {
    const { f } = fakeFetch([
      [/api\/catalog/, CATALOG],
      [/resource\/8vzz-qzz9/, [METER, METER]],
      [/resource\/mizu-nf6z/, []],
      [/resource\/yhqp-riqs/, []],
    ]);
    const report = await harvestAll({ fetchImpl: f, pageSize: 500, limit: 500 });
    expect(report.items.filter((i) => i.externalRef === "datasf:meter:596-00180").length).toBe(1);
  });

  it("skips a source the catalog can't confidently match rather than importing the wrong table", async () => {
    const { f } = fakeFetch([[/api\/catalog/, { results: [{ resource: { id: "aaaa-bbbb", name: "Tree Canopy Survey" } }] }]]);
    const report = await harvestAll({ fetchImpl: f, limit: 10 });
    expect(report.items).toEqual([]);
    expect(report.failed.length).toBe(DATASF_SOURCES.length);
    expect(report.bySource.meters!.error).toMatch(/no confident/i);
  });
});

describe("pushPlaces", () => {
  it("chunks the push and totals the server's counts", async () => {
    const bodies: any[] = [];
    const f = (async (_url: string, init: any) => {
      const body = JSON.parse(init.body);
      bodies.push(body);
      return { ok: true, status: 200, json: async () => ({ inserted: body.places.length, updated: 0, skipped: 0 }) } as unknown as Response;
    }) as unknown as typeof fetch;
    const items = Array.from({ length: 250 }, (_, i) => ({ externalRef: `r${i}`, kindId: "parking", lat: 37.77, lng: -122.41 }));
    const res = await pushPlaces(items, { url: "https://thebay.events/", token: "tok", fetchImpl: f, chunk: 100 });
    expect(res).toMatchObject({ inserted: 250, failedChunks: 0 });
    expect(bodies.length).toBe(3);
    expect(bodies[0].places.length).toBe(100);
  });

  it("fails loudly on a bad token instead of retrying forever", async () => {
    const f = (async () => ({ ok: false, status: 401, json: async () => ({}) }) as unknown as Response) as unknown as typeof fetch;
    await expect(pushPlaces([{ externalRef: "r", kindId: "parking", lat: 37.77, lng: -122.41 }], { url: "https://x", token: "bad", fetchImpl: f })).rejects.toThrow(/unauthorized/i);
  });
});
