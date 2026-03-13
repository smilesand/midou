/**
 * Artifact Store — 制品存储与管理
 *
 * 管理 Pipeline 中各阶段产出的结构化制品（契约、代码、审查报告、测试用例等）。
 * 制品按 pipelineRunId / stageId 组织存储。
 */

import fs from 'fs/promises';
import path from 'path';
import { MIDOU_WORKSPACE_DIR } from './config.js';
import type { Artifact, ArtifactType } from './types.js';

const ARTIFACTS_DIR = path.join(MIDOU_WORKSPACE_DIR, 'artifacts');

/**
 * 生成制品 ID
 */
function generateArtifactId(): string {
  return `art-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 获取制品存储路径
 */
function getArtifactDir(pipelineRunId: string, stageId: string): string {
  return path.join(ARTIFACTS_DIR, pipelineRunId, stageId);
}

/**
 * 创建并持久化一个制品
 */
export async function createArtifact(
  type: ArtifactType,
  producedBy: string,
  pipelineRunId: string,
  stageId: string,
  payload: unknown,
): Promise<Artifact> {
  const artifact: Artifact = {
    id: generateArtifactId(),
    type,
    producedBy,
    pipelineRunId,
    stageId,
    payload,
    createdAt: new Date().toISOString(),
  };

  const dir = getArtifactDir(pipelineRunId, stageId);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, `${artifact.id}.json`),
    JSON.stringify(artifact, null, 2),
    'utf-8',
  );

  return artifact;
}

/**
 * 读取单个制品
 */
export async function getArtifact(
  pipelineRunId: string,
  stageId: string,
  artifactId: string,
): Promise<Artifact | null> {
  try {
    const filePath = path.join(getArtifactDir(pipelineRunId, stageId), `${artifactId}.json`);
    const data = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(data) as Artifact;
  } catch {
    return null;
  }
}

/**
 * 列出某个 stage 的所有制品
 */
export async function listStageArtifacts(
  pipelineRunId: string,
  stageId: string,
): Promise<Artifact[]> {
  const dir = getArtifactDir(pipelineRunId, stageId);
  try {
    const files = await fs.readdir(dir);
    const artifacts: Artifact[] = [];
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      try {
        const data = await fs.readFile(path.join(dir, file), 'utf-8');
        artifacts.push(JSON.parse(data) as Artifact);
      } catch {
        // 跳过损坏的文件
      }
    }
    return artifacts;
  } catch {
    return [];
  }
}

/**
 * 收集某个 pipeline run 中指定类型的所有制品
 */
export async function collectArtifactsByType(
  pipelineRunId: string,
  stageIds: string[],
  types: ArtifactType[],
): Promise<Artifact[]> {
  const result: Artifact[] = [];
  for (const stageId of stageIds) {
    const artifacts = await listStageArtifacts(pipelineRunId, stageId);
    for (const art of artifacts) {
      if (types.includes(art.type)) {
        result.push(art);
      }
    }
  }
  return result;
}

/**
 * 列出一次 pipeline run 的所有制品
 */
export async function listRunArtifacts(pipelineRunId: string): Promise<Artifact[]> {
  const runDir = path.join(ARTIFACTS_DIR, pipelineRunId);
  try {
    const stages = await fs.readdir(runDir);
    const all: Artifact[] = [];
    for (const stage of stages) {
      const arts = await listStageArtifacts(pipelineRunId, stage);
      all.push(...arts);
    }
    return all;
  } catch {
    return [];
  }
}
