/**
 * 统一 3D 场景 —— 5 级预计算布局切换。
 * 替代运行时过滤，每个缩放级别有独立点位置。
 */

import * as THREE from "three";
import { createTree } from "./tree_factory.js";

const CANVAS_W = 4000, CANVAS_H = 3000;
// 日间色调（我的世界式明亮白天）
const HORIZON_COLOR = 0xf5f6ef;  // 与首页一致的淡白底色（同时作 clearColor 兜底）
const ZENITH_COLOR = 0xfffdf7;   // 顶部微暖白
const GROUND_COLOR = 0xf5f6ef;   // 地面改为协调淡白色
const GROUND_RADIUS = 18000;     // 圆盘地面半径（跟随相机，永远延伸到地平线、形成干净圆形天际线）
const PHI_MAX = 1.50;            // 俯仰角上限：接近 π/2，配合抬头视线可仰望天空
const LABEL_ZOOM_R = 3600;       // 拉近/簇近景自动显示屏幕内全部小标签；默认全景仍保持干净

export class Scene3D {
    constructor(container, layout, data) {
        this.container = container;
        this.layout = layout;
        this.data = data;

        this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        this.renderer.setSize(container.clientWidth, container.clientHeight);
        this.renderer.setClearColor(HORIZON_COLOR);
        this.renderer.shadowMap.enabled = true;          // 阳光投影，给场景体积感
        this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
        this.renderer.domElement.style.cssText = "position:absolute;top:0;left:0;";
        container.appendChild(this.renderer.domElement);

        this.scene = new THREE.Scene();
        // 不用雾：靠「跟随相机的大圆盘地面 + 天空球」自然形成干净的开放世界圆形天际线
        this.camera = new THREE.PerspectiveCamera(35, container.clientWidth / container.clientHeight, 10, 22000);
        // 世界是 Z 朝上（地面 z=0，相机高度 cz=r·cos(phi)）；相机 up 必须用 +Z，
        // 否则绕竖直轴自由旋转方位角(theta)时会退化/翻滚，水平朝向转不顺/看似没变。
        this.camera.up.set(0, 0, 1);
        this.camera.position.set(CANVAS_W / 2, CANVAS_H / 2 + 1500, 2000);
        this.camera.lookAt(CANVAS_W / 2, CANVAS_H / 2, 0);

        // 白天日光：半球光给户外天/地自然补光 + 投影暖白阳光 + 少量环境光
        // （半球/环境压低一点，让阳光阴影读得出来、场景有立体感而不发平）
        this.scene.add(new THREE.HemisphereLight(0xfffdf7, 0xdde7d6, 0.78));
        this.scene.add(new THREE.AmbientLight(0xffffff, 0.34));
        const sun = new THREE.DirectionalLight(0xfff4df, 1.45);
        sun.position.set(CANVAS_W / 2 + 1900, CANVAS_H / 2 - 2700, 4400);
        sun.target.position.set(CANVAS_W / 2, CANVAS_H / 2, 0);
        this.scene.add(sun.target);
        sun.castShadow = true;
        sun.shadow.mapSize.set(2048, 2048);
        sun.shadow.bias = -0.0006;
        const sc = sun.shadow.camera;
        sc.near = 200; sc.far = 9000; sc.left = -2700; sc.right = 2700; sc.top = 2700; sc.bottom = -2700;
        this.scene.add(sun);

        // 天空 + 云（在地图之前建，渲染顺序最底）
        this._buildSky();
        this._buildClouds();

        // 地图
        this.mapGroup = new THREE.Group(); this.scene.add(this.mapGroup);
        this._buildGround();
        this._buildDomains();

        // Category 索引
        this._catPolygons = [];
        for (const c of this.data.index.categories) {
            const lc = this.layout.categories.find(l => l.id === c.id);
            if (lc && lc.polygon) this._catPolygons.push({ id: c.id, poly: lc.polygon });
        }

        // 域标签（DOM overlay，必须在 _buildTrees 之前创建）
        this._labelLayer = document.createElement("div");
        this._labelLayer.style.cssText = "position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:1;";
        container.appendChild(this._labelLayer);
        this._labelEls = [];
        this._buildLabels();

        // 3D 树
        this.highGroup = new THREE.Group(); this.scene.add(this.highGroup);
        this.treeMeta = []; this._buildTrees();

        // Level sprites 层
        this._levelGroup = new THREE.Group(); this.scene.add(this._levelGroup);
        this._currentLevel = -1;

        // 高亮
        this.highlightGroup = new THREE.Group(); this.scene.add(this.highlightGroup);
        this.highlightGroup.visible = false;

        // 学习路径：独立图层，便于生成/清空虚线和编号标记，不干扰树与簇边界。
        this.learningPathGroup = new THREE.Group(); this.scene.add(this.learningPathGroup);
        this._learningPathIds = [];
        this._learningPathIdSet = new Set();
        this._pathLabelEls = [];

        this._needsVisRefresh = true;
        this._hoverId = null;
        this._batchLabelIds = new Set();
        this._showAllTreeLabels = false;
        this._forceFullLabelsForRefresh = false;
        this._onCameraChange = null;
        this._setupControls();
    }

    /* ============ 天空 / 云 ============ */
    _buildSky() {
        // 跟随相机的大天空球，按世界 Z 方向做天顶→地平线渐变
        const geo = new THREE.SphereGeometry(15000, 32, 16);
        const mat = new THREE.ShaderMaterial({
            side: THREE.BackSide, depthWrite: false, fog: false,
            uniforms: {
                topColor: { value: new THREE.Color(ZENITH_COLOR) },
                bottomColor: { value: new THREE.Color(HORIZON_COLOR) },
            },
            vertexShader: `
                varying vec3 vDir;
                void main() { vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
            `,
            fragmentShader: `
                uniform vec3 topColor; uniform vec3 bottomColor; varying vec3 vDir;
                void main() {
                    float h = clamp(vDir.z * 0.5 + 0.5, 0.0, 1.0);  // 世界 Z 仰角 0..1
                    float t = pow(h, 0.55);                          // 蓝色偏上、地平线更浅
                    gl_FragColor = vec4(mix(bottomColor, topColor, t), 1.0);
                }
            `,
        });
        this._sky = new THREE.Mesh(geo, mat);
        this._sky.renderOrder = -1;
        this.scene.add(this._sky);
    }

    _makeCloudTexture() {
        const c = document.createElement("canvas"); c.width = c.height = 128;
        const ctx = c.getContext("2d");
        // 由几团柔和白斑叠成蓬松云
        for (const [bx, by, br] of [[54, 70, 34], [78, 64, 30], [64, 78, 38], [40, 64, 24], [90, 76, 22]]) {
            const g = ctx.createRadialGradient(bx, by, 2, bx, by, br);
            g.addColorStop(0, "rgba(255,255,255,0.95)");
            g.addColorStop(0.6, "rgba(255,255,255,0.55)");
            g.addColorStop(1, "rgba(255,255,255,0)");
            ctx.fillStyle = g; ctx.fillRect(0, 0, 128, 128);
        }
        const t = new THREE.CanvasTexture(c);
        t.needsUpdate = true;
        return t;
    }

    _buildClouds() {
        const tex = this._makeCloudTexture();
        this._clouds = [];
        const N = 20;
        for (let i = 0; i < N; i++) {
            // 云挂在「跟随相机的地平线环」上：固定方位角 + 低仰角 + 远距离，
            // 这样相机始终看向地面注视点时，云稳定地出现在地平线上方的天空带里（任意朝向都有）。
            const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, fog: false, opacity: 0.95 }));
            const sc = 2200 + ((i * 433) % 2600);
            s.scale.set(sc, sc * 0.5, 1);
            s.userData.az = (i * 2.39996) % (Math.PI * 2);           // 方位角（黄金角铺开）
            s.userData.el = 0.04 + ((i * 311) % 1000) / 1000 * 0.42; // 仰角 ~2°..26°（贴地平线到中高空，抬头时也有云）
            s.userData.dist = 9000 + ((i * 547) % 3500);             // 远距离（< 天空球 15000）
            this.scene.add(s);
            this._clouds.push(s);
        }
    }

    /* ============ 地图 ============ */
    _buildGround() {
        // 用「圆盘」而非方形平面：没有直边 / 直角，远端从任意方向都均匀雾化融入地平线，
        // 形成连续的开放世界式圆形天际线（不再是会露出方块边的方形地面）。
        const g = new THREE.Mesh(
            new THREE.CircleGeometry(GROUND_RADIUS, 96),
            new THREE.MeshLambertMaterial({
                color: GROUND_COLOR,
                emissive: 0xf5f6ef,
                emissiveIntensity: 0.38,
                side: THREE.DoubleSide,
            })
        );
        g.position.set(CANVAS_W / 2, CANVAS_H / 2, -0.5);
        g.receiveShadow = true;    // 承接树的投影
        this._ground = g;          // render() 里跟随相机 xy，使地面始终延伸到地平线
        this.mapGroup.add(g);
    }

    // 凸包顶点 → 闭合 Catmull-Rom 平滑曲线（重采样为多点），让簇边界圆润不生硬
    _smoothPolygon(pts, samples = 72) {
        const v = pts.map(p => new THREE.Vector3(p[0], p[1], 0));
        const curve = new THREE.CatmullRomCurve3(v, true, "catmullrom", 0.5);
        return curve.getPoints(samples); // Vector3[]（首尾相接、闭合平滑）
    }

    _buildDomains() {
        for (const dom of this.layout.domains) {
            const pts = dom.polygon;
            if (pts.length < 3) continue;
            const smooth = this._smoothPolygon(pts);
            // 填充与描边用同一条平滑轮廓，边界吻合、无尖角
            const shape = new THREE.Shape();
            shape.moveTo(smooth[0].x, smooth[0].y);
            for (let i = 1; i < smooth.length; i++) shape.lineTo(smooth[i].x, smooth[i].y);
            shape.closePath();
            const geo = new THREE.ShapeGeometry(shape);
            const fill = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: dom.color, transparent: true, opacity: 0.16, side: THREE.DoubleSide, depthWrite: false, fog: false }));
            fill.position.z = 0; this.mapGroup.add(fill);
            const edge = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(smooth), new THREE.LineBasicMaterial({ color: dom.color, transparent: true, opacity: 0.55, fog: false }));
            edge.position.z = 0.02; this.mapGroup.add(edge);
        }
    }

    _buildLabels() {
        for (const dom of this.layout.domains) {
            const d = this.data.domById[dom.id];
            if (!d) continue;
            const el = document.createElement("div");
            el.textContent = d.name_zh;
            // 亮背景适配：簇色字压在深色半透明小底牌上，保留簇配色又清晰可读
            el.style.cssText =
                `position:absolute;color:${dom.color};font-size:18px;font-weight:700;` +
                `font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;` +
                `text-align:center;transform:translate(-50%,-50%);white-space:nowrap;` +
                `padding:2px 10px;border-radius:999px;background:rgba(17,28,42,0.62);` +
                `box-shadow:0 1px 6px rgba(0,0,0,0.25);text-shadow:0 1px 2px rgba(0,0,0,0.55);pointer-events:none;`;
            this._labelLayer.appendChild(el);
            this._labelEls.push({ el, poly: dom.polygon });
        }
    }

    _updateLabelPositions() {
        this.camera.updateMatrixWorld();
        const rect = this.container.getBoundingClientRect();
        const v3 = new THREE.Vector3();
        const domainBoxes = [];
        // 域标签
        for (const lbl of this._labelEls) {
            let sx = 0, sy = 0;
            const n = lbl.poly.length;
            for (const pt of lbl.poly) {
                v3.set(pt[0], pt[1], 0);
                v3.project(this.camera);
                sx += (v3.x * 0.5 + 0.5) * rect.width;
                sy += (-v3.y * 0.5 + 0.5) * rect.height;
            }
            sx /= n; sy /= n;
            lbl.el.style.left = sx + "px";
            lbl.el.style.top = sy + "px";
            const off = sx < -200 || sx > rect.width + 200 || sy < -200 || sy > rect.height + 200;
            lbl.el.style.visibility = off ? "hidden" : "visible";
            if (!off) {
                const r = lbl.el.getBoundingClientRect();
                domainBoxes.push({
                    left: r.left - rect.left - 4,
                    top: r.top - rect.top - 4,
                    right: r.right - rect.left + 4,
                    bottom: r.bottom - rect.top + 4,
                });
            }
        }
        // 树标签：避开知识簇标题和已经摆好的树标签；悬停标签优先尝试多个方位
        const occupied = [...domainBoxes];
        for (const m of this.treeMeta) {
            if (!m.label || m.label.style.display === "none") continue;
            v3.set(m.pos[0], m.pos[1], 0);
            v3.project(this.camera);
            const sx = (v3.x * 0.5 + 0.5) * rect.width;
            const sy = (-v3.y * 0.5 + 0.5) * rect.height;
            this._placeTreeLabel(m, sx, sy, rect, occupied);
        }
        this._updatePathLabelPositions(rect);
    }

    _boxesOverlap(a, b) {
        return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
    }

    _candidateLabelBox(el, sx, sy, placement) {
        const w = el.offsetWidth || 72;
        const h = el.offsetHeight || 22;
        const gap = placement.gap || 18;
        let left = sx + placement.x * gap;
        let top = sy + placement.y * gap;
        if (placement.anchorX === "center") left -= w / 2;
        if (placement.anchorX === "right") left -= w;
        if (placement.anchorY === "center") top -= h / 2;
        if (placement.anchorY === "bottom") top -= h;
        return { left, top, right: left + w, bottom: top + h };
    }

    _placeTreeLabel(m, sx, sy, rect, occupied) {
        const el = m.label;
        const hovered = m.id === this._hoverId;
        const placements = hovered
            ? [
                { x: 1, y: -1, anchorX: "left", anchorY: "bottom", cls: "place-ne" },
                { x: -1, y: -1, anchorX: "right", anchorY: "bottom", cls: "place-nw" },
                { x: 1, y: 1, anchorX: "left", anchorY: "top", cls: "place-se" },
                { x: -1, y: 1, anchorX: "right", anchorY: "top", cls: "place-sw" },
            ]
            : [
                { x: 1, y: -1, anchorX: "left", anchorY: "bottom", gap: 14, cls: "place-ne" },
                { x: -1, y: -1, anchorX: "right", anchorY: "bottom", gap: 14, cls: "place-nw" },
                { x: 1, y: 1, anchorX: "left", anchorY: "top", gap: 14, cls: "place-se" },
                { x: -1, y: 1, anchorX: "right", anchorY: "top", gap: 14, cls: "place-sw" },
            ];
        const margin = 4;
        let chosen = null;
        let box = null;
        for (const p of placements) {
            const b = this._candidateLabelBox(el, sx, sy, p);
            const off = b.left < margin || b.top < margin || b.right > rect.width - margin || b.bottom > rect.height - margin;
            const hit = occupied.some(o => this._boxesOverlap(b, o));
            if (!off && !hit) { chosen = p; box = b; break; }
        }
        if (!chosen) {
            if (hovered || this._showAllTreeLabels) {
                chosen = placements[0];
                box = this._candidateLabelBox(el, sx, sy, chosen);
            } else {
                el.style.visibility = "hidden";
                return;
            }
        }
        el.style.visibility = "visible";
        el.classList.remove("place-ne", "place-nw", "place-se", "place-sw");
        el.classList.add(chosen.cls);
        el.style.left = box.left + "px";
        el.style.top = box.top + "px";
        occupied.push({ left: box.left - 3, top: box.top - 3, right: box.right + 3, bottom: box.bottom + 3 });
    }

    _updatePathLabelPositions(rect) {
        if (!this._pathLabelEls || !this._pathLabelEls.length) return;
        const v3 = new THREE.Vector3();
        const placements = [
            { x: 0, y: -1, anchorX: "center", anchorY: "bottom", gap: 26 },
            { x: 1, y: -1, anchorX: "left", anchorY: "bottom", gap: 22 },
            { x: -1, y: -1, anchorX: "right", anchorY: "bottom", gap: 22 },
            { x: 0, y: 1, anchorX: "center", anchorY: "top", gap: 22 },
        ];
        for (const item of this._pathLabelEls) {
            const el = item.el;
            v3.set(item.pos[0], item.pos[1], 0);
            v3.project(this.camera);
            const sx = (v3.x * 0.5 + 0.5) * rect.width;
            const sy = (-v3.y * 0.5 + 0.5) * rect.height;
            const off = !Number.isFinite(sx) || !Number.isFinite(sy)
                || v3.z < -1 || v3.z > 1
                || sx < -140 || sx > rect.width + 140
                || sy < -120 || sy > rect.height + 120;
            if (off) {
                el.style.display = "none";
                el.style.visibility = "hidden";
                continue;
            }
            el.style.display = "";
            const placement = placements[item.index % placements.length];
            const box = this._candidateLabelBox(el, sx, sy, placement);
            const margin = 6;
            const left = Math.min(Math.max(margin, box.left), Math.max(margin, rect.width - (el.offsetWidth || 120) - margin));
            const top = Math.min(Math.max(margin, box.top), Math.max(margin, rect.height - (el.offsetHeight || 24) - margin));
            el.style.visibility = "visible";
            el.style.left = left + "px";
            el.style.top = top + "px";
            el.classList.toggle("is-hovered", item.id === this._hoverId);
        }
    }

    // 簇 accent → 自然树冠色：保留色相做区分，降饱和 + 适度压暗，去掉糖果感
    _mutedFoliage(hex) {
        const c = new THREE.Color(hex);
        const hsl = {}; c.getHSL(hsl);
        c.setHSL(hsl.h, Math.min(hsl.s, 0.52), Math.min(Math.max(hsl.l * 0.86, 0.38), 0.52));
        return "#" + c.getHexString();
    }

    /* ============ 3D 树 ============ */
    _buildTrees() {
        const posMap = {};
        for (const pt of this.layout.points) posMap[pt.id] = pt;
        for (const kp of Object.values(this.data.kpById)) {
            const pt = posMap[kp.id]; if (!pt) continue;
            const imp = pt.scale || 1.0;
            const wx = pt.pos[0], wy = pt.pos[1];
            const cat = this.data.catById[kp.category_id];
            const domId = cat ? cat.domain_id : null;
            const color = domId ? (this.layout.domains.find(d => d.id === domId) || {}).color || "#888" : "#888";
            const foliage = this._mutedFoliage(color);  // 树冠用降饱和的自然色（保留簇色相做区分，不再糖果色）
            let seed = 0;
            for (let i = 0; i < kp.id.length; i++) seed = (seed * 31 + kp.id.charCodeAt(i)) & 0x7fffffff;
            const tree = createTree({ seed, scale: imp * 300, domainColor: foliage, lod: "high" });
            tree.rotation.x = Math.PI / 2;
            tree.position.set(wx, wy, 0);
            tree.userData = { type: "tree", id: kp.id };
            tree.traverse(c => { if (c.isMesh) c.castShadow = true; });  // 投影到地面
            this.highGroup.add(tree);
            const short = kp.name_zh.length > 8 ? kp.name_zh.slice(0, 8) + "…" : kp.name_zh;
            const lbl = document.createElement("div");
            lbl.textContent = short;
            lbl.title = kp.name_zh;
            lbl.className = "forest-tree-label";
            lbl.style.display = "none";
            this._labelLayer.appendChild(lbl);
            this.treeMeta.push({ id: kp.id, catId: kp.category_id, pos: [wx, wy], mesh: tree, seed, scale: imp, domainColor: color, importance: kp.importance || 0.5, label: lbl });
        }
    }

    /* ============ 相机控制 ============ */
    _setupControls() {
        this._computeBestView();
        const b = this._best;
        this._state = { theta: b.theta, phi: b.phi, r: b.r, target: { x: b.target.x, y: b.target.y } };
        // 方位角 theta 不夹紧：右键左右拖动可绕森林 360° 自由旋转水平朝向
        // 俯仰角范围：收紧到自然区间——下限不再接近正俯视(0.35→0.62)，上限仍可抬头仰望天空(略收 1.50→1.44)
        this._PHI = { min: 0.62, max: 1.44 };
        const el = this.container;
        // 用 Pointer Events + setPointerCapture：右键拖动也能可靠地持续收到 move 事件
        // （比 mousedown/window-mousemove 更稳，避免真实浏览器里右键拖动丢 move）。
        this._listeners = [];
        const on = (target, type, fn, opts) => { target.addEventListener(type, fn, opts); this._listeners.push([target, type, fn, opts]); };

        const onPointerDown = e => {
            if (e.target.closest && e.target.closest(".facet-panel,input,button,select,a")) return;
            this._state.isDragging = true;
            this._state.pointerId = e.pointerId;
            this._state.ds = { x: e.clientX, y: e.clientY };
            this._state._dtx = this._state.target.x;
            this._state._dty = this._state.target.y;
            this._state._dth = this._state.theta;
            this._state._dph = this._state.phi;
            // 右键 / Ctrl / Meta = 旋转视角；左键 = 平移
            this._state._rot = (e.button === 2 || e.ctrlKey || e.metaKey);
            try { el.setPointerCapture(e.pointerId); } catch { /* 非指针环境忽略 */ }
        };
        const onPointerMove = e => {
            if (!this._state.isDragging || e.pointerId !== this._state.pointerId) return;
            const dx = e.clientX - this._state.ds.x, dy = e.clientY - this._state.ds.y;
            if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
            if (this._state._rot) {
                // dx 调方位角：左右拖动绕森林自由旋转水平朝向（像地图罗盘，朝北→朝西→朝南，不夹紧）
                this._state.theta = this._state._dth - dx * 0.004;
                // dy 调俯仰角：上滑(dy<0)拉低视角(更贴地平线,phi↑)，下滑(dy>0)拉高视角(更俯视,phi↓)
                this._state.phi = Math.max(this._PHI.min, Math.min(this._PHI.max, this._state._dph - dy * 0.0035));
            } else {
                // 左键平移：把屏幕拖拽量按当前朝向 theta 投影到地面，使平移方向跟手（转向后也一致）
                const s = this._state.r / 1500;
                const th = this._state.theta;
                const sin = Math.sin(th), cos = Math.cos(th);
                const rx = -sin, ry = cos;   // 屏幕右方向在地面的投影
                const fx = -cos, fy = -sin;  // 屏幕前(上滑)方向在地面的投影
                const nx = this._state._dtx - dx * s * rx + dy * s * fx;
                const ny = this._state._dty - dx * s * ry + dy * s * fy;
                const c = this._clampTarget(nx, ny);
                this._state.target.x = c.x;
                this._state.target.y = c.y;
            }
            this._updateCamera();
        };
        const onPointerUp = e => {
            if (e.pointerId === this._state.pointerId) {
                this._state.isDragging = false;
                this._state.pointerId = null;
                try { el.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
            }
        };

        on(el, "pointerdown", onPointerDown);
        on(el, "pointermove", onPointerMove);
        on(el, "pointerup", onPointerUp);
        on(el, "pointercancel", onPointerUp);
        on(el, "contextmenu", e => e.preventDefault());
        on(el, "wheel", e => {
            e.preventDefault();
            this._state.r *= (e.deltaY > 0 ? 1.04 : 0.96);
            this._state.r = Math.max(250, Math.min(12000, this._state.r));
            this._needsVisRefresh = true;
            this._updateCamera();
        }, { passive: false });

        this._updateCamera();
    }

    // 解绑所有事件监听（供 React 卸载时调用，避免 StrictMode 双挂载残留重复监听）
    dispose() {
        if (this._listeners) for (const [t, type, fn, opts] of this._listeners) t.removeEventListener(type, fn, opts);
        this._listeners = [];
        this._onCameraChange = null;
        this._clearPathLabels();
        if (this._labelLayer) this._labelLayer.remove();
        if (this.scene) this._disposeObject(this.scene);
        if (this.renderer) {
            if (this.renderer.renderLists) this.renderer.renderLists.dispose();
            this.renderer.dispose();
            if (this.renderer.domElement) this.renderer.domElement.remove();
        }
    }

    getCameraHeight() {
        if (!this._PHI || !this._state) return 50;
        const pct = (this._state.phi - this._PHI.min) / (this._PHI.max - this._PHI.min) * 100;
        return Math.max(0, Math.min(100, Math.round(pct)));
    }

    setCameraHeight(value) {
        if (!this._PHI || !this._state) return;
        const pct = Math.max(0, Math.min(100, Number(value) || 0)) / 100;
        this._state.phi = this._PHI.min + pct * (this._PHI.max - this._PHI.min);
        this._updateCamera();
    }

    getViewState() {
        if (!this._state || !this._state.target) return null;
        return {
            theta: this._state.theta,
            phi: this._state.phi,
            r: this._state.r,
            target: {
                x: this._state.target.x,
                y: this._state.target.y,
            },
        };
    }

    restoreViewState(view) {
        if (!this._PHI || !this._state || !view || !view.target) return false;
        const theta = Number(view.theta);
        const phi = Number(view.phi);
        const r = Number(view.r);
        const targetX = Number(view.target.x);
        const targetY = Number(view.target.y);
        if (![theta, phi, r, targetX, targetY].every(Number.isFinite)) return false;

        this.setHover(null);
        const c = this._clampTarget(targetX, targetY);
        this._state.theta = theta;
        this._state.phi = Math.max(this._PHI.min, Math.min(this._PHI.max, phi));
        this._state.r = Math.max(250, Math.min(12000, r));
        this._state.target.x = c.x;
        this._state.target.y = c.y;
        this._needsVisRefresh = true;
        this._updateCamera();
        return true;
    }

    onCameraChange(fn) {
        this._onCameraChange = typeof fn === "function" ? fn : null;
        if (this._onCameraChange) this._onCameraChange({ phi: this._state.phi, height: this.getCameraHeight() });
    }

    _updateCamera() {
        const s = this._state;
        // phi 现为用户可控的独立状态（不再随 r 自动推导）；兜底默认值
        if (s.phi == null) s.phi = 0.95;
        const D = s.r * Math.sin(s.phi);
        const cz = s.r * Math.cos(s.phi);
        const cx = s.target.x + D * Math.cos(s.theta);
        const cy = s.target.y + D * Math.sin(s.theta);
        this.camera.position.set(cx, cy, cz);
        // 视线俯仰随 phi 连续变化：phi≤1.0 看地面(俯视森林) → 渐过地平线 → phi→PHI_MAX 抬头仰望天空。
        // 通过抬高 lookAt 的 Z 实现「看向地面之上」，相机本身始终在地面之上。
        const t = Math.min(1, Math.max(0, (s.phi - 1.0) / (PHI_MAX - 1.0)));
        const lookZ = t * (cz + D * Math.tan(0.55));  // t=1 时视线约 +28° 仰望天空
        this.camera.lookAt(s.target.x, s.target.y, lookZ);

        // 树大小 = 视口宽度 × 5%
        const visW = s.r * 0.7;
        const sf = Math.max(0.02, Math.min(1.0, visW * 0.07 / 300));
        for (const m of this.treeMeta) if (m.mesh) m.mesh.scale.set(sf, sf, sf);

        // DOM 标签跟随相机投影
        this._updateLabelPositions();

        // 连续密度可见性（仅缩放时刷新，拖动不变）
        if (this._needsVisRefresh) {
            this._applyVisibility(s.r, sf);
            this._needsVisRefresh = false;
        }
        if (this._onCameraChange) {
            this._onCameraChange({ phi: s.phi, height: this.getCameraHeight() });
        }
    }

    _applyVisibility(r, sf) {
        const maxV = Math.max(12, Math.min(567, Math.floor(567 * (1 - r / 9000))));

        // 每 category 保底数 = 按该类别树量占比 × maxV
        const catPop = new Map();  // catId → total tree count
        for (const m of this.treeMeta) catPop.set(m.catId, (catPop.get(m.catId) || 0) + 1);
        const catQuota = new Map();
        for (const [cid, pop] of catPop)
            catQuota.set(cid, Math.max(1, Math.round(pop / 567 * maxV * 0.8)));
        const catTop = new Map();  // catId → [most important trees, up to quota]
        for (const m of this.treeMeta) {
            const arr = catTop.get(m.catId) || [];
            arr.push(m);
            arr.sort((a, b) => b.importance - a.importance);
            catTop.set(m.catId, arr.slice(0, catQuota.get(m.catId) || 1));
        }

        // 按 importance 降序取候选
        const sorted = [...this.treeMeta].sort((a, b) => b.importance - a.importance);
        const candidates = new Set();
        for (const arr of catTop.values()) for (const m of arr) candidates.add(m.id);
        for (const m of sorted) {
            if (candidates.size >= maxV) break;
            candidates.add(m.id);
        }

        // 屏幕间距过滤（树宽 ≈ 0.05 × 屏宽，间距 = 树宽 × 1.5）
        const rect = this.container.getBoundingClientRect();
        const minDist = rect.width * 0.03;
        const v3 = new THREE.Vector3();
        const inOrder = sorted.filter(m => candidates.has(m.id));
        const visible = new Set();
        for (const m of inOrder) {
            v3.set(m.pos[0], m.pos[1], 0);
            v3.project(this.camera);
            const sx = (v3.x * 0.5 + 0.5) * rect.width;
            const sy = (-v3.y * 0.5 + 0.5) * rect.height;
            let far = true;
            for (const vid of visible) {
                const v = inOrder.find(x => x.id === vid);
                if (!v) continue;
                v3.set(v.pos[0], v.pos[1], 0);
                v3.project(this.camera);
                const vx = (v3.x * 0.5 + 0.5) * rect.width;
                const vy = (-v3.y * 0.5 + 0.5) * rect.height;
                if (Math.hypot(sx - vx, sy - vy) < minDist) { far = false; break; }
            }
            if (far) visible.add(m.id);
        }

        const pathMode = this._learningPathIdSet && this._learningPathIdSet.size > 0;

        // 标签默认不全开：进入簇级近景后，屏幕内可见树的名称全部自动显示。
        // In path mode, path labels carry names and the normal black tree labels stay hidden.
        this._labelsShown = !pathMode && (r < LABEL_ZOOM_R || this._forceFullLabelsForRefresh);
        this._showAllTreeLabels = this._labelsShown;
        this._batchLabelIds = new Set();
        if (this._labelsShown) {
            for (const m of sorted) {
                if (!visible.has(m.id)) continue;
                v3.set(m.pos[0], m.pos[1], 0);
                v3.project(this.camera);
                const sx = (v3.x * 0.5 + 0.5) * rect.width;
                const sy = (-v3.y * 0.5 + 0.5) * rect.height;
                const nearScreen = Number.isFinite(sx) && Number.isFinite(sy)
                    && v3.z >= -1 && v3.z <= 1
                    && sx > -80 && sx < rect.width + 80
                    && sy > -80 && sy < rect.height + 80;
                if (nearScreen) this._batchLabelIds.add(m.id);
            }
        }
        this._forceFullLabelsForRefresh = false;
        this.highGroup.visible = true;
        for (const m of this.treeMeta) {
            const forcePath = pathMode && this._learningPathIdSet.has(m.id);
            const show = visible.has(m.id) || forcePath;
            m.mesh.visible = show;
            if (m.label) {
                const showLabel = !pathMode && show && (m.id === this._hoverId || this._batchLabelIds.has(m.id));
                m.label.style.display = showLabel ? "" : "none";
                m.label.style.visibility = showLabel ? "visible" : "hidden";
                m.label.classList.toggle("is-hovered", m.id === this._hoverId);
            }
        }
        // 立即更新标签位置
        this._updateLabelPositions();
    }

    // 悬停某棵树时单独显示它的标签（远景默认隐藏标签，靠悬停做发现性）
    setHover(id) {
        if (id === this._hoverId) return;
        const pathMode = this._learningPathIdSet && this._learningPathIdSet.size > 0;
        const prev = this._hoverId && this.treeMeta.find(m => m.id === this._hoverId);
        if (prev && prev.label) {
            prev.label.classList.remove("is-hovered");
            if (pathMode || !this._batchLabelIds.has(prev.id)) {
                prev.label.style.display = "none";
                prev.label.style.visibility = "hidden";
            }
        }
        this._hoverId = id || null;
        const cur = id && this.treeMeta.find(m => m.id === id);
        if (!pathMode && cur && cur.label && cur.mesh.visible) {
            cur.label.classList.add("is-hovered");
            cur.label.style.display = "";
            cur.label.style.visibility = "visible";
        }
        this._updateLabelPositions();
    }

    _colorForPt(pt) {
        if (pt.domId) return (this.layout.domains.find(d => d.id === pt.domId) || {}).color || "#888";
        if (pt.catId) return (this.layout.categories.find(c => c.id === pt.catId) || {}).color || "#888";
        const kp = this.data.kpById[pt.id];
        if (kp) {
            const cat = this.data.catById[kp.category_id];
            if (cat) {
                const d = this.layout.domains.find(x => x.id === cat.domain_id);
                if (d) return d.color;
            }
        }
        return "#888";
    }

    _findCatAt(wx, wy) {
        for (const cp of this._catPolygons) {
            let ok = false;
            const p = cp.poly;
            for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
                if ((p[i][1] > wy) !== (p[j][1] > wy) && wx < (p[j][0] - p[i][0]) * (wy - p[i][1]) / (p[j][1] - p[i][1]) + p[i][0]) ok = !ok;
            }
            if (ok) return cp.id;
        }
        return null;
    }

    _pathMetas(ids) {
        const seen = new Set();
        const metas = [];
        for (const id of ids || []) {
            if (seen.has(id)) continue;
            seen.add(id);
            const meta = this.treeMeta.find(m => m.id === id);
            if (meta) metas.push(meta);
        }
        return metas;
    }

    _clearPathLabels() {
        if (!this._pathLabelEls) {
            this._pathLabelEls = [];
            return;
        }
        for (const item of this._pathLabelEls) {
            if (item && item.el) item.el.remove();
        }
        this._pathLabelEls = [];
    }

    _makePathLabel(meta, index, total) {
        const kp = this.data.kpById[meta.id];
        const name = (kp && kp.name_zh) || (meta.label && meta.label.title) || meta.id;
        const el = document.createElement("div");
        el.className = "forest-path-label";
        if (index === 1) el.classList.add("is-start");
        if (index === total) el.classList.add("is-end");
        el.title = `${index}/${total} ${name}`;

        const seq = document.createElement("span");
        seq.className = "forest-path-label-index";
        seq.textContent = String(index).padStart(2, "0");

        const title = document.createElement("span");
        title.className = "forest-path-label-title";
        title.textContent = name;

        el.append(seq, title);
        el.style.visibility = "hidden";
        this._labelLayer.appendChild(el);
        this._pathLabelEls.push({ el, id: meta.id, pos: [meta.pos[0], meta.pos[1]], index: index - 1 });
    }

    _buildLearningPathMarkers(metas) {
        const ringGeo = new THREE.RingGeometry(38, 58, 48);
        const ringMat = new THREE.MeshBasicMaterial({
            color: 0x1f9d72,
            transparent: true,
            opacity: 0.72,
            side: THREE.DoubleSide,
            depthWrite: false,
            depthTest: false,
        });
        metas.forEach((m, i) => {
            const ring = new THREE.Mesh(ringGeo, ringMat.clone());
            if (i === metas.length - 1) ring.material.color.set(0xb45309);
            ring.position.set(m.pos[0], m.pos[1], 9);
            ring.renderOrder = 18;
            this.learningPathGroup.add(ring);

            this._makePathLabel(m, i + 1, metas.length);
        });
    }

    setLearningPath(ids) {
        this._clearGroup(this.learningPathGroup);
        this._clearPathLabels();
        const metas = this._pathMetas(ids);
        this._learningPathIds = metas.map(m => m.id);
        this._learningPathIdSet = new Set(this._learningPathIds);

        if (metas.length >= 2) {
            const points = metas.map(m => new THREE.Vector3(m.pos[0], m.pos[1], 18));
            const routePoints = points.length > 2
                ? new THREE.CatmullRomCurve3(points, false, "catmullrom", 0.18).getPoints(Math.max(64, points.length * 18))
                : points;
            const geo = new THREE.BufferGeometry().setFromPoints(routePoints);
            const mat = new THREE.LineDashedMaterial({
                color: 0x1f9d72,
                dashSize: 86,
                gapSize: 52,
                linewidth: 2,
                transparent: true,
                opacity: 0.9,
                depthWrite: false,
                depthTest: false,
            });
            const line = new THREE.Line(geo, mat);
            line.computeLineDistances();
            line.renderOrder = 16;
            this.learningPathGroup.add(line);
        }

        this._buildLearningPathMarkers(metas);
        this._needsVisRefresh = true;
        this._updateCamera();
    }

    clearLearningPath() {
        this._clearGroup(this.learningPathGroup);
        this._clearPathLabels();
        this._learningPathIds = [];
        this._learningPathIdSet = new Set();
        this._needsVisRefresh = true;
        this._updateCamera();
    }

    focusLearningPath() {
        const metas = this._pathMetas(this._learningPathIds);
        if (!metas.length) return;
        if (metas.length === 1) {
            this.flyTo(metas[0].id);
            return;
        }
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        for (const m of metas) {
            const x = m.pos[0], y = m.pos[1];
            if (x < minX) minX = x; if (x > maxX) maxX = x;
            if (y < minY) minY = y; if (y > maxY) maxY = y;
        }
        const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
        let r = this._frameRadius(Math.max(260, maxX - minX), Math.max(260, maxY - minY), 1.35);
        const maxR = (this._best && this._best.r) || 6000;
        r = Math.max(850, Math.min(maxR, r));
        const c = this._clampTarget(cx, cy);
        this._state.target.x = c.x;
        this._state.target.y = c.y;
        this._state.r = r;
        this._forceFullLabelsForRefresh = true;
        this._needsVisRefresh = true;
        this._updateCamera();
    }

    /* ============ 公共接口 ============ */
    render() {
        // 天空球跟随相机，永远在背景、不被裁剪
        if (this._sky) this._sky.position.copy(this.camera.position);
        // 地面跟随相机 xy（高度不变），使圆盘永远延伸到地平线、不露出边缘（替代雾的天际线方案）
        if (this._ground) this._ground.position.set(this.camera.position.x, this.camera.position.y, -0.5);
        // 云挂在跟随相机的地平线环上，缓慢绕方位角飘动，始终位于地平线上方天空带
        if (this._clouds) {
            this._frame = (this._frame || 0) + 1;
            const cam = this.camera.position;
            for (const s of this._clouds) {
                const az = s.userData.az + this._frame * 0.00004;
                const el = s.userData.el, d = s.userData.dist;
                const ce = Math.cos(el);
                s.position.set(cam.x + Math.cos(az) * ce * d, cam.y + Math.sin(az) * ce * d, cam.z + Math.sin(el) * d);
            }
        }
        this.renderer.render(this.scene, this.camera);
    }
    resize(w, h) {
        this.renderer.setSize(w, h);
        this.camera.aspect = w / h;
        this.camera.updateProjectionMatrix();
        this._updateLabelPositions();
    }

    raycast(sx, sy) {
        this.camera.updateMatrixWorld(); // camera 可能在事件间被 _updateCamera 移动过
        this.highGroup.updateMatrixWorld(); // 树 position/scale 在 _switchLevel / _updateCamera 中被改过
        const rect = this.container.getBoundingClientRect();
        const mx = ((sx - rect.left) / rect.width) * 2 - 1;
        const my = -((sy - rect.top) / rect.height) * 2 + 1;
        const rc = new THREE.Raycaster();
        rc.setFromCamera(new THREE.Vector2(mx, my), this.camera);
        // 先检测 3D 树
        const treeHits = rc.intersectObjects([this.highGroup], true);
        if (treeHits.length > 0) {
            let obj = treeHits[0].object;
            while (obj) { if (obj.userData && obj.userData.type === "tree") return obj.userData.id; obj = obj.parent; }
        }
        // 再检测 level sprites（L3/L4，Sprite 不支持射线，用屏幕距离替代）
        const lv = this.layout.levels[this._currentLevel];
        if (lv && this._currentLevel >= 3) {
            const crx = sx - rect.left, cry = sy - rect.top;
            // 动态阈值：与 _switchLevel 中的 sprite 屏幕尺寸匹配
            const screenH = rect.height || 700;
            const pxPerRad = screenH / (35 * Math.PI / 180);
            const screenPx = Math.max(30, 40 * this._state.r / pxPerRad);
            let best = null, bestD = screenPx;
            const v3 = new THREE.Vector3();
            for (const pt of lv.points) {
                v3.set(pt.pos[0], pt.pos[1], 0);
                v3.project(this.camera);
                const pxx = (v3.x * 0.5 + 0.5) * rect.width;
                const pxy = (-v3.y * 0.5 + 0.5) * rect.height;
                const d = Math.hypot(pxx - crx, pxy - cry);
                if (d < bestD) { bestD = d; best = pt; }
            }
            if (best) {
                // L3 点是 category ID，L4 点是 domain ID — 需转为 KP ID
                if (this._currentLevel === 3) {
                    const kps = this.data.kpsByCat[best.id];
                    if (kps && kps.length > 0) return kps[0].id;
                }
                if (this._currentLevel === 4) {
                    const kps = this.data.kpsByDom[best.id];
                    if (kps && kps.length > 0) return kps[0].id;
                }
                return best.id;
            }
        }
        return null;
    }

    flyTo(kpId) {
        this.setHover(null);
        const meta = this.treeMeta.find(m => m.id === kpId);
        if (meta) {
            let tx, ty;
            if (this._currentLevel >= 3) {
                const lv = this.layout.levels[this._currentLevel];
                let lpt = null;
                if (lv) {
                    const kp = this.data.kpById[kpId];
                    const catId = kp ? kp.category_id : null;
                    const cat = catId ? this.data.catById[catId] : null;
                    const domId = cat ? cat.domain_id : null;
                    if (this._currentLevel === 3 && catId) {
                        lpt = lv.points.find(p => p.catId === catId);
                    } else if (this._currentLevel === 4 && domId) {
                        lpt = lv.points.find(p => p.domId === domId);
                    }
                }
                tx = lpt ? lpt.pos[0] : meta.mesh.position.x;
                ty = lpt ? lpt.pos[1] : meta.mesh.position.y;
            } else {
                tx = meta.mesh.position.x;
                ty = meta.mesh.position.y;
            }
            const c = this._clampTarget(tx, ty);
            this._state.target.x = c.x;
            this._state.target.y = c.y;
            this._state.r = 800;
            this._needsVisRefresh = true;
            this._updateCamera();
            return;
        }
        const cr = this.layout.categories.find(c => c.id === kpId);
        if (cr && cr.label_pos) { const c = this._clampTarget(cr.label_pos[0], cr.label_pos[1]); this._state.target.x = c.x; this._state.target.y = c.y; this._state.r = 2500; this._needsVisRefresh = true; this._updateCamera(); }
    }

    highlightTree(kpId) {
        this._clearGroup(this.highlightGroup);
        const m = this.treeMeta.find(t => t.id === kpId);
        if (!m) return;
        let hx, hy;
        if (this._currentLevel >= 3) {
            const lv = this.layout.levels[this._currentLevel];
            let lpt = null;
            if (lv) {
                const kp = this.data.kpById[kpId];
                const catId = kp ? kp.category_id : null;
                const cat = catId ? this.data.catById[catId] : null;
                const domId = cat ? cat.domain_id : null;
                if (this._currentLevel === 3 && catId) {
                    lpt = lv.points.find(p => p.catId === catId);
                } else if (this._currentLevel === 4 && domId) {
                    lpt = lv.points.find(p => p.domId === domId);
                }
            }
            hx = lpt ? lpt.pos[0] : m.mesh.position.x;
            hy = lpt ? lpt.pos[1] : m.mesh.position.y;
        } else {
            hx = m.mesh.position.x;
            hy = m.mesh.position.y;
        }
        const sf = Math.max(0.02, Math.min(1.0, this._state.r * 0.7 * 0.05 / 300));
        const hl = createTree({ seed: m.seed, scale: m.scale * 300 * sf * 1.15, domainColor: m.domainColor, lod: "high" });
        hl.rotation.x = Math.PI / 2; hl.position.set(hx, hy, 0);
        hl.traverse(c => { if (c.isMesh && c.material.emissive) { c.material.emissive.set(m.domainColor); c.material.emissiveIntensity = 0.4; } });
        this.highlightGroup.add(hl); this.highlightGroup.visible = true;
    }

    unhighlightAll() { this._clearGroup(this.highlightGroup); this.highlightGroup.visible = false; }

    // 由内容包围盒推导：平移限位框 _panBox + 最佳视角 _best（框住整片森林、居中、舒服倾斜）
    _computeBestView() {
        const pts = this.layout.points || [];
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        for (const p of pts) {
            const x = p.pos[0], y = p.pos[1];
            if (x < minX) minX = x; if (x > maxX) maxX = x;
            if (y < minY) minY = y; if (y > maxY) maxY = y;
        }
        if (!isFinite(minX)) { minX = 0; maxX = CANVAS_W; minY = 0; maxY = CANVAS_H; }
        const spanX = maxX - minX, spanY = maxY - minY;
        // 平移限位：内容包围盒外扩 ~15% 边距（随布局自适应，不写死）
        const mx = spanX * 0.15, my = spanY * 0.15;
        this._panBox = { minX: minX - mx, maxX: maxX + mx, minY: minY - my, maxY: maxY + my };
        const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
        // 距离按 FOV 反算，使竖直与水平跨度都框得住，再留边距
        const r = this._frameRadius(spanX, spanY, 1.12);
        // phi 默认自然 3/4 俯视森林、露出一小截天空；用户右键上拖可继续抬头直到仰望天空
        this._best = { theta: -Math.PI / 2, phi: 1.0, r, target: { x: cx, y: cy } };
    }

    // 按相机 FOV + 画面比例反算「恰好框住给定地面跨度」所需距离 r（×factor 留边距）
    _frameRadius(spanX, spanY, factor = 1.05) {
        const fov = this.camera.fov * Math.PI / 180;
        const aspect = this.camera.aspect || 1.4;
        const rY = spanY / (2 * Math.tan(fov / 2));
        const rX = spanX / (2 * Math.tan(fov / 2) * aspect);
        return Math.max(rY, rX) * factor;
    }

    // 跳转到某个知识簇：框住该簇全部知识点的范围（图例 / 下拉用，23 簇都稳定生效）
    flyToCluster(clusterId) {
        this.setHover(null);
        const members = this.treeMeta.filter(m => m.catId === clusterId);
        if (!members.length) {
            // 兜底：用 domain 标签位（适配器为 23 簇都填了 label_pos）
            const cr = this.layout.categories.find(c => c.id === clusterId) || this.layout.domains.find(d => d.id === clusterId);
            const lp = cr && (cr.label_pos);
            if (lp) { const c = this._clampTarget(lp[0], lp[1]); this._state.target.x = c.x; this._state.target.y = c.y; this._state.r = 2500; this._forceFullLabelsForRefresh = true; this._needsVisRefresh = true; this._updateCamera(); }
            return;
        }
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        for (const m of members) {
            const x = m.pos[0], y = m.pos[1];
            if (x < minX) minX = x; if (x > maxX) maxX = x;
            if (y < minY) minY = y; if (y > maxY) maxY = y;
        }
        const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
        // 框住该簇 + 少量上下文边距；夹在 [合理下限, 整片森林距离] 之间，避免过近/过远
        let r = this._frameRadius(maxX - minX, maxY - minY, 1.6);
        const maxR = (this._best && this._best.r) || 6000;
        r = Math.max(900, Math.min(maxR, r));
        const c = this._clampTarget(cx, cy);
        this._state.target.x = c.x;
        this._state.target.y = c.y;
        this._state.r = r;
        // 俯仰/朝向沿用当前视角，保持观感一致（不每次跳转翻转角度）
        this._forceFullLabelsForRefresh = true;
        this._needsVisRefresh = true;
        this._updateCamera();
    }

    _clampTarget(x, y) {
        const b = this._panBox;
        if (!b) return { x, y };
        return { x: Math.max(b.minX, Math.min(b.maxX, x)), y: Math.max(b.minY, Math.min(b.maxY, y)) };
    }

    // 重置 / 初始「最佳视角」：显式设定 theta/phi/r/target 四量，并复位 target（修复旧 bug）
    resetView() {
        const b = this._best || { theta: -Math.PI / 2, phi: 0.9, r: 5000, target: { x: CANVAS_W / 2, y: CANVAS_H / 2 } };
        this._state.theta = b.theta;
        this._state.phi = b.phi;
        this._state.r = b.r;
        const c = this._clampTarget(b.target.x, b.target.y);
        this._state.target.x = c.x;
        this._state.target.y = c.y;
        this._needsVisRefresh = true;
        this._updateCamera();
    }

    _disposeObject(obj) {
        obj.traverse(child => {
            if (child.geometry) child.geometry.dispose();
            const materials = Array.isArray(child.material) ? child.material : (child.material ? [child.material] : []);
            for (const mat of materials) {
                if (mat.map) mat.map.dispose();
                mat.dispose();
            }
        });
    }

    _clearGroup(g) {
        while (g.children.length > 0) {
            const child = g.children[0];
            g.remove(child);
            this._disposeObject(child);
        }
    }
}
