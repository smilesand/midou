/**
 * 功耗模式管理器 — midou 的能量调节
 * 
 * 三种模式，像猫咪的三种状态：
 * 
 *   🐱 eco    — 打盹模式：省 token，轻量提示词，核心工具，快速回复
 *   🐱 normal — 日常模式：平衡功耗，标准提示词，全部工具
 *   🐱 full   — 全能模式：深度思考，完整上下文，大 token 预算
 * 
 * 切换方式：
 *   对话中输入 /mode eco | /mode normal | /mode full
 *   环境变量   MIDOU_MODE=eco
 */

// ── 模式定义 ──────────────────────────────────────

const MODES = {
  eco: {
    name: 'eco',
    label: '🌙 低功耗',
    description: '省 token 模式 — 简洁提示词 + 核心工具 + 短回复',
    maxTokens: 1024,
    temperature: 0.5,
    // 系统提示词策略
    prompt: {
      includeSoul: true,        // SOUL.md（总是需要）
      includeIdentity: false,   // IDENTITY.md（省略）
      includeUser: true,        // USER.md（保留核心关系）
      includeMemory: false,     // MEMORY.md（省略长期记忆）
      includeJournals: false,   // 日记（省略）
      includeSkills: false,     // 技能列表（省略）
      includeMCP: false,        // MCP 状态（省略）
      includeReminders: true,   // 活跃提醒（保留）
      toolDescStyle: 'minimal', // 工具描述风格
      journalDays: 0,           // 加载日记天数
    },
    // 工具策略：只保留核心工具
    coreToolsOnly: true,
    coreTools: [
      'read_file', 'write_file', 'list_dir',
      'write_memory', 'write_journal',
      'set_reminder', 'list_reminders', 'cancel_reminder',
      'add_schedule', 'remove_schedule', 'list_schedules',
      'run_command', 'read_system_file',
    ],
    // 心跳策略
    heartbeat: {
      maxTokens: 256,
      skipIfBusy: true,
    },
    // 日记记录策略
    journal: {
      truncateResponse: 200,    // 回复截断长度
      logToolCalls: false,      // 不记录工具调用细节
    },
  },

  normal: {
    name: 'normal',
    label: '☀️ 标准',
    description: '平衡模式 — 完整提示词 + 全部工具',
    maxTokens: 4096,
    temperature: 0.7,
    prompt: {
      includeSoul: true,
      includeIdentity: true,
      includeUser: true,
      includeMemory: true,
      includeJournals: true,
      includeSkills: true,
      includeMCP: true,
      includeReminders: true,
      toolDescStyle: 'normal',
      journalDays: 2,
    },
    coreToolsOnly: false,
    coreTools: [],
    heartbeat: {
      maxTokens: 512,
      skipIfBusy: false,
    },
    journal: {
      truncateResponse: 500,
      logToolCalls: true,
    },
  },

  full: {
    name: 'full',
    label: '🔥 全能',
    description: '全能模式 — 深度上下文 + 大 token 预算 + 完整日记',
    maxTokens: 8192,
    temperature: 0.8,
    prompt: {
      includeSoul: true,
      includeIdentity: true,
      includeUser: true,
      includeMemory: true,
      includeJournals: true,
      includeSkills: true,
      includeMCP: true,
      includeReminders: true,
      toolDescStyle: 'detailed',
      journalDays: 5,          // 加载更多天的日记
    },
    coreToolsOnly: false,
    coreTools: [],
    heartbeat: {
      maxTokens: 1024,
      skipIfBusy: false,
    },
    journal: {
      truncateResponse: 0,     // 不截断
      logToolCalls: true,
    },
  },
};

// ── 当前模式 ──────────────────────────────────────

let currentMode = null;

/**
 * 初始化模式（从环境变量或默认 normal）
 */
export function initMode(modeName) {
  const name = modeName || process.env.MIDOU_MODE || 'normal';
  if (!MODES[name]) {
    console.warn(`未知模式 "${name}"，使用 normal`);
    currentMode = MODES.normal;
  } else {
    currentMode = MODES[name];
  }
  return currentMode;
}

/**
 * 获取当前模式
 */
export function getMode() {
  if (!currentMode) initMode();
  return currentMode;
}

/**
 * 切换模式
 */
export function setMode(modeName) {
  if (!MODES[modeName]) {
    return null;
  }
  currentMode = MODES[modeName];
  return currentMode;
}

/**
 * 列出所有模式
 */
export function listModes() {
  return Object.values(MODES).map(m => ({
    name: m.name,
    label: m.label,
    description: m.description,
    maxTokens: m.maxTokens,
    temperature: m.temperature,
    active: m === currentMode,
  }));
}

/**
 * 获取当前模式的 maxTokens
 */
export function getModeMaxTokens() {
  return getMode().maxTokens;
}

/**
 * 获取当前模式的 temperature
 */
export function getModeTemperature() {
  return getMode().temperature;
}

/**
 * 获取模式下的提示词策略
 */
export function getPromptStrategy() {
  return getMode().prompt;
}

/**
 * 获取模式下要使用的工具列表
 * @param {Array} allTools - 完整工具定义列表
 */
export function filterToolsByMode(allTools) {
  const mode = getMode();
  if (!mode.coreToolsOnly) return allTools;

  return allTools.filter(t => {
    const name = t.function?.name || t._mcpToolName;
    return mode.coreTools.includes(name);
  });
}

/**
 * 获取心跳参数
 */
export function getHeartbeatParams() {
  return getMode().heartbeat;
}

/**
 * 获取日记策略
 */
export function getJournalStrategy() {
  return getMode().journal;
}

/**
 * 检测是否是核心工具模式
 */
export function isCoreToolsOnly() {
  return getMode().coreToolsOnly;
}
