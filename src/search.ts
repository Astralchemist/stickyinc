/**
 * Pure helpers for sticky_search, kept out of db.ts (which opens the
 * database on import) so they can be tested on their own.
 */

/** The words in a search, letters and digits only, so punctuation or quotes can't break FTS5's query syntax. */
export function searchWords(query: string): string[] {
  return query.match(/[\p{L}\p{N}]+/gu) ?? [];
}

/** An FTS5 MATCH expression: every word, each as a prefix ("dent" finds "dentist"). */
export function ftsQuery(words: string[]): string {
  return words.map((w) => `"${w}"*`).join(" ");
}

/** UTC ISO 8601 ("2026-09-01T04:00:00Z") in SQLite's datetime('now') shape, which created_at uses. */
export function toSqliteUtc(iso: string): string {
  return iso.replace("T", " ").replace(/(\.\d+)?Z$/, "");
}

/** A LIKE pattern matching `word` anywhere, with LIKE's wildcards escaped (ESCAPE '\'). */
export function likeAnywhere(word: string): string {
  return `%${word.replace(/[\\%_]/g, "\\$&")}%`;
}
