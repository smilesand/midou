/**
 * Example Plugin for Midou (TypeScript)
 *
 * 这个插件展示了如何通过 Midou 的插件系统扩展核心功能。
 * 包含以下几个方面的扩展示例：
 * 1. 注册自定义 LLM 工具 (Tools)
 * 2. 注册自定义后端 API 路由 (Express Routes)
 * 3. 拦截和修改 Agent 的输出事件 (Output Handler Middleware)
 * 4. 监听系统级事件 (System Events)
 * 5. 使用注入的 LLM 能力 (依赖注入示例)
 *
 * 注意：插件不应硬引用 ../../src/ 中的任何模块，
 * 所有核心能力（LLM、记忆等）均通过 PluginContext 注入获取。
 */

/** 插件上下文类型（对齐 src/types.ts 中的 PluginContext） */
interface PluginContext {
  systemManager: SystemManagerLike;
  app: ExpressLike;
  registerTool: (
    definition: ToolDefinitionLike,
    handler: (
      args: Record<string, unknown>,
      context: { systemManager: unknown; agentId: string }
    ) => Promise<string> | string
  ) => void;
  registerMemoryProvider: (provider: unknown) => void;
  createLLM: (options?: Record<string, unknown>) => unknown;
  quickAsk: (prompt: string, systemPrompt?: string) => Promise<string>;
  workspaceDir: string;
}

interface SystemManagerLike {
  io?: { on: (event: string, cb: (socket: { id: string }) => void) => void };
  useOutputHandler: (
    middleware: (agent: { id: string }, handler: OutputHandlerLike) => OutputHandlerLike
  ) => void;
}

interface ExpressLike {
  get: (path: string, handler: (req: unknown, res: { json: (data: unknown) => void }) => void) => void;
}

interface OutputHandlerLike {
  onTextDelta?: (text: string) => void;
  onToolStart?: (name: string) => void;
  onThinkingDelta?: (text: string) => void;
  [key: string]: unknown;
}

interface ToolDefinitionLike {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export default {
  name: 'example-plugin',

  // install 方法会在系统启动时被调用
  async install(context: PluginContext): Promise<void> {
    console.log('[ExamplePlugin] 开始安装插件...');

    const { systemManager, app, registerTool, quickAsk } = context;

    // ==========================================
    // 1. 注册自定义 LLM 工具 (Tools)
    // ==========================================
    // 允许 Agent 调用你自定义的函数，例如查询天气、操作数据库等
    registerTool(
      {
        type: 'function',
        function: {
          name: 'get_current_weather',
          description: '获取指定城市的当前天气情况',
          parameters: {
            type: 'object',
            properties: {
              location: {
                type: 'string',
                description: '城市名称，例如：北京, 上海',
              },
              unit: {
                type: 'string',
                enum: ['celsius', 'fahrenheit'],
              },
            },
            required: ['location'],
          },
        },
      },
      async (args, ctx) => {
        console.log(`[ExamplePlugin] Agent ${ctx.agentId} 正在查询 ${args.location} 的天气`);
        // 在真实的插件中，这里可以调用第三方天气 API
        const temp = Math.floor(Math.random() * 30) + 10;
        const unit = (args.unit as string) || 'celsius';
        return `${args.location} 当前的天气是 ${temp} 度 (${unit})，晴朗。`;
      }
    );

    // ==========================================
    // 2. 使用注入的 LLM 能力 (依赖注入示例)
    // ==========================================
    // 通过 context.quickAsk 调用 LLM，无需硬引用 src/llm.ts
    registerTool(
      {
        type: 'function',
        function: {
          name: 'summarize_text',
          description: '使用 LLM 对文本进行摘要总结',
          parameters: {
            type: 'object',
            properties: {
              text: {
                type: 'string',
                description: '需要总结的文本',
              },
            },
            required: ['text'],
          },
        },
      },
      async (args) => {
        const text = args.text as string;
        try {
          const summary = await quickAsk(
            `请简洁地总结以下内容（不超过 100 字）：\n\n${text}`,
            '你是一个文本摘要助手，擅长精炼信息。'
          );
          return `摘要：${summary}`;
        } catch (err: unknown) {
          return `总结失败：${(err as Error).message}`;
        }
      }
    );

    // ==========================================
    // 3. 注册自定义后端 API 路由 (Express Routes)
    // ==========================================
    app.get('/api/plugins/example/status', (_req: unknown, res: { json: (data: unknown) => void }) => {
      res.json({
        status: 'active',
        message: 'Example plugin is running!',
        timestamp: new Date().toISOString(),
      });
    });

    // ==========================================
    // 4. 拦截和修改 Agent 的输出事件 (Output Handler Middleware)
    // ==========================================
    systemManager.useOutputHandler((agent, baseHandler) => {
      return {
        ...baseHandler,

        // 拦截文本输出流 (例如：实现敏感词过滤、日志记录)
        onTextDelta: (text: string) => {
          const filteredText = text.replace(/坏蛋/g, '***');
          if (baseHandler.onTextDelta) {
            baseHandler.onTextDelta(filteredText);
          }
        },

        // 拦截工具调用开始事件
        onToolStart: (name: string) => {
          console.log(`[ExamplePlugin] 监控到 Agent ${agent.id} 准备调用工具: ${name}`);
          if (baseHandler.onToolStart) {
            baseHandler.onToolStart(name);
          }
        },

        // 拦截思考过程
        onThinkingDelta: (text: string) => {
          if (baseHandler.onThinkingDelta) {
            baseHandler.onThinkingDelta(text);
          }
        },
      } as OutputHandlerLike;
    });

    // ==========================================
    // 5. 监听系统级事件 (System Events)
    // ==========================================
    if (systemManager.io) {
      systemManager.io.on('connection', (socket) => {
        console.log(`[ExamplePlugin] 检测到新客户端连接: ${socket.id}`);
      });
    }

    console.log('[ExamplePlugin] 插件安装完成。');
  },
};
