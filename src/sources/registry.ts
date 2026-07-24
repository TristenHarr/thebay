import type { SourceAdapter } from "./types";
import { icalAdapter } from "./ical";
import { lumaAdapter } from "./luma";
import { eventbriteAdapter } from "./eventbrite";
import { airtableAdapter } from "./airtable";
import { genericJsonAdapter } from "./generic-json";
import { htmlAdapter } from "./html";
import { partifulAdapter } from "./partiful";

/* eslint-disable @typescript-eslint/no-explicit-any */
const adapters = new Map<string, SourceAdapter<any>>();

function register(a: SourceAdapter<any>): void {
  adapters.set(a.type, a);
}

[
  icalAdapter,
  lumaAdapter,
  eventbriteAdapter,
  airtableAdapter,
  partifulAdapter,
  genericJsonAdapter,
  htmlAdapter,
].forEach(register);

export function getAdapter(type: string): SourceAdapter<any> {
  const a = adapters.get(type);
  if (!a) throw new Error(`No source adapter registered for type "${type}"`);
  return a;
}

export function hasAdapter(type: string): boolean {
  return adapters.has(type);
}

export function listAdapterTypes(): string[] {
  return [...adapters.keys()];
}
