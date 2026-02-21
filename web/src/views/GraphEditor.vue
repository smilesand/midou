<template>
  <div class="graph-editor">
    <div class="toolbar">
      <button @click="addAgent">Add Agent</button>
      <button @click="saveSystem" :disabled="isSaving">
        {{ isSaving ? 'Saving...' : 'Save System' }}
      </button>
      <button @click="openMcpConfig">Configure MCP</button>
    </div>
    
    <div class="editor-container">
      <VueFlow
        v-model="elements"
        :default-zoom="1"
        :min-zoom="0.2"
        :max-zoom="4"
        @connect="onConnect"
        @node-click="onNodeClick"
        @edge-click="onEdgeClick"
        class="vue-flow-container"
      >
        <Background pattern-color="#aaa" gap="16" />
        <Controls />
        <MiniMap />
      </VueFlow>

      <!-- Agent Config Panel -->
      <div v-if="selectedNode" class="config-panel">
        <h3>Agent Configuration</h3>
        <div class="form-group">
          <label>Name:</label>
          <input v-model="selectedNode.data.name" @input="updateNodeLabel" />
        </div>
        <div class="form-group">
          <label>System Prompt:</label>
          <textarea v-model="selectedNode.data.systemPrompt" rows="5"></textarea>
        </div>
        
        <h4>LLM Settings</h4>
        <div class="form-group">
          <label>Provider:</label>
          <select v-model="selectedNode.data.provider">
            <option value="anthropic">Anthropic</option>
            <option value="openai">OpenAI</option>
          </select>
        </div>
        <div class="form-group">
          <label>Model:</label>
          <input v-model="selectedNode.data.model" />
        </div>
        <div class="form-group">
          <label>Base URL:</label>
          <input v-model="selectedNode.data.baseURL" />
        </div>
        <div class="form-group">
          <label>API Key:</label>
          <input type="password" v-model="selectedNode.data.apiKey" />
        </div>

        <h4>Cron Jobs</h4>
        <div v-for="(job, index) in selectedNode.data.cronJobs" :key="index" class="cron-job">
          <input v-model="job.expression" placeholder="* * * * *" class="cron-expr" />
          <input v-model="job.prompt" placeholder="Trigger prompt" class="cron-prompt" />
          <button @click="removeCronJob(index)" class="btn-remove">X</button>
        </div>
        <button @click="addCronJob" class="btn-add">+ Add Cron Job</button>

        <button @click="selectedNode = null" class="btn-close">Close</button>
      </div>

      <!-- Edge Config Panel -->
      <div v-if="selectedEdge" class="config-panel">
        <h3>Connection Configuration</h3>
        <div class="form-group">
          <label>Condition (contains):</label>
          <input v-model="selectedEdge.data.condition" placeholder="Leave empty for all messages" />
        </div>
        <button @click="removeEdge" class="btn-remove-edge">Delete Connection</button>
        <button @click="selectedEdge = null" class="btn-close">Close</button>
      </div>

      <!-- MCP Config Modal -->
      <div v-if="showMcpConfig" class="modal-overlay">
        <div class="modal-content">
          <h3>MCP Servers Configuration (JSON)</h3>
          <div class="form-group">
            <textarea 
              v-model="mcpServersJson" 
              rows="15" 
              style="font-family: monospace; width: 100%;"
              placeholder='{\n  "server-name": {\n    "command": "npx",\n    "args": ["..."]\n  }\n}'
            ></textarea>
          </div>
          <div v-if="mcpJsonError" class="error-text">{{ mcpJsonError }}</div>
          
          <div class="modal-actions">
            <button @click="saveMcpConfig" class="btn-save">Save & Restart MCP</button>
            <button @click="showMcpConfig = false">Cancel</button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { VueFlow, useVueFlow } from '@vue-flow/core'
import { Background } from '@vue-flow/background'
import { Controls } from '@vue-flow/controls'
import { MiniMap } from '@vue-flow/minimap'
import '@vue-flow/core/dist/style.css'
import '@vue-flow/core/dist/theme-default.css'

const { addEdges, onConnect: onConnectFlow } = useVueFlow()

const elements = ref([])
const selectedNode = ref(null)
const selectedEdge = ref(null)
const isSaving = ref(false)
const showMcpConfig = ref(false)
const mcpServers = ref({})
const mcpServersJson = ref('{}')
const mcpJsonError = ref('')

let nodeId = 1

onMounted(async () => {
  try {
    const response = await fetch('/api/system')
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`)
    }
    const data = await response.json()
    
    const nodes = (data.agents || []).map(agent => ({
      id: agent.id,
      type: 'default',
      label: agent.name || agent.id,
      position: agent.position || { x: Math.random() * 400, y: Math.random() * 400 },
      data: {
        name: agent.name || agent.id,
        systemPrompt: agent.data?.systemPrompt || '',
        provider: agent.data?.provider || 'anthropic',
        model: agent.data?.model || '',
        baseURL: agent.data?.baseURL || '',
        apiKey: agent.data?.apiKey || '',
        cronJobs: agent.data?.cronJobs || []
      }
    }))
    
    const edges = (data.connections || []).map(conn => ({
      id: conn.id,
      source: conn.source,
      target: conn.target,
      data: { condition: conn.data?.condition || '' }
    }))
    
    elements.value = [...nodes, ...edges]
    
    if (nodes.length > 0) {
      const maxId = Math.max(...nodes.map(n => parseInt(n.id.replace('agent-', '')) || 0))
      nodeId = maxId + 1
    }

    mcpServers.value = data.mcpServers || {}
  } catch (error) {
    console.error('Failed to load system:', error)
  }
})

const addAgent = () => {
  const id = `agent-${nodeId++}`
  elements.value.push({
    id,
    type: 'default',
    label: `New Agent ${id}`,
    position: { x: 100, y: 100 },
    data: {
      name: `New Agent ${id}`,
      systemPrompt: 'You are a helpful AI assistant.',
      provider: 'anthropic',
      model: '',
      baseURL: '',
      apiKey: '',
      cronJobs: []
    }
  })
}

const onConnect = (params) => {
  params.id = `edge-${params.source}-${params.target}`
  params.data = { condition: '' }
  addEdges([params])
}

const onNodeClick = (event) => {
  selectedEdge.value = null
  selectedNode.value = event.node
}

const onEdgeClick = (event) => {
  selectedNode.value = null
  selectedEdge.value = event.edge
}

const updateNodeLabel = () => {
  if (selectedNode.value) {
    selectedNode.value.label = selectedNode.value.data.name
  }
}

const addCronJob = () => {
  if (!selectedNode.value.data.cronJobs) {
    selectedNode.value.data.cronJobs = []
  }
  selectedNode.value.data.cronJobs.push({ expression: '', prompt: '' })
}

const removeCronJob = (index) => {
  selectedNode.value.data.cronJobs.splice(index, 1)
}

const removeEdge = () => {
  if (selectedEdge.value) {
    elements.value = elements.value.filter(e => e.id !== selectedEdge.value.id)
    selectedEdge.value = null
  }
}

const openMcpConfig = () => {
  mcpServersJson.value = JSON.stringify(mcpServers.value, null, 2)
  mcpJsonError.value = ''
  showMcpConfig.value = true
}

const saveMcpConfig = () => {
  try {
    const parsed = JSON.parse(mcpServersJson.value)
    mcpServers.value = parsed
    showMcpConfig.value = false
    saveSystem() // Automatically save and restart
  } catch (e) {
    mcpJsonError.value = 'Invalid JSON format: ' + e.message
  }
}

const saveSystem = async () => {
  isSaving.value = true
  try {
    const nodes = elements.value.filter(e => !e.source)
    const edges = elements.value.filter(e => e.source)
    
    const system = {
      agents: nodes.map(n => ({
        id: n.id,
        name: n.data.name,
        position: n.position,
        data: {
          systemPrompt: n.data.systemPrompt,
          provider: n.data.provider,
          model: n.data.model,
          baseURL: n.data.baseURL,
          apiKey: n.data.apiKey,
          cronJobs: n.data.cronJobs
        }
      })),
      connections: edges.map(e => ({
        id: e.id,
        source: e.source,
        target: e.target,
        data: e.data
      })),
      mcpServers: mcpServers.value
    }
    
    const response = await fetch('/api/system', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(system)
    })
    
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`)
    }
    
    alert('System saved successfully!')
  } catch (error) {
    console.error('Failed to save system:', error)
    alert('Failed to save system')
  } finally {
    isSaving.value = false
  }
}
</script>

<style scoped>
.graph-editor {
  display: flex;
  flex-direction: column;
  height: 100vh;
}

.toolbar {
  padding: 10px;
  background: #f5f5f5;
  border-bottom: 1px solid #ddd;
  display: flex;
  gap: 10px;
}

.toolbar button {
  padding: 8px 16px;
  background: #4CAF50;
  color: white;
  border: none;
  border-radius: 4px;
  cursor: pointer;
}

.toolbar button:disabled {
  background: #ccc;
}

.editor-container {
  flex: 1;
  position: relative;
  display: flex;
}

.vue-flow-container {
  flex: 1;
  height: 100%;
}

.config-panel {
  width: 300px;
  background: white;
  border-left: 1px solid #ddd;
  padding: 20px;
  overflow-y: auto;
  box-shadow: -2px 0 5px rgba(0,0,0,0.1);
}

.form-group {
  margin-bottom: 15px;
}

.form-group label {
  display: block;
  margin-bottom: 5px;
  font-weight: bold;
}

.form-group input,
.form-group select,
.form-group textarea {
  width: 100%;
  padding: 8px;
  border: 1px solid #ccc;
  border-radius: 4px;
  box-sizing: border-box;
}

.cron-job {
  display: flex;
  gap: 5px;
  margin-bottom: 10px;
}

.cron-expr {
  width: 80px;
}

.cron-prompt {
  flex: 1;
}

.btn-remove {
  background: #f44336;
  color: white;
  border: none;
  border-radius: 4px;
  cursor: pointer;
}

.btn-add {
  width: 100%;
  padding: 8px;
  background: #2196F3;
  color: white;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  margin-bottom: 20px;
}

.btn-close {
  width: 100%;
  padding: 10px;
  background: #607D8B;
  color: white;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  margin-top: 20px;
}

.btn-remove-edge {
  width: 100%;
  padding: 10px;
  background: #f44336;
  color: white;
  border: none;
  border-radius: 4px;
  cursor: pointer;
}

.modal-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0,0,0,0.5);
  display: flex;
  justify-content: center;
  align-items: center;
  z-index: 1000;
}

.modal-content {
  background: white;
  padding: 20px;
  border-radius: 8px;
  width: 500px;
  max-height: 80vh;
  overflow-y: auto;
}

.mcp-server-item {
  border: 1px solid #eee;
  padding: 10px;
  margin-bottom: 10px;
  border-radius: 4px;
}

.add-mcp-server {
  margin-top: 20px;
  padding-top: 20px;
  border-top: 1px solid #eee;
  display: flex;
  gap: 10px;
  align-items: center;
}

.modal-actions {
  margin-top: 20px;
  text-align: right;
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}

.btn-save {
  background: #4CAF50;
  color: white;
  border: none;
  border-radius: 4px;
  padding: 8px 16px;
  cursor: pointer;
}

.error-text {
  color: #f44336;
  margin-top: 10px;
  font-size: 14px;
}
</style>
