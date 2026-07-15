import type { ForestIndex } from "./types";

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Adapts the course index into the data shape consumed by the original
 * knowledge-forest Three.js scene. Keeping this boundary small lets the
 * course API evolve without coupling it to the renderer.
 */
export function buildSceneInputs(index: ForestIndex) {
  const domains = index.clusters.map((cluster) => ({
    id: cluster.id,
    polygon: cluster.polygon ?? [],
    color: cluster.accent,
    label_pos: cluster.labelPos ?? [2000, 1500],
  }));

  const layout = {
    canvas: { width: 4000, height: 3000 },
    points: index.points.map((point) => ({
      id: point.id,
      pos: point.pos,
      scale: point.scale ?? 1,
    })),
    domains,
    categories: [] as any[],
    levels: [] as any[],
  };

  const kpById: Record<string, any> = {};
  const kpsByCat: Record<string, any[]> = {};
  const kpsByDom: Record<string, any[]> = {};
  for (const point of index.points) {
    const knowledgePoint = {
      id: point.id,
      name_zh: point.title,
      category_id: point.clusterId,
      importance: point.importance ?? 0.5,
    };
    kpById[point.id] = knowledgePoint;
    (kpsByCat[point.clusterId] ||= []).push(knowledgePoint);
    (kpsByDom[point.clusterId] ||= []).push(knowledgePoint);
  }

  const catById: Record<string, any> = {};
  const domById: Record<string, any> = {};
  const indexDomains: any[] = [];
  const indexCategories: any[] = [];
  for (const cluster of index.clusters) {
    catById[cluster.id] = {
      id: cluster.id,
      domain_id: cluster.id,
      name_zh: cluster.title,
    };
    domById[cluster.id] = { id: cluster.id, name_zh: cluster.title };
    indexDomains.push({ id: cluster.id, name_zh: cluster.title });
    indexCategories.push({
      id: cluster.id,
      domain_id: cluster.id,
      name_zh: cluster.title,
    });
  }

  return {
    layout,
    data: {
      index: { domains: indexDomains, categories: indexCategories },
      layout,
      kpById,
      catById,
      domById,
      kpsByCat,
      kpsByDom,
    },
  };
}
