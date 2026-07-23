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

type TreeEntry = {
  pointId: string;
  root: THREE.Object3D;
  seed: THREE.Mesh | null;
  growthStartedAt: number;
  targetPosition: THREE.Vector3;
  clustered: boolean;
};

type ClusterPad = {
  root: THREE.Group;
  material: THREE.MeshBasicMaterial;
  bornAt: number;
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

    const accentByCluster = new Map(
      clusters.map((cluster) => [cluster.id, cluster.accent])
    );
    for (const point of points) {
      let entry = this.treeEntries.get(point.id);
      if (!entry) {
        const position = provisionalPosition(point.order, totalPoints);
        const seed = makeSeed(hashString(point.id));
        seed.position.copy(position);
        this.world.add(seed);
        entry = {
          pointId: point.id,
          root: new THREE.Group(),
          seed,
          growthStartedAt: 0,
          targetPosition: position.clone(),
          clustered: false,
        };
        this.treeEntries.set(point.id, entry);
      }

      if (point.status !== "planned" && entry.root.children.length === 0) {
        const accent = accentByCluster.get(point.clusterId) ?? "#6f9171";
        const tree = createTree({
          seed: hashString(point.id),
          scale: 3 + (point.scale ?? 1) * 1.15 + (point.importance ?? 0.5) * 0.7,
          domainColor: point.status === "clustered" ? accent : "#78966f",
          lod: "medium",
        }) as THREE.Object3D;
        tree.position.copy(entry.targetPosition);
        tree.scale.setScalar(this.reducedMotion ? 1 : 0.015);
        tree.traverse((child) => {
          if (!(child instanceof THREE.Mesh)) return;
          child.castShadow = true;
          child.receiveShadow = true;
        });
        this.world.add(tree);
        entry.root = tree;
        entry.growthStartedAt = performance.now();
      }

      if (point.status === "clustered") {
        const target = finalPosition(point.pos);
        entry.targetPosition.copy(target);
        if (!entry.clustered) {
          entry.clustered = true;
          recolorTree(entry.root, accentByCluster.get(point.clusterId) ?? "#6f9171");
        }
      }
    }

    this.syncClusterPads(points, clusters);
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

  private syncClusterPads(points: GenerationPointState[], clusters: ForestCluster[]) {
    const clusterIds = new Set(clusters.map((cluster) => cluster.id));
    for (const [clusterId, pad] of this.clusterPads) {
      if (clusterIds.has(clusterId)) continue;
      this.world.remove(pad.root);
      disposeObject(pad.root);
      this.clusterPads.delete(clusterId);
    }

    for (const cluster of clusters) {
      if (this.clusterPads.has(cluster.id)) continue;
      const members = points.filter((point) => point.clusterId === cluster.id);
      if (members.length === 0) continue;
      const center = members.reduce(
        (sum, point) => sum.add(finalPosition(point.pos)),
        new THREE.Vector3()
      ).multiplyScalar(1 / members.length);
      const radius = Math.max(
        4.2,
        Math.min(
          9,
          Math.max(
            ...members.map((point) => finalPosition(point.pos).distanceTo(center))
          ) + 2.1
        )
      );
      const root = new THREE.Group();
      root.position.set(center.x, 0.02, center.z);
      root.scale.setScalar(this.reducedMotion ? 1 : 0.08);

      const fillMaterial = new THREE.MeshBasicMaterial({
        color: cluster.soft ?? cluster.accent,
        transparent: true,
        opacity: this.reducedMotion ? 0.3 : 0,
        depthWrite: false,
      });
      const fill = new THREE.Mesh(new THREE.CircleGeometry(radius, 40), fillMaterial);
      fill.rotation.x = -Math.PI / 2;
      root.add(fill);

      const ringMaterial = new THREE.MeshBasicMaterial({
        color: cluster.accent,
        transparent: true,
        opacity: this.reducedMotion ? 0.55 : 0,
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
        material: fillMaterial,
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

    for (const entry of this.treeEntries.values()) {
      if (entry.root.children.length > 0) {
        entry.root.position.lerp(entry.targetPosition, positionBlend);
        if (!this.reducedMotion && entry.root.scale.x < 0.999) {
          const progress = Math.min(1, (now - entry.growthStartedAt) / 880);
          const scale = Math.max(0.015, easeOutBack(progress));
          entry.root.scale.setScalar(scale);
        }
        if (entry.seed) {
          const seedScale = Math.max(0, 1 - entry.root.scale.x * 1.25);
          entry.seed.scale.setScalar(seedScale);
          if (seedScale <= 0.01) {
            this.world.remove(entry.seed);
            disposeObject(entry.seed);
            entry.seed = null;
          }
        }
      }
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
            ? progress * 0.55
            : progress * 0.3;
        }
      });
    }

    const targetGround = new THREE.Color(this.completed ? "#e4ecd7" : "#dce7d3");
    this.groundMaterial.color.lerp(targetGround, Math.min(1, deltaSeconds * 1.4));
    this.renderer.render(this.scene, this.camera);
    this.animationFrame = window.requestAnimationFrame(this.render);
  };

  private removeTreeEntry(entry: TreeEntry) {
    if (entry.seed) {
      this.world.remove(entry.seed);
      disposeObject(entry.seed);
    }
    if (entry.root.children.length > 0) {
      this.world.remove(entry.root);
      disposeObject(entry.root);
    }
  }
}

function makeSeed(seed: number) {
  const material = new THREE.MeshStandardMaterial({
    color: seed % 2 === 0 ? "#8b6845" : "#765739",
    roughness: 0.88,
  });
  const mesh = new THREE.Mesh(new THREE.DodecahedronGeometry(0.24, 0), material);
  mesh.castShadow = true;
  return mesh;
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

function finalPosition(position: [number, number]) {
  return new THREE.Vector3(
    (position[0] - 2_000) / 47,
    0,
    (position[1] - 1_500) / 47
  );
}

function recolorTree(root: THREE.Object3D, accent: string) {
  const accentColor = new THREE.Color(accent);
  root.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    const materials = Array.isArray(child.material) ? child.material : [child.material];
    for (const material of materials) {
      if (!(material instanceof THREE.MeshStandardMaterial)) continue;
      if (material.color.getHexString().toLowerCase() === "6b4a2f") continue;
      material.color.lerp(accentColor, 0.84);
    }
  });
}

function disposeObject(root: THREE.Object3D) {
  root.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    child.geometry.dispose();
    const materials = Array.isArray(child.material) ? child.material : [child.material];
    for (const material of materials) material.dispose();
  });
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

