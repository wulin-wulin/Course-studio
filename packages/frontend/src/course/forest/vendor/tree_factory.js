/**
 * 3D 树工厂 —— 简约几何抽象风格（五棱台树干 + 多面体树冠）。
 *
 * 约定:
 *   createTree({ seed, scale, domainColor, lod }) → THREE.Object3D
 *
 *   seed:        知识点 id 派生的数值种子（树形稳定可复现）
 *   scale:       ~12–40，由 importance × 20 计算
 *   domainColor: 所属板块的 HEX 颜色（用于树冠着色）
 *   lod:         "high" | "medium" | "low"（视缩放级别自动设置）
 */

import * as THREE from "three";

/* ── 基于 seed 的伪随机 ── */
function seededRandom(seed) {
    let s = seed;
    return function () {
        s = (s * 16807 + 0) % 2147483647;
        return (s - 1) / 2147483646;
    };
}

/* ── 颜色变体：略微调亮/调暗 ── */
function varyColor(hex, rand, amount = 0.12) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    const d = (rand() - 0.5) * 2 * amount;
    const clamp = (v) => Math.min(255, Math.max(0, Math.round(v * (1 + d))));
    const hr = clamp(r).toString(16).padStart(2, "0");
    const hg = clamp(g).toString(16).padStart(2, "0");
    const hb = clamp(b).toString(16).padStart(2, "0");
    return `#${hr}${hg}${hb}`;
}

const TRUNK_COLOR = "#6b4a2f";

function foliageMat(color) {
    return new THREE.MeshStandardMaterial({ color, roughness: 0.78, flatShading: true });
}

// 锥度树干（底粗顶细），返回树干高度
function addTrunk(group, h, frac, rBottom) {
    const th = h * frac;
    const geo = new THREE.CylinderGeometry(rBottom * 0.55, rBottom, th, 6);
    const trunk = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: TRUNK_COLOR, roughness: 0.9, flatShading: true }));
    trunk.position.y = th / 2;
    group.add(trunk);
    return th;
}

/**
 * 主入口：按 seed 确定性地从几种自然树型中挑一种（针叶松 / 阔叶圆冠 / 高瘦杨树），
 * 低多边形 + 平面着色，保持轻量与统一画风，但读起来明确是「树」而非几何块。
 */
export function createTree({ seed, scale, domainColor, lod }) {
    const rand = seededRandom(seed);
    const h = scale;                      // 树总高（世界坐标，Y 朝上；调用方再转成世界 Z 朝上）
    const canopyColor = varyColor(domainColor, rand, 0.06);
    const group = new THREE.Group();

    /* ── LOW LOD: 树干 + 单个圆润树冠 ── */
    if (lod === "low") {
        const th = addTrunk(group, h, 0.3, h * 0.05);
        const r = h * 0.3;
        const blob = new THREE.Mesh(new THREE.IcosahedronGeometry(r, 0), foliageMat(canopyColor));
        blob.position.y = th + r * 0.7;
        group.add(blob);
        group.rotation.y = rand() * Math.PI * 2;
        return group;
    }

    const detail = lod === "high" ? 1 : 0;   // high 用细分球，更圆润；medium 保持粗面
    const archetype = rand();

    if (archetype < 0.4) {
        /* ── 针叶松：多层堆叠圆锥（经典三角松树） ── */
        const th = addTrunk(group, h, 0.24, h * 0.05);
        const tiers = lod === "high" ? 3 : 2;
        const baseR = h * 0.32;
        const tierH = h * 0.42;
        const tColor = varyColor(canopyColor, rand, 0.05);
        let y = th * 0.92;
        for (let i = 0; i < tiers; i++) {
            const f = i / tiers;
            const r = baseR * (1 - f * 0.5);
            const cone = new THREE.Mesh(new THREE.ConeGeometry(r, tierH, 7), foliageMat(varyColor(tColor, rand, 0.05)));
            cone.position.y = y + tierH * 0.4;
            cone.rotation.y = rand() * Math.PI;
            group.add(cone);
            y += tierH * 0.42;
        }
    } else if (archetype < 0.75) {
        /* ── 阔叶圆冠：主冠 + 顶部小冠，圆润饱满 ── */
        const th = addTrunk(group, h, 0.4, h * 0.055);
        const r = h * 0.33;
        const main = new THREE.Mesh(new THREE.IcosahedronGeometry(r, detail), foliageMat(canopyColor));
        main.position.y = th + r * 0.7;
        main.scale.set(1, 0.92, 1);
        main.rotation.set(rand() * 0.4, rand() * Math.PI * 2, rand() * 0.4);
        group.add(main);
        if (lod === "high") {
            const r2 = r * 0.6;
            const top = new THREE.Mesh(new THREE.IcosahedronGeometry(r2, detail), foliageMat(varyColor(canopyColor, rand, 0.1)));
            top.position.set((rand() - 0.5) * r * 0.5, th + r * 1.2, (rand() - 0.5) * r * 0.5);
            top.rotation.y = rand() * Math.PI;
            group.add(top);
        }
    } else {
        /* ── 高瘦杨树：纵向拉长的椭圆冠 ── */
        const th = addTrunk(group, h, 0.5, h * 0.045);
        const r = h * 0.2;
        const canopy = new THREE.Mesh(new THREE.IcosahedronGeometry(r, detail), foliageMat(canopyColor));
        canopy.position.y = th + r * 1.35;
        canopy.scale.set(1, 1.9, 1);
        canopy.rotation.y = rand() * Math.PI;
        group.add(canopy);
    }

    group.rotation.y = rand() * Math.PI * 2;
    return group;
}
