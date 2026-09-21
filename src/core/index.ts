/**
 * Public surface of the blueprint core.
 *
 * This barrel keeps the previous `BlueprintCore` API shape intact: the Node-side regression suite
 * and the Playwright browser suite both drive these exact entry points.
 */
export * from './types';
export {
  DV,
  CORNER,
  clone,
  key,
  beltKey,
  dims,
  footprint,
  hit,
  placementError,
  bounds,
  buildingCells,
  route,
  conveyorSprites,
  History,
} from './geometry';
export { undergroundRole, undergroundPeer, pairUnderground, unpair, removeNode } from './underground';
export { validate, MAX_NODES, MAX_SIZE } from './validate';
export { worldPorts, routeEndpoint, connectedRoute, mergeRoutes } from './routing';
