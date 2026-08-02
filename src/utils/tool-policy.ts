/**
 * Tool policy name lists (`allowedTools` / `disallowedTools`) arrive from caller input and
 * from the session record, so both the session layer and the query consumer compare against
 * them. Normalizing in one place keeps those comparisons using the same notion of equality.
 */
export function normalizeToolPolicyNames(values: string[] | undefined): string[] {
  if (!Array.isArray(values) || values.length === 0) return [];
  return values
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter((value) => value !== "");
}
