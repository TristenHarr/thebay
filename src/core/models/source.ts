import { z } from "zod";

export const SourceConfigSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  enabled: z.boolean().default(true),
  note: z.string().optional(),
  params: z.record(z.string(), z.unknown()).default({}),
});
export type SourceConfig<P = Record<string, unknown>> = {
  id: string;
  type: string;
  enabled: boolean;
  note?: string;
  params: P;
};

export const SourcesFileSchema = z.array(SourceConfigSchema);

export const CityDefSchema = z.object({
  id: z.string(),
  label: z.string(),
  timezone: z.string(),
  latitude: z.number().optional(),
  longitude: z.number().optional(),
  aliases: z.array(z.string()).default([]),
});
export type CityDef = z.infer<typeof CityDefSchema>;
export const CitiesFileSchema = z.array(CityDefSchema);

export const UNKNOWN_CITY = "unknown";
