const SCOPES = ['cluster', 'point'];

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function findCycle(nodes, edges) {
  const outgoing = new Map([...nodes].map((id) => [id, []]));
  for (const edge of edges) outgoing.get(edge.fromId)?.push(edge.toId);
  const state = new Map();
  const stack = [];

  function visit(id) {
    const current = state.get(id) ?? 0;
    if (current === 2) return null;
    if (current === 1) {
      const start = stack.lastIndexOf(id);
      return [...stack.slice(start), id];
    }
    state.set(id, 1);
    stack.push(id);
    for (const next of outgoing.get(id) ?? []) {
      const cycle = visit(next);
      if (cycle) return cycle;
    }
    stack.pop();
    state.set(id, 2);
    return null;
  }

  for (const id of nodes) {
    const cycle = visit(id);
    if (cycle) return cycle;
  }
  return null;
}

/**
 * Validate the explicit reading-order contract. Sequence edges are kept
 * separate from prerequisite and related relations because order in a book is
 * not proof of a learning dependency.
 */
export function validateSequences(value, { clusterIds, pointIds }) {
  const findings = [];
  if (value === undefined) return findings;
  if (!isRecord(value)) {
    return [{
      code: 'sequences-not-object',
      field: 'sequences',
      message: 'sequences must be an object',
      fix: 'Use { cluster: [], point: [] }',
    }];
  }
  const extra = Object.keys(value).filter((key) => !SCOPES.includes(key));
  if (extra.length > 0) {
    findings.push({
      code: 'sequences-extra-fields',
      field: 'sequences',
      value: extra,
      message: `sequences contains unsupported fields: ${extra.join(', ')}`,
      fix: 'Keep only cluster and point arrays',
    });
  }

  for (const scope of SCOPES) {
    const edges = value[scope];
    const ids = scope === 'cluster' ? clusterIds : pointIds;
    if (!Array.isArray(edges)) {
      findings.push({
        code: 'sequence-scope-not-array',
        field: `sequences.${scope}`,
        message: `sequences.${scope} must be an array`,
        fix: `Use sequences.${scope}: [] when there are no explicit order edges`,
      });
      continue;
    }
    const validEdges = [];
    const seen = new Set();
    edges.forEach((edge, index) => {
      const field = `sequences.${scope}[${index}]`;
      if (
        !isRecord(edge)
        || Object.keys(edge).sort().join(',') !== 'fromId,toId'
        || typeof edge.fromId !== 'string'
        || typeof edge.toId !== 'string'
      ) {
        findings.push({
          code: 'bad-sequence-edge',
          field,
          message: `${field} must contain exactly string fromId/toId`,
          fix: 'Use { fromId: "earlier-id", toId: "later-id" }',
        });
        return;
      }
      const key = `${edge.fromId}\u0000${edge.toId}`;
      if (edge.fromId === edge.toId) {
        findings.push({
          code: 'sequence-self-loop',
          field,
          value: edge.fromId,
          message: `${scope} sequence cannot point to itself`,
          fix: 'Remove the self loop',
        });
        return;
      }
      if (!ids.has(edge.fromId) || !ids.has(edge.toId)) {
        findings.push({
          code: 'dangling-sequence-edge',
          field,
          value: edge,
          message: `${scope} sequence references an unknown id`,
          fix: `Use ids declared in graph.${scope === 'cluster' ? 'clusters' : 'points'}`,
        });
        return;
      }
      if (seen.has(key)) {
        findings.push({
          code: 'duplicate-sequence-edge',
          field,
          value: edge,
          message: `${scope} sequence edge is duplicated`,
          fix: 'Keep one copy of the edge',
        });
        return;
      }
      seen.add(key);
      validEdges.push(edge);
    });
    const cycle = findCycle(ids, validEdges);
    if (cycle) {
      findings.push({
        code: 'sequence-cycle',
        field: `sequences.${scope}`,
        cycle,
        message: `${scope} sequence contains a cycle`,
        fix: 'Remove or reverse an edge so the reading order is acyclic',
      });
    }
  }
  return findings;
}

export function sequenceCounts(value) {
  return {
    clusterSequenceEdges: Array.isArray(value?.cluster) ? value.cluster.length : 0,
    pointSequenceEdges: Array.isArray(value?.point) ? value.point.length : 0,
  };
}
