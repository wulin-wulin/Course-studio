import assert from "node:assert/strict";
import { before, test } from "node:test";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { build } from "esbuild";

let graph;
before(async () => {
  const result = await build({
    entryPoints: [path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/components/course/catalogGraph.ts")],
    bundle: true, platform: "node", format: "esm", target: "node20", write: false,
  });
  graph = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
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
