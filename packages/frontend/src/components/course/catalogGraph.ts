export type CourseEdge = { fromId: string; toId: string };
export type MapPosition = { x: number; y: number };
export type CourseLayoutPosition = MapPosition & { pinned?: boolean };
export type CourseGroupLayout = {
  mode: "hybrid";
  positions: Record<string, CourseLayoutPosition>;
};
export type LayoutOptions = {
  availableWidth?: number;
  compact?: boolean;
  independentColumns?: number;
  /** Use a deterministic curated/relaxed layout on wide graph canvases. */
  flexible?: boolean;
  /** User-pinned nodes that the assistant should preserve while relaxing peers. */
  manualPositions?: Record<string, CourseLayoutPosition>;
};

/**
 * The computer-science catalog is the presentation graph shown to clients.
 * These anchors follow the same airy, hand-composed rhythm as the reference
 * atlas: a high systems branch, a lower data branch, and two soft convergences.
 * Other catalogs continue to use the generic layout below.
 */
const CURATED_POSITIONS: Record<string, [number, number]> = {
  "placeholder-75828d40794a48dd": [100, 360], // C语言
  "placeholder-6b0aa20b42f941fa": [250, 125], // 计算机组成原理
  "textbook-d9c2cd46140d4ed6be3b9a6f": [390, 90], // 数字逻辑
  "placeholder-8167121300674372": [535, 115], // 汇编语言
  "placeholder-5dc541329662436d": [680, 165], // 操作系统
  "textbook-eb46b3faaf17e3d11a7b1451": [825, 140], // 计算机网络
  "placeholder-d80847e163794a50": [975, 165], // 信息安全
  "placeholder-9cb293660e034f73": [830, 285], // 嵌入式开发
  "textbook-bf9e6438e096d32ed9ecb64c": [1050, 300], // 工业物联网
  "placeholder-376389247d424467": [245, 555], // 数理逻辑
  "compiler-principles-basics": [455, 555], // 编译原理
  "data-structures": [280, 370], // 数据结构
  "placeholder-067902d21dd04b98": [470, 350], // 算法设计与分析
  "ai-principles": [650, 400], // 人工智能原理
  "placeholder-058e6962b67246e5": [860, 430], // 大数据技术
  "placeholder-eeb1ce0c49eb4de7": [650, 285], // 计算机图形学
  "textbook-8786f8dd100c0d7af2538e79": [470, 490], // 数据库系统概论
  "placeholder-10d44d23147b44b9": [255, 270], // 面向对象程序设计
  "software-engineering": [450, 250], // 软件工程
  "placeholder-196a50bf5fbc4b44": [735, 555], // Web开发
};

/** Only explicit, valid user relations participate in layout and highlighting. */
export function validEdges(ids: string[], edges: CourseEdge[]): CourseEdge[] {
  const members = new Set(ids);
  const seen = new Set<string>();
  return edges.filter((edge) => {
    const key = JSON.stringify([edge.fromId, edge.toId]);
    if (!members.has(edge.fromId) || !members.has(edge.toId) || edge.fromId === edge.toId || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function relatedCourses(id: string, edges: CourseEdge[], direction: "before" | "after"): Set<string> {
  const found = new Set<string>();
  const queue = [id];
  for (let index = 0; index < queue.length; index++) {
    for (const edge of edges) {
      const from = direction === "before" ? edge.toId : edge.fromId;
      const to = direction === "before" ? edge.fromId : edge.toId;
      if (from === queue[index] && to !== id && !found.has(to)) {
        found.add(to);
        queue.push(to);
      }
    }
  }
  return found;
}

export function layoutCourses(ids: string[], rawEdges: CourseEdge[], options: LayoutOptions = {}) {
  const edges = validEdges(ids, rawEdges);
  const positions = new Map<string, MapPosition>();
  const connected = new Set(edges.flatMap((edge) => [edge.fromId, edge.toId]));
  const indegree = new Map(ids.map((id) => [id, 0]));
  const levels = new Map(ids.map((id) => [id, 0]));
  edges.forEach((edge) => indegree.set(edge.toId, (indegree.get(edge.toId) ?? 0) + 1));
  const queue = ids.filter((id) => connected.has(id) && indegree.get(id) === 0);
  const visited = new Set<string>();
  for (let index = 0; index < queue.length; index++) {
    const id = queue[index]!;
    visited.add(id);
    edges.filter((edge) => edge.fromId === id).forEach((edge) => {
      levels.set(edge.toId, Math.max(levels.get(edge.toId) ?? 0, (levels.get(id) ?? 0) + 1));
      const count = (indegree.get(edge.toId) ?? 1) - 1;
      indegree.set(edge.toId, count);
      if (count === 0) queue.push(edge.toId);
    });
  }
  const rows = new Map<number, number>();
  // Cyclic legacy relations still render safely without inventing new edges.
  const cycleLevel = visited.size ? Math.max(...[...visited].map((id) => levels.get(id) ?? 0)) + 1 : 0;
  const compact = options.compact ?? false;
  const levelGap = compact ? 250 : 300;
  const independentGap = compact ? 250 : 300;
  const nodeLeftExtent = 25;
  const nodeRightExtent = compact ? 200 : 260;
  const minimumLeft = compact ? 32 : 90;
  const centeredStart = (columnCount: number, gap: number) => {
    if (!options.availableWidth) return minimumLeft;
    const contentWidth = nodeLeftExtent + nodeRightExtent + Math.max(0, columnCount - 1) * gap;
    return Math.max(minimumLeft, (options.availableWidth - contentWidth) / 2 + nodeLeftExtent);
  };
  const connectedIds = ids.filter((id) => connected.has(id));
  const connectedLevelCount = connectedIds.length
    ? Math.max(...connectedIds.map((id) => visited.has(id) ? levels.get(id) ?? 0 : cycleLevel)) + 1
    : 0;
  if (compact && connectedIds.length) {
    const columns = Math.max(1, Math.min(options.independentColumns ?? 2, connectedIds.length));
    const groups = new Map<number, string[]>();
    connectedIds.forEach((id) => {
      const level = visited.has(id) ? levels.get(id) ?? 0 : cycleLevel;
      const group = groups.get(level) ?? [];
      group.push(id);
      groups.set(level, group);
    });
    let y = 90;
    [...groups.keys()].sort((a, b) => a - b).forEach((level) => {
      const group = groups.get(level)!;
      const rowCount = Math.ceil(group.length / columns);
      const start = centeredStart(Math.min(columns, group.length), independentGap);
      group.forEach((id, index) => {
        positions.set(id, {
          x: start + (index % columns) * independentGap,
          y: y + Math.floor(index / columns) * 112,
        });
      });
      y += Math.max(1, rowCount) * 112 + 58;
    });
  } else {
    const connectedStart = centeredStart(connectedLevelCount, levelGap);
    connectedIds.forEach((id) => {
      const level = visited.has(id) ? levels.get(id) ?? 0 : cycleLevel;
      const row = rows.get(level) ?? 0;
      positions.set(id, { x: connectedStart + level * levelGap, y: 90 + row * 112 });
      rows.set(level, row + 1);
    });
  }
  const connectedBottom = Math.max(0, ...[...positions.values()].map((point) => point.y + 100));
  const independentStart = connected.size ? connectedBottom + 56 : 90;
  const independentIds = ids.filter((id) => !connected.has(id));
  const independentColumns = Math.max(1, Math.min(options.independentColumns ?? 3, independentIds.length || 1));
  const independentLeft = centeredStart(independentColumns, independentGap);
  independentIds.forEach((id, index) => {
    positions.set(id, { x: independentLeft + (index % independentColumns) * independentGap, y: independentStart + Math.floor(index / independentColumns) * 112 });
  });

  if (options.flexible && !compact && connectedIds.length > 1) {
    relaxConnectedLayout(positions, connectedIds, edges, levels, options.availableWidth);
  }
  if (options.flexible && !compact && options.manualPositions) {
    relaxAroundAnchors(positions, ids, edges, options.manualPositions, options.availableWidth);
  }

  const relaxedBottom = Math.max(0, ...[...positions.values()].map((point) => point.y + 100));
  return {
    positions,
    width: Math.max(options.availableWidth ?? 900, ...[...positions.values()].map((point) => point.x + nodeRightExtent)),
    height: Math.max(430, relaxedBottom - 10),
    independentStart: connected.size && connected.size < ids.length ? independentStart : null,
    orientation: compact ? "vertical" : "horizontal",
  };
}

/**
 * Keep dragged nodes fixed and gently reflow the remaining nodes around them.
 * This is deliberately bounded and deterministic: a drag should feel
 * immediate, not like a continuously moving simulation.
 */
function relaxAroundAnchors(
  positions: Map<string, MapPosition>,
  ids: string[],
  edges: CourseEdge[],
  manualPositions: Record<string, CourseLayoutPosition>,
  availableWidth?: number,
) {
  const anchors = new Set(ids.filter((id) => {
    const point = manualPositions[id];
    return point && Number.isFinite(point.x) && Number.isFinite(point.y) && point.pinned !== false;
  }));
  if (!anchors.size) return;
  const points = new Map(ids.map((id) => [id, { ...(positions.get(id) ?? { x: 90, y: 90 }) }]));
  const rest = new Map(ids.map((id) => [id, { ...points.get(id)! }]));
  anchors.forEach((id) => points.set(id, { x: manualPositions[id]!.x, y: manualPositions[id]!.y }));
  const width = Math.max(availableWidth ?? 1200, ...[...points.values()].map((point) => point.x + 180));
  const height = Math.max(620, ...[...points.values()].map((point) => point.y + 120));
  const minX = 50;
  const maxX = width - 100;
  const minY = 55;
  const maxY = height - 70;

  for (let iteration = 0; iteration < 42; iteration += 1) {
    const force = new Map(ids.map((id) => [id, { x: 0, y: 0 }]));
    for (let left = 0; left < ids.length; left += 1) {
      const first = points.get(ids[left]!)!;
      for (let right = left + 1; right < ids.length; right += 1) {
        const second = points.get(ids[right]!)!;
        const dx = second.x - first.x;
        const dy = second.y - first.y;
        const distance = Math.max(1, Math.hypot(dx, dy));
        if (distance >= 125) continue;
        const push = (125 - distance) * 0.035;
        const fx = (dx / distance) * push;
        const fy = (dy / distance) * push;
        if (!anchors.has(ids[left]!)) {
          force.get(ids[left]!)!.x -= fx;
          force.get(ids[left]!)!.y -= fy;
        }
        if (!anchors.has(ids[right]!)) {
          force.get(ids[right]!)!.x += fx;
          force.get(ids[right]!)!.y += fy;
        }
      }
    }
    edges.forEach((edge) => {
      const source = points.get(edge.fromId);
      const target = points.get(edge.toId);
      if (!source || !target) return;
      const dx = target.x - source.x;
      const dy = target.y - source.y;
      const distance = Math.max(1, Math.hypot(dx, dy));
      const spring = (distance - 175) * 0.004;
      if (!anchors.has(edge.fromId)) {
        force.get(edge.fromId)!.x += (dx / distance) * spring;
        force.get(edge.fromId)!.y += (dy / distance) * spring;
      }
      if (!anchors.has(edge.toId)) {
        force.get(edge.toId)!.x -= (dx / distance) * spring;
        force.get(edge.toId)!.y -= (dy / distance) * spring;
      }
    });
    ids.forEach((id) => {
      if (anchors.has(id)) {
        points.set(id, { x: manualPositions[id]!.x, y: manualPositions[id]!.y });
        return;
      }
      const point = points.get(id)!;
      const pull = force.get(id)!;
      const target = rest.get(id)!;
      pull.x += (target.x - point.x) * 0.025;
      pull.y += (target.y - point.y) * 0.025;
      point.x = Math.max(minX, Math.min(maxX, point.x + pull.x));
      point.y = Math.max(minY, Math.min(maxY, point.y + pull.y));
    });
  }
  ids.forEach((id) => {
    const point = points.get(id)!;
    positions.set(id, { x: Math.round(point.x * 10) / 10, y: Math.round(point.y * 10) / 10 });
  });
}

/**
 * Lay out a connected course forest as separated, gently staggered branches.
 *
 * The previous force simulation looked organic, but it also allowed two
 * unrelated branches to pass through one another.  A tidy tree gives each
 * subtree its own vertical interval (so edges cannot cross), then adds a
 * small deterministic horizontal offset to keep the result from looking like
 * a rigid grid.  The fallback is intentionally conservative for legacy DAGs
 * that are not forests.
 */
function relaxConnectedLayout(
  positions: Map<string, MapPosition>,
  ids: string[],
  edges: CourseEdge[],
  levels: Map<string, number>,
  availableWidth?: number,
) {
  const curatedIds = ids.filter((id) => CURATED_POSITIONS[id]);
  if (curatedIds.length === ids.length && ids.length >= 12) {
    const xScale = Math.max(0.9, Math.min(1.75, ((availableWidth ?? 1320) - 180) / 1100));
    ids.forEach((id) => {
      const [baseX, baseY] = CURATED_POSITIONS[id]!;
      positions.set(id, {
        x: Math.round((70 + baseX * xScale) * 10) / 10,
        y: baseY,
      });
    });
    return;
  }
  const children = new Map(ids.map((id) => [id, [] as string[]]));
  const parentCount = new Map(ids.map((id) => [id, 0]));
  edges.forEach((edge) => {
    children.get(edge.fromId)?.push(edge.toId);
    parentCount.set(edge.toId, (parentCount.get(edge.toId) ?? 0) + 1);
  });
  const roots = ids.filter((id) => (parentCount.get(id) ?? 0) === 0);
  const isForest = roots.length > 0 && ids.every((id) => (parentCount.get(id) ?? 0) <= 1);
  const minX = 90;
  const minY = 90;

  if (isForest) {
    const leavesByNode = new Map<string, string[]>();
    const visiting = new Set<string>();
    const collectLeaves = (id: string): string[] => {
      const cached = leavesByNode.get(id);
      if (cached) return cached;
      // A defensive cycle guard keeps malformed legacy data renderable.
      if (visiting.has(id)) return [id];
      visiting.add(id);
      const next = children.get(id) ?? [];
      const leaves = next.length ? next.flatMap(collectLeaves) : [id];
      visiting.delete(id);
      leavesByNode.set(id, leaves);
      return leaves;
    };
    const orderedLeaves = roots.flatMap(collectLeaves);
    ids.filter((id) => !orderedLeaves.includes(id) && !(children.get(id)?.length)).forEach((id) => orderedLeaves.push(id));
    const uniqueLeaves = [...new Set(orderedLeaves)];
    const laneGap = uniqueLeaves.length > 1 ? Math.max(116, Math.min(142, 700 / (uniqueLeaves.length - 1))) : 0;
    const leafY = new Map(uniqueLeaves.map((id, index) => [id, minY + index * laneGap]));
    const yByNode = new Map<string, number>();
    const placeY = (id: string): number => {
      const cached = yByNode.get(id);
      if (cached !== undefined) return cached;
      const leaves = leavesByNode.get(id) ?? [id];
      const y = leaves.reduce((sum, leaf) => sum + (leafY.get(leaf) ?? minY), 0) / Math.max(1, leaves.length);
      yByNode.set(id, y);
      return y;
    };
    ids.forEach(placeY);
    const maxDepth = Math.max(1, ...ids.map((id) => levels.get(id) ?? 0));
    const xGap = Math.max(156, Math.min(190, ((availableWidth ?? 1320) - 180) / maxDepth));
    const stableOffset = (id: string) => {
      let hash = 0;
      for (const character of id) hash = (hash * 31 + character.charCodeAt(0)) | 0;
      return (Math.abs(hash) % 3 - 1) * 22;
    };
    ids.forEach((id) => {
      const level = levels.get(id) ?? 0;
      positions.set(id, {
        x: Math.round((minX + level * xGap + (level ? stableOffset(id) : 0)) * 10) / 10,
        y: Math.round((yByNode.get(id) ?? minY) * 10) / 10,
      });
    });
    return;
  }

  // Legacy graphs with merges/cycles retain a readable, deterministic layout.
  const width = Math.max(availableWidth ?? 900, 1080);
  const levelGap = Math.max(150, Math.min(190, (width - 180) / Math.max(1, ...ids.map((id) => levels.get(id) ?? 0))));
  const rows = new Map<number, number>();
  ids.forEach((id) => {
    const level = levels.get(id) ?? 0;
    const row = rows.get(level) ?? 0;
    rows.set(level, row + 1);
    positions.set(id, { x: minX + level * levelGap, y: minY + row * 128 });
  });
}
