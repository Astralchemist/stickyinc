export interface Task {
  id: number;
  uuid: string;
  text: string;
  created_at: string;
  completed_at: string | null;
  due_at: string | null;
  /** The words due_at was read from; null for pane quick-adds. */
  due_phrase: string | null;
  source: string;
  /** Provenance: the app, a pointer back, and the words it came from. */
  source_client: string | null;
  source_ref: string | null;
  source_excerpt: string | null;
}
