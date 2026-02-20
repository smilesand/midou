/**
 * 定时任务系统 — midou 的闹钟
 * 
 * 让 midou 可以设定提醒和定时任务，
 * 就像猫咪的生物钟一样精准。
 * 
 * 提醒存储在 ~/.midou/reminders.json
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
 * 添加提醒
 * @param {string} text - 提醒内容
 * @param {number} intervalMinutes - 间隔（分钟）
 * @param {boolean} repeat - 是否重复
 * @param {string} [triggerAt] - 指定触发时间 (ISO 字符串)，如果设置则 intervalMinutes 被忽略
 * @returns {object} 创建的提醒对象
 */
export async function addReminder(text, intervalMinutes, repeat = false, triggerAt = null) {
  const now = Date.now();
  const reminder = {
    id: nextId++,
    text,
    intervalMinutes,
    repeat,
    createdAt: new Date(now).toISOString(),
    nextTrigger: triggerAt || new Date(now + intervalMinutes * 60 * 1000).toISOString(),
    firedCount: 0,
    active: true,
  };
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
 * 暂停/恢复提醒
 */
export async function toggleReminder(id) {
  const reminder = reminders.find(r => r.id === id);
  if (!reminder) return null;
  reminder.active = !reminder.active;
  await saveReminders();
  return reminder;
}

/**
 * 列出所有提醒
 */
export function listReminders() {
  return reminders.map(r => ({
    id: r.id,
    text: r.text,
    intervalMinutes: r.intervalMinutes,
    repeat: r.repeat,
    active: r.active,
    nextTrigger: r.nextTrigger,
    firedCount: r.firedCount,
  }));
}

/**
 * 检查并触发到期的提醒
 * @param {function} onFire - 触发时的回调 (reminder) => void
 */
async function checkReminders(onFire) {
  const now = Date.now();
  let changed = false;

  for (const reminder of reminders) {
    if (!reminder.active) continue;

    const triggerTime = new Date(reminder.nextTrigger).getTime();
    if (now >= triggerTime) {
      reminder.firedCount++;

      // 通知
      if (onFire) {
        onFire(reminder);
      }

      // 系统通知
      sendSystemNotification(reminder);

      if (reminder.repeat) {
        // 重复提醒：设置下一次触发时间
        reminder.nextTrigger = new Date(now + reminder.intervalMinutes * 60 * 1000).toISOString();
      } else {
        // 一次性提醒：标记为非活跃
        reminder.active = false;
      }

      changed = true;
    }
  }

  if (changed) {
    // 清除已完成的非重复提醒（保留记录最多 50 条）
    const inactive = reminders.filter(r => !r.active);
    if (inactive.length > 50) {
      reminders = [
        ...reminders.filter(r => r.active),
        ...inactive.slice(-50),
      ];
    }
    await saveReminders();
  }
}

/**
 * 启动调度器（每 30 秒检查一次）
 */
export async function startScheduler(onFire) {
  await loadReminders();

  // 每 30 秒检查一次提醒
  schedulerTimer = setInterval(() => {
    checkReminders(onFire).catch(err => {
      console.error(chalk.dim(`  ⏰ 提醒检查异常: ${err.message}`));
    });
  }, 30 * 1000);

  return {
    stop: stopScheduler,
  };
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
  if (active.length === 0) return '当前没有活跃的提醒';

  return active.map(r => {
    const next = dayjs(r.nextTrigger).format('HH:mm:ss');
    const type = r.repeat ? `每 ${r.intervalMinutes} 分钟` : '一次性';
    return `[${r.id}] ${r.text} — ${type}，下次: ${next}`;
  }).join('\n');
}

/**
 * 获取调度器状态摘要（用于状态栏显示）
 */
export function getSchedulerSummary() {
  const active = reminders.filter(r => r.active);
  const lastFired = reminders
    .filter(r => r.firedCount > 0)
    .sort((a, b) => b.firedCount - a.firedCount)[0];
  return {
    activeCount: active.length,
    lastTask: lastFired ? lastFired.text : '',
  };
}

/**
 * 发送系统桌面通知
 */
function sendSystemNotification(reminder) {
  try {
    const type = reminder.repeat ? `每 ${reminder.intervalMinutes} 分钟` : '一次性';
    notifier.notify({
      title: '🐱 midou 提醒',
      message: reminder.text,
      subtitle: type,
      sound: true,
      timeout: 10,
    });
  } catch {
    // 系统通知失败不影响主流程
  }
}
