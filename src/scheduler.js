/**
 * 定时任务系统 — midou 的闹钟
 * 
 * 让 midou 可以设定提醒和定时任务，
 * 就像猫咪的生物钟一样精准。
 * 
 * 所有任务统一存储在 ~/.midou/reminders.json，每次启动自动加载。
 * 
 * 支持的任务类型：
 *   once     — 一次性，N 分钟后触发，触发后自动删除
 *   interval — 每隔 N 分钟重复触发
 *   daily    — 每天指定时间触发
 *   weekly   — 每周指定星期和时间触发
 *   monthly  — 每月指定日期和时间触发
 */

import fs from 'fs/promises';
import path from 'path';
import chalk from 'chalk';
import dayjs from 'dayjs';
import notifier from 'node-notifier';
import config from '../midou.config.js';

const REMINDERS_FILE = path.join(config.workspace.root, 'reminders.json');

let reminders = [];
let schedulerTimer = null;
let nextId = 1;

/**
 * 加载提醒列表
 */
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

/**
 * 持久化提醒列表
 */
async function saveReminders() {
  await fs.writeFile(REMINDERS_FILE, JSON.stringify({ reminders, nextId }, null, 2), 'utf-8');
}

/**
 * 计算 daily/weekly/monthly 类型的下一次触发时间
 */
function calcNextTrigger(reminder) {
  const [h, m] = reminder.time.split(':').map(Number);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m, 0);

  if (reminder.type === 'weekly' && reminder.weekday != null) {
    let daysUntil = (reminder.weekday - now.getDay() + 7) % 7;
    const target = new Date(today.getTime() + daysUntil * 86400000);
    if (target <= now) target.setTime(target.getTime() + 7 * 86400000);
    return target;
  }

  if (reminder.type === 'monthly' && reminder.day != null) {
    const target = new Date(now.getFullYear(), now.getMonth(), reminder.day, h, m, 0);
    if (target <= now) target.setMonth(target.getMonth() + 1);
    return target;
  }

  // daily
  if (today <= now) today.setDate(today.getDate() + 1);
  return today;
}

/**
 * 添加提醒 / 定时任务
 * @param {string} text - 提醒内容
 * @param {object} opts
 * @param {string}  [opts.type='once']          - 类型: once | interval | daily | weekly | monthly
 * @param {number}  [opts.intervalMinutes]       - once/interval 的分钟数
 * @param {string}  [opts.time]                  - daily/weekly/monthly 的触发时间 "HH:MM"
 * @param {number}  [opts.weekday]               - weekly 的星期几 (0=日 1=一 … 6=六)
 * @param {number}  [opts.day]                   - monthly 的日期 (1-31)
 * @param {string}  [opts.triggerAt]             - 直接指定首次触发时间 (ISO)
 */
export async function addReminder(text, opts = {}) {
  const type = opts.type || (opts.intervalMinutes != null ? (opts.repeat ? 'interval' : 'once') : 'once');
  const now = Date.now();

  const reminder = {
    id: nextId++,
    text,
    type,
    active: true,
    createdAt: new Date(now).toISOString(),
  };

  if (type === 'once' || type === 'interval') {
    reminder.intervalMinutes = opts.intervalMinutes || 1;
    reminder.nextTrigger = opts.triggerAt || new Date(now + reminder.intervalMinutes * 60 * 1000).toISOString();
  } else {
    // daily / weekly / monthly
    reminder.time = opts.time || '09:00';
    if (type === 'weekly') reminder.weekday = opts.weekday ?? 1;
    if (type === 'monthly') reminder.day = opts.day ?? 1;
    reminder.nextTrigger = calcNextTrigger(reminder).toISOString();
  }

  reminders.push(reminder);
  await saveReminders();
  return reminder;
}

/**
 * 移除提醒
 */
export async function removeReminder(id) {
  const idx = reminders.findIndex(r => r.id === id);
  if (idx === -1) return false;
  reminders.splice(idx, 1);
  await saveReminders();
  return true;
}

/**
 * 检查并触发到期的提醒
 * @param {function} onFire - 触发时的回调 (reminder) => void
 */
async function checkReminders(onFire) {
  const now = Date.now();
  let changed = false;
  const toRemove = [];

  for (const reminder of reminders) {
    if (!reminder.active) continue;

    const triggerTime = new Date(reminder.nextTrigger).getTime();
    if (now >= triggerTime) {
      // 先更新状态，再通知（确保回调中获取的 summary 是最新的）
      switch (reminder.type) {
        case 'once':
          toRemove.push(reminder.id);
          break;
        case 'interval':
          reminder.nextTrigger = new Date(now + reminder.intervalMinutes * 60 * 1000).toISOString();
          break;
        case 'daily':
        case 'weekly':
        case 'monthly':
          reminder.nextTrigger = calcNextTrigger(reminder).toISOString();
          break;
        default:
          // 兼容旧数据：无 type 字段的视为 once
          toRemove.push(reminder.id);
          break;
      }

      changed = true;

      if (onFire) onFire(reminder);
      sendSystemNotification(reminder);
    }
  }

  // 一次性任务触发后直接删除
  if (toRemove.length > 0) {
    reminders = reminders.filter(r => !toRemove.includes(r.id));
  }

  if (changed) {
    await saveReminders();
  }
}

/**
 * 启动调度器（每 30 秒检查一次）
 */
export async function startScheduler(onFire) {
  await loadReminders();

  // 启动时重新计算 daily/weekly/monthly 的下次触发时间（防止离线期间堆积触发）
  let needSave = false;
  const now = Date.now();
  for (const r of reminders) {
    if (!r.active) continue;
    if (['daily', 'weekly', 'monthly'].includes(r.type) && new Date(r.nextTrigger).getTime() <= now) {
      r.nextTrigger = calcNextTrigger(r).toISOString();
      needSave = true;
    }
  }
  // 兼容旧数据：给没有 type 的提醒补上 type
  for (const r of reminders) {
    if (!r.type) {
      r.type = r.repeat ? 'interval' : 'once';
      needSave = true;
    }
  }
  if (needSave) await saveReminders();

  schedulerTimer = setInterval(() => {
    checkReminders(onFire).catch(err => {
      console.error(chalk.dim(`  ⏰ 提醒检查异常: ${err.message}`));
    });
  }, 30 * 1000);

  return { stop: stopScheduler };
}

/**
 * 停止调度器
 */
export function stopScheduler() {
  if (schedulerTimer) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
  }
}

/**
 * 格式化提醒列表为可读字符串
 */
export function formatReminders() {
  const active = reminders.filter(r => r.active);
  if (active.length === 0) return '当前没有活跃的定时任务';

  const weekdayNames = ['日', '一', '二', '三', '四', '五', '六'];
  return active.map(r => {
    const next = dayjs(r.nextTrigger).format('MM-DD HH:mm');
    let desc;
    switch (r.type) {
      case 'interval':
        desc = `每 ${r.intervalMinutes} 分钟`;
        break;
      case 'daily':
        desc = `每天 ${r.time}`;
        break;
      case 'weekly':
        desc = `每周${weekdayNames[r.weekday]} ${r.time}`;
        break;
      case 'monthly':
        desc = `每月${r.day}号 ${r.time}`;
        break;
      default:
        desc = '一次性';
    }
    return `[${r.id}] ${r.text} — ${desc}，下次: ${next}`;
  }).join('\n');
}

/**
 * 发送系统桌面通知
 */
function sendSystemNotification(reminder) {
  try {
    notifier.notify({
      title: '🐱 midou 提醒',
      message: reminder.text,
      sound: true,
      timeout: 10,
    });
  } catch {
    // 系统通知失败不影响主流程
  }
}
