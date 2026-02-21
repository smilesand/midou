<template>
  <div class="h-full flex flex-col bg-gray-50">
    <div class="p-4 bg-white border-b border-gray-200 flex justify-between items-center">
      <h2 class="text-lg font-semibold">Chat</h2>
      <div class="flex items-center gap-2">
        <label class="text-sm font-medium text-gray-700">Target Agent:</label>
        <select v-model="selectedAgentId" class="border border-gray-300 rounded-md p-1 text-sm">
          <option value="">Auto (First Agent)</option>
          <option v-for="agent in agents" :key="agent.id" :value="agent.id">{{ agent.name }}</option>
        </select>
      </div>
    </div>
    <div class="flex-1 overflow-y-auto p-4 space-y-4">
      <div v-for="(msg, index) in messages" :key="index" class="flex" :class="msg.role === 'user' ? 'justify-end' : 'justify-start'">
        <div class="max-w-[70%] rounded-lg p-3 shadow-sm" :class="msg.role === 'user' ? 'bg-blue-500 text-white' : 'bg-white border border-gray-200'">
          <div class="text-xs font-semibold mb-1 opacity-75">{{ msg.role === 'user' ? 'You' : msg.agent }}</div>
          <div class="prose prose-sm max-w-none" :class="msg.role === 'user' ? 'prose-invert' : ''" v-html="renderMarkdown(msg.content)"></div>
        </div>
      </div>
    </div>
    <div class="p-4 bg-white border-t border-gray-200">
      <div class="flex gap-2">
        <input v-model="inputMessage" @keyup.enter="sendMessage" type="text" class="flex-1 border border-gray-300 rounded-lg px-4 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500" placeholder="Type your message..." />
        <button @click="sendMessage" class="bg-blue-500 text-white px-6 py-2 rounded-lg hover:bg-blue-600 transition-colors">Send</button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, watch } from 'vue'
import { marked } from 'marked'
import { io } from 'socket.io-client'

const messages = ref([
  { role: 'system', agent: 'System', content: 'Welcome to Midou Multi-Agent Chat!' }
])
const inputMessage = ref('')
const agents = ref([])
const selectedAgentId = ref('')
let socket = null
let currentAssistantMessage = null

onMounted(async () => {
  await loadAgents()
  await loadHistory()
  
  socket = io('http://localhost:3000')
  
  socket.on('message_delta', (data) => {
    if (!currentAssistantMessage) {
      currentAssistantMessage = { role: 'assistant', agent: data.agentId || 'Agent', content: '' }
      messages.value.push(currentAssistantMessage)
      currentAssistantMessage = messages.value[messages.value.length - 1]
    }
    currentAssistantMessage.content += data.text
  })

  socket.on('message_end', (data) => {
    if (currentAssistantMessage) {
      currentAssistantMessage = null
    }
  })

  socket.on('thinking_start', (data) => {
    if (!currentAssistantMessage) {
      currentAssistantMessage = { role: 'assistant', agent: data.agentId || 'Agent', content: '<details><summary>💭 Thinking...</summary>\n\n' }
      messages.value.push(currentAssistantMessage)
      currentAssistantMessage = messages.value[messages.value.length - 1]
    }
  })

  socket.on('thinking_delta', (data) => {
    if (currentAssistantMessage) {
      currentAssistantMessage.content += data.text
    }
  })

  socket.on('thinking_end', () => {
    if (currentAssistantMessage) {
      currentAssistantMessage.content += '\n\n</details>\n\n'
    }
  })

  socket.on('error', (data) => {
    messages.value.push({ role: 'system', agent: 'System', content: `Error: ${data.message}` })
  })
})

const loadAgents = async () => {
  try {
    const res = await fetch('http://localhost:3000/api/system')
    const data = await res.json()
    agents.value = data.agents || []
  } catch (error) {
    console.error('Failed to load agents:', error)
  }
}

const loadHistory = async () => {
  try {
    const agentId = selectedAgentId.value || 'null'
    const res = await fetch(`http://localhost:3000/api/agent/${agentId}/history`)
    const data = await res.json()
    
    // Reset messages to just the system welcome message
    messages.value = [
      { role: 'system', agent: 'System', content: 'Welcome to Midou Multi-Agent Chat!' }
    ]
    
    if (data.messages && data.messages.length > 0) {
      messages.value.push(...data.messages)
    }
  } catch (error) {
    console.error('Failed to load history:', error)
  }
}

watch(selectedAgentId, () => {
  loadHistory()
})

const renderMarkdown = (text) => {
  let processedText = text || ''
  processedText = processedText.replace(/<think>/g, '<details><summary>💭 Thinking...</summary>\n\n')
  processedText = processedText.replace(/<\/think>/g, '\n\n</details>\n\n')
  return marked(processedText)
}

const sendMessage = () => {
  if (!inputMessage.value.trim()) return
  
  const msg = {
    role: 'user',
    content: inputMessage.value,
    targetAgentId: selectedAgentId.value || null
  }
  
  messages.value.push(msg)
  socket.emit('message', msg)
  inputMessage.value = ''
}
</script>
