import fs from 'fs/promises';
import path from 'path';
import { MIDOU_WORKSPACE_DIR } from './config.js';
import type { TodoItem, TodoUpdateFields } from './types.js';

const TODOS_FILE = path.join(MIDOU_WORKSPACE_DIR, 'todos.json');

export async function loadTodos(): Promise<TodoItem[]> {
  try {
    const data = await fs.readFile(TODOS_FILE, 'utf-8');
    return JSON.parse(data) as TodoItem[];
  } catch (_e) {
    return [];
  }
}

export async function saveTodos(todos: TodoItem[]): Promise<void> {
  await fs.mkdir(path.dirname(TODOS_FILE), { recursive: true });
  await fs.writeFile(TODOS_FILE, JSON.stringify(todos, null, 2), 'utf-8');
}

export async function addTodoItem(
  agentId: string,
  title: string,
  description?: string
): Promise<TodoItem> {
  const todos = await loadTodos();
  const id = Date.now().toString();
  const newTodo: TodoItem = {
    id,
    agentId,
    title,
    description: description || '',
    status: 'pending',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    notes: '',
  };
  todos.push(newTodo);
  await saveTodos(todos);
  return newTodo;
}

export async function updateTodoStatus(
  id: string,
  updates: TodoUpdateFields
): Promise<TodoItem | null> {
  const todos = await loadTodos();
  const item = todos.find((t) => t.id === id);
  if (item) {
    if (updates.status) item.status = updates.status;
    if (updates.notes !== undefined) item.notes = updates.notes;
    if (updates.title !== undefined) item.title = updates.title;
    if (updates.description !== undefined) item.description = updates.description;
    if (updates.agentId !== undefined) item.agentId = updates.agentId;
    item.updatedAt = new Date().toISOString();
    await saveTodos(todos);
    return item;
  }
  return null;
}

export async function deleteTodoItem(id: string): Promise<boolean> {
  const todos = await loadTodos();
  const initialLength = todos.length;
  const filtered = todos.filter((t) => t.id !== id);
  if (filtered.length !== initialLength) {
    await saveTodos(filtered);
    return true;
  }
  return false;
}

export async function getTodoItems(
  agentId: string | null = null
): Promise<TodoItem[]> {
  const todos = await loadTodos();
  if (agentId) {
    return todos.filter((t) => t.agentId === agentId);
  }
  return todos;
}

export async function clearTodoItems(
  agentId: string | null = null
): Promise<void> {
  if (agentId) {
    const todos = await loadTodos();
    const filtered = todos.filter((t) => t.agentId !== agentId);
    await saveTodos(filtered);
  } else {
    await saveTodos([]);
  }
}
