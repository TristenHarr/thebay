import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  SourcesFileSchema,
  CitiesFileSchema,
  type SourceConfig,
  type CityDef,
} from "../core/models/source";
import { CategoriesFileSchema, type CategoryDef } from "../core/models/category";

const CONFIG_DIR = resolve(process.cwd(), "config");

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(resolve(CONFIG_DIR, file), "utf8"));
}

export function loadSources(): SourceConfig[] {
  return SourcesFileSchema.parse(readJson("sources.json")) as SourceConfig[];
}

export function loadCities(): CityDef[] {
  return CitiesFileSchema.parse(readJson("cities.json"));
}

export function loadCategories(): CategoryDef[] {
  return CategoriesFileSchema.parse(readJson("categories.json"));
}
