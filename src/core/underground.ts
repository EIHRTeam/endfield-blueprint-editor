/**
 * Underground pipe pairing.
 *
 * A pair is a stable `pipe-<serial>` marker shared by exactly one loader and one unloader. The
 * marker is user-visible metadata only: nothing here simulates fluid flow. Ported from the previous
 * `editor_core.js` with identical behaviour, including the error strings.
 */
import type { BlueprintNode } from './types';

/** 'in' for loaders, 'out' for unloaders, null for anything that cannot be paired. */
export function undergroundRole(node: Pick<BlueprintNode, 'templateId'>): 'in' | 'out' | null {
  return /^udpipe_loader_[12]$/.test(node.templateId)
    ? 'in'
    : /^udpipe_unloader_[12]$/.test(node.templateId)
      ? 'out'
      : null;
}

/** The node paired with `node`, or null. */
export function undergroundPeer<T extends BlueprintNode>(nodes: T[], node: T): T | null {
  return node.undergroundPair
    ? (nodes.find(candidate => candidate !== node && candidate.undergroundPair === node.undergroundPair) ?? null)
    : null;
}

/** Clears the pairing marker on both sides of `node`'s pair. */
export function unpair(nodes: BlueprintNode[], node: BlueprintNode): void {
  if (node.undergroundPair) {
    for (const candidate of nodes) {
      if (candidate.undergroundPair === node.undergroundPair && candidate !== node) delete candidate.undergroundPair;
    }
  }
  delete node.undergroundPair;
}

/**
 * Pairs `nodes[index]` with `nodes[peerIndex]`, or unpairs it when `peerIndex` is -1.
 *
 * Throws when the selected device is not a loader/unloader, or when both ends have the same role.
 */
export function pairUnderground(nodes: BlueprintNode[], index: number, peerIndex: number): void {
  const node = nodes[index];
  const peer = nodes[peerIndex];
  if (!node || !undergroundRole(node)) throw Error('请选择暗管入口或出口');
  if (peerIndex !== -1 && (!peer || !undergroundRole(peer) || undergroundRole(node) === undergroundRole(peer))) {
    throw Error('暗管需要配对一个入口和一个出口');
  }
  unpair(nodes, node);
  if (peerIndex === -1) return;
  unpair(nodes, peer!);
  let serial = 1;
  while (nodes.some(candidate => candidate.undergroundPair === `pipe-${serial}`)) serial++;
  node.undergroundPair = `pipe-${serial}`;
  peer!.undergroundPair = `pipe-${serial}`;
}

/** Removes a node, clearing any pairing first so the peer is not left dangling. */
export function removeNode(nodes: BlueprintNode[], index: number): void {
  const node = nodes[index];
  if (node) unpair(nodes, node);
  nodes.splice(index, 1);
}
