import { z } from "zod";

/**
 * A category/tag id. The canonical taxonomy lives in config/categories.json,
 * so this is a string (extensible) rather than a hard union. The five defaults
 * are the seed the app ships with.
 */
export type Category = string;

export const DEFAULT_CATEGORIES = ["hardware", "vc", "math", "software", "tech"] as const;
export const CATCH_ALL_CATEGORY: Category = "tech";

export const CategoryDefSchema = z.object({
  id: z.string(),
  label: z.string(),
  color: z.string().default("#8d99ae"),
  keywords: z.array(z.string()).default([]),
});
export type CategoryDef = z.infer<typeof CategoryDefSchema>;

export const CategoriesFileSchema = z.array(CategoryDefSchema);
