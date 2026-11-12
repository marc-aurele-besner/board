// recipes.json: the Kitchen section (js/modules/kitchen.js).

// One attempt at a recipe.
export interface RecipeVersion {
  id: string;
  // YYYY-MM-DD
  date: string;
  changes: string;
  // 1-5, or null when not rated.
  rating: number | null;
  notes: string;
}

export interface Recipe {
  id: string;
  title: string;
  // 'idea' | 'testing' | 'final'
  status: string;
  tags: string[];
  ingredients: string[];
  steps: string[];
  notes: string;
  // The page an imported recipe was read from.
  source?: string;
  // Picture URLs of an imported recipe.
  images?: string[];
  // Data-folder paths (recipes/) of the photos a recipe was read from.
  scans?: string[];
  versions: RecipeVersion[];
  created: string;
}

export interface RecipesData {
  recipes: Recipe[];
  // Written by the store on save.
  schemaVersion?: number;
}
