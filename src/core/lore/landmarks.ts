/**
 * SF-Bay founder/VC landmarks — the "lore" of the map. Rendered as billboard
 * monuments (the museum layer) and offered as ready-made stops when you plan a
 * founder crawl. Curated + config-driven: add a landmark here and it appears on the
 * map and in the crawl planner with no other code change. Coordinates are approximate
 * — this is game lore, not a survey.
 */
export interface Landmark {
  id: string;
  name: string;
  lat: number;
  lng: number;
  emoji: string;
  blurb: string;
}

export const LANDMARKS: Landmark[] = [
  { id: "shack15", name: "SHACK15", lat: 37.7955, lng: -122.3937, emoji: "🏛", blurb: "Founder clubhouse in the Ferry Building's grand hall." },
  { id: "frontier-tower", name: "Frontier Tower", lat: 37.7816, lng: -122.4108, emoji: "🗼", blurb: "Sixteen floors of frontier tech, stacked vertically." },
  { id: "founders-inc", name: "Founders Inc", lat: 37.8065, lng: -122.43, emoji: "⚓", blurb: "Builders' harbor at Fort Mason — hardware, ships, startups." },
  { id: "south-park-commons", name: "South Park Commons", lat: 37.7815, lng: -122.3949, emoji: "🌳", blurb: "The commons where pre-idea founders gather." },
  { id: "openai", name: "OpenAI", lat: 37.7626, lng: -122.4147, emoji: "🧠", blurb: "The Pioneer Building — where the models are raised." },
  { id: "anthropic", name: "Anthropic", lat: 37.7857, lng: -122.3996, emoji: "📐", blurb: "Constitutional AI, from the heart of SoMa." },
  { id: "github", name: "GitHub HQ", lat: 37.7823, lng: -122.3925, emoji: "🐙", blurb: "Where the world's code comes home." },
  { id: "the-battery", name: "The Battery", lat: 37.7969, lng: -122.4033, emoji: "🔋", blurb: "The members' club the whole valley networks in." },
  { id: "sequoia", name: "Sequoia Capital", lat: 37.422, lng: -122.205, emoji: "🌲", blurb: "The redwood on Sand Hill Road." },
  { id: "a16z", name: "Andreessen Horowitz", lat: 37.453, lng: -122.1817, emoji: "💸", blurb: "Software is eating the world — from right here." },
  { id: "yc", name: "Y Combinator", lat: 37.4192, lng: -122.0785, emoji: "🟧", blurb: "The orange batch factory in Mountain View." },
];

export const landmarkById = (id: string): Landmark | undefined => LANDMARKS.find((l) => l.id === id);
