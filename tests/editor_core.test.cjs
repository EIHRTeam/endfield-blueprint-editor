const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const C = require('../src/editor_core.js');
const kit = path.resolve(__dirname, '..');
const table = JSON.parse(fs.readFileSync(path.join(kit, 'data/tables/FactoryBuildingTable.json'), 'utf8'));
const buildings = Object.fromEntries(Object.entries(table).map(([id, b]) => [id, {w: b.range.width, d: b.range.depth}]));
const spriteIndex = JSON.parse(fs.readFileSync(path.join(kit, 'assets/blueprint_source/index.json'), 'utf8'));
for (const key of Object.keys(spriteIndex)) if (key.startsWith('blueprint/bg_logistic_')) buildings[key.slice('blueprint/bg_logistic_'.length)] = {w: 1, d: 1};
const tests = [];
function test(name, run) { run(); tests.push(name); }
const layout = () => ({name: 'fixture', size: {x: 32, z: 28}, nodes: [], conveyors: []});
const node = (x = 12, z = 9, direction = 1) => ({templateId: 'udpipe_loader_2', position: {x, z}, direction});
test('rotated rectangular export bounds use 5 by 3 cells', () => {
  const d = layout(); d.nodes.push(node());
  assert.deepEqual(C.bounds(d, buildings, 0), {x0: 12, z0: 9, x1: 17, z1: 12});
});
test('out-of-bounds rotation is rejected', () => {
  const d = layout(); d.nodes.push(node(28, 10, 0)); C.validate(d, buildings);
  d.nodes[0].direction = 1; assert.throws(() => C.validate(d, buildings), /边界/);
});
test('overlap rejected, touching footprints accepted', () => {
  const d = layout(); d.nodes.push(node(3, 3, 0), node(6, 3, 0)); C.validate(d, buildings);
  d.nodes[1].position.x = 5; assert.throws(() => C.validate(d, buildings), /重叠/);
});
test('import is non-mutating and preserves gas IDs and extra fields', () => {
  const d = layout(); d.nodes.push({...node(), productIcon: '[gas]Acid', custom: {source: 7}});
  d.custom = {nested: true}; const before = JSON.stringify(d); const result = C.validate(d, buildings);
  assert.equal(JSON.stringify(d), before); assert.equal(result.nodes[0].productIcon, '[gas]Acid');
  assert.deepEqual(result.nodes[0].custom, {source: 7}); assert.deepEqual(result.custom, {nested: true});
});
test('invalid IDs, fractional coordinates and directions are rejected', () => {
  for (const patch of [{templateId: '__proto__'}, {direction: -1}, {direction: 4}, {position: {x: 1.1, z: 2}}]) {
    const d = layout(); d.nodes.push({...node(), ...patch}); assert.throws(() => C.validate(d, buildings));
  }
});
test('malformed collection fields cannot silently clear a document', () => {
  for (const nodes of [null, false, '', {}]) assert.throws(() => C.validate({...layout(), nodes}, buildings));
});
test('route includes both endpoints and tracks the elbow direction', () => {
  const r = C.route({x: 1, z: 1}, {x: 4, z: 4}, 'item'); assert.equal(r.length, 7);
  assert.deepEqual(r[0], {x: 1, z: 1, kind: 'item', dir: 0});
  assert.deepEqual(r[3], {x: 4, z: 1, kind: 'item', dir: 1, fromDir: 0});
  assert.deepEqual(r[6], {x: 4, z: 4, kind: 'item', dir: 1, fromDir: 1});
  const v = C.route({x: 1, z: 1}, {x: 4, z: 4}, 'item', true); assert.deepEqual([v[3].x, v[3].z], [1, 4]);
});
test('pipe and belt can cross without overwriting each other', () => {
  const a = {x: 3, z: 3, kind: 'item', dir: 0}, b = {...a, kind: 'fluid', dir: 1};
  const merged = C.mergeRoutes([a], [b]); assert.equal(merged.length, 2);
  assert.equal(C.mergeRoutes(merged, [{...a, dir: 2}]).length, 2);
  const d = layout(); d.conveyors = merged; C.validate(d, buildings);
});
test('original Lua corner mapping is respected', () => {
  const b = C.conveyorSprites([{x: 0, z: 0, dir: 1, fromDir: 0, kind: 'fluid'}])[0];
  assert.equal(b.sprite, 'icon_pipe_corner_2'); assert.equal(b.angle, -180);
  const inferred = C.conveyorSprites([{x: 0, z: 0, dir: 0, kind: 'item'}, {x: 1, z: 0, dir: 1, kind: 'item'}]);
  assert.equal(inferred[1].sprite, 'icon_belt_corner_2');
});
test('duplicate same-layer routes and U-turns are rejected', () => {
  const d = layout(); const b = {x: 1, z: 1, dir: 0, kind: 'item'};
  d.conveyors = [b, {...b}]; assert.throws(() => C.validate(d, buildings), /重复/);
  d.conveyors = [{...b, fromDir: 2}]; assert.throws(() => C.validate(d, buildings), /掉头/);
});
test('undo/redo restores names, product badges and grid size together', () => {
  const h = new C.History(), before = layout(), after = {...layout(), name: 'changed', size: {x: 30, z: 20}, nodes: [{...node(), productIcon: 'item_iron_nugget'}]};
  h.commit(before, after); const restored = h.undo(after); assert.deepEqual(restored, before);
  assert.deepEqual(h.redo(restored), after); h.undo(after); h.commit(before, {...before, name: 'branch'}); assert.equal(h.future.length, 0);
});
test('bundled demo validates against actual game footprints', () => {
  const demo = JSON.parse(fs.readFileSync(path.join(kit, 'examples/demo_blueprint.json'), 'utf8'));
  assert.equal(C.validate(demo, buildings).nodes.length, 11);
});
test('underground pair validation rejects dangling, duplicate, and same-role endpoints', () => {
  const d = layout(); d.nodes = [node(1, 1, 0), {...node(12, 1, 0), templateId: 'udpipe_unloader_2'}];
  C.pairUnderground(d.nodes, 0, 1); C.validate(d, buildings);
  assert.equal(C.undergroundPeer(d.nodes, d.nodes[0]), d.nodes[1]);
  for (const bad of [
    {...d, nodes: [d.nodes[0]]},
    {...d, nodes: [d.nodes[0], {...d.nodes[1], templateId: d.nodes[0].templateId}]},
    {...d, nodes: [...d.nodes, {...d.nodes[1], position: {x: 20, z: 1}}]},
  ]) assert.throws(() => C.validate(bad, buildings), /配对/);
});
test('re-pairing and deletion clear the former endpoint; undo restores both endpoints', () => {
  const d = layout(); d.nodes = [node(1, 1, 0), {...node(12, 1, 0), templateId: 'udpipe_unloader_2'}, {...node(20, 1, 0), templateId: 'udpipe_unloader_1'}];
  C.pairUnderground(d.nodes, 0, 1); C.pairUnderground(d.nodes, 0, 2);
  assert.equal(d.nodes[1].undergroundPair, undefined); C.validate(d, buildings);
  const before = C.clone(d), h = new C.History(); C.removeNode(d.nodes, 2); C.validate(d, buildings);
  assert.equal(d.nodes[0].undergroundPair, undefined); h.commit(before, d);
  assert.deepEqual(h.undo(d), before);
});
const portBuildings = {machine: {w: 6, d: 4, ports: [
  {x: 0, z: 0, dir: 3, input: true, pipe: false},
  {x: 5, z: 3, dir: 1, input: false, pipe: false},
  {x: 5, z: 1, dir: 0, input: true, pipe: true}
]}};
test('rectangular ports rotate with the footprint on all four faces', () => {
  const n = {templateId: 'machine', position: {x: 10, z: 10}, direction: 0};
  const expected = [[10, 9, 3], [14, 10, 0], [15, 14, 1], [9, 15, 2]];
  for (let d = 0; d < 4; d++) {
    n.direction = d; const p = C.worldPorts(n, portBuildings)[0];
    assert.deepEqual([p.outX, p.outZ, p.dir], expected[d]);
  }
});
test('drawing into a machine snaps to its outside input cell and preserves inward arrows', () => {
  const d = layout(); d.nodes = [{templateId: 'machine', position: {x: 10, z: 10}, direction: 0}];
  const result = C.connectedRoute(d, portBuildings, {x: 10, z: 5}, {x: 10, z: 10}, 'item');
  assert.deepEqual(result.path.at(-1), {x: 10, z: 9, kind: 'item', dir: 1, fromDir: 1});
  assert(result.path.every(p => !C.buildingCells(d, portBuildings).has(C.key(p.x, p.z))));
  assert.equal(result.end.port.input, true);
});
test('routing detours around occupied device cells and respects fluid port type', () => {
  const d = layout(); d.nodes = [{templateId: 'machine', position: {x: 10, z: 10}, direction: 0}];
  const route = C.connectedRoute(d, portBuildings, {x: 7, z: 11}, {x: 18, z: 11}, 'item');
  const occupied = C.buildingCells(d, portBuildings);
  assert(route.path.length > 12); assert(route.path.every(p => !occupied.has(C.key(p.x, p.z))));
  const fluid = C.routeEndpoint(d, portBuildings, {x: 15, z: 11}, 'fluid', false);
  assert.deepEqual([fluid.x, fluid.z, fluid.port.pipe], [16, 11, true]);
  d.nodes[0].formulaMode = 'normal'; assert.throws(() => C.routeEndpoint(d, portBuildings, {x: 15, z: 11}, 'fluid', false), /流体/);
});
test('continuing an existing elbow retains its incoming direction', () => {
  const existing = [{x: 3, z: 3, kind: 'item', dir: 0, fromDir: 1}];
  const next = C.mergeRoutes(existing, C.route({x: 3, z: 3}, {x: 5, z: 3}, 'item'));
  assert.equal(next[0].fromDir, 1); assert.equal(C.conveyorSprites(next)[0].sprite, 'icon_belt_corner_1');
});
console.log(JSON.stringify({passed: tests.length, tests}, null, 2));
