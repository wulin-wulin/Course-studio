import { useEffect, useRef } from "react";
import * as THREE from "three";
import type { ForestCluster } from "@/course/forest/types";
import type { GenerationPointState } from "./types";
// The course forest keeps the low-poly tree factory as an isolated JavaScript module.
// @ts-expect-error The vendor module intentionally has no TypeScript declaration file.
import { createTree } from "@/course/forest/vendor/tree_factory.js";

type GenerationForestCanvasProps = {
  points: GenerationPointState[];
  clusters: ForestCluster[];
  totalPoints: number;
  completed: boolean;
};

type VisualPointStatus = "planned" | "generating" | "grown" | "clustered";

type TreeEntry = {
  pointId: string;
  root: THREE.Object3D;
  growthStartedAt: number;
  revealAt: number;
  revealed: boolean;
  targetPosition: THREE.Vector3;
  targetColor: THREE.Color;
  progressElement: HTMLDivElement | null;
  treeHeight: number;
};

type ClusterPad = {
  root: THREE.Group;
  bornAt: number;
};

type PreviewLayout = {
  positions: Map<string, THREE.Vector3>;
  clusterCenters: Map<string, THREE.Vector3>;
  clusterRadii: Map<string, number>;
};

const TREE_COLORS: Record<Exclude<VisualPointStatus, "clustered">, string> = {
  planned: "#87958b",
  generating: "#d09a4e",
  grown: "#4d936a",
};

export function GenerationForestCanvas({
  points,
  clusters,
  totalPoints,
  completed,
}: GenerationForestCanvasProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const sceneRef = useRef<GenerationForestScene | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const scene = new GenerationForestScene(container);
    sceneRef.current = scene;
    return () => {
      scene.dispose();
      sceneRef.current = null;
    };
  }, []);

  useEffect(() => {
    sceneRef.current?.sync(points, clusters, totalPoints, completed);
  }, [clusters, completed, points, totalPoints]);

  return (
    <div
      ref={containerRef}
      className="course-generation__canvas"
      aria-label="正在生长的课程知识森林"
    />
  );
}

class GenerationForestScene {
  private readonly container: HTMLDivElement;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(38, 1, 0.1, 300);
  private readonly renderer: THREE.WebGLRenderer;
  private readonly world = new THREE.Group();
  private readonly treeEntries = new Map<string, TreeEntry>();
  private readonly clusterPads = new Map<string, ClusterPad>();
  private readonly resizeObserver: ResizeObserver;
  private readonly reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  private readonly groundMaterial = new THREE.MeshStandardMaterial({
    color: "#dce7d3",
    roughness: 0.94,
    metalness: 0,
  });
  private animationFrame = 0;
  private disposed = false;
  private completed = false;
  private lastFrame = performance.now();

  constructor(container: HTMLDivElement) {
    this.container = container;
    this.scene.background = new THREE.Color("#eef3e9");
    this.scene.fog = new THREE.Fog("#eef3e9", 70, 125);
    this.camera.position.set(0, 49, 58);
    this.camera.lookAt(0, 0, 0);

    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: false,
      powerPreference: "high-performance",
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(this.renderer.domElement);

    const hemisphere = new THREE.HemisphereLight("#fffef4", "#6c7b61", 2.15);
    this.scene.add(hemisphere);
    const sun = new THREE.DirectionalLight("#fff6d8", 3.2);
    sun.position.set(-24, 42, 18);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    sun.shadow.camera.left = -55;
    sun.shadow.camera.right = 55;
    sun.shadow.camera.top = 42;
    sun.shadow.camera.bottom = -42;
    this.scene.add(sun);

    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(112, 82),
      this.groundMaterial
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.04;
    ground.receiveShadow = true;
    this.scene.add(ground);

    const grid = new THREE.GridHelper(110, 22, "#a8bba0", "#cbd8c4");
    grid.position.y = 0.015;
    const gridMaterials = Array.isArray(grid.material) ? grid.material : [grid.material];
    for (const material of gridMaterials) {
      material.transparent = true;
      material.opacity = 0.2;
    }
    this.scene.add(grid);
    this.scene.add(this.world);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
    this.animationFrame = window.requestAnimationFrame(this.render);
  }

  sync(
    points: GenerationPointState[],
    clusters: ForestCluster[],
    totalPoints: number,
    completed: boolean
  ) {
    this.completed = completed;
    const pointIds = new Set(points.map((point) => point.id));
    for (const [pointId, entry] of this.treeEntries) {
      if (pointIds.has(pointId)) continue;
      this.removeTreeEntry(entry);
      this.treeEntries.delete(pointId);
    }

    const now = performance.now();
    const previewLayout = clusters.length > 0
      ? buildClusterPreviewLayout(points, clusters)
      : null;
    const accentByCluster = new Map(
      clusters.map((cluster) => [cluster.id, cluster.accent])
    );
    const newPoints = points
      .filter((point) => !this.treeEntries.has(point.id))
      .sort((left, right) => left.order - right.order);
    const revealDelayById = new Map(
      newPoints.map((point, index) => [point.id, this.reducedMotion ? 0 : index * 68])
    );

    for (const point of points) {
      const visualStatus = getVisualStatus(point, clusters.length > 0);
      const treeHeight = getTreeHeight(point);
      let entry = this.treeEntries.get(point.id);
      if (!entry) {
        const position = provisionalPosition(point.order, totalPoints);
        const tree = createTree({
          seed: hashString(point.id),
          scale: treeHeight,
          domainColor: TREE_COLORS.planned,
          lod: "medium",
        }) as THREE.Object3D;
        tree.position.copy(position);
        tree.scale.setScalar(this.reducedMotion ? 1 : 0.015);
        tree.visible = this.reducedMotion;
        tree.traverse((child) => {
          if (!(child instanceof THREE.Mesh)) return;
          child.castShadow = true;
          child.receiveShadow = true;
        });
        this.world.add(tree);
        entry = {
          pointId: point.id,
          root: tree,
          growthStartedAt: now,
          revealAt: now + (revealDelayById.get(point.id) ?? 0),
          revealed: this.reducedMotion,
          targetPosition: position.clone(),
          targetColor: new THREE.Color(TREE_COLORS.planned),
          progressElement: null,
          treeHeight,
        };
        this.treeEntries.set(point.id, entry);
      }

      const clustered = previewLayout !== null && pointClusterId(point) !== "";
      if (clustered) {
        const target = previewLayout.positions.get(point.id);
        if (target) entry.targetPosition.copy(target);
      } else {
        entry.targetPosition.copy(provisionalPosition(point.order, totalPoints));
      }

      entry.targetColor.set(
        visualStatus === "clustered"
          ? accentByCluster.get(pointClusterId(point)) ?? "#5a8d73"
          : TREE_COLORS[visualStatus]
      );
    }

    const visibleProgressIds = new Set(
      points
        .filter((point) => getVisualStatus(point, false) === "generating")
        .sort((left, right) => left.order - right.order)
        .slice(0, 4)
        .map((point) => point.id)
    );
    for (const point of points) {
      const entry = this.treeEntries.get(point.id);
      if (!entry) continue;
      if (visibleProgressIds.has(point.id)) {
        this.syncProgressIndicator(entry, point);
      } else {
        this.removeProgressIndicator(entry);
      }
    }

    this.syncClusterPads(previewLayout, clusters);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    window.cancelAnimationFrame(this.animationFrame);
    this.resizeObserver.disconnect();
    for (const entry of this.treeEntries.values()) this.removeTreeEntry(entry);
    this.treeEntries.clear();
    for (const pad of this.clusterPads.values()) {
      this.world.remove(pad.root);
      disposeObject(pad.root);
    }
    this.clusterPads.clear();
    this.groundMaterial.dispose();
    this.renderer.renderLists.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  private syncProgressIndicator(
    entry: TreeEntry,
    point: GenerationPointState
  ) {
    const progress = getPointProgress(point);
    if (!entry.progressElement) {
      const element = document.createElement("div");
      element.className = "course-generation__point-indicator";
      element.innerHTML = `
        <span class="course-generation__point-indicator-title"></span>
        <span class="course-generation__point-indicator-track"><i></i></span>
        <strong></strong>
      `;
      element.setAttribute("role", "progressbar");
      element.setAttribute("aria-valuemin", "0");
      element.setAttribute("aria-valuemax", "100");
      this.container.appendChild(element);
      entry.progressElement = element;
    }

    const element = entry.progressElement;
    element.setAttribute("aria-label", `${point.title} 生成进度`);
    element.setAttribute("aria-valuenow", String(Math.round(progress)));
    const title = element.querySelector<HTMLElement>(".course-generation__point-indicator-title");
    const fill = element.querySelector<HTMLElement>(".course-generation__point-indicator-track i");
    const value = element.querySelector<HTMLElement>("strong");
    if (title) title.textContent = point.title;
    if (fill) fill.style.width = `${progress}%`;
    if (value) value.textContent = `${Math.round(progress)}%`;
  }

  private removeProgressIndicator(entry: TreeEntry) {
    entry.progressElement?.remove();
    entry.progressElement = null;
  }

  private syncClusterPads(
    layout: PreviewLayout | null,
    clusters: ForestCluster[]
  ) {
    const clusterIds = new Set(layout ? clusters.map((cluster) => cluster.id) : []);
    for (const [clusterId, pad] of this.clusterPads) {
      if (clusterIds.has(clusterId)) continue;
      this.world.remove(pad.root);
      disposeObject(pad.root);
      this.clusterPads.delete(clusterId);
    }
    if (!layout) return;

    for (const cluster of clusters) {
      const center = layout.clusterCenters.get(cluster.id);
      const radius = layout.clusterRadii.get(cluster.id);
      if (!center || !radius) continue;

      const existing = this.clusterPads.get(cluster.id);
      if (existing) {
        existing.root.position.set(center.x, 0.02, center.z);
        continue;
      }

      const root = new THREE.Group();
      root.position.set(center.x, 0.02, center.z);
      root.scale.setScalar(this.reducedMotion ? 1 : 0.08);

      const fillMaterial = new THREE.MeshBasicMaterial({
        color: cluster.soft ?? cluster.accent,
        transparent: true,
        opacity: this.reducedMotion ? 0.26 : 0,
        depthWrite: false,
      });
      const fill = new THREE.Mesh(new THREE.CircleGeometry(radius, 40), fillMaterial);
      fill.rotation.x = -Math.PI / 2;
      root.add(fill);

      const ringMaterial = new THREE.MeshBasicMaterial({
        color: cluster.accent,
        transparent: true,
        opacity: this.reducedMotion ? 0.52 : 0,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(radius, radius + 0.16, 48),
        ringMaterial
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.025;
      root.add(ring);
      this.world.add(root);
      this.clusterPads.set(cluster.id, {
        root,
        bornAt: performance.now(),
      });
    }
  }

  private resize() {
    const width = Math.max(1, this.container.clientWidth);
    const height = Math.max(1, this.container.clientHeight);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
  }

  private render = (now: number) => {
    if (this.disposed) return;
    const deltaSeconds = Math.min(0.1, (now - this.lastFrame) / 1000);
    this.lastFrame = now;
    const positionBlend = this.reducedMotion ? 1 : 1 - Math.exp(-deltaSeconds * 2.25);
    const colorBlend = this.reducedMotion ? 1 : 1 - Math.exp(-deltaSeconds * 3.6);

    for (const entry of this.treeEntries.values()) {
      if (!entry.revealed && now >= entry.revealAt) {
        entry.revealed = true;
        entry.root.visible = true;
        entry.growthStartedAt = now;
      }
      if (!entry.revealed) {
        if (entry.progressElement) entry.progressElement.hidden = true;
        continue;
      }

      entry.root.position.lerp(entry.targetPosition, positionBlend);
      if (!this.reducedMotion) {
        const progress = Math.min(1, (now - entry.growthStartedAt) / 820);
        if (progress < 1) {
          entry.root.scale.setScalar(Math.max(0.015, easeOutBack(progress)));
        } else if (entry.root.scale.x !== 1) {
          // easeOutBack briefly overshoots 1. Keep animating until the end so
          // every tree settles at its intended scale instead of freezing large.
          entry.root.scale.setScalar(1);
        }
      }
      tintFoliage(entry.root, entry.targetColor, colorBlend);
      this.positionProgressIndicator(entry);
    }

    for (const pad of this.clusterPads.values()) {
      if (this.reducedMotion) continue;
      const progress = Math.min(1, (now - pad.bornAt) / 1_100);
      pad.root.scale.setScalar(easeOutCubic(progress));
      pad.root.traverse((child) => {
        if (!(child instanceof THREE.Mesh)) return;
        const material = child.material;
        if (material instanceof THREE.MeshBasicMaterial) {
          material.opacity = child.geometry.type === "RingGeometry"
            ? progress * 0.52
            : progress * 0.26;
        }
      });
    }

    const targetGround = new THREE.Color(this.completed ? "#e4ecd7" : "#dce7d3");
    this.groundMaterial.color.lerp(targetGround, Math.min(1, deltaSeconds * 1.4));
    this.renderer.render(this.scene, this.camera);
    this.animationFrame = window.requestAnimationFrame(this.render);
  };

  private positionProgressIndicator(entry: TreeEntry) {
    const element = entry.progressElement;
    if (!element) return;
    const position = entry.root.position.clone();
    position.y += entry.treeHeight * Math.max(0.7, entry.root.scale.y) + 1.15;
    position.project(this.camera);
    const onScreen = position.z > -1 && position.z < 1;
    element.hidden = !onScreen;
    if (!onScreen) return;
    const x = (position.x * 0.5 + 0.5) * this.container.clientWidth;
    const y = (-position.y * 0.5 + 0.5) * this.container.clientHeight;
    element.style.transform =
      `translate3d(${x}px, ${y}px, 0) translate(-50%, -100%)`;
  }

  private removeTreeEntry(entry: TreeEntry) {
    this.removeProgressIndicator(entry);
    this.world.remove(entry.root);
    disposeObject(entry.root);
  }
}

function getVisualStatus(
  point: GenerationPointState,
  clustersReady: boolean
): VisualPointStatus {
  if (clustersReady && pointClusterId(point)) return "clustered";
  const status = String(point.status);
  if (status === "generating") return "generating";
  if (status === "grown") return "grown";
  if (status === "clustered") return "clustered";
  return "planned";
}

function getPointProgress(point: GenerationPointState) {
  const candidate = (point as GenerationPointState & { progress?: number }).progress;
  return Number.isFinite(candidate)
    ? Math.max(0, Math.min(100, candidate ?? 0))
    : 0;
}

function pointClusterId(point: GenerationPointState) {
  return typeof point.clusterId === "string" ? point.clusterId : "";
}

function getTreeHeight(point: GenerationPointState) {
  return 3 + (point.scale ?? 1) * 1.15 + (point.importance ?? 0.5) * 0.7;
}

function provisionalPosition(order: number, total: number) {
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));
  const angle = order * goldenAngle;
  const maxRadius = Math.min(31, 8 + Math.sqrt(Math.max(1, total)) * 4.1);
  const radius = 3 + Math.sqrt(order + 0.6) / Math.sqrt(Math.max(1, total)) * maxRadius;
  return new THREE.Vector3(
    Math.cos(angle) * radius,
    0,
    Math.sin(angle) * radius * 0.78
  );
}

/**
 * A compact deterministic layout used only while the course is being generated.
 * It deliberately does not reuse final map coordinates: the published map remains
 * governed by the project's layout pipeline.
 */
function buildClusterPreviewLayout(
  points: GenerationPointState[],
  clusters: ForestCluster[]
): PreviewLayout {
  const positions = new Map<string, THREE.Vector3>();
  const clusterCenters = new Map<string, THREE.Vector3>();
  const clusterRadii = new Map<string, number>();
  const columns = Math.max(1, Math.ceil(Math.sqrt(clusters.length * 1.15)));
  const rows = Math.max(1, Math.ceil(clusters.length / columns));
  const xGap = Math.min(27, 48 / Math.max(1, columns - 1));
  const zGap = Math.min(22, 34 / Math.max(1, rows - 1));

  clusters.forEach((cluster, clusterIndex) => {
    const row = Math.floor(clusterIndex / columns);
    const column = clusterIndex % columns;
    const rowCount = Math.min(columns, clusters.length - row * columns);
    const jitter = seededUnit(hashString(cluster.id));
    const center = new THREE.Vector3(
      (column - (rowCount - 1) / 2) * xGap
        + (row % 2 === 0 ? -1.1 : 1.1)
        + (jitter - 0.5) * 1.4,
      0,
      (row - (rows - 1) / 2) * zGap
        + (seededUnit(hashString(`${cluster.id}:z`)) - 0.5) * 1.2
    );
    clusterCenters.set(cluster.id, center);

    const members = points
      .filter((point) => pointClusterId(point) === cluster.id)
      .sort((left, right) => left.order - right.order);
    let maximumRadius = 0;
    members.forEach((point, memberIndex) => {
      const angle = memberIndex * Math.PI * (3 - Math.sqrt(5))
        + seededUnit(hashString(point.id)) * 0.5;
      const radius = memberIndex === 0 ? 0 : 2.25 * Math.sqrt(memberIndex);
      const position = new THREE.Vector3(
        center.x + Math.cos(angle) * radius,
        0,
        center.z + Math.sin(angle) * radius * 0.78
      );
      positions.set(point.id, position);
      maximumRadius = Math.max(maximumRadius, radius);
    });
    clusterRadii.set(cluster.id, Math.max(4.2, Math.min(9, maximumRadius + 2.6)));
  });

  // A malformed snapshot should still keep every tree on screen.
  points
    .filter((point) => !positions.has(point.id))
    .forEach((point) => positions.set(
      point.id,
      provisionalPosition(point.order, points.length)
    ));

  return { positions, clusterCenters, clusterRadii };
}

function tintFoliage(
  root: THREE.Object3D,
  targetColor: THREE.Color,
  blend: number
) {
  root.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    const materials = Array.isArray(child.material) ? child.material : [child.material];
    for (const material of materials) {
      if (!(material instanceof THREE.MeshStandardMaterial)) continue;
      if (isTrunkMaterial(material)) continue;
      material.color.lerp(targetColor, blend);
      material.emissive.lerp(
        targetColor,
        blend * (targetColor.r > targetColor.b * 1.45 ? 0.08 : 0.025)
      );
      material.emissiveIntensity = 0.18;
    }
  });
}

function isTrunkMaterial(material: THREE.MeshStandardMaterial) {
  const trunk = new THREE.Color("#6b4a2f");
  const red = material.color.r - trunk.r;
  const green = material.color.g - trunk.g;
  const blue = material.color.b - trunk.b;
  return Math.sqrt(red * red + green * green + blue * blue) < 0.12;
}

function disposeObject(root: THREE.Object3D) {
  root.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    child.geometry.dispose();
    const materials = Array.isArray(child.material) ? child.material : [child.material];
    for (const material of materials) material.dispose();
  });
}

function seededUnit(seed: number) {
  return ((Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0) / 4_294_967_295;
}

function hashString(value: string) {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return Math.abs(hash) || 1;
}

function easeOutBack(progress: number) {
  const c1 = 1.35;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(progress - 1, 3) + c1 * Math.pow(progress - 1, 2);
}

function easeOutCubic(progress: number) {
  return 1 - Math.pow(1 - progress, 3);
}
