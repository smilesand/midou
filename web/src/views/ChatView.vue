<template>
  <div class="h-full flex flex-col bg-gray-50 relative">
    <div class="p-4 bg-white border-b border-gray-200 flex justify-between items-center">
      <h2 class="text-lg font-semibold">Chat</h2>
      <div class="flex items-center gap-4">
        <button @click="toggleTodoDrawer" class="text-sm font-medium text-blue-600 hover:text-blue-800 flex items-center gap-1">
          <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
            <path fill-rule="evenodd" d="M3 4a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm0 4a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm0 4a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm0 4a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1z" clip-rule="evenodd" />
          </svg>
          TODOs
        </button>
        <div class="flex items-center gap-2">
          <label class="text-sm font-medium text-gray-700">Target Agent:</label>
          <select v-model="selectedAgentId" class="border border-gray-300 rounded-md p-1 text-sm">
            <option value="">Auto (First Agent)</option>
            <option v-for="agent in agents" :key="agent.id" :value="agent.id">{{ agent.name }}</option>
          </select>
        </div>
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
        <input v-model="inputMessage" @keyup.enter="sendMessage" type="text" class="flex-1 border border-gray-300 rounded-lg px-4 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500" placeholder="Type your message..." :disabled="isBusy" />
        <button v-if="!isBusy" @click="sendMessage" class="bg-blue-500 text-white px-6 py-2 rounded-lg hover:bg-blue-600 transition-colors">Send</button>
        <button v-else @click="interruptAgent" class="bg-red-500 text-white px-6 py-2 rounded-lg hover:bg-red-600 transition-colors">Interrupt</button>
      </div>
    </div>

    <!-- TODO Drawer -->
    <div v-if="isTodoDrawerOpen" class="absolute top-0 right-0 w-96 h-full bg-white shadow-2xl border-l border-gray-200 flex flex-col z-50 transition-transform transform translate-x-0">
      <div class="p-4 border-b border-gray-200 flex justify-between items-center bg-gray-50">
        <h3 class="text-lg font-semibold text-gray-800">TODO Management</h3>
        <button @click="toggleTodoDrawer" class="text-gray-500 hover:text-gray-700">
          <svg xmlns="http://www.w3.org/2000/svg" class="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
      
      <div class="flex-1 overflow-y-auto p-4 space-y-4">
        <!-- Add New TODO Form -->
        <div class="bg-blue-50 p-3 rounded-lg border border-blue-100 space-y-2">
          <h4 class="text-sm font-semibold text-blue-800">Add New TODO</h4>
          <input v-model="newTodo.title" type="text" placeholder="Task Title" class="w-full border border-gray-300 rounded px-2 py-1 text-sm" />
          <textarea v-model="newTodo.description" placeholder="Description (optional)" class="w-full border border-gray-300 rounded px-2 py-1 text-sm" rows="2"></textarea>
          <select v-model="newTodo.agentId" class="w-full border border-gray-300 rounded px-2 py-1 text-sm">
            <option value="" disabled>Select Assignee</option>
            <option v-for="agent in agents" :key="agent.id" :value="agent.id">{{ agent.name }}</option>
          </select>
          <button @click="createTodo" class="w-full bg-blue-500 text-white text-sm py-1 rounded hover:bg-blue-600" :disabled="!newTodo.title || !newTodo.agentId">
            Create Task
          </button>
        </div>

        <!-- TODO List -->
        <div v-if="todos.length === 0" class="text-center text-gray-500 text-sm py-4">
          No tasks found.
        </div>
        <div v-for="todo in todos" :key="todo.id" class="border border-gray-200 rounded-lg p-3 space-y-2 bg-white shadow-sm">
          <div class="flex justify-between items-start">
            <div class="flex-1">
              <div class="flex items-center gap-2">
                <span class="font-medium text-sm" :class="{'line-through text-gray-400': todo.status === 'done'}">{{ todo.title }}</span>
                <span class="text-xs px-2 py-0.5 rounded-full" :class="{
                  'bg-yellow-100 text-yellow-800': todo.status === 'pending',
                  'bg-blue-100 text-blue-800': todo.status === 'in_progress',
                  'bg-green-100 text-green-800': todo.status === 'done',
                  'bg-red-100 text-red-800': todo.status === 'blocked'
                }">{{ todo.status }}</span>
              </div>
              <div class="text-xs text-gray-500 mt-1">Assignee: {{ getAgentName(todo.agentId) }}</div>
            </div>
            <button @click="deleteTodo(todo.id)" class="text-red-500 hover:text-red-700 text-xs">Delete</button>
          </div>
          
          <div v-if="todo.description" class="text-xs text-gray-600 bg-gray-50 p-2 rounded">
            {{ todo.description }}
          </div>
          
          <div v-if="todo.notes" class="text-xs text-gray-600 bg-yellow-50 p-2 rounded border border-yellow-100">
            <strong>Notes:</strong> {{ todo.notes }}
          </div>

          <div class="flex gap-2 pt-2 border-t border-gray-100">
            <select v-model="todo.status" @change="updateTodo(todo)" class="text-xs border border-gray-300 rounded px-1 py-0.5 flex-1">
              <option value="pending">Pending</option>
              <option value="in_progress">In Progress</option>
              <option value="done">Done</option>
              <option value="blocked">Blocked</option>
            </select>
          </div>
        </div>
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
const isBusy = ref(false)
const isTodoDrawerOpen = ref(false)
const todos = ref([])
const newTodo = ref({ title: '', description: '', agentId: '' })
let socket = null
let currentAssistantMessage = null

const toggleTodoDrawer = () => {
  isTodoDrawerOpen.value = !isTodoDrawerOpen.value
  if (isTodoDrawerOpen.value) {
    loadTodos()
  }
}

const getAgentName = (id) => {
  const agent = agents.value.find(a => a.id === id)
  return agent ? agent.name : 'Unknown'
}

const loadTodos = async () => {
  try {
    const res = await fetch('http://localhost:3000/api/todos')
    todos.value = await res.json()
  } catch (error) {
    console.error('Failed to load todos:', error)
  }
}

const createTodo = async () => {
  if (!newTodo.value.title || !newTodo.value.agentId) return
  try {
    const res = await fetch('http://localhost:3000/api/todos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(newTodo.value)
    })
    if (res.ok) {
      newTodo.value = { title: '', description: '', agentId: '' }
      await loadTodos()
    }
  } catch (error) {
    console.error('Failed to create todo:', error)
  }
}

const updateTodo = async (todo) => {
  try {
    await fetch(`http://localhost:3000/api/todos/${todo.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: todo.status, notes: todo.notes })
    })
  } catch (error) {
    console.error('Failed to update todo:', error)
  }
}

const deleteTodo = async (id) => {
  try {
    const res = await fetch(`http://localhost:3000/api/todos/${id}`, {
      method: 'DELETE'
    })
    if (res.ok) {
      await loadTodos()
    }
  } catch (error) {
    console.error('Failed to delete todo:', error)
  }
}

onMounted(async () => {
  await loadAgents()
  await loadHistory()
  
  socket = io('http://localhost:3000')
  
  socket.on('agent_busy', () => {
    isBusy.value = true
  })

  socket.on('agent_idle', () => {
    isBusy.value = false
  })

  socket.on('system_message', (data) => {
    messages.value.push({ role: 'system', agent: 'System', content: data.message })
  })

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
  if (!inputMessage.value.trim() || isBusy.value) return
  
  const msg = {
    role: 'user',
    content: inputMessage.value,
    targetAgentId: selectedAgentId.value || null
  }
  
  messages.value.push(msg)
  socket.emit('message', msg)
  inputMessage.value = ''
}

const interruptAgent = () => {
  if (!isBusy.value) return
  socket.emit('interrupt', { targetAgentId: selectedAgentId.value || null })
}
</script>
