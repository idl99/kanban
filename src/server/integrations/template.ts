const VARIABLE = /\{\{\s*([\w.-]+)\s*\}\}/g;

/** The `{{names}}` the instructions use, once each. */
export function usedVariables(text: string): string[] {
  return [...new Set([...text.matchAll(VARIABLE)].map((m) => m[1]))];
}

/** Fills `{{name}}` from vars (missing value: empty text). Unknown names stay as typed so a typo is visible. */
export function render(text: string, vars: Record<string, string>): string {
  return text.replace(VARIABLE, (whole, name: string) => (name in vars ? vars[name] ?? "" : whole));
}
