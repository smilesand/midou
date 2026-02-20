/**
 * 定时任务系统 — midou 的闹钟
 * 
 * 让 midou 可以设定提醒和定时任务，
 * 就像猫咪的生物钟一样精准。
 * 
 * 提醒存储在 ~/.midou/reminders.json
 * 永久定时任务存储在 ~/.midou/schedules.json（每次启动自动加载）
 */

import fs from 'fs/promises';
import path from 'path';
import chalk from 'chalk';
import dayjs from 'dayjs';
import notifier from 'node-notifier';
import config from '../midou.config.js';

const REMINDERS_FILE = path.join(config.workspace.root, 'reminders.json');
const SCHEDULES_FILE = path.join(config.workspace.root, 'schedules.json');

let reminders = [];
let schedules = [];
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

// ─── 永久定时任务（schedules） ────────────────────────

/**
 * 计算某个 schedule 的下一次触发时间
 * @param {object} schedule - { time: "HH:MM", repeat: "daily"|"weekly"|"monthly", weekday?: 0-6, day?: 1-31 }
 * @returns {Date}
 */
function calcNextTrigger(schedule) {
  const [h, m] = schedule.time.split(':').map(Number);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m, 0);

  if (schedule.repeat === 'weekly' && schedule.weekday != null) {
    // weekday: 0=周日, 1=周一, ... 6=周六
    let daysUntil = (schedule.weekday - now.getDay() + 7) % 7;
    const target = new Date(today.getTime() + daysUntil * 86400000);
    if (target <= now) target.setTime(target.getTime() + 7 * 86400000);
    return target;
  }

  if (schedule.repeat === 'monthly' && schedule.day != null) {
    const target = new Date(now.getFullYear(), now.getMonth(), schedule.day, h, m, 0);
    if (target <= now) target.setMonth(target.getMonth() + 1);
    return target;
  }

  // daily（默认）
  if (today <= now) today.setDate(today.getDate() + 1);
  return today;
}

/**
 * 加载永久定时任务
 */
async function loadSchedules() {
  try {
    const data = await fs.readFile(SCHEDULES_FILE, 'utf-8');
    schedules = JSON.parse(data) || [];
  } catch {
    schedules = [];
  }
}

/**
 * 持久化永久定时任务
 */
async function saveSchedules() {
  await fs.writeFile(SCHEDULES_FILE, JSON.stringify(schedules, null, 2), 'utf-8');
}

/**
 * 添加永久定时任务
 * @param {string} text - 任务描述
 * @param {string} time - 触发时间 "HH:MM"
 * @param {string} repeat - 重复方式: "daily" | "weekly" | "monthly"
 * @param {number} [weekday] - 周几 (0=日 1=一 ... 6=六)，weekly 时必填
 * @param {number} [day] - 几号 (1-31)，monthly 时必填
 */
export async function addSchedule(text, time, repeat = 'daily', weekday = null, day = null) {
  const id = `sch_${Date.now()}`;
  const schedule = { id, text, time, repeat, enabled: true };
  if (repeat === 'weekly' && weekday != null) schedule.weekday = weekday;
  if (repeat === 'monthly' && day != null) schedule.day = day;
  schedule.nextTrigger = calcNextTrigger(schedule).toISOString();
  schedules.push(schedule);
  await saveSchedules();
  return schedule;
}

/**
 * 删除永久定时任务
 */
export async function removeSchedule(id) {
  const idx = schedules.findIndex(s => s.id === id);
  if (idx === -1) return false;
  schedules.splice(idx, 1);
  await saveSchedules();
  return true;
}

/**
 * 列出永久定时任务
 */
export function listSchedules() {
  return schedules.map(s => ({
    id: s.id,
    text: s.text,
    time: s.time,
    repeat: s.repeat,
    weekday: s.weekday,
    day: s.day,
    enabled: s.enabled,
    nextTrigger: s.nextTrigger,
  }));
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
 * 检查并触发到期的提醒和永久任务
 * @param {function} onFire - 触发时的回调 (item) => void
 */
async function checkReminders(onFire) {
  const now = Date.now();
  let changed = false;

  // 检查普通提醒
  for (const reminder of reminders) {
    if (!reminder.active) continue;

    const triggerTime = new Date(reminder.nextTrigger).getTime();
    if (now >= triggerTime) {
      reminder.firedCount++;

      // 先更新状态，再通知（确保回调中获取的 summary 是最新的）
      if (reminder.repeat) {
        reminder.nextTrigger = new Date(now + reminder.intervalMinutes * 60 * 1000).toISOString();
      } else {
        reminder.active = false;
      }

      changed = true;

      if (onFire) {
        onFire(reminder);
      }
      sendSystemNotification(reminder);
    }
  }

  if (changed) {
    const inactive = reminders.filter(r => !r.active);
    if (inactive.length > 50) {
      reminders = [
        ...reminders.filter(r => r.active),
        ...inactive.slice(-50),
      ];
    }
    await saveReminders();
  }

  // 检查永久定时任务
  let schedChanged = false;
  for (const sch of schedules) {
    if (!sch.enabled) continue;
    const triggerTime = new Date(sch.nextTrigger).getTime();
    if (now >= triggerTime) {
      // 计算下一次触发时间
      sch.nextTrigger = calcNextTrigger(sch).toISOString();
      schedChanged = true;

      if (onFire) {
        onFire({ text: sch.text, id: sch.id, isSchedule: true });
      }
      sendSystemNotification({ text: `[定时] ${sch.text}` });
    }
  }

  if (schedChanged) {
    await saveSchedules();
  }
}

/**
 * 启动调度器（每 30 秒检查一次）
 */
export async function startScheduler(onFire) {
  await loadReminders();
  await loadSchedules();

  // 启动时重新计算永久任务的下次触发时间（防止旧时间导致集中触发）
  let schedNeedSave = false;
  const now = Date.now();
  for (const sch of schedules) {
    if (!sch.enabled) continue;
    if (new Date(sch.nextTrigger).getTime() <= now) {
      sch.nextTrigger = calcNextTrigger(sch).toISOString();
      schedNeedSave = true;
    }
  }
  if (schedNeedSave) await saveSchedules();

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
 * 格式化提醒列表为可读字符串（包含普通提醒和永久定时任务）
 */
export function formatReminders() {
  const active = reminders.filter(r => r.active);
  const enabledSchedules = schedules.filter(s => s.enabled);
  const lines = [];

  if (active.length > 0) {
    lines.push('── 提醒 ──');
    for (const r of active) {
      const next = dayjs(r.nextTrigger).format('HH:mm:ss');
      const type = r.repeat ? `每 ${r.intervalMinutes} 分钟` : '一次性';
      lines.push(`[${r.id}] ${r.text} — ${type}，下次: ${next}`);
    }
  }

  if (enabledSchedules.length > 0) {
    lines.push('── 永久定时任务 ──');
    const repeatLabels = { daily: '每天', weekly: '每周', monthly: '每月' };
    const weekdayNames = ['日', '一', '二', '三', '四', '五', '六'];
    for (const s of enabledSchedules) {
      let desc = `${repeatLabels[s.repeat] || s.repeat} ${s.time}`;
      if (s.repeat === 'weekly' && s.weekday != null) desc += ` 周${weekdayNames[s.weekday]}`;
      if (s.repeat === 'monthly' && s.day != null) desc += ` ${s.day}号`;
      const next = dayjs(s.nextTrigger).format('MM-DD HH:mm');
      lines.push(`[${s.id}] ${s.text} — ${desc}，下次: ${next}`);
    }
  }

  return lines.length > 0 ? lines.join('\n') : '当前没有活跃的提醒或定时任务';
}

/**
 * 获取调度器状态摘要（用于状态栏显示）
 */
export function getSchedulerSummary() {
  const active = reminders.filter(r => r.active);
  const enabledSchedules = schedules.filter(s => s.enabled);
  const totalCount = active.length + enabledSchedules.length;

  // 合并所有任务，找下一个最近将要触发的
  const allItems = [
    ...active.map(r => ({ text: r.text, time: new Date(r.nextTrigger).getTime() })),
    ...enabledSchedules.map(s => ({ text: s.text, time: new Date(s.nextTrigger).getTime() })),
  ].sort((a, b) => a.time - b.time);

  return {
    activeCount: totalCount,
    nextTask: allItems.length > 0 ? allItems[0].text : '',
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
