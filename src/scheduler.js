import fs from 'fs/promises';
import path from 'path';
import cron from 'node-cron';
import config from '../midou.config.js';

const REMINDERS_FILE = path.join(config.workspace.root, 'reminders.json');

let reminders = [];
let cronJobs = new Map();
let nextId = 1;

async function loadReminders() {
  try {
    const data = await fs.readFile(REMINDERS_FILE, 'utf-8');
    const parsed = JSON.parse(data);
    reminders = parsed.reminders || [];
    nextId = parsed.nextId || (reminders.length > 0 ? Math.max(...reminders.map(r => r.id)) + 1 : 1);
  } catch {
    reminders = [];
    nextId = 1;
  }
}

async function saveReminders() {
  await fs.writeFile(REMINDERS_FILE, JSON.stringify({ reminders, nextId }, null, 2), 'utf-8');
}

export async function startScheduler() {
  await loadReminders();
  
  for (const reminder of reminders) {
    scheduleJob(reminder);
  }
  
  console.log(`Scheduler started with ${reminders.length} active jobs.`);
}

export function stopScheduler() {
  for (const [id, job] of cronJobs.entries()) {
    job.stop();
  }
  cronJobs.clear();
  console.log('Scheduler stopped.');
}

function scheduleJob(reminder) {
  if (cronJobs.has(reminder.id)) {
    cronJobs.get(reminder.id).stop();
  }

  const job = cron.schedule(reminder.cronExpression, () => {
    console.log(`[Reminder] ${reminder.message}`);
    // Here we could emit a socket event or trigger the chat engine
  });

  cronJobs.set(reminder.id, job);
}

export async function addReminder(cronExpression, message) {
  const id = nextId++;
  const reminder = { id, cronExpression, message, createdAt: new Date().toISOString() };
  
  reminders.push(reminder);
  await saveReminders();
  
  scheduleJob(reminder);
  
  return id;
}

export async function removeReminder(id) {
  const index = reminders.findIndex(r => r.id === id);
  if (index !== -1) {
    reminders.splice(index, 1);
    await saveReminders();
    
    if (cronJobs.has(id)) {
      cronJobs.get(id).stop();
      cronJobs.delete(id);
    }
    return true;
  }
  return false;
}

export function formatReminders() {
  return reminders.map(r => `[${r.id}] ${r.cronExpression} - ${r.message}`);
}
