export interface Task {
  id: number;
  text: string;
  created_at: string;
  completed_at: string | null;
  due_at: string | null;
  source: string;
}
