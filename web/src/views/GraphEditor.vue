<template>
  <div class="flex flex-col h-full">
    <div class="p-2.5 bg-gray-100 border-b border-gray-300 flex gap-2.5">
      <button @click="addAgent" class="px-4 py-2 bg-green-500 text-white border-none rounded cursor-pointer disabled:bg-gray-300">Add Agent</button>
      <button @click="layoutGraph" class="px-4 py-2 bg-green-500 text-white border-none rounded cursor-pointer disabled:bg-gray-300">Auto Layout</button>
      <button @click="saveSystem" :disabled="isSaving" class="px-4 py-2 bg-green-500 text-white border-none rounded cursor-pointer disabled:bg-gray-300">
        {{ isSaving ? 'Saving...' : 'Save System' }}
      </button>
      <button @click="exportSystem" class="px-4 py-2 bg-green-500 text-white border-none rounded cursor-pointer disabled:bg-gray-300">Export System</button>
      <button @click="triggerImport" class="px-4 py-2 bg-green-500 text-white border-none rounded cursor-pointer disabled:bg-gray-300">Import System</button>
      <input type="file" ref="fileInput" @change="importSystem" accept=".json" class="hidden" />
      <button @click="openMcpConfig" class="px-4 py-2 bg-green-500 text-white border-none rounded cursor-pointer disabled:bg-gray-300">Configure MCP</button>
    </div>
    
    <div class="flex-1 relative flex min-h-0">
      <VueFlow
        v-model="elements"
        :default-zoom="1"
        :min-zoom="0.2"
        :max-zoom="4"
        @connect="onConnect"
        @node-click="onNodeClick"
        @edge-click="onEdgeClick"
        @node-drag-stop="onNodeDragStop"
        class="flex-1 h-full"
      >
        <template #node-agent="props">
          <div class="px-4 py-3 bg-white border-2 border-blue-500 rounded-lg shadow-md min-w-[150px] text-center relative">
            <Handle type="target" position="left" id="left-target" class="!w-3 !h-3 !bg-blue-500 !-left-1.5" style="top: 30%" />
            <Handle type="source" position="left" id="left-source" class="!w-3 !h-3 !bg-green-500 !-left-1.5" style="top: 70%" />
            <div class="font-bold text-gray-800">{{ props.data.name }}</div>
            <div class="text-xs text-gray-500 mt-1">{{ props.data.provider }}</div>
            <Handle type="target" position="right" id="right-target" class="!w-3 !h-3 !bg-blue-500 !-right-1.5" style="top: 30%" />
            <Handle type="source" position="right" id="right-source" class="!w-3 !h-3 !bg-green-500 !-right-1.5" style="top: 70%" />
          </div>
        </template>
        <Background pattern-color="#aaa" gap="16" />
        <Controls />
        <MiniMap />
      </VueFlow>

      <!-- Agent Config Panel -->
      <div v-if="selectedNode" class="absolute right-0 top-0 bottom-0 w-80 bg-gray-50 border-l border-gray-200 flex flex-col overflow-hidden box-border shadow-[-4px_0_15px_rgba(0,0,0,0.05)] z-10">
        <div class="p-4 bg-white border-b border-gray-200 flex justify-between items-center">
          <h3 class="m-0 text-base text-gray-800">Agent Configuration</h3>
          <button @click="selectedNode = null" class="bg-transparent border-none text-2xl leading-none text-gray-400 cursor-pointer p-0 m-0 hover:text-gray-800">×</button>
        </div>
        <div class="flex-1 p-5 overflow-y-auto">
          <div class="mb-4 bg-white p-3 rounded-md border border-gray-100">
            <label class="block mb-2 font-semibold text-gray-700 text-sm">Name:</label>
            <input v-model="selectedNode.data.name" @input="updateNodeLabel" class="w-full px-2.5 py-2 border border-gray-300 rounded box-border text-sm transition-colors focus:outline-none focus:border-blue-500" />
          </div>
          <div class="mb-4 bg-white p-3 rounded-md border border-gray-100">
            <label title="If enabled, the agent will automatically loop and use tools until the task is finished." class="block mb-2 font-semibold text-gray-700 text-sm">
              <input type="checkbox" v-model="selectedNode.data.isAgentMode" />
              Agent Mode ℹ️
            </label>
          </div>
          <div class="mb-4 bg-white p-3 rounded-md border border-gray-100">
            <label title="The core instructions and persona for this agent." class="block mb-2 font-semibold text-gray-700 text-sm">System Prompt ℹ️:</label>
            <textarea v-model="selectedNode.data.systemPrompt" rows="5" class="w-full px-2.5 py-2 border border-gray-300 rounded box-border text-sm transition-colors focus:outline-none focus:border-blue-500"></textarea>
          </div>
          
          <h4 class="mt-5 mb-2.5 text-gray-500 text-sm uppercase tracking-wide">LLM Settings</h4>
          <div class="mb-4 bg-white p-3 rounded-md border border-gray-100">
            <label class="block mb-2 font-semibold text-gray-700 text-sm">Provider:</label>
            <select v-model="selectedNode.data.provider" class="w-full px-2.5 py-2 border border-gray-300 rounded box-border text-sm transition-colors focus:outline-none focus:border-blue-500">
              <option value="anthropic">Anthropic</option>
              <option value="openai">OpenAI</option>
            </select>
          </div>
          <div class="mb-4 bg-white p-3 rounded-md border border-gray-100">
            <label class="block mb-2 font-semibold text-gray-700 text-sm">Model:</label>
            <input v-model="selectedNode.data.model" class="w-full px-2.5 py-2 border border-gray-300 rounded box-border text-sm transition-colors focus:outline-none focus:border-blue-500" />
          </div>
          <div class="mb-4 bg-white p-3 rounded-md border border-gray-100">
            <label title="Optional. Custom API endpoint." class="block mb-2 font-semibold text-gray-700 text-sm">Base URL ℹ️:</label>
            <input v-model="selectedNode.data.baseURL" class="w-full px-2.5 py-2 border border-gray-300 rounded box-border text-sm transition-colors focus:outline-none focus:border-blue-500" />
          </div>
          <div class="mb-4 bg-white p-3 rounded-md border border-gray-100">
            <label class="block mb-2 font-semibold text-gray-700 text-sm">API Key:</label>
            <input type="password" v-model="selectedNode.data.apiKey" class="w-full px-2.5 py-2 border border-gray-300 rounded box-border text-sm transition-colors focus:outline-none focus:border-blue-500" />
          </div>
          <div class="mb-4 bg-white p-3 rounded-md border border-gray-100">
            <label title="Maximum tokens to generate in a single response." class="block mb-2 font-semibold text-gray-700 text-sm">Max Tokens ℹ️:</label>
            <input type="number" v-model.number="selectedNode.data.maxTokens" placeholder="e.g. 4096" class="w-full px-2.5 py-2 border border-gray-300 rounded box-border text-sm transition-colors focus:outline-none focus:border-blue-500" />
          </div>
          <div class="mb-4 bg-white p-3 rounded-md border border-gray-100">
            <label title="Maximum number of tool-calling iterations before stopping." class="block mb-2 font-semibold text-gray-700 text-sm">Max Iterations ℹ️:</label>
            <input type="number" v-model.number="selectedNode.data.maxIterations" placeholder="e.g. 30" class="w-full px-2.5 py-2 border border-gray-300 rounded box-border text-sm transition-colors focus:outline-none focus:border-blue-500" />
          </div>

          <h4 class="mt-5 mb-2.5 text-gray-500 text-sm uppercase tracking-wide">Cron Jobs</h4>
          <div v-for="(job, index) in selectedNode.data.cronJobs" :key="index" class="flex gap-2 mb-2.5 bg-white p-2.5 rounded-md border border-gray-100">
            <input v-model="job.expression" placeholder="* * * * *" class="w-20 px-2.5 py-2 border border-gray-300 rounded box-border text-sm transition-colors focus:outline-none focus:border-blue-500" />
            <input v-model="job.prompt" placeholder="Trigger prompt" class="flex-1 px-2.5 py-2 border border-gray-300 rounded box-border text-sm transition-colors focus:outline-none focus:border-blue-500" />
            <button @click="removeCronJob(index)" class="bg-red-50 text-red-500 border border-red-200 rounded cursor-pointer px-2.5 font-bold transition-all hover:bg-red-500 hover:text-white">X</button>
          </div>
          <button @click="addCronJob" class="w-full p-2.5 bg-blue-50 text-blue-600 border border-dashed border-blue-200 rounded-md cursor-pointer font-semibold transition-all hover:bg-blue-100">+ Add Cron Job</button>
        </div>
        <div class="p-4 bg-white border-t border-gray-200">
          <button @click="removeNode" class="w-full p-2.5 bg-red-500 text-white border-none rounded-md cursor-pointer font-semibold transition-colors hover:bg-red-600">Delete Agent</button>
        </div>
      </div>

      <!-- Edge Config Panel -->
      <div v-if="selectedEdge" class="absolute right-0 top-0 bottom-0 w-80 bg-gray-50 border-l border-gray-200 flex flex-col overflow-hidden box-border shadow-[-4px_0_15px_rgba(0,0,0,0.05)] z-10">
        <div class="p-4 bg-white border-b border-gray-200 flex justify-between items-center">
          <h3 class="m-0 text-base text-gray-800">Connection Config</h3>
          <button @click="selectedEdge = null" class="bg-transparent border-none text-2xl leading-none text-gray-400 cursor-pointer p-0 m-0 hover:text-gray-800">×</button>
        </div>
        <div class="bg-blue-50 px-4 py-2.5 border-b border-blue-100 text-sm font-bold text-blue-800 text-center shadow-inner">
          {{ selectedEdgeLabel }}
        </div>
        <div class="flex-1 p-5 overflow-y-auto">
          <div class="mb-4 bg-white p-3 rounded-md border border-gray-100">
            <label title="If specified, the message must match at least one condition to follow this connection." class="block mb-2 font-semibold text-gray-700 text-sm">Routing Conditions ℹ️:</label>
            
            <div v-for="(cond, index) in selectedEdge.data.conditions" :key="index" class="flex flex-col gap-2 mb-2.5 bg-gray-50 p-2.5 rounded-md border border-gray-200">
              <div class="flex gap-2">
                <select v-model="cond.type" class="w-24 px-2 py-1.5 border border-gray-300 rounded text-sm focus:outline-none focus:border-blue-500">
                  <option value="contains">Contains</option>
                  <option value="regex">Regex</option>
                </select>
                <button @click="removeCondition(index)" class="ml-auto bg-red-50 text-red-500 border border-red-200 rounded cursor-pointer px-2 font-bold transition-all hover:bg-red-500 hover:text-white">X</button>
              </div>
              <input v-model="cond.value" placeholder="Condition value" class="w-full px-2.5 py-2 border border-gray-300 rounded box-border text-sm transition-colors focus:outline-none focus:border-blue-500" />
            </div>
            
            <button @click="addCondition" class="w-full p-2 bg-blue-50 text-blue-600 border border-dashed border-blue-200 rounded-md cursor-pointer font-semibold transition-all hover:bg-blue-100 mt-2">+ Add Condition</button>
            <p class="text-xs text-gray-500 mt-2">If no conditions are added, all messages will be routed.</p>
          </div>
        </div>
        <div class="p-4 bg-white border-t border-gray-200">
          <button @click="removeEdge" class="w-full p-2.5 bg-red-500 text-white border-none rounded-md cursor-pointer font-semibold transition-colors hover:bg-red-600">Delete Connection</button>
        </div>
      </div>

      <!-- MCP Config Modal -->
      <div v-if="showMcpConfig" class="fixed inset-0 bg-black/50 flex justify-center items-center z-[1000]">
        <div class="bg-white p-5 rounded-lg w-[500px] max-h-[80vh] overflow-y-auto">
          <h3 class="mt-0 mb-4 text-lg font-semibold">MCP Servers Configuration (JSON)</h3>
          <div class="mb-4 bg-white p-3 rounded-md border border-gray-100">
            <textarea 
              v-model="mcpServersJson" 
              rows="15" 
              class="font-mono w-full px-2.5 py-2 border border-gray-300 rounded box-border text-sm transition-colors focus:outline-none focus:border-blue-500"
              placeholder='{\n  "server-name": {\n    "command": "npx",\n    "args": ["..."]\n  }\n}'
            ></textarea>
          </div>
          <div v-if="mcpJsonError" class="text-red-500 mt-2.5 text-sm">{{ mcpJsonError }}</div>
          
          <div class="mt-5 text-right flex justify-end gap-2.5">
            <button @click="saveMcpConfig" class="bg-green-500 text-white border-none rounded px-4 py-2 cursor-pointer hover:bg-green-600">Save & Restart MCP</button>
            <button @click="showMcpConfig = false" class="bg-gray-200 text-gray-800 border-none rounded px-4 py-2 cursor-pointer hover:bg-gray-300">Cancel</button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, computed } from 'vue'
import { VueFlow, useVueFlow, Handle, MarkerType } from '@vue-flow/core'
import { Background } from '@vue-flow/background'
import { Controls } from '@vue-flow/controls'
import { MiniMap } from '@vue-flow/minimap'
import dagre from 'dagre'
import '@vue-flow/core/dist/style.css'
import '@vue-flow/core/dist/theme-default.css'

const { onConnect: onConnectFlow, fitView } = useVueFlow()

const elements = ref([])
const selectedNode = ref(null)
const selectedEdge = ref(null)
const isSaving = ref(false)
const showMcpConfig = ref(false)
const mcpServers = ref({})
const mcpServersJson = ref('{}')
const mcpJsonError = ref('')
const fileInput = ref(null)

const selectedEdgeLabel = computed(() => {
  if (!selectedEdge.value) return ''
  const sourceNode = elements.value.find(n => n.id === selectedEdge.value.source)
  const targetNode = elements.value.find(n => n.id === selectedEdge.value.target)
  const sourceName = sourceNode?.data?.name || selectedEdge.value.source
  const targetName = targetNode?.data?.name || selectedEdge.value.target
  return `${sourceName} ➔ ${targetName}`
})

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
      type: 'agent',
      label: agent.name || agent.id,
      position: agent.position || { x: Math.random() * 400, y: Math.random() * 400 },
      data: {
        name: agent.name || agent.id,
        isAgentMode: agent.data?.isAgentMode !== false,
        systemPrompt: agent.data?.systemPrompt || '',
        provider: agent.data?.provider || 'anthropic',
        model: agent.data?.model || '',
        baseURL: agent.data?.baseURL || '',
        apiKey: agent.data?.apiKey || '',
        maxTokens: agent.data?.maxTokens || null,
        maxIterations: agent.data?.maxIterations || null,
        cronJobs: agent.data?.cronJobs || []
      }
    }))
    
    const edges = (data.connections || []).map(conn => {
      let conditions = conn.data?.conditions || []
      // Migrate old single condition to array format
      if (conn.data?.condition && conditions.length === 0) {
        conditions.push({ type: 'contains', value: conn.data.condition })
      }
      return {
        id: conn.id,
        source: conn.source,
        target: conn.target,
        sourceHandle: conn.sourceHandle || 'right-source',
        targetHandle: conn.targetHandle || 'left-target',
        markerEnd: MarkerType.ArrowClosed,
        data: { conditions }
      }
    })
    
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

const layoutGraph = () => {
  const g = new dagre.graphlib.Graph()
  g.setGraph({ rankdir: 'LR', nodesep: 100, ranksep: 200 })
  g.setDefaultEdgeLabel(() => ({}))

  const nodes = elements.value.filter(e => !e.source)
  const edges = elements.value.filter(e => e.source)

  nodes.forEach(node => {
    g.setNode(node.id, { width: 150, height: 50 })
  })

  edges.forEach(edge => {
    g.setEdge(edge.source, edge.target)
  })

  dagre.layout(g)

  elements.value = elements.value.map(el => {
    if (!el.source) {
      const nodeWithPosition = g.node(el.id)
      return {
        ...el,
        position: {
          x: nodeWithPosition.x - 75,
          y: nodeWithPosition.y - 25
        }
      }
    }
    return el
  })

  setTimeout(() => {
    fitView({ padding: 0.2 })
  }, 50)
}

const addAgent = () => {
  const id = `agent-${nodeId++}`
  elements.value.push({
    id,
    type: 'agent',
    label: `New Agent ${id}`,
    position: { x: 100, y: 100 },
    data: {
      name: `New Agent ${id}`,
      isAgentMode: true,
      systemPrompt: 'You are a helpful AI assistant.',
      provider: 'anthropic',
      model: '',
      baseURL: '',
      apiKey: '',
      maxTokens: null,
      maxIterations: null,
      cronJobs: []
    }
  })
}

const onConnect = (params) => {
  params.id = `edge-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
  params.data = { conditions: [] }
  params.markerEnd = MarkerType.ArrowClosed
  elements.value.push(params)
}

const onNodeClick = (event) => {
  selectedEdge.value = null
  // 确保节点对象是响应式的
  const node = elements.value.find(n => n.id === event.node.id)
  selectedNode.value = node || null
}

const onEdgeClick = (event) => {
  selectedNode.value = null
  // 确保边对象是响应式的
  const edge = elements.value.find(e => e.id === event.edge.id)
  selectedEdge.value = edge || null
}

const onNodeDragStop = (event) => {
  const node = elements.value.find(n => n.id === event.node.id)
  if (node) {
    node.position = { ...event.node.position }
  }
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

const addCondition = () => {
  if (!selectedEdge.value.data.conditions) {
    selectedEdge.value.data.conditions = []
  }
  selectedEdge.value.data.conditions.push({ type: 'contains', value: '' })
}

const removeCondition = (index) => {
  selectedEdge.value.data.conditions.splice(index, 1)
}

const removeNode = () => {
  if (selectedNode.value) {
    // Remove the node and any connected edges
    elements.value = elements.value.filter(e => 
      e.id !== selectedNode.value.id && 
      e.source !== selectedNode.value.id && 
      e.target !== selectedNode.value.id
    )
    selectedNode.value = null
  }
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

const getSystemData = () => {
  const nodes = elements.value.filter(e => !e.source)
  const edges = elements.value.filter(e => e.source)
  
  return {
    agents: nodes.map(n => ({
      id: n.id,
      name: n.data.name,
      position: n.position,
      data: {
        isAgentMode: n.data.isAgentMode,
        systemPrompt: n.data.systemPrompt,
        provider: n.data.provider,
        model: n.data.model,
        baseURL: n.data.baseURL,
        apiKey: n.data.apiKey,
        maxTokens: n.data.maxTokens,
        maxIterations: n.data.maxIterations,
        cronJobs: n.data.cronJobs
      }
    })),
    connections: edges.map(e => ({
      id: e.id,
      source: e.source,
      target: e.target,
      sourceHandle: e.sourceHandle,
      targetHandle: e.targetHandle,
      data: e.data
    })),
    mcpServers: mcpServers.value
  }
}

const exportSystem = () => {
  const systemData = getSystemData()
  const blob = new Blob([JSON.stringify(systemData, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = 'system.json'
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

const triggerImport = () => {
  if (fileInput.value) {
    fileInput.value.click()
  }
}

const importSystem = async (event) => {
  const file = event.target.files[0]
  if (!file) return
  
  const reader = new FileReader()
  reader.onload = async (e) => {
    try {
      const systemData = JSON.parse(e.target.result)
      
      // Send to backend to save and reload
      const response = await fetch('/api/system', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(systemData)
      })
      
      if (response.ok) {
        alert('System imported successfully!')
        window.location.reload()
      } else {
        alert('Failed to import system.')
      }
    } catch (err) {
      alert('Invalid JSON file.')
      console.error(err)
    }
  }
  reader.readAsText(file)
  
  // Reset input
  event.target.value = ''
}

async function saveSystem() {
  isSaving.value = true
  try {
    const system = getSystemData()
    
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
/* Tailwind CSS is used for styling. Custom styles can be added here if needed. */
</style>
