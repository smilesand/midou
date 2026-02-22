import fs from 'fs/promises';
import path from 'path';
import { MIDOU_WORKSPACE_DIR } from '../midou.config.js';

const TODOS_FILE = path.join(MIDOU_WORKSPACE_DIR, 'todos.json');

export async function loadTodos() {
  try {
    const data = await fs.readFile(TODOS_FILE, 'utf-8');
    return JSON.parse(data);
  } catch (e) {
    return [];
  }
}

export async function saveTodos(todos) {
  await fs.mkdir(path.dirname(TODOS_FILE), { recursive: true });
  await fs.writeFile(TODOS_FILE, JSON.stringify(todos, null, 2), 'utf-8');
}

export async function addTodoItem(agentId, title, description) {
  const todos = await loadTodos();
  const id = Date.now().toString();
  const newTodo = {
    id,
    agentId,
    title,
    description: description || '',
    status: 'pending',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    notes: ''
  };
  todos.push(newTodo);
  await saveTodos(todos);
  return newTodo;
}

export async function updateTodoStatus(id, updates) {
  const todos = await loadTodos();
  const item = todos.find(t => t.id === id);
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

export async function deleteTodoItem(id) {
  const todos = await loadTodos();
  const initialLength = todos.length;
  const filtered = todos.filter(t => t.id !== id);
  if (filtered.length !== initialLength) {
    await saveTodos(filtered);
    return true;
  }
  return false;
}

export async function getTodoItems(agentId = null) {
  const todos = await loadTodos();
  if (agentId) {
    return todos.filter(t => t.agentId === agentId);
  }
  return todos;
}

export async function clearTodoItems(agentId = null) {
  if (agentId) {
    const todos = await loadTodos();
    const filtered = todos.filter(t => t.agentId !== agentId);
    await saveTodos(filtered);
  } else {
    await saveTodos([]);
  }
}
