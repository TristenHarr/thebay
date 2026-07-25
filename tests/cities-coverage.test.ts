import { describe, it, expect } from "vitest";
import { loadCities } from "../src/config/load";
import { createNormalizer } from "../src/core/normalize/normalize";
import { inBay } from "../src/core/geo";

// Test against the REAL config/cities.json so the alias list is what actually ships.
const normalize = createNormalizer(loadCities());
const NOW = new Date("2026-07-25T00:00:00Z");

function cityOf(address: string): string | undefined {
  return normalize(
    { sourceId: "t", sourceType: "test", externalId: "x", title: "Test Event", url: "https://x/e", startRaw: "2026-08-01T18:00:00Z", address },
    NOW,
  )?.city;
}

describe("geographic coverage — every real Bay + Santa Cruz city resolves to sf-bay", () => {
  // Santa Cruz county — the explicit ask, plus cities that were leaking to "unknown".
  const inRegion: Array<[string, string]> = [
    ["Santa Cruz", "Pleasure Pizza, 1415 Pacific Ave, Santa Cruz, CA 95060, USA"],
    ["Capitola", "820 Bay Ave, Capitola, CA 95010, USA"],
    ["Scotts Valley", "5060 Scotts Valley Dr, Scotts Valley, CA 95066, USA"],
    ["Watsonville", "18 W Lake Ave, Watsonville, CA 95076, USA"],
    ["Aptos", "7605 Old Dominion Ct, Aptos, CA 95003, USA"],
    ["Soquel", "4724 Soquel Dr, Soquel, CA 95073, USA"],
    ["Felton", "6191 Highway 9, Felton, CA 95018, USA"],
    // Bay cities that were resolving to "unknown" in production data:
    ["Corte Madera", "645 Tamalpais Drive, Corte Madera, CA 94925, USA"],
    ["Napa", "1331 1st Street, Napa, CA 94559, USA"],
    ["Sausalito", "944 Fort Barry, Sausalito, CA 94965, USA"],
    ["San Rafael", "1100 4th St, San Rafael, CA 94901, USA"],
    ["Novato", "7th St, Novato, CA 94945, USA"],
    ["Petaluma", "100 Petaluma Blvd, Petaluma, CA 94952, USA"],
    ["Santa Rosa", "50 Old Courthouse Sq, Santa Rosa, CA 95404, USA"],
    ["Vallejo", "1 Marina Way, Vallejo, CA 94590, USA"],
    ["Antioch", "1 I Street, Antioch, CA 94509, USA"],
    ["Healdsburg", "1340 Healdsburg Avenue, Healdsburg, CA 95448, USA"],
    ["Gilroy", "7471 Monterey St, Gilroy, CA 95020, USA"],
  ];
  for (const [name, addr] of inRegion) {
    it(`${name} → sf-bay`, () => expect(cityOf(addr)).toBe("sf-bay"));
  }

  it("genuinely out-of-region addresses stay 'unknown' (not lumped into the Bay)", () => {
    expect(cityOf("Shore Road, Brodick, KA27 8DL")).toBe("unknown"); // Scotland
    expect(cityOf("102 North Avenue, Wake Forest, NC 27587, USA")).toBe("unknown"); // North Carolina
    expect(cityOf("For venue details reach us at: Savannah, GA 31401")).toBe("unknown"); // Georgia
    expect(cityOf("Kiosko, Campeche, CAM 24040")).toBe("unknown"); // Mexico
  });

  it("Santa Cruz-county coordinates are inside the Bay geo-fence", () => {
    expect(inBay(36.9741, -122.0308)).toBe(true); // Santa Cruz
    expect(inBay(36.9102, -121.7569)).toBe(true); // Watsonville
    expect(inBay(37.0058, -121.5683)).toBe(true); // Gilroy
    expect(inBay(51.55, -5.15)).toBe(false); // Brodick, Scotland — stays out
  });
});
