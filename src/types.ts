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
}
