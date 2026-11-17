/**
 * Catalog search and facets: the browse grid filters over names, titles, and
 * purposes with the shared multilingual matcher, and narrows by one exact
 * category facet first, so a query finds the same entry the picker lists.
 */
import { TextSearchIndex } from '@deepseek-ai/dsh-util-text-search'
import type { PlazaSkillEntry } from '@deepseek-ai/dsh-skill-plaza/types'

/**
 * Filter published skills by one user query.
 * @param entries - published skills the surface listed.
 * @param query - user search text; blank returns every entry in list order.
 * @returns matching entries in the list's own order.
 */
export function filterSkills(
  entries: readonly PlazaSkillEntry[],
  query: string,
): readonly PlazaSkillEntry[] {
  const trimmed = query.trim()
  if (trimmed === '') return entries
  // Names and titles match fuzzily from a word start; the purpose is prose and
  // matches as a contiguous substring.
  const index = new TextSearchIndex(entries, entry => ({
    fuzzy: [entry.slug, entry.title],
    substring: [entry.description],
  }))
  return index.search(trimmed)
}

/**
 * Narrow published skills to one exact category.
 * @param entries - published skills the surface listed.
 * @param category - category to keep; omission keeps every entry.
 * @returns entries of that category in the list's own order.
 */
export function filterCategory(
  entries: readonly PlazaSkillEntry[],
  category: string | undefined,
): readonly PlazaSkillEntry[] {
  if (category === undefined) return entries
  return entries.filter(entry => entry.category === category)
}

/**
 * Categories the catalog offers, sorted for a stable chip row.
 * @param entries - published skills the surface listed.
 * @returns distinct non-empty category names.
 */
export function categoriesOf(entries: readonly PlazaSkillEntry[]): readonly string[] {
  const names = new Set<string>()
  for (const entry of entries) {
    if (entry.category === undefined || entry.category.trim() === '') continue
    names.add(entry.category)
  }
  return [...names].sort((a, b) => a.localeCompare(b))
}
