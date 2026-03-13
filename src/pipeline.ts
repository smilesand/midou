/**
 * PipelineEngine — DAG 流水线调度引擎
 *
 * 负责流水线的执行调度、阶段状态管理、裁决处理与回滚机制。
 * 每个阶段依赖 Agent 执行，通过制品系统传递上下游数据。
 */

import fs from 'fs/promises';
import path from 'path';
import { MIDOU_WORKSPACE_DIR } from './config.js';
import { collectArtifactsByType } from './artifact.js';
import type {
  PipelineDefinition,
  PipelineRun,
  PipelineRunStatus,
  StageDefinition,
  StageState,
  StageStatus,
  Artifact,
  PipelineEngineInterface,
  SystemManagerInterface,
} from './types.js';

const RUNS_DIR = path.join(MIDOU_WORKSPACE_DIR, 'pipeline-runs');

/**
 * 生成运行 ID
 */
function generateRunId(): string {
  return `run-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * PipelineEngine — 管理流水线运行
 */
export class PipelineEngine implements PipelineEngineInterface {
  private _runs: Map<string, PipelineRun> = new Map();
  private _pipelines: Map<string, PipelineDefinition> = new Map();
  private _systemManager: SystemManagerInterface;

  constructor(systemManager: SystemManagerInterface) {
    this._systemManager = systemManager;
  }

  /**
   * 注册可用的流水线定义
   */
  registerPipelines(pipelines: PipelineDefinition[]): void {
    this._pipelines.clear();
    for (const p of pipelines) {
      this._pipelines.set(p.id, p);
    }
  }

  /**
   * 获取所有已注册的流水线定义
   */
  getPipelines(): PipelineDefinition[] {
    return Array.from(this._pipelines.values());
  }

  /**
   * 启动一条流水线
   */
  async startPipeline(pipelineId: string, input?: string): Promise<PipelineRun> {
    const pipeline = this._pipelines.get(pipelineId);
    if (!pipeline) throw new Error(`流水线不存在: ${pipelineId}`);

    const runId = generateRunId();
    const stageStates: Record<string, StageState> = {};
    for (const stage of pipeline.stages) {
      stageStates[stage.id] = {
        status: 'pending',
        artifacts: [],
        retryCount: 0,
      };
    }

    const run: PipelineRun = {
      id: runId,
      pipelineId,
      status: 'running',
      stageStates,
      createdAt: new Date().toISOString(),
    };

    this._runs.set(runId, run);
    await this._persistRun(run);

    // 发送事件通知前端
    this._emitRunUpdate(run);

    // 开始调度
    this._scheduleReadyStages(run, pipeline, input);

    return run;
  }

  /**
   * 获取运行状态
   */
  getPipelineRun(runId: string): PipelineRun | undefined {
    return this._runs.get(runId);
  }

  /**
   * 获取所有运行
   */
  getAllRuns(): PipelineRun[] {
    return Array.from(this._runs.values());
  }

  /**
   * 提交制品到某个阶段
   */
  submitArtifact(runId: string, stageId: string, artifact: Artifact): void {
    const run = this._runs.get(runId);
    if (!run) return;

    const state = run.stageStates[stageId];
    if (!state) return;

    state.artifacts.push(artifact.id);

    this._persistRun(run).catch(() => {});
    this._emitRunUpdate(run);
  }

  /**
   * 审查 Agent 提交裁决
   */
  submitVerdict(runId: string, stageId: string, verdict: 'pass' | 'block', report: unknown): void {
    const run = this._runs.get(runId);
    if (!run) return;

    const pipeline = this._pipelines.get(run.pipelineId);
    if (!pipeline) return;

    const state = run.stageStates[stageId];
    if (!state) return;

    state.verdict = verdict;

    if (verdict === 'pass') {
      state.status = 'completed';
      state.completedAt = new Date().toISOString();
      console.log(`[Pipeline] 阶段 ${stageId} 审查通过`);
      // 继续调度后续阶段
      this._scheduleReadyStages(run, pipeline);
    } else {
      state.status = 'blocked';
      state.error = typeof report === 'string' ? report : JSON.stringify(report);

      // 查找该阶段的 onBlockReturnTo
      const stageDef = pipeline.stages.find(s => s.id === stageId);
      if (stageDef?.onBlockReturnTo) {
        console.log(`[Pipeline] 阶段 ${stageId} 被阻塞，回滚到 ${stageDef.onBlockReturnTo}`);
        this._rollbackToStage(run, pipeline, stageDef.onBlockReturnTo);
      } else {
        // 没有回滚目标，标记整个流水线为阻塞状态
        run.status = 'blocked';
        console.log(`[Pipeline] 阶段 ${stageId} 被阻塞，流水线暂停`);
      }
    }

    this._persistRun(run).catch(() => {});
    this._emitRunUpdate(run);
  }

  /**
   * 恢复运行某个已加载的流水线
   */
  async loadRuns(): Promise<void> {
    try {
      const entries = await fs.readdir(RUNS_DIR);
      for (const file of entries) {
        if (!file.endsWith('.json')) continue;
        try {
          const data = await fs.readFile(path.join(RUNS_DIR, file), 'utf-8');
          const run = JSON.parse(data) as PipelineRun;
          this._runs.set(run.id, run);
        } catch {
          // 跳过损坏文件
        }
      }
    } catch {
      // 目录不存在
    }
  }

  // ── 内部调度逻辑 ──

  /**
   * 调度所有依赖已满足的阶段
   */
  private _scheduleReadyStages(run: PipelineRun, pipeline: PipelineDefinition, input?: string): void {
    for (const stage of pipeline.stages) {
      const state = run.stageStates[stage.id];
      if (state.status !== 'pending') continue;

      // 检查所有依赖是否已完成
      const depsReady = stage.dependsOn.every(depId => {
        const depState = run.stageStates[depId];
        return depState && depState.status === 'completed';
      });

      if (depsReady) {
        this._executeStage(run, pipeline, stage, input).catch(err => {
          console.error(`[Pipeline] 执行阶段 ${stage.id} 失败:`, err);
          state.status = 'blocked';
          state.error = (err as Error).message;
          this._checkPipelineComplete(run, pipeline);
          this._persistRun(run).catch(() => {});
          this._emitRunUpdate(run);
        });
      }
    }
  }

  /**
   * 执行单个阶段
   */
  private async _executeStage(
    run: PipelineRun,
    pipeline: PipelineDefinition,
    stage: StageDefinition,
    input?: string,
  ): Promise<void> {
    const state = run.stageStates[stage.id];
    state.status = 'running';
    state.startedAt = new Date().toISOString();
    await this._persistRun(run);
    this._emitRunUpdate(run);

    // 收集上游制品
    let upstreamContext = '';
    if (stage.dependsOn.length > 0 && stage.inputArtifacts.length > 0) {
      const artifacts = await collectArtifactsByType(run.id, stage.dependsOn, stage.inputArtifacts);
      if (artifacts.length > 0) {
        upstreamContext = '\n\n## 上游制品\n\n' + JSON.stringify(artifacts, null, 2);
      }
    }

    // 构建 prompt
    let prompt = stage.promptTemplate
      .replace('{{PROJECT_DIR}}', pipeline.projectDir)
      .replace('{{RUN_ID}}', run.id)
      .replace('{{STAGE_ID}}', stage.id);

    if (input) {
      prompt = prompt.replace('{{INPUT}}', input);
    }

    prompt += upstreamContext;

    // 发送给 Agent 执行
    const agent = this._systemManager.agents.get(stage.agentId);
    if (!agent) {
      throw new Error(`Agent 不存在: ${stage.agentId}`);
    }

    console.log(`[Pipeline] 阶段 ${stage.id} (${stage.name}) → Agent ${agent.name}`);

    try {
      await agent.talk(prompt);

      // Agent 执行完毕后，如果不是 gate 阶段则自动标记完成
      if (!stage.isGate) {
        state.status = 'completed';
        state.completedAt = new Date().toISOString();
        // 继续调度后续
        this._scheduleReadyStages(run, pipeline);
        this._checkPipelineComplete(run, pipeline);
      }
      // gate 阶段需要等待 submit_verdict 调用
    } catch (err) {
      state.status = 'blocked';
      state.error = (err as Error).message;
      this._checkPipelineComplete(run, pipeline);
    }

    await this._persistRun(run);
    this._emitRunUpdate(run);
  }

  /**
   * 回滚到指定阶段：将该阶段及所有下游阶段重置为 pending
   */
  private _rollbackToStage(run: PipelineRun, pipeline: PipelineDefinition, targetStageId: string): void {
    const toReset = new Set<string>();
    toReset.add(targetStageId);

    // 使用 BFS 找到所有下游阶段
    let frontier = [targetStageId];
    while (frontier.length > 0) {
      const nextFrontier: string[] = [];
      for (const stageId of frontier) {
        for (const stage of pipeline.stages) {
          if (stage.dependsOn.includes(stageId) && !toReset.has(stage.id)) {
            toReset.add(stage.id);
            nextFrontier.push(stage.id);
          }
        }
      }
      frontier = nextFrontier;
    }

    // 重置状态
    for (const stageId of toReset) {
      const state = run.stageStates[stageId];
      if (state) {
        state.status = 'pending';
        state.artifacts = [];
        state.verdict = undefined;
        state.retryCount += 1;
        state.startedAt = undefined;
        state.completedAt = undefined;
        state.error = undefined;
      }
    }

    run.status = 'running';

    // 重新调度
    this._scheduleReadyStages(run, pipeline);
  }

  /**
   * 检查流水线是否全部完成
   */
  private _checkPipelineComplete(run: PipelineRun, _pipeline: PipelineDefinition): void {
    const states = Object.values(run.stageStates);
    const allDone = states.every(s => s.status === 'completed' || s.status === 'skipped');
    const anyFailed = states.some(s => s.status === 'blocked');

    if (allDone) {
      run.status = 'completed';
      run.completedAt = new Date().toISOString();
      console.log(`[Pipeline] 流水线 ${run.pipelineId} 运行 ${run.id} 已完成`);
    } else if (anyFailed && !states.some(s => s.status === 'running' || s.status === 'pending')) {
      run.status = 'failed';
      run.completedAt = new Date().toISOString();
      console.log(`[Pipeline] 流水线 ${run.pipelineId} 运行 ${run.id} 失败`);
    }
  }

  /**
   * 持久化运行状态
   */
  private async _persistRun(run: PipelineRun): Promise<void> {
    await fs.mkdir(RUNS_DIR, { recursive: true });
    await fs.writeFile(
      path.join(RUNS_DIR, `${run.id}.json`),
      JSON.stringify(run, null, 2),
      'utf-8',
    );
  }

  /**
   * 向前端发送运行状态更新
   */
  private _emitRunUpdate(run: PipelineRun): void {
    this._systemManager.emitEvent('pipeline:run_update', run);
  }
}
