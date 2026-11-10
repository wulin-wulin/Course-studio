import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { before, test } from "node:test";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { build } from "esbuild";

let graph;
let canvasElements;
const testDirectory = path.dirname(fileURLToPath(import.meta.url));
before(async () => {
  const [graphResult, canvasResult] = await Promise.all([
    build({
      entryPoints: [path.resolve(testDirectory, "../src/components/course/catalogGraph.ts")],
      bundle: true, platform: "node", format: "esm", target: "node20", write: false,
    }),
    build({
      entryPoints: [path.resolve(testDirectory, "../src/components/course/courseGroupCanvasElements.ts")],
      bundle: true, platform: "node", format: "esm", target: "node20", write: false,
      loader: { ".png": "dataurl" },
    }),
  ]);
  graph = await import(`data:text/javascript;base64,${Buffer.from(graphResult.outputFiles[0].text).toString("base64")}`);
  canvasElements = await import(`data:text/javascript;base64,${Buffer.from(canvasResult.outputFiles[0].text).toString("base64")}`);
});

test("the case course group has one locked canvas image with the original PNG dimensions", async () => {
  const catalog = JSON.parse(await readFile(path.resolve(testDirectory, "../../../course-data/course-catalog.json"), "utf8"));
  const caseGroup = catalog.groups.find((group) => group.id === canvasElements.CASE_COURSE_GROUP_ID);
  assert.equal(caseGroup?.name, "案例");

  const elements = canvasElements.courseGroupCanvasElements(canvasElements.CASE_COURSE_GROUP_ID);
  assert.equal(elements.length, 1);
  assert.deepEqual(
    { kind: elements[0].kind, x: elements[0].x, y: elements[0].y, width: elements[0].width, height: elements[0].height, locked: elements[0].locked },
    { kind: "image", x: 280, y: 110, width: 821, height: 283, locked: true },
  );
  assert.match(elements[0].src, /^data:image\/png;base64,/);
  assert.deepEqual(canvasElements.courseGroupCanvasElements("another-group"), []);

  const png = await readFile(path.resolve(testDirectory, "../src/assets/course-catalog/teacher-ai-ecosystem.png"));
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(png.readUInt32BE(16), 821);
  assert.equal(png.readUInt32BE(20), 283);
});

test("canvas images only extend bounds and never enter course layout or edges", () => {
  const ids = ["teacher-ai-literacy-training", "placeholder-da8e9ef22a13417b", "placeholder-b541cd49d90249a5"];
  const layout = graph.layoutCourses(ids, []);
  const positionsBefore = [...layout.positions.entries()].map(([id, position]) => [id, { ...position }]);
  const edgesBefore = graph.validEdges(ids, []);
  const elements = canvasElements.courseGroupCanvasElements(canvasElements.CASE_COURSE_GROUP_ID);
  const bounds = canvasElements.extendCanvasBounds(layout, elements);

  assert.deepEqual([...layout.positions.entries()], positionsBefore);
  assert.deepEqual(graph.validEdges(ids, []), edgesBefore);
  assert.equal(layout.positions.has(elements[0].id), false);
  assert.ok(bounds.width >= elements[0].x + elements[0].width + 36);
  assert.ok(bounds.height >= elements[0].y + elements[0].height + 96);
  assert.ok(bounds.width >= layout.width);
  assert.ok(bounds.height >= layout.height);
});

test("narrow canvases keep the image below nodes without shrinking the graph width", () => {
  const ids = ["knowledge", "ability", "questions"];
  for (const availableWidth of [375, 500, 900, 1000, 1100]) {
    const compact = availableWidth < 940;
    const layout = graph.layoutCourses(ids, [], {
      availableWidth,
      compact,
      independentColumns: availableWidth < 500 ? 1 : 2,
    });
    const elements = canvasElements.positionCanvasElements(
      canvasElements.courseGroupCanvasElements(canvasElements.CASE_COURSE_GROUP_ID),
      { availableWidth: layout.width, compact, nodePositions: layout.positions.values() },
    );
    const bounds = canvasElements.extendCanvasBounds(layout, elements);
    const lastNodeY = Math.max(...[...layout.positions.values()].map((position) => position.y));

    assert.ok(elements[0].y > lastNodeY + 24, `${availableWidth}px image should be below every node`);
    assert.ok(elements[0].x >= 0);
    assert.ok(elements[0].x + elements[0].width <= layout.width);
    assert.ok(availableWidth / bounds.width >= 0.95, `${availableWidth}px labels should retain their scale`);
  }
});

test("courses with no explicit edges remain independent in a deterministic grid", () => {
  const ids = ["a", "b", "c", "d"];
  const first = graph.layoutCourses(ids, []);
  const second = graph.layoutCourses(ids, []);
  assert.deepEqual(first, second);
  assert.equal(first.positions.size, ids.length);
  assert.equal(first.positions.get("a").y, first.positions.get("b").y);
  assert.ok(first.positions.get("d").y > first.positions.get("a").y);
  assert.equal(new Set([...first.positions.values()].map(({ x, y }) => `${x},${y}`)).size, ids.length);
  assert.deepEqual(graph.relatedCourses("a", [], "after"), new Set());
});

test("compact layout uses fewer columns without shrinking node labels to a 900px canvas", () => {
  const ids = ["a", "b", "c", "d", "e", "f", "g", "h"];
  const layout = graph.layoutCourses(ids, [], { availableWidth: 560, compact: true, independentColumns: 2 });
  assert.equal(layout.width, 560);
  assert.equal(layout.positions.get("a").y, layout.positions.get("b").y);
  assert.ok(layout.positions.get("c").y > layout.positions.get("a").y);
  assert.ok(Math.max(...[...layout.positions.values()].map(({ x }) => x + 200)) <= 560);
  assert.equal(layout.orientation, "vertical");
});

test("compact relation levels stack vertically and keep every node inside the available width", () => {
  const ids = ["a", "b", "c", "d", "e"];
  const edges = [{ fromId: "a", toId: "b" }, { fromId: "b", toId: "c" }, { fromId: "c", toId: "d" }];
  const layout = graph.layoutCourses(ids, edges, { availableWidth: 560, compact: true, independentColumns: 2 });
  assert.ok(layout.positions.get("b").y > layout.positions.get("a").y);
  assert.ok(layout.positions.get("c").y > layout.positions.get("b").y);
  assert.ok(Math.max(...[...layout.positions.values()].map(({ x }) => x + 200)) <= 560);
});

test("explicit relations determine topological levels, independent courses stay separate", () => {
  const edges = [{ fromId: "a", toId: "c" }, { fromId: "b", toId: "c" }, { fromId: "c", toId: "d" }];
  const layout = graph.layoutCourses(["a", "b", "c", "d", "independent"], edges);
  const point = (id) => layout.positions.get(id);
  assert.equal(point("a").x, point("b").x);
  assert.ok(point("c").x > point("a").x);
  assert.ok(point("d").x > point("c").x);
  assert.ok(point("independent").y > Math.max(...["a", "b", "c", "d"].map((id) => point(id).y)));
  assert.deepEqual(graph.relatedCourses("c", edges, "before"), new Set(["a", "b"]));
  assert.deepEqual(graph.relatedCourses("c", edges, "after"), new Set(["d"]));
});

test("upstream and downstream traversal do not highlight sibling branches", () => {
  const edges = [{ fromId: "a", toId: "b" }, { fromId: "a", toId: "c" }, { fromId: "b", toId: "d" }];
  assert.deepEqual(graph.relatedCourses("b", edges, "before"), new Set(["a"]));
  assert.deepEqual(graph.relatedCourses("b", edges, "after"), new Set(["d"]));
});

test("invalid relations are excluded and cyclic legacy data cannot break rendering", () => {
  const edges = [{ fromId: "a", toId: "b" }, { fromId: "b", toId: "a" }, { fromId: "a", toId: "a" }, { fromId: "a", toId: "missing" }, { fromId: "a", toId: "b" }];
  assert.equal(graph.validEdges(["a", "b"], edges).length, 2);
  const layout = graph.layoutCourses(["a", "b"], edges);
  assert.equal(layout.positions.size, 2);
  assert.deepEqual(graph.relatedCourses("a", edges, "after"), new Set(["b", "missing"]));
});
