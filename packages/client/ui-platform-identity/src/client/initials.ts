/** First visible character of a platform display name, for the generated avatar. */

/**
 * Pick the avatar initial: the first character of the trimmed name, uppercased
 * where the script has case. A name with no visible character falls back to a
 * neutral placeholder rather than rendering an empty circle.
 * @param name - display name, or the work id when W3 publishes no name.
 * @returns the initial shown inside the avatar.
 */
export function initialOf(name: string): string {
  for (const character of name.trim()) return character.toLocaleUpperCase()
  return '?'
}
