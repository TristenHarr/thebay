/**
 * Identity, badges, and the schema invariants behind them.
 *
 * The snapshot tests matter more than they look: `founderStats` has been unit tested since the
 * XP module was written and wired to NOTHING, so this is the first time its inputs have ever
 * been assembled from real tables. Several fields had no query in the codebase at all, and two
 * have a non-obvious source — see the comments.
 */
import { describe, it, expect, beforeEach } from "vitest";
import type Database from "better-sqlite3";
import { makeTestDb } from "./helpers/d1";
import { IdentityRepo } from "../src/storage/d1/identity-repo";
import { SocialRepo } from "../src/storage/d1/social-repo";
import { FOUNDER_TYPES } from "../src/core/types/chart";

let d1: any, raw: Database.Database, ident: IdentityRepo, social: SocialRepo;
const AT = "2026-07-01T18:00:00Z";

beforeEach(() => {
  ({ d1, raw } = makeTestDb());
  ident = new IdentityRepo(d1);
  social = new SocialRepo(d1);
});

const mkUser = async (email: string) =>
  (await social.upsertByIdentity({ provider: "dev", providerUid: email, email, displayName: email.split("@")[0]! })).id;

function mkEvent(id: string, hostId: string | null = null) {
  raw
    .prepare(
      `INSERT INTO events (id,fingerprint,title,start_utc,timezone,city,url,categories,content_hash,host_user_id,first_seen_at,last_seen_at)
       VALUES (?,?,?,?,'America/Los_Angeles','sf-bay',?,'[]',?,?,?,?)`,
    )
    .run(id, `fp-${id}`, `Event ${id}`, AT, `https://x/${id}`, `ch-${id}`, hostId, AT, AT);
}

describe("the seeded type chart", () => {
  it("matches src/core/types/chart.ts exactly", async () => {
    // The table is the source of truth for the renderer; the module is the source of truth for
    // affinity. If they drift, a type renders with one colour and scores as another.
    const rows = await ident.types();
    expect(rows.map((t) => t.id)).toEqual(FOUNDER_TYPES.map((t) => t.id));
    for (const t of FOUNDER_TYPES) {
      const row = rows.find((r) => r.id === t.id)!;
      expect(row.label, t.id).toBe(t.label);
      expect(row.emoji, t.id).toBe(t.emoji);
      expect(row.color.toLowerCase(), t.id).toBe(t.color.toLowerCase());
      expect(row.crowdKey, t.id).toBe(t.crowd);
    }
  });
});

describe("declaring a type", () => {
  it("stores a primary and an optional secondary", async () => {
    const ann = await mkUser("a@x.com");
    await ident.declare(ann, "founder", "engineer");
    expect(await ident.identity(ann)).toMatchObject({ typeId: "founder", type2Id: "engineer" });
    await ident.declare(ann, "vc", null);
    expect(await ident.identity(ann)).toMatchObject({ typeId: "vc", type2Id: null });
  });

  it("REFUSES a made-up type — the FK is what makes the vocabulary closed", async () => {
    const ann = await mkUser("a@x.com");
    await expect(ident.declare(ann, "timelord", null)).rejects.toThrow();
  });

  it("refuses the same type twice on one card", async () => {
    const ann = await mkUser("a@x.com");
    await expect(ident.declare(ann, "founder", "founder")).rejects.toThrow();
  });
});

describe("vouching", () => {
  it("counts one vouch per voucher", async () => {
    const ann = await mkUser("a@x.com");
    const bob = await mkUser("b@x.com");
    const cid = await mkUser("c@x.com");
    expect(await ident.vouch(ann, bob, "vc")).toBe(true);
    expect(await ident.vouch(ann, bob, "vc"), "a second vouch from the same person is a no-op").toBe(false);
    await ident.vouch(ann, cid, "vc");
    expect((await ident.identity(ann)).vouches).toEqual({ vc: 2 });
  });

  it("REFUSES a self-vouch — a gate you walk through alone is decorative", async () => {
    const ann = await mkUser("a@x.com");
    expect(await ident.vouch(ann, ann, "vc")).toBe(false);
    // …and the schema refuses it too, without any help from the repo.
    expect(() =>
      raw.prepare("INSERT INTO founder_type_vouches (user_id,voucher_id,type_id,created_at) VALUES (?,?,'vc',?)").run(ann, ann, AT),
    ).toThrow();
  });

  it("grants no XP and no points — a vouch is a tick on a card and nothing else", async () => {
    const ann = await mkUser("a@x.com");
    const bob = await mkUser("b@x.com");
    await ident.vouch(ann, bob, "vc");
    for (const table of ["xp_ledger", "points_ledger"]) {
      const n = (raw.prepare(`SELECT COUNT(*) n FROM ${table} WHERE user_id=?`).get(ann) as any).n;
      expect(n, `a vouch wrote to ${table}`).toBe(0);
    }
  });
});

describe("the snapshot — founderStats' inputs, assembled for the first time", () => {
  it("reads interests from match_prefs, which nothing read before", async () => {
    const ann = await mkUser("a@x.com");
    raw
      .prepare("INSERT INTO match_prefs (user_id, technical, interests_json, updated_at) VALUES (?,1,?,?)")
      .run(ann, JSON.stringify(["vc", "seed", "angel"]), AT);

    const { snapshot } = await ident.snapshot(ann);
    expect(snapshot.technical).toBe(true);
    expect(snapshot.interests).toEqual(["vc", "seed", "angel"]);
  });

  it("counts lifetime shadows from the POINTS ledger, not the shadows table", async () => {
    // A shadow is deleted when its author posts another and purged 24h after expiry, so the
    // table holds at most one row per person. The once-per-day points row is the only record.
    const ann = await mkUser("a@x.com");
    for (const day of ["2026-07-01", "2026-07-02", "2026-07-03"]) {
      raw
        .prepare("INSERT INTO points_ledger (id,user_id,kind,points,dedup_key,created_at) VALUES (?,?,'shadow',4,?,?)")
        .run(`p${day}`, ann, `shadow:${ann}:${day}`, day);
    }
    expect((await ident.snapshot(ann)).snapshot.shadows).toBe(3);
  });

  it("counts friends from either side of the pair, and only accepted ones", async () => {
    const ann = await mkUser("a@x.com");
    const bob = await mkUser("b@x.com");
    const cid = await mkUser("c@x.com");
    const pair = (x: string, y: string) => (x < y ? [x, y] : [y, x]);
    for (const [other, status] of [[bob, "accepted"], [cid, "pending"]] as const) {
      const [lo, hi] = pair(ann, other);
      raw
        .prepare("INSERT INTO friendships (user_low,user_high,status,requested_by,created_at,updated_at) VALUES (?,?,?,?,?,?)")
        .run(lo, hi, status, ann, AT, AT);
    }
    expect((await ident.snapshot(ann)).snapshot.friends).toBe(1);
  });

  it("derives the level from the XP total and returns the total separately", async () => {
    const ann = await mkUser("a@x.com");
    raw.prepare("INSERT INTO xp_ledger (id,user_id,kind,xp,dedup_key,created_at) VALUES ('x1',?,'gym',900,'k1',?)").run(ann, AT);
    const { snapshot, xpTotal } = await ident.snapshot(ann);
    expect(xpTotal).toBe(900);
    expect(snapshot.level).toBe(4);
  });

  it("is total for an account with nothing on it", async () => {
    const ann = await mkUser("a@x.com");
    const { snapshot } = await ident.snapshot(ann);
    expect(snapshot.interests).toEqual([]);
    expect(snapshot.reviewAvg).toBeNull();
    for (const k of ["friends", "introsMade", "points", "streakBest", "shadows", "checkins"] as const) {
      expect(snapshot[k], k).toBe(0);
    }
  });
});

describe("host-minted badges", () => {
  async function gym() {
    const host = await mkUser("h@x.com");
    mkEvent("e1", host);
    return host;
  }

  it("mints, then awards, writing into the reserved namespace", async () => {
    const host = await gym();
    const ann = await mkUser("a@x.com");
    const m = await ident.mintBadge("e1", host, { label: "Best Demo", emoji: "🏅" });
    expect(m.result).toBe("ok");

    expect(await ident.awardBadge(ann, m.badgeId!)).toBe(true);
    expect(await ident.awardBadge(ann, m.badgeId!), "awarding twice is a no-op").toBe(false);
    const kind = (raw.prepare("SELECT kind FROM achievements WHERE user_id=?").get(ann) as any).kind;
    expect(kind).toBe(`gym:${m.badgeId}`);
  });

  it("REFUSES a badge named after a system trophy", async () => {
    const host = await gym();
    expect((await ident.mintBadge("e1", host, { label: "Local Legend", emoji: "🏅" })).result).toBe("reserved");
    expect((await ident.mintBadge("e1", host, { label: "L0cal-Legend!", emoji: "🏅" })).result).toBe("reserved");
  });

  it("refuses a second badge with the same slug at one event", async () => {
    const host = await gym();
    expect((await ident.mintBadge("e1", host, { label: "Best Demo", emoji: "🏅" })).result).toBe("ok");
    expect((await ident.mintBadge("e1", host, { label: "best demo", emoji: "🎖️" })).result).toBe("duplicate");
  });

  it("hydrates a held badge with the provenance that stops it posing as a trophy", async () => {
    const host = await gym();
    const ann = await mkUser("a@x.com");
    const m = await ident.mintBadge("e1", host, { label: "Best Demo", emoji: "🏅" });
    await ident.awardBadge(ann, m.badgeId!);

    const [badge] = await ident.badges(ann);
    expect(badge!.label).toBe("Best Demo");
    // `awardedBy` is the host's HANDLE, which `upsertByIdentity` uniquifies — so assert
    // against the real one rather than guessing it from the display name.
    const hostHandle = (raw.prepare("SELECT handle FROM users WHERE id = ?").get(host) as any).handle;
    expect(badge!.awardedBy).toBe(hostHandle);
    expect(badge!.eventTitle).toBe("Event e1");
  });

  it("stops rendering a hidden badge without deleting the grant", async () => {
    const host = await gym();
    const ann = await mkUser("a@x.com");
    const m = await ident.mintBadge("e1", host, { label: "Best Demo", emoji: "🏅" });
    await ident.awardBadge(ann, m.badgeId!);
    await ident.hideBadge(m.badgeId!);

    expect(await ident.badges(ann)).toEqual([]);
    // The grant survives — it is a true record of something a host actually did.
    expect((raw.prepare("SELECT COUNT(*) n FROM achievements WHERE user_id=?").get(ann) as any).n).toBe(1);
  });

  it("REFUSES any namespace but gym: — enforced by the schema, not the repo", async () => {
    const ann = await mkUser("a@x.com");
    expect(() =>
      raw
        .prepare("INSERT INTO achievements (id,user_id,kind,dedup_key,meta_json,awarded_at) VALUES ('x',?,'trophy:legendary','k','{}',?)")
        .run(ann, AT),
    ).toThrow(/namespaced/i);
    // A bare canonical kind is still fine.
    raw.prepare("INSERT INTO achievements (id,user_id,kind,dedup_key,meta_json,awarded_at) VALUES ('y',?,'first_review','k2','{}',?)").run(ann, AT);
  });
});

describe("the card", () => {
  it("assembles types, badges, level and rarity for a real user", async () => {
    const host = await mkUser("h@x.com");
    const ann = await mkUser("a@x.com");
    const bob = await mkUser("b@x.com");
    mkEvent("e1", host);
    await ident.declare(ann, "founder", "engineer");
    await ident.vouch(ann, bob, "founder");
    raw.prepare("INSERT INTO xp_ledger (id,user_id,kind,xp,dedup_key,created_at) VALUES ('x1',?,'gym',900,'k1',?)").run(ann, AT);
    const m = await ident.mintBadge("e1", host, { label: "Best Demo", emoji: "🏅" });
    await ident.awardBadge(ann, m.badgeId!);

    const card = (await ident.card(ann))!;
    expect(card.displayName).toBe("a");
    expect(card.level.level).toBe(4);
    expect(card.types.map((t) => t.id)).toEqual(["founder", "engineer"]);
    expect(card.types[0]!.vouches).toBe(1);
    expect(card.badges).toHaveLength(1);
    // A host badge is not a system trophy, so it must not inflate the trophy count.
    expect(card.trophies).toBe(0);
    expect(card.tagline.trim()).not.toBe("");
  });

  it("returns null for an unknown user", async () => {
    expect(await ident.card("nope")).toBeNull();
  });
});
