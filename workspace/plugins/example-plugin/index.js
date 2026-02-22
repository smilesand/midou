/**
 * Example Plugin for Midou
 * 
 * 这个插件展示了如何通过 Midou 的插件系统扩展核心功能。
 * 包含以下几个方面的扩展示例：
 * 1. 注册自定义 LLM 工具 (Tools)
 * 2. 注册自定义后端 API 路由 (Express Routes)
 * 3. 拦截和修改 Agent 的输出事件 (Output Handler Middleware)
 * 4. 监听系统级事件 (System Events)
 */

export default {
  name: 'example-plugin',
  
  // install 方法会在系统启动时被调用
  install({ systemManager, app, registerTool }) {
    console.log('[ExamplePlugin] 开始安装插件...');

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
      async (args, context) => {
        console.log(`[ExamplePlugin] Agent ${context.agentId} 正在查询 ${args.location} 的天气`);
        // 在真实的插件中，这里可以调用第三方天气 API
        const temp = Math.floor(Math.random() * 30) + 10;
        const unit = args.unit || 'celsius';
        return `${args.location} 当前的天气是 ${temp} 度 (${unit})，晴朗。`;
      }
    );

    // ==========================================
    // 2. 注册自定义后端 API 路由 (Express Routes)
    // ==========================================
    // 允许你为前端或其他服务提供自定义的 HTTP 接口
    app.get('/api/plugins/example/status', (req, res) => {
      res.json({ 
        status: 'active', 
        message: 'Example plugin is running!',
        timestamp: new Date().toISOString()
      });
    });

    // ==========================================
    // 3. 拦截和修改 Agent 的输出事件 (Output Handler Middleware)
    // ==========================================
    // 允许你监听、修改甚至阻止 Agent 的输出流
    systemManager.useOutputHandler((agent, baseHandler) => {
      return {
        ...baseHandler, // 继承基础逻辑
        
        // 拦截文本输出流 (例如：实现敏感词过滤、日志记录)
        onTextDelta: (text) => {
          // 示例：将输出中的 "坏蛋" 替换为 "***"
          const filteredText = text.replace(/坏蛋/g, '***');
          
          // 记录日志 (可选)
          // console.log(`[ExamplePlugin] Agent ${agent.id} 输出了: ${filteredText}`);
          
          // 调用原始的基础逻辑，将处理后的文本发送给前端
          if (baseHandler.onTextDelta) {
            baseHandler.onTextDelta(filteredText);
          }
        },

        // 拦截工具调用开始事件
        onToolStart: (name) => {
          console.log(`[ExamplePlugin] 监控到 Agent ${agent.id} 准备调用工具: ${name}`);
          if (baseHandler.onToolStart) {
            baseHandler.onToolStart(name);
          }
        },
        
        // 拦截思考过程 (DeepSeek R1 等模型的 <think> 标签内容)
        onThinkingDelta: (text) => {
          // 可以在这里对思考过程进行特殊处理
          if (baseHandler.onThinkingDelta) {
            baseHandler.onThinkingDelta(text);
          }
        }
      };
    });

    // ==========================================
    // 4. 监听系统级事件 (System Events)
    // ==========================================
    // 如果你需要监听系统状态变化，可以通过 systemManager.io (Socket.io 实例) 或其他方式
    // 注意：直接操作 io 需要小心，避免影响核心通信
    if (systemManager.io) {
      // 例如：监听新客户端连接
      systemManager.io.on('connection', (socket) => {
        console.log(`[ExamplePlugin] 检测到新客户端连接: ${socket.id}`);
      });
    }

    console.log('[ExamplePlugin] 插件安装完成。');
  }
};
