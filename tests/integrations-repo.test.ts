import { describe, it, expect, beforeEach } from "vitest";
import { makeTestDb } from "./helpers/d1";
import { IntegrationsRepo } from "../src/storage/d1/integrations-repo";
import { SocialRepo } from "../src/storage/d1/social-repo";

let d1: any;
let integrations: IntegrationsRepo;
let social: SocialRepo;

beforeEach(() => {
  ({ d1 } = makeTestDb());
  integrations = new IntegrationsRepo(d1);
  social = new SocialRepo(d1);
});

async function mkUser(email: string, name: string, socialEnabled = true) {
  const u = await social.upsertByIdentity({ provider: "dev", providerUid: email, email, displayName: name });
  if (socialEnabled) await social.updateProfile(u.id, { socialEnabled: true });
  return (await social.getUserById(u.id))!;
}
const conn = (email: string, name: string) => ({ externalId: `li:${email || name}`, kind: "connection", payload: { name, email } });

describe("people-you-may-know: imported connections → platform members", () => {
  it("matches connections to Bay members by email; excludes self, existing friends, non-members, and no-email rows", async () => {
    const me = await mkUser("me@x.com", "Me");
    const alice = await mkUser("alice@x.com", "Alice"); // on the platform, not yet a friend → SUGGEST
    const bob = await mkUser("bob@x.com", "Bob");       // on the platform but already my friend → exclude
    const carol = await mkUser("carol@x.com", "Carol", /* socialEnabled */ false); // opted out → exclude
    await mkUser("erin@x.com", "Erin");                 // on the platform but NOT in my imports → exclude

    // I'm already friends with Bob
    await social.requestFriend(me.id, bob.id);
    await social.respondFriend(bob.id, me.id, true);

    await integrations.importItems(me.id, "linkedin", [
      conn("alice@x.com", "Alice A"),
      conn("bob@x.com", "Bob B"),
      conn("carol@x.com", "Carol C"),
      conn("dave@x.com", "Dave D"),   // no platform account → exclude
      conn("me@x.com", "My Other Self"), // my own email → exclude
      conn("", "No Email Person"),    // no email → exclude
    ]);

    const sugg = await integrations.suggestionsFromImports(me.id);
    expect(sugg.map((s) => s.displayName)).toEqual(["Alice"]);
    expect(sugg[0]).toMatchObject({ id: alice.id, handle: alice.handle, provider: "linkedin" });
    // the matched-on name from the CSV is surfaced for context
    expect(sugg[0]?.matchedName).toBe("Alice A");
    // carol (opted out) and bob (already a friend) must not appear
    expect(sugg.find((s) => s.id === carol.id)).toBeUndefined();
    expect(sugg.find((s) => s.id === bob.id)).toBeUndefined();
  });

  it("email match is case-insensitive and de-duplicates a member imported twice", async () => {
    const me = await mkUser("me@x.com", "Me");
    const alice = await mkUser("alice@x.com", "Alice");
    await integrations.importItems(me.id, "luma", [
      { externalId: "a1", kind: "connection", payload: { name: "Alice One", email: "ALICE@X.COM" } },
      { externalId: "a2", kind: "connection", payload: { name: "Alice Two", email: "Alice@x.com" } },
    ]);
    const sugg = await integrations.suggestionsFromImports(me.id);
    expect(sugg.filter((s) => s.id === alice.id).length).toBe(1); // deduped despite two import rows / mixed case
  });

  it("a pending (not-yet-accepted) friend request also suppresses the suggestion", async () => {
    const me = await mkUser("me@x.com", "Me");
    const alice = await mkUser("alice@x.com", "Alice");
    await social.requestFriend(me.id, alice.id); // pending, not accepted
    await integrations.importItems(me.id, "linkedin", [conn("alice@x.com", "Alice A")]);
    expect(await integrations.suggestionsFromImports(me.id)).toEqual([]);
  });
});
