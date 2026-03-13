<template>
  <div class="h-full overflow-y-auto bg-stone-50 text-stone-800">
    <div class="mx-auto max-w-5xl px-6 py-8">
      <div class="mb-6 flex flex-wrap items-center gap-3">
        <router-link to="/pipeline" class="inline-flex items-center rounded bg-stone-200 px-4 py-2 text-sm font-semibold text-stone-700 no-underline hover:bg-stone-300">
          返回流水线页
        </router-link>
        <router-link to="/" class="inline-flex items-center rounded bg-stone-700 px-4 py-2 text-sm font-semibold text-white no-underline hover:bg-stone-800">
          返回编辑器
        </router-link>
      </div>

      <section class="rounded-2xl border border-stone-200 bg-white p-8 shadow-sm">
        <p class="mb-2 text-xs font-bold uppercase tracking-[0.24em] text-amber-600">Pipeline Guide</p>
        <h1 class="m-0 text-4xl font-black tracking-tight text-stone-900">流水线帮助</h1>
        <p class="mt-4 max-w-3xl text-base leading-7 text-stone-600">
          流水线用于把多个 Agent 串成一个有依赖关系的执行图。每个阶段会指定由哪个 Agent 执行、依赖哪些上游阶段、消费哪些制品，以及产出哪些制品。
        </p>
      </section>

      <section class="mt-6 grid gap-6 lg:grid-cols-[1.1fr_0.9fr]">
        <article class="rounded-2xl border border-stone-200 bg-white p-6 shadow-sm">
          <h2 class="mt-0 text-2xl font-bold text-stone-900">“阶段定义 JSON”是什么意思</h2>
          <p class="mt-3 text-sm leading-7 text-stone-600">
            阶段定义 JSON 就是 <span class="font-mono text-stone-900">stages</span> 字段的内容。
            它必须是一个 JSON 数组，数组里的每个对象就是一个流水线阶段，对应后端里的 <span class="font-mono text-stone-900">StageDefinition</span>。
          </p>
          <p class="mt-3 text-sm leading-7 text-stone-600">
            执行时，系统会先看 <span class="font-mono text-stone-900">dependsOn</span>。只有依赖的阶段都完成后，当前阶段才会运行。运行时会把 <span class="font-mono text-stone-900">promptTemplate</span> 发给指定的 Agent，并允许它通过工具读取上游制品、产出新制品或提交裁决。
          </p>

          <div class="mt-5 overflow-hidden rounded-xl border border-stone-200 bg-stone-950">
            <div class="border-b border-stone-800 px-4 py-2 text-xs uppercase tracking-[0.2em] text-stone-400">示例</div>
            <pre class="m-0 overflow-x-auto p-4 text-sm leading-6 text-stone-100"><code v-pre>[
  {
    "id": "contract-design",
    "name": "契约设计",
    "agentId": "agent-frontend",
    "dependsOn": [],
    "inputArtifacts": [],
    "outputArtifacts": ["contract"],
    "promptTemplate": "请为 {{PROJECT_DIR}} 设计 API 契约，并调用 produce_artifact 产出 contract。"
  },
  {
    "id": "contract-review",
    "name": "契约审查",
    "agentId": "agent-review",
    "dependsOn": ["contract-design"],
    "inputArtifacts": ["contract"],
    "outputArtifacts": ["review-report"],
    "promptTemplate": "请读取上游 contract，完成审查后调用 submit_verdict。",
    "isGate": true,
    "onBlockReturnTo": "contract-design"
  },
  {
    "id": "backend-impl",
    "name": "后端实现",
    "agentId": "agent-backend",
    "dependsOn": ["contract-review"],
    "inputArtifacts": ["contract", "review-report"],
    "outputArtifacts": ["code"],
    "promptTemplate": "基于通过审查的 contract 实现后端代码，并调用 produce_artifact 产出 code。"
  }
]</code></pre>
          </div>
        </article>

        <aside class="rounded-2xl border border-amber-200 bg-amber-50 p-6 shadow-sm">
          <h2 class="mt-0 text-2xl font-bold text-amber-900">核心规则</h2>
          <div class="mt-4 space-y-3 text-sm leading-7 text-amber-950">
            <p><span class="font-semibold">`id`</span> 必须唯一，后续依赖和回滚都靠它识别阶段。</p>
            <p><span class="font-semibold">`agentId`</span> 必须是系统里真实存在的 Agent ID，不是显示名称。</p>
            <p><span class="font-semibold">`dependsOn`</span> 形成 DAG，不能互相循环依赖。</p>
            <p><span class="font-semibold">`inputArtifacts`</span> 和 <span class="font-semibold">`outputArtifacts`</span> 要和 Agent 角色设计对齐，否则阶段虽然能跑，但协作语义会混乱。</p>
            <p><span class="font-semibold">`isGate`</span> 为 <span class="font-mono">true</span> 时，阶段不会自动完成，必须由 Agent 调用 <span class="font-mono">submit_verdict</span> 提交通过或阻塞。</p>
            <p><span class="font-semibold">`onBlockReturnTo`</span> 只在门禁阶段被阻塞时生效，用于把下游阶段重置并回滚到指定阶段重新执行。</p>
          </div>
        </aside>
      </section>

      <section class="mt-6 rounded-2xl border border-stone-200 bg-white p-6 shadow-sm">
        <h2 class="mt-0 text-2xl font-bold text-stone-900">字段说明</h2>
        <div class="mt-4 grid gap-3 md:grid-cols-2">
          <div class="rounded-xl border border-stone-200 bg-stone-50 p-4">
            <div class="font-mono text-sm font-bold text-stone-900">id</div>
            <p class="mt-2 text-sm leading-6 text-stone-600">阶段唯一标识，例如 <span class="font-mono text-stone-900">contract-design</span>。</p>
          </div>
          <div class="rounded-xl border border-stone-200 bg-stone-50 p-4">
            <div class="font-mono text-sm font-bold text-stone-900">name</div>
            <p class="mt-2 text-sm leading-6 text-stone-600">阶段展示名称，给 UI 和运行记录使用。</p>
          </div>
          <div class="rounded-xl border border-stone-200 bg-stone-50 p-4">
            <div class="font-mono text-sm font-bold text-stone-900">agentId</div>
            <p class="mt-2 text-sm leading-6 text-stone-600">执行这个阶段的 Agent ID。</p>
          </div>
          <div class="rounded-xl border border-stone-200 bg-stone-50 p-4">
            <div class="font-mono text-sm font-bold text-stone-900">dependsOn</div>
            <p class="mt-2 text-sm leading-6 text-stone-600">依赖的上游阶段 ID 数组，空数组表示起始阶段。</p>
          </div>
          <div class="rounded-xl border border-stone-200 bg-stone-50 p-4">
            <div class="font-mono text-sm font-bold text-stone-900">inputArtifacts</div>
            <p class="mt-2 text-sm leading-6 text-stone-600">当前阶段会读取哪些类型的制品。可选值有 contract、code、review-report、test-suite、mock-data。</p>
          </div>
          <div class="rounded-xl border border-stone-200 bg-stone-50 p-4">
            <div class="font-mono text-sm font-bold text-stone-900">outputArtifacts</div>
            <p class="mt-2 text-sm leading-6 text-stone-600">当前阶段应该产出哪些类型的制品，供下游阶段消费。</p>
          </div>
          <div class="rounded-xl border border-stone-200 bg-stone-50 p-4 md:col-span-2">
            <div class="font-mono text-sm font-bold text-stone-900">promptTemplate</div>
            <p v-pre class="mt-2 text-sm leading-6 text-stone-600">发给 Agent 的提示词模板。当前支持占位符 <span class="font-mono text-stone-900">{{PROJECT_DIR}}</span>、<span class="font-mono text-stone-900">{{RUN_ID}}</span>、<span class="font-mono text-stone-900">{{STAGE_ID}}</span>、<span class="font-mono text-stone-900">{{INPUT}}</span>。</p>
          </div>
          <div class="rounded-xl border border-stone-200 bg-stone-50 p-4">
            <div class="font-mono text-sm font-bold text-stone-900">isGate</div>
            <p class="mt-2 text-sm leading-6 text-stone-600">是否是门禁阶段。通常给 review Agent 使用。</p>
          </div>
          <div class="rounded-xl border border-stone-200 bg-stone-50 p-4">
            <div class="font-mono text-sm font-bold text-stone-900">onBlockReturnTo</div>
            <p class="mt-2 text-sm leading-6 text-stone-600">门禁阶段阻塞后，回滚到哪个阶段重新跑。</p>
          </div>
        </div>
      </section>

      <section class="mt-6 rounded-2xl border border-stone-200 bg-white p-6 shadow-sm">
        <h2 class="mt-0 text-2xl font-bold text-stone-900">推荐工作流</h2>
        <div class="mt-4 grid gap-4 md:grid-cols-4">
          <div class="rounded-xl bg-sky-50 p-4">
            <div class="text-xs font-bold uppercase tracking-[0.18em] text-sky-700">1</div>
            <h3 class="mb-2 mt-2 text-lg font-bold text-sky-950">设计契约</h3>
            <p class="m-0 text-sm leading-6 text-sky-900">由 frontend 或 backend Agent 先产出 contract。</p>
          </div>
          <div class="rounded-xl bg-orange-50 p-4">
            <div class="text-xs font-bold uppercase tracking-[0.18em] text-orange-700">2</div>
            <h3 class="mb-2 mt-2 text-lg font-bold text-orange-950">审查门禁</h3>
            <p class="m-0 text-sm leading-6 text-orange-900">review Agent 消费 contract，必要时阻塞并回滚。</p>
          </div>
          <div class="rounded-xl bg-emerald-50 p-4">
            <div class="text-xs font-bold uppercase tracking-[0.18em] text-emerald-700">3</div>
            <h3 class="mb-2 mt-2 text-lg font-bold text-emerald-950">实现代码</h3>
            <p class="m-0 text-sm leading-6 text-emerald-900">backend 或 frontend Agent 根据 contract 产出 code。</p>
          </div>
          <div class="rounded-xl bg-violet-50 p-4">
            <div class="text-xs font-bold uppercase tracking-[0.18em] text-violet-700">4</div>
            <h3 class="mb-2 mt-2 text-lg font-bold text-violet-950">测试验证</h3>
            <p class="m-0 text-sm leading-6 text-violet-900">testing Agent 读取 code 后产出 test-suite 或验证报告。</p>
          </div>
        </div>
      </section>
    </div>
  </div>
</template>

<script setup lang="ts">
</script>