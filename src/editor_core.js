/* Pure layout operations shared by the offline editor and regression checks. */
(function (root) {
  'use strict';
  const DV = [[1, 0], [0, 1], [-1, 0], [0, -1]];
  const CORNER = {0: {3: [1, 180], 1: [2, 270]}, 1: {0: [1, 90], 2: [2, 180]},
    2: {1: [1, 0], 3: [2, 90]}, 3: {2: [1, 270], 0: [2, 0]}};
  const clone = value => JSON.parse(JSON.stringify(value));
  const key = (x, z) => `${x},${z}`;
  const beltKey = b => `${b.kind}:${b.x},${b.z}`;
  const undergroundRole = n => /^udpipe_loader_[12]$/.test(n.templateId) ? 'in' : /^udpipe_unloader_[12]$/.test(n.templateId) ? 'out' : null;
  function undergroundPeer(nodes, node) {
    return node.undergroundPair ? nodes.find(n => n !== node && n.undergroundPair === node.undergroundPair) : null;
  }
  function unpair(nodes, node) {
    if (node.undergroundPair) for (const n of nodes) if (n.undergroundPair === node.undergroundPair && n !== node) delete n.undergroundPair;
    delete node.undergroundPair;
  }
  function pairUnderground(nodes, index, peerIndex) {
    const n = nodes[index], peer = nodes[peerIndex];
    if (!n || !undergroundRole(n)) throw Error('请选择暗管入口或出口');
    if (peerIndex !== -1 && (!peer || !undergroundRole(peer) || undergroundRole(n) === undergroundRole(peer))) throw Error('暗管需要配对一个入口和一个出口');
    unpair(nodes, n);
    if (peerIndex === -1) return;
    unpair(nodes, peer);
    let serial = 1;
    while (nodes.some(n => n.undergroundPair === `pipe-${serial}`)) serial++;
    n.undergroundPair = peer.undergroundPair = `pipe-${serial}`;
  }
  function removeNode(nodes, index) { unpair(nodes, nodes[index]); nodes.splice(index, 1); }
  function dims(building, direction = 0) {
    return direction % 2 ? {w: building.d, d: building.w} : {w: building.w, d: building.d};
  }
  function footprint(node, buildings) {
    return {...node.position, ...dims(buildings[node.templateId], node.direction)};
  }
  function hit(nodes, buildings, x, z) {
    return nodes.findIndex(n => { const f = footprint(n, buildings);
      return x >= f.x && z >= f.z && x < f.x + f.w && z < f.z + f.d; });
  }
  function placementError(data, buildings, node, ignore = -1) {
    const f = footprint(node, buildings);
    if (f.x < 0 || f.z < 0 || f.x + f.w > data.size.x || f.z + f.d > data.size.z) return '超出蓝图边界';
    for (let i = 0; i < data.nodes.length; i++) {
      if (i === ignore) continue;
      const q = footprint(data.nodes[i], buildings);
      if (f.x < q.x + q.w && f.x + f.w > q.x && f.z < q.z + q.d && f.z + f.d > q.z) return '与其他设备重叠';
    }
    // Existing routes are preserved when moving a device; topology is the user's layout.
    return '';
  }
  function bounds(data, buildings, margin = 1) {
    let x0 = data.size.x, z0 = data.size.z, x1 = 0, z1 = 0;
    for (const node of data.nodes) {
      const f = footprint(node, buildings);
      x0 = Math.min(x0, f.x); z0 = Math.min(z0, f.z);
      x1 = Math.max(x1, f.x + f.w); z1 = Math.max(z1, f.z + f.d);
    }
    for (const b of data.conveyors) {
      x0 = Math.min(x0, b.x); z0 = Math.min(z0, b.z); x1 = Math.max(x1, b.x + 1); z1 = Math.max(z1, b.z + 1);
    }
    if (!data.nodes.length && !data.conveyors.length) return {x0: 0, z0: 0, x1: data.size.x, z1: data.size.z};
    return {x0: Math.max(0, x0 - margin), z0: Math.max(0, z0 - margin),
      x1: Math.min(data.size.x, x1 + margin), z1: Math.min(data.size.z, z1 + margin)};
  }
  function validate(input, buildings) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('蓝图必须是 JSON 对象');
    if (input.schemaVersion != null && input.schemaVersion !== 2) throw Error('不支持此蓝图文件版本');
    const data = clone(input);
    data.name = data.name == null ? '未命名蓝图' : data.name;
    if (typeof data.name !== 'string' || data.name.length > 120) throw Error('蓝图名称格式不正确');
    if (data.presentation != null) {
      const p = data.presentation;
      if (typeof p !== 'object' || Array.isArray(p)) throw Error('蓝图详情格式不正确');
      for (const [field, limit] of [['creatorId', 40], ['description', 400], ['coverId', 160]])
        if (p[field] != null && (typeof p[field] !== 'string' || p[field].length > limit)) throw Error('蓝图详情文字过长或格式不正确');
      if (p.tags != null && (!Array.isArray(p.tags) || p.tags.length > 6 || p.tags.some(t => typeof t !== 'string' || !t.trim() || t.length > 16)))
        throw Error('最多 6 个标签，每个标签 1–16 个字符');
      if (p.coverColor != null && !['blue', 'cyan', 'yellow', 'green', 'purple', 'orange', 'gray'].includes(p.coverColor)) throw Error('未知的封面底色');
      if (p.showChangeHints != null && typeof p.showChangeHints !== 'boolean') throw Error('图标角标开关无效');
      if (p.connectionPair != null && (typeof p.connectionPair !== 'string' || p.connectionPair.length > 120)) throw Error('暗管连接示意标记无效');
      if (p.viewport != null) {
        const v = p.viewport;
        if (typeof v !== 'object' || Array.isArray(v) || !Number.isFinite(v.zoom) || v.zoom < 1 || v.zoom > 4 ||
            !Number.isFinite(v.x) || v.x < 0 || v.x > 1 || !Number.isFinite(v.y) || v.y < 0 || v.y > 1) throw Error('预览取景参数无效');
      }
    }
    if (data.size === undefined) data.size = {x: 50, z: 50};
    if (!data.size || typeof data.size !== 'object' || Array.isArray(data.size)) throw Error('蓝图尺寸格式不正确');
    for (const axis of ['x', 'z']) if (!Number.isInteger(data.size[axis]) || data.size[axis] < 1 || data.size[axis] > 50)
      throw Error('蓝图宽、高必须为 1–50 格');
    if (data.nodes === undefined) data.nodes = [];
    if (data.conveyors === undefined) data.conveyors = [];
    if (!Array.isArray(data.nodes) || !Array.isArray(data.conveyors)) throw Error('nodes / conveyors 必须为数组');
    if (data.nodes.length > 160) throw Error('设备数量不能超过 160');
    if (data.conveyors.length > data.size.x * data.size.z * 2) throw Error('线路数量超过网格容量');
    for (const [i, n] of data.nodes.entries()) {
      if (!n || typeof n.templateId !== 'string' || !Object.hasOwn(buildings, n.templateId)) throw Error(`第 ${i + 1} 个设备 ID 未知：${n?.templateId}`);
      if (!n.position || !Number.isInteger(n.position.x) || !Number.isInteger(n.position.z)) throw Error(`第 ${i + 1} 个设备坐标必须是整数`);
      n.direction = n.direction ?? 0;
      if (!Number.isInteger(n.direction) || n.direction < 0 || n.direction > 3) throw Error(`第 ${i + 1} 个设备朝向必须为 0–3`);
      if (n.productIcon != null && typeof n.productIcon !== 'string') throw Error('产物图标必须是字符串或 null');
      if (n.formulaMode != null && typeof n.formulaMode !== 'string') throw Error('配方模式格式不正确');
      if (n.environmentEffect != null && !['', 'acid', 'humidity', 'inactive', 'stable', 'xiranite'].includes(n.environmentEffect)) throw Error('未知的环境生效标记');
      if (n.itemStatus != null && !['normal', 'locked', 'limited', 'expired'].includes(n.itemStatus)) throw Error('未知的物品状态标记');
      if (n.itemStatusColor != null && (typeof n.itemStatusColor !== 'string' || !/^#[0-9a-f]{6}$/i.test(n.itemStatusColor))) throw Error('物品状态颜色格式不正确');
      if (n.closedPorts != null && (!Array.isArray(n.closedPorts) || n.closedPorts.length > (buildings[n.templateId].ports || []).length ||
          n.closedPorts.some(id => !(buildings[n.templateId].ports || []).some(p => p.id === id)))) throw Error('接口显示标记无效');
      if (n.closedPorts?.length && buildings[n.templateId].editablePorts === false) throw Error('该设备不支持逐个隐藏接口');
      const error = placementError(data, buildings, n, i);
      if (error) throw Error(`第 ${i + 1} 个设备${error}`);
    }
    const occupied = new Set();
    const pairs = new Map();
    for (const n of data.nodes) if (n.undergroundPair != null) {
      if (!undergroundRole(n) || typeof n.undergroundPair !== 'string' || !n.undergroundPair.length || n.undergroundPair.length > 120) throw Error('暗管配对标记无效');
      if (!pairs.has(n.undergroundPair)) pairs.set(n.undergroundPair, []);
      pairs.get(n.undergroundPair).push(n);
    }
    for (const nodes of pairs.values()) if (nodes.length !== 2 || undergroundRole(nodes[0]) === undergroundRole(nodes[1])) throw Error('暗管配对必须恰好包含一个入口和一个出口');
    for (const [i, b] of data.conveyors.entries()) {
      if (!b || !Number.isInteger(b.x) || !Number.isInteger(b.z) || b.x < 0 || b.z < 0 || b.x >= data.size.x || b.z >= data.size.z)
        throw Error(`第 ${i + 1} 段线路越界或坐标无效`);
      b.kind = b.kind || 'item';
      if (!['item', 'fluid'].includes(b.kind)) throw Error(`尚无已核实的线路素材：${b.kind}`);
      for (const field of ['dir', 'fromDir']) if ((field === 'dir' || b[field] != null) &&
          (!Number.isInteger(b[field]) || b[field] < 0 || b[field] > 3)) throw Error('线路方向必须为 0–3');
      if (b.fromDir != null && (b.fromDir + 2) % 4 === b.dir) throw Error('单格线路不能原地掉头');
      if (occupied.has(beltKey(b))) throw Error('同一格有重复的同类线路');
      occupied.add(beltKey(b));
    }
    data.schemaVersion = 2;
    return data;
  }
  function route(start, end, kind, verticalFirst = false, defaultDir = 0) {
    const points = [{x: start.x, z: start.z}];
    let {x, z} = start;
    const walk = axis => {
      while ((axis === 'x' ? x : z) !== end[axis]) {
        if (axis === 'x') x += Math.sign(end.x - x); else z += Math.sign(end.z - z);
        points.push({x, z});
      }
    };
    (verticalFirst ? ['z', 'x'] : ['x', 'z']).forEach(walk);
    const direction = (a, b) => b.x > a.x ? 0 : b.x < a.x ? 2 : b.z > a.z ? 1 : 3;
    return points.map((p, i) => ({...p, kind,
      dir: i + 1 < points.length ? direction(p, points[i + 1]) : i ? direction(points[i - 1], p) : defaultDir,
      ...(i ? {fromDir: direction(points[i - 1], p)} : {})}));
  }
  function worldPorts(node, buildings) {
    const b = buildings[node.templateId], f = footprint(node, buildings);
    return (b.ports || []).filter(p => !(p.pipe && node.formulaMode === 'normal') && !node.closedPorts?.includes(p.id)).map(p => {
      let x = p.x, z = p.z, dir = p.dir, w = b.w, d = b.d;
      for (let i = 0; i < node.direction; i++) { [x, z] = [d - 1 - z, x]; [w, d] = [d, w]; dir = (dir + 1) % 4; }
      x += f.x; z += f.z;
      // Ports sit on the footprint edge, even when the source transform is inset.
      if (dir === 0) x = f.x + f.w - 1;
      if (dir === 2) x = f.x;
      if (dir === 1) z = f.z + f.d - 1;
      if (dir === 3) z = f.z;
      const [dx, dz] = DV[dir];
      return {...p, x, z, dir, edgeX: x + .5 + dx * .5, edgeZ: z + .5 + dz * .5,
        outX: x + dx, outZ: z + dz};
    });
  }
  function buildingCells(layout, buildings) {
    const occupied = new Set();
    for (const n of layout.nodes) {
      if (buildings[n.templateId].logistic) continue;
      const f = footprint(n, buildings);
      for (let z = f.z; z < f.z + f.d; z++) for (let x = f.x; x < f.x + f.w; x++) occupied.add(key(x, z));
    }
    return occupied;
  }
  function routeEndpoint(layout, buildings, point, kind, start) {
    const index = hit(layout.nodes, buildings, point.x, point.z);
    const inside = index >= 0 && !buildings[layout.nodes[index].templateId].logistic;
    const candidates = [];
    for (const [i, n] of layout.nodes.entries()) {
      if (buildings[n.templateId].logistic || inside && i !== index) continue;
      for (const p of worldPorts(n, buildings)) {
        if (p.pipe !== (kind === 'fluid')) continue;
        if (!inside && (p.outX !== point.x || p.outZ !== point.z)) continue;
        const distance = Math.hypot((point.gx ?? point.x + .5) - p.edgeX, (point.gz ?? point.z + .5) - p.edgeZ);
        candidates.push({...p, score: distance + (p.input === start ? .05 : 0), nodeIndex: i});
      }
    }
    candidates.sort((a, b) => a.score - b.score);
    if (inside && !candidates.length) throw Error(`该设备没有可见的${kind === 'fluid' ? '流体' : '物品'}接口`);
    const port = candidates[0];
    return port ? {x: port.outX, z: port.outZ, port} : {x: point.x, z: point.z};
  }
  function connectedRoute(layout, buildings, start, end, kind, verticalFirst = false, defaultDir = 0) {
    const a = routeEndpoint(layout, buildings, start, kind, true), b = routeEndpoint(layout, buildings, end, kind, false);
    const occupied = buildingCells(layout, buildings);
    const free = p => p.x >= 0 && p.z >= 0 && p.x < layout.size.x && p.z < layout.size.z && !occupied.has(key(p.x, p.z));
    if (!free(a) || !free(b)) throw Error('接口外侧没有可用格，请移动设备或从其他接口铺线');
    const existing = layout.conveyors.find(c => c.kind === kind && c.x === b.x && c.z === b.z);
    const endDir = b.port ? (b.port.dir + 2) % 4 : existing?.dir;
    const startDir = a.port?.dir;
    function decorate(path) {
      if (startDir != null) path[0].fromDir = startDir;
      if (endDir != null) path[path.length - 1].dir = endDir;
      return path;
    }
    const valid = path => path.every(p => free(p) && (p.fromDir == null || (p.fromDir + 2) % 4 !== p.dir));
    for (const vFirst of [verticalFirst, !verticalFirst]) {
      const path = decorate(route(a, b, kind, vFirst, defaultDir));
      if (valid(path)) return {path, start: a, end: b};
    }
    // Shortest grid path around device footprints; no production or admission simulation.
    const queue = [{x: a.x, z: a.z, dir: startDir, parent: -1}], seen = new Set([key(a.x, a.z)]);
    const priority = verticalFirst ? [1, 3, 0, 2] : [0, 2, 1, 3];
    for (let head = 0; head < queue.length; head++) {
      const current = queue[head];
      if (current.x === b.x && current.z === b.z) {
        const points = []; let i = head;
        while (i >= 0) { points.push(queue[i]); i = queue[i].parent; } points.reverse();
        const path = points.map((p, j) => ({x: p.x, z: p.z, kind,
          dir: points[j + 1]?.dir ?? endDir ?? p.dir ?? defaultDir, ...(j ? {fromDir: p.dir} : {})}));
        decorate(path);
        if (!valid(path)) throw Error('请从接口拖向另一格，单格线路不能掉头');
        return {path, start: a, end: b};
      }
      const directions = [...new Set([current.dir, ...priority])].filter(d => d != null);
      for (const dir of directions) {
        if (head === 0 && startDir != null && dir === (startDir + 2) % 4) continue;
        const p = {x: current.x + DV[dir][0], z: current.z + DV[dir][1]};
        if (!free(p) || seen.has(key(p.x, p.z))) continue;
        if (p.x === b.x && p.z === b.z && endDir != null && (dir + 2) % 4 === endDir) continue;
        seen.add(key(p.x, p.z)); queue.push({...p, dir, parent: head});
      }
    }
    throw Error('设备之间没有可铺设的路径，请调整端点');
  }
  function mergeRoutes(existing, addition) {
    const keys = new Set(addition.map(beltKey));
    const next = clone(addition), previous = existing.find(b => beltKey(b) === beltKey(next[0] || {}));
    if (previous?.fromDir != null && next[0]?.fromDir == null && (previous.fromDir + 2) % 4 !== next[0].dir) next[0].fromDir = previous.fromDir;
    return existing.filter(b => !keys.has(beltKey(b))).concat(next);
  }
  function conveyorSprites(belts) {
    const incoming = new Map();
    for (const b of belts) {
      const v = DV[b.dir], k = `${b.kind}:${b.x + v[0]},${b.z + v[1]}`;
      if (!incoming.has(k)) incoming.set(k, []);
      incoming.get(k).push(b.dir);
    }
    return belts.map(b => {
      const choices = incoming.get(beltKey(b)) || [];
      const from = b.fromDir ?? (choices.length === 1 ? choices[0] : b.dir);
      const start = (from + 1) % 4, end = (b.dir + 1) % 4;
      const type = b.kind === 'fluid' ? 'pipe' : 'belt';
      if (start === end || !CORNER[start]?.[end]) return {...b, sprite: `icon_${type}_grid`, angle: end * 90 - 90};
      const [variant, rotation] = CORNER[start][end];
      return {...b, sprite: `icon_${type}_corner_${variant}`, angle: -rotation};
    });
  }
  class History {
    constructor(limit = 100) { this.limit = limit; this.past = []; this.future = []; }
    commit(before, after) {
      const a = JSON.stringify(before), b = JSON.stringify(after);
      if (a === b) return false;
      this.past.push(a); if (this.past.length > this.limit) this.past.shift(); this.future = []; return true;
    }
    undo(current) { if (!this.past.length) return current; this.future.push(JSON.stringify(current)); return JSON.parse(this.past.pop()); }
    redo(current) { if (!this.future.length) return current; this.past.push(JSON.stringify(current)); return JSON.parse(this.future.pop()); }
  }
  const api = {DV, clone, key, beltKey, dims, footprint, hit, placementError, bounds, validate, route, mergeRoutes, conveyorSprites, History,
    undergroundRole, undergroundPeer, pairUnderground, removeNode, worldPorts, buildingCells, routeEndpoint, connectedRoute};
  if (typeof module !== 'undefined') module.exports = api;
  root.BlueprintCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
