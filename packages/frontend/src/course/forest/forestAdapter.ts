import type {
  ForestIndex,
  ForestSequenceEdge,
  ForestSequences,
} from "./types";

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

/**
 * Normalize the course index at the API boundary.
 *
 * `sequences.cluster` / `sequences.point` is the canonical contract. A small
 * compatibility layer also accepts snake_case edges and ordered id arrays so
 * a partially upgraded course can still be opened while its data is migrated.
 */
export function normalizeForestIndex(payload: unknown): ForestIndex | null {
  const candidate = isRecord(payload) && "index" in payload ? payload.index : payload;
  if (
    !isRecord(candidate)
    || !Array.isArray(candidate.clusters)
    || !Array.isArray(candidate.points)
  ) {
    return null;
  }

  const index = candidate as unknown as ForestIndex;
  const clusterIds = readIds(candidate.clusters);
  const pointIds = readIds(candidate.points);
  const sequences = normalizeForestSequences(candidate, clusterIds, pointIds);

  return sequences ? { ...index, sequences } : { ...index, sequences: undefined };
}

export function normalizeForestSequences(
  index: Record<string, unknown>,
  clusterIds: ReadonlySet<string>,
  pointIds: ReadonlySet<string>,
): ForestSequences | undefined {
  const raw = isRecord(index.sequences)
    ? index.sequences
    : isRecord(index.sequence)
      ? index.sequence
      : null;

  const clusterValues = raw
    ? raw.cluster ?? raw.clusters ?? raw.cluster_edges ?? raw.clusterEdges ?? raw.cluster_ids ?? raw.clusterIds
    : undefined;
  const pointValues = raw
    ? raw.point ?? raw.points ?? raw.point_edges ?? raw.pointEdges ?? raw.point_ids ?? raw.pointIds
    : undefined;

  let cluster = normalizeSequenceCollection(clusterValues, clusterIds);
  let point = normalizeSequenceCollection(pointValues, pointIds);

  // Early prototypes used a single scoped edge list. Keep it readable without
  // making it part of the published contract.
  const scopedValues = raw && Array.isArray(raw.edges)
    ? raw.edges
    : Array.isArray(index.sequence_edges)
      ? index.sequence_edges
      : null;
  if (scopedValues) {
    cluster = mergeEdges(cluster, normalizeScopedEdges(scopedValues, "cluster", clusterIds));
    point = mergeEdges(point, normalizeScopedEdges(scopedValues, "point", pointIds));
  }

  return cluster.length > 0 || point.length > 0 ? { cluster, point } : undefined;
}

function normalizeSequenceCollection(
  value: unknown,
  allowedIds: ReadonlySet<string>,
): ForestSequenceEdge[] {
  if (!Array.isArray(value)) return [];
  if (value.every((item) => typeof item === "string")) {
    const ids = value.filter((id): id is string => (
      typeof id === "string" && allowedIds.has(id)
    ));
    return dedupeEdges(ids.slice(1).map((toId, index) => ({
      fromId: ids[index]!,
      toId,
    })));
  }

  return dedupeEdges(value.flatMap((item) => {
    const edge = readSequenceEdge(item);
    if (
      !edge
      || edge.fromId === edge.toId
      || !allowedIds.has(edge.fromId)
      || !allowedIds.has(edge.toId)
    ) {
      return [];
    }
    return [edge];
  }));
}

function normalizeScopedEdges(
  values: unknown[],
  scope: "cluster" | "point",
  allowedIds: ReadonlySet<string>,
) {
  return normalizeSequenceCollection(
    values.filter((item) => {
      if (!isRecord(item)) return false;
      const candidate = item.scope ?? item.kind ?? item.type;
      return candidate === scope || candidate === `${scope}-sequence` || candidate === `${scope}_sequence`;
    }),
    allowedIds,
  );
}

function readSequenceEdge(value: unknown): ForestSequenceEdge | null {
  if (!isRecord(value)) return null;
  const fromId = value.fromId ?? value.from_id ?? value.from ?? value.source;
  const toId = value.toId ?? value.to_id ?? value.to ?? value.target;
  return typeof fromId === "string" && typeof toId === "string"
    ? { fromId, toId }
    : null;
}

function readIds(values: unknown[]) {
  return new Set(values.flatMap((value) => (
    isRecord(value) && typeof value.id === "string" ? [value.id] : []
  )));
}

function mergeEdges(left: ForestSequenceEdge[], right: ForestSequenceEdge[]) {
  return dedupeEdges([...left, ...right]);
}

function dedupeEdges(edges: ForestSequenceEdge[]) {
  const seen = new Set<string>();
  return edges.filter((edge) => {
    const key = `${edge.fromId}\u0000${edge.toId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
