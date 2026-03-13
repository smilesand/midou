<template>
  <div class="flex flex-col h-full bg-gray-50">
    <!-- 顶部工具栏 -->
    <div class="p-2.5 bg-gray-100 border-b border-gray-300 flex gap-2.5 items-center">
      <h2 class="m-0 text-lg font-bold text-gray-800 mr-4">流水线管理</h2>
      <button @click="showCreateDialog = true" class="px-4 py-2 bg-green-500 text-white border-none rounded cursor-pointer hover:bg-green-600">
        新建流水线
      </button>
      <button @click="loadData" class="px-4 py-2 bg-blue-500 text-white border-none rounded cursor-pointer hover:bg-blue-600">
        刷新
      </button>
      <router-link to="/pipeline/help" class="px-4 py-2 bg-amber-500 text-white border-none rounded cursor-pointer hover:bg-amber-600 no-underline text-sm">
        使用帮助
      </router-link>
      <router-link to="/" class="px-4 py-2 bg-gray-500 text-white border-none rounded cursor-pointer hover:bg-gray-600 no-underline text-sm">
        返回编辑器
      </router-link>
    </div>

    <div class="flex-1 flex min-h-0 overflow-hidden">
      <!-- 左侧：流水线列表 -->
      <div class="w-72 border-r border-gray-200 bg-white overflow-y-auto">
        <div class="p-3 border-b border-gray-100 text-sm font-semibold text-gray-500 uppercase tracking-wider">
          流水线定义
        </div>
        <div v-if="pipelines.length === 0" class="p-4 text-gray-400 text-sm text-center">
          暂无流水线
        </div>
        <div
          v-for="p in pipelines"
          :key="p.id"
          @click="selectPipeline(p)"
          class="p-3 border-b border-gray-50 cursor-pointer transition-colors hover:bg-blue-50"
          :class="{ 'bg-blue-50 border-l-4 border-l-blue-500': selectedPipeline?.id === p.id }"
        >
          <div class="font-semibold text-gray-800 text-sm">{{ p.name }}</div>
          <div class="text-xs text-gray-400 mt-1">{{ p.stages.length }} 个阶段</div>
          <div class="text-xs text-gray-400">{{ p.projectDir }}</div>
        </div>

        <div class="p-3 border-b border-gray-100 mt-4 text-sm font-semibold text-gray-500 uppercase tracking-wider">
          运行记录
        </div>
        <div v-if="runs.length === 0" class="p-4 text-gray-400 text-sm text-center">
          暂无运行记录
        </div>
        <div
          v-for="r in runs"
          :key="r.id"
          @click="selectRun(r)"
          class="p-3 border-b border-gray-50 cursor-pointer transition-colors hover:bg-green-50"
          :class="{ 'bg-green-50 border-l-4 border-l-green-500': selectedRun?.id === r.id }"
        >
          <div class="flex items-center gap-2">
            <span :class="statusColor(r.status)" class="inline-block w-2 h-2 rounded-full"></span>
            <span class="text-sm font-medium text-gray-700">{{ r.id.slice(0, 16) }}</span>
          </div>
          <div class="text-xs text-gray-400 mt-1">{{ statusLabel(r.status) }}</div>
          <div class="text-xs text-gray-400">{{ formatTime(r.createdAt) }}</div>
        </div>
      </div>

      <!-- 右侧：详情面板 -->
      <div class="flex-1 overflow-y-auto p-6">
        <!-- 流水线详情 -->
        <template v-if="selectedPipeline && !selectedRun">
          <div class="max-w-3xl">
            <div class="flex items-center justify-between mb-6">
              <div>
                <h3 class="m-0 text-xl font-bold text-gray-800">{{ selectedPipeline.name }}</h3>
                <p class="text-sm text-gray-500 mt-1">ID: {{ selectedPipeline.id }} | 项目: {{ selectedPipeline.projectDir }}</p>
              </div>
              <div class="flex gap-2">
                <button @click="runPipeline" class="px-4 py-2 bg-blue-600 text-white border-none rounded cursor-pointer hover:bg-blue-700 font-semibold">
                  ▶ 运行
                </button>
                <button @click="deletePipeline" class="px-4 py-2 bg-red-500 text-white border-none rounded cursor-pointer hover:bg-red-600">
                  删除
                </button>
              </div>
            </div>

            <!-- 阶段 DAG 可视化 -->
            <h4 class="text-gray-600 text-sm uppercase tracking-wider mb-3">阶段 (Stages)</h4>
            <div class="space-y-3">
              <div
                v-for="stage in selectedPipeline.stages"
                :key="stage.id"
                class="bg-white border border-gray-200 rounded-lg p-4 shadow-sm"
              >
                <div class="flex items-center justify-between">
                  <div>
                    <span class="font-bold text-gray-800">{{ stage.name }}</span>
                    <span v-if="stage.isGate" class="ml-2 px-2 py-0.5 bg-yellow-100 text-yellow-700 text-xs rounded-full">审查门禁</span>
                  </div>
                  <span class="text-xs text-gray-400">Agent: {{ stage.agentId }}</span>
                </div>
                <div class="mt-2 text-xs text-gray-500">
                  <span v-if="stage.dependsOn.length > 0" class="mr-4">依赖: {{ stage.dependsOn.join(', ') }}</span>
                  <span v-if="stage.inputArtifacts.length > 0" class="mr-4">输入: {{ stage.inputArtifacts.join(', ') }}</span>
                  <span v-if="stage.outputArtifacts.length > 0">输出: {{ stage.outputArtifacts.join(', ') }}</span>
                </div>
                <div v-if="stage.promptTemplate" class="mt-2 text-xs text-gray-400 bg-gray-50 p-2 rounded font-mono whitespace-pre-wrap max-h-20 overflow-y-auto">
                  {{ stage.promptTemplate.slice(0, 200) }}{{ stage.promptTemplate.length > 200 ? '...' : '' }}
                </div>
              </div>
            </div>
          </div>
        </template>

        <!-- 运行详情 -->
        <template v-else-if="selectedRun">
          <div class="max-w-3xl">
            <div class="flex items-center justify-between mb-6">
              <div>
                <h3 class="m-0 text-xl font-bold text-gray-800">运行: {{ selectedRun.id }}</h3>
                <p class="text-sm text-gray-500 mt-1">
                  流水线: {{ selectedRun.pipelineId }} |
                  状态: <span :class="statusTextColor(selectedRun.status)" class="font-semibold">{{ statusLabel(selectedRun.status) }}</span>
                </p>
              </div>
              <button @click="selectedRun = null" class="px-3 py-1.5 bg-gray-200 text-gray-600 border-none rounded cursor-pointer hover:bg-gray-300 text-sm">
                返回
              </button>
            </div>

            <h4 class="text-gray-600 text-sm uppercase tracking-wider mb-3">阶段状态</h4>
            <div class="space-y-3">
              <div
                v-for="(state, stageId) in selectedRun.stageStates"
                :key="stageId"
                class="bg-white border rounded-lg p-4 shadow-sm"
                :class="stageStateBorder(state.status)"
              >
                <div class="flex items-center justify-between">
                  <div class="flex items-center gap-2">
                    <span :class="statusColor(state.status)" class="inline-block w-3 h-3 rounded-full"></span>
                    <span class="font-bold text-gray-800">{{ stageId }}</span>
                  </div>
                  <span :class="statusTextColor(state.status)" class="text-sm font-semibold">{{ statusLabel(state.status) }}</span>
                </div>
                <div v-if="state.verdict" class="mt-2 text-sm">
                  裁决: <span :class="state.verdict === 'pass' ? 'text-green-600' : 'text-red-600'" class="font-bold">{{ state.verdict === 'pass' ? '通过' : '阻塞' }}</span>
                </div>
                <div v-if="state.error" class="mt-2 text-sm text-red-600 bg-red-50 p-2 rounded">
                  {{ state.error }}
                </div>
                <div class="mt-2 text-xs text-gray-400">
                  制品: {{ state.artifacts.length }} 个
                  <span v-if="state.retryCount > 0" class="ml-3">重试: {{ state.retryCount }} 次</span>
                  <span v-if="state.startedAt" class="ml-3">开始: {{ formatTime(state.startedAt) }}</span>
                  <span v-if="state.completedAt" class="ml-3">完成: {{ formatTime(state.completedAt) }}</span>
                </div>
              </div>
            </div>
          </div>
        </template>

        <!-- 空状态 -->
        <template v-else>
          <div class="flex items-center justify-center h-full text-gray-400 text-lg">
            选择一个流水线或运行记录查看详情
          </div>
        </template>
      </div>
    </div>

    <!-- 创建流水线对话框 -->
    <div v-if="showCreateDialog" class="fixed inset-0 bg-black/50 flex justify-center items-center z-[1000]">
      <div class="bg-white p-6 rounded-lg w-[900px] max-h-[85vh] overflow-y-auto shadow-xl">
        <h3 class="mt-0 mb-4 text-lg font-semibold">新建流水线</h3>
        <div class="mb-4">
          <label class="block mb-1 text-sm font-semibold text-gray-700">名称</label>
          <input v-model="newPipeline.name" class="w-full px-3 py-2 border border-gray-300 rounded text-sm" placeholder="如: 前后端契约驱动流水线" />
        </div>
        <div class="mb-4">
          <label class="block mb-1 text-sm font-semibold text-gray-700">项目目录</label>
          <input v-model="newPipeline.projectDir" class="w-full px-3 py-2 border border-gray-300 rounded text-sm font-mono" placeholder="/path/to/project" />
        </div>

        <div class="mb-4 flex items-center justify-between gap-3">
          <div>
            <h4 class="m-0 text-gray-600 text-sm">阶段定义构建器</h4>
            <p class="mt-1 text-xs text-gray-500 leading-5">
              从已定义 Agent 列表中选择执行者，系统会自动建议阶段名、产出制品、消费制品、门禁设置和提示词模板。
            </p>
          </div>
          <button @click="addStage" class="px-3 py-2 bg-indigo-500 text-white border-none rounded cursor-pointer hover:bg-indigo-600 text-sm font-semibold">
            添加阶段
          </button>
        </div>

        <div v-if="stageDrafts.length === 0" class="rounded-lg border border-dashed border-gray-300 bg-gray-50 px-4 py-6 text-center text-sm text-gray-400">
          还没有阶段。点击“添加阶段”开始构建。
        </div>

        <div v-for="(stage, index) in stageDrafts" :key="stage.localId" class="mb-4 rounded-xl border border-gray-200 bg-gray-50 p-4">
          <div class="mb-3 flex items-center justify-between">
            <div>
              <div class="text-sm font-bold text-gray-800">阶段 {{ index + 1 }}</div>
              <div class="text-xs text-gray-400">系统会实时生成右侧 JSON 预览</div>
            </div>
            <button @click="removeStage(index)" class="px-3 py-1.5 bg-red-100 text-red-600 border border-red-200 rounded cursor-pointer hover:bg-red-200 text-sm">
              删除阶段
            </button>
          </div>

          <div class="grid gap-3 md:grid-cols-2">
            <div>
              <label class="mb-1 block text-sm font-semibold text-gray-700">执行 Agent</label>
              <select v-model="stage.agentId" @change="applyAgentSuggestion(stage)" class="w-full rounded border border-gray-300 px-3 py-2 text-sm">
                <option value="">请选择 Agent</option>
                <option v-for="agent in agentOptions" :key="agent.id" :value="agent.id">
                  {{ agent.name }} ({{ agent.id }})
                </option>
              </select>
            </div>
            <div>
              <label class="mb-1 block text-sm font-semibold text-gray-700">阶段名称</label>
              <input v-model="stage.name" class="w-full rounded border border-gray-300 px-3 py-2 text-sm" placeholder="如: 契约设计" />
            </div>
            <div>
              <label class="mb-1 block text-sm font-semibold text-gray-700">阶段 ID</label>
              <input v-model="stage.id" class="w-full rounded border border-gray-300 px-3 py-2 text-sm font-mono" placeholder="如: contract-design" />
            </div>
            <div class="flex items-end">
              <label class="flex items-center gap-2 text-sm text-gray-700">
                <input type="checkbox" v-model="stage.isGate" />
                这是门禁阶段
              </label>
            </div>
          </div>

          <div class="mt-3 grid gap-3 md:grid-cols-3">
            <div>
              <label class="mb-1 block text-sm font-semibold text-gray-700">依赖阶段</label>
              <div class="max-h-28 overflow-y-auto rounded border border-gray-200 bg-white p-2">
                <label v-for="candidate in dependencyCandidates(index)" :key="candidate.localId" class="mb-1 flex items-center gap-2 text-sm text-gray-700 last:mb-0">
                  <input type="checkbox" :value="candidate.id" v-model="stage.dependsOn" :disabled="!candidate.id" />
                  <span>{{ candidate.name || candidate.id || '未命名阶段' }}</span>
                </label>
                <div v-if="dependencyCandidates(index).length === 0" class="text-xs text-gray-400">无可选上游阶段</div>
              </div>
            </div>
            <div>
              <label class="mb-1 block text-sm font-semibold text-gray-700">输入制品</label>
              <div class="rounded border border-gray-200 bg-white p-2">
                <label v-for="artifact in artifactTypes" :key="artifact" class="mb-1 flex items-center gap-2 text-sm text-gray-700 last:mb-0">
                  <input type="checkbox" :value="artifact" v-model="stage.inputArtifacts" />
                  <span>{{ artifact }}</span>
                </label>
              </div>
            </div>
            <div>
              <label class="mb-1 block text-sm font-semibold text-gray-700">输出制品</label>
              <div class="rounded border border-gray-200 bg-white p-2">
                <label v-for="artifact in artifactTypes" :key="artifact" class="mb-1 flex items-center gap-2 text-sm text-gray-700 last:mb-0">
                  <input type="checkbox" :value="artifact" v-model="stage.outputArtifacts" />
                  <span>{{ artifact }}</span>
                </label>
              </div>
            </div>
          </div>

          <div v-if="stage.isGate" class="mt-3">
            <label class="mb-1 block text-sm font-semibold text-gray-700">阻塞后回滚到</label>
            <select v-model="stage.onBlockReturnTo" class="w-full rounded border border-gray-300 px-3 py-2 text-sm">
              <option value="">不回滚</option>
              <option v-for="candidate in dependencyCandidates(index)" :key="candidate.localId" :value="candidate.id" :disabled="!candidate.id">
                {{ candidate.name || candidate.id || '未命名阶段' }}
              </option>
            </select>
          </div>

          <div class="mt-3">
            <label class="mb-1 block text-sm font-semibold text-gray-700">提示词模板</label>
            <textarea v-model="stage.promptTemplate" rows="4" class="w-full rounded border border-gray-300 px-3 py-2 text-sm font-mono" placeholder="请描述该阶段要做的事"></textarea>
          </div>
        </div>

        <h4 class="text-gray-600 text-sm mb-2">阶段定义 JSON 预览</h4>
        <p class="mb-2 text-xs text-gray-500 leading-5">
          下面内容由上方表单自动生成，可直接作为流水线的阶段数组。
          <router-link to="/pipeline/help" class="text-amber-600 no-underline font-semibold hover:text-amber-700">查看完整字段说明与示例</router-link>
        </p>
        <textarea
          :value="newPipelineStagesJson"
          rows="15"
          readonly
          class="w-full px-3 py-2 border border-gray-300 rounded text-sm font-mono bg-gray-50"
        ></textarea>
        <div v-if="createError" class="text-red-500 mt-2 text-sm">{{ createError }}</div>

        <div class="mt-5 flex justify-end gap-2">
          <button @click="createPipeline" class="px-4 py-2 bg-green-500 text-white border-none rounded cursor-pointer hover:bg-green-600 font-semibold">创建</button>
          <button @click="showCreateDialog = false" class="px-4 py-2 bg-gray-200 text-gray-700 border-none rounded cursor-pointer hover:bg-gray-300">取消</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, onMounted, onUnmounted } from 'vue'
import { io as socketIO } from 'socket.io-client'

type ArtifactType = 'contract' | 'code' | 'review-report' | 'test-suite' | 'mock-data'

interface AgentRole {
  type: string
  produces?: ArtifactType[]
  consumes?: ArtifactType[]
  canVerdict?: boolean
}

interface AgentOption {
  id: string
  name: string
  role?: AgentRole
}

interface StageDraft extends StageDefinition {
  localId: string
}

interface StageDefinition {
  id: string
  name: string
  agentId: string
  dependsOn: string[]
  inputArtifacts: ArtifactType[]
  outputArtifacts: ArtifactType[]
  promptTemplate: string
  isGate?: boolean
  onBlockReturnTo?: string
}

interface PipelineDefinition {
  id: string
  name: string
  projectDir: string
  stages: StageDefinition[]
}

interface StageState {
  status: string
  artifacts: string[]
  verdict?: string
  retryCount: number
  startedAt?: string
  completedAt?: string
  error?: string
}

interface PipelineRun {
  id: string
  pipelineId: string
  status: string
  stageStates: Record<string, StageState>
  createdAt: string
  completedAt?: string
}

const pipelines = ref<PipelineDefinition[]>([])
const runs = ref<PipelineRun[]>([])
const agentOptions = ref<AgentOption[]>([])
const selectedPipeline = ref<PipelineDefinition | null>(null)
const selectedRun = ref<PipelineRun | null>(null)
const showCreateDialog = ref(false)
const createError = ref('')

const newPipeline = ref({ name: '', projectDir: '' })
const stageDrafts = ref<StageDraft[]>([])
const artifactTypes: ArtifactType[] = ['contract', 'code', 'review-report', 'test-suite', 'mock-data']
const newPipelineStagesJson = computed(() => JSON.stringify(stageDrafts.value.map(stripLocalId), null, 2))

// Socket.IO 实时更新
const socket = socketIO()

onMounted(() => {
  loadData()

  socket.on('pipeline:run_update', (run: PipelineRun) => {
    // 更新 runs 列表
    const idx = runs.value.findIndex(r => r.id === run.id)
    if (idx >= 0) {
      runs.value[idx] = run
    } else {
      runs.value.unshift(run)
    }
    // 如果正在查看这个 run，也更新
    if (selectedRun.value?.id === run.id) {
      selectedRun.value = run
    }
  })
})

onUnmounted(() => {
  socket.disconnect()
})

async function loadData() {
  try {
    const [pRes, rRes, systemRes] = await Promise.all([
      fetch('/api/pipelines'),
      fetch('/api/pipeline-runs'),
      fetch('/api/system'),
    ])
    pipelines.value = await pRes.json()
    runs.value = (await rRes.json()).sort((a: PipelineRun, b: PipelineRun) =>
      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    )
    const systemData = await systemRes.json()
    agentOptions.value = (systemData.agents || []).map((agent: { id: string; name: string; data?: { role?: AgentRole } }) => ({
      id: agent.id,
      name: agent.name,
      role: agent.data?.role,
    }))
  } catch (e) {
    console.error('加载流水线数据失败:', e)
  }
}

function createEmptyStage(): StageDraft {
  return {
    localId: `stage-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    id: '',
    name: '',
    agentId: '',
    dependsOn: [],
    inputArtifacts: [],
    outputArtifacts: [],
    promptTemplate: '',
    isGate: false,
    onBlockReturnTo: '',
  }
}

function stripLocalId(stage: StageDraft): StageDefinition {
  return {
    id: stage.id,
    name: stage.name,
    agentId: stage.agentId,
    dependsOn: [...stage.dependsOn],
    inputArtifacts: [...stage.inputArtifacts],
    outputArtifacts: [...stage.outputArtifacts],
    promptTemplate: stage.promptTemplate,
    isGate: stage.isGate || undefined,
    onBlockReturnTo: stage.isGate ? stage.onBlockReturnTo || undefined : undefined,
  }
}

function dependencyCandidates(currentIndex: number): StageDraft[] {
  return stageDrafts.value.filter((_, idx) => idx < currentIndex)
}

function addStage() {
  stageDrafts.value.push(createEmptyStage())
}

function removeStage(index: number) {
  const removed = stageDrafts.value[index]
  stageDrafts.value.splice(index, 1)
  if (!removed?.id) return
  for (const stage of stageDrafts.value) {
    stage.dependsOn = stage.dependsOn.filter((dep) => dep !== removed.id)
    if (stage.onBlockReturnTo === removed.id) {
      stage.onBlockReturnTo = ''
    }
  }
}

function suggestPrompt(stage: StageDraft, agent: AgentOption): string {
  if (stage.isGate || agent.role?.canVerdict) {
    return '请读取上游制品完成审查，必要时调用 submit_verdict 给出 pass 或 block。'
  }
  if (stage.outputArtifacts.includes('contract')) {
    return '请为 {{PROJECT_DIR}} 设计契约，并调用 produce_artifact 产出 contract。'
  }
  if (stage.outputArtifacts.includes('code')) {
    return '请基于上游制品完成实现，并调用 produce_artifact 产出 code。'
  }
  if (stage.outputArtifacts.includes('test-suite')) {
    return '请基于上游制品编写测试，并调用 produce_artifact 产出 test-suite。'
  }
  if (stage.outputArtifacts.includes('review-report')) {
    return '请审查上游制品，并调用 produce_artifact 产出 review-report。'
  }
  if (stage.outputArtifacts.includes('mock-data')) {
    return '请生成 mock 数据，并调用 produce_artifact 产出 mock-data。'
  }
  return `请完成阶段 ${stage.name || stage.id || '当前任务'}。`
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function applyAgentSuggestion(stage: StageDraft) {
  const agent = agentOptions.value.find((item) => item.id === stage.agentId)
  if (!agent) return

  const roleType = agent.role?.type || 'stage'
  const stageBaseName = stage.name || `${agent.name}阶段`
  const suggestedId = slugify(`${roleType}-${agent.name}-${stageDrafts.value.indexOf(stage) + 1}`) || `stage-${stageDrafts.value.indexOf(stage) + 1}`

  if (!stage.name) {
    stage.name = stageBaseName
  }
  if (!stage.id) {
    stage.id = suggestedId
  }
  if (stage.inputArtifacts.length === 0 && agent.role?.consumes?.length) {
    stage.inputArtifacts = [...agent.role.consumes]
  }
  if (stage.outputArtifacts.length === 0 && agent.role?.produces?.length) {
    stage.outputArtifacts = [...agent.role.produces]
  }
  if (agent.role?.canVerdict) {
    stage.isGate = true
  }
  if (!stage.promptTemplate) {
    stage.promptTemplate = suggestPrompt(stage, agent)
  }
}

function selectPipeline(p: PipelineDefinition) {
  selectedPipeline.value = p
  selectedRun.value = null
}

function selectRun(r: PipelineRun) {
  selectedRun.value = r
  selectedPipeline.value = null
}

async function runPipeline() {
  if (!selectedPipeline.value) return
  try {
    const res = await fetch(`/api/pipelines/${selectedPipeline.value.id}/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: '' }),
    })
    if (!res.ok) throw new Error(await res.text())
    const run = await res.json()
    runs.value.unshift(run)
    selectedRun.value = run
    selectedPipeline.value = null
  } catch (e) {
    alert('启动失败: ' + (e as Error).message)
  }
}

async function createPipeline() {
  createError.value = ''
  try {
    const stages = stageDrafts.value.map(stripLocalId)

    if (!newPipeline.value.name.trim()) {
      throw new Error('请填写流水线名称')
    }
    if (!newPipeline.value.projectDir.trim()) {
      throw new Error('请填写项目目录')
    }
    if (stages.length === 0) {
      throw new Error('请至少添加一个阶段')
    }
    for (const stage of stages) {
      if (!stage.id || !stage.name || !stage.agentId) {
        throw new Error('每个阶段都必须填写 id、name 和 agentId')
      }
    }

    const pipeline: PipelineDefinition = {
      id: `pipeline-${Date.now()}`,
      name: newPipeline.value.name,
      projectDir: newPipeline.value.projectDir,
      stages,
    }

    // 获取当前系统配置
    const sysRes = await fetch('/api/system')
    const sysData = await sysRes.json()

    const currentPipelines = sysData.pipelines || []
    currentPipelines.push(pipeline)

    // 保存
    await fetch('/api/system', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...sysData, pipelines: currentPipelines }),
    })

    showCreateDialog.value = false
    newPipeline.value = { name: '', projectDir: '' }
    stageDrafts.value = []
    await loadData()
  } catch (e) {
    createError.value = (e as Error).message
  }
}

async function deletePipeline() {
  if (!selectedPipeline.value || !confirm('确定删除此流水线？')) return
  try {
    const sysRes = await fetch('/api/system')
    const sysData = await sysRes.json()
    sysData.pipelines = (sysData.pipelines || []).filter(
      (p: PipelineDefinition) => p.id !== selectedPipeline.value!.id
    )
    await fetch('/api/system', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sysData),
    })
    selectedPipeline.value = null
    await loadData()
  } catch (e) {
    alert('删除失败: ' + (e as Error).message)
  }
}

function statusColor(status: string): string {
  const map: Record<string, string> = {
    running: 'bg-blue-500',
    completed: 'bg-green-500',
    blocked: 'bg-red-500',
    failed: 'bg-red-500',
    pending: 'bg-gray-300',
    skipped: 'bg-gray-300',
  }
  return map[status] || 'bg-gray-300'
}

function statusTextColor(status: string): string {
  const map: Record<string, string> = {
    running: 'text-blue-600',
    completed: 'text-green-600',
    blocked: 'text-red-600',
    failed: 'text-red-600',
    pending: 'text-gray-400',
    skipped: 'text-gray-400',
  }
  return map[status] || 'text-gray-400'
}

function stageStateBorder(status: string): string {
  const map: Record<string, string> = {
    running: 'border-blue-300',
    completed: 'border-green-300',
    blocked: 'border-red-300',
    pending: 'border-gray-200',
  }
  return map[status] || 'border-gray-200'
}

function statusLabel(status: string): string {
  const map: Record<string, string> = {
    running: '运行中',
    completed: '已完成',
    blocked: '已阻塞',
    failed: '已失败',
    pending: '等待中',
    skipped: '已跳过',
  }
  return map[status] || status
}

function formatTime(ts: string): string {
  return new Date(ts).toLocaleString('zh-CN')
}
</script>
