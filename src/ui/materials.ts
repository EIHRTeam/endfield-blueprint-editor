import { buildingCells } from '../core/geometry';
import type { BakePayload, BuildingIndex, Layout, PortKind } from '../core/types';

type MaterialsPayload = Pick<BakePayload, 'lineItems' | 'constructionRecipes' | 'materialItems' | 'products'>;

export interface MaterialTotal {
  id: string;
  name: string;
  count: number;
  badge: string | null;
}

export interface MissingMaterialRecipe {
  id: string;
  name: string;
  count: number;
  unit: '个' | '格';
  reason: string;
}

export interface ConstructionMaterials {
  materials: MaterialTotal[];
  missing: MissingMaterialRecipe[];
  lineCells: Record<PortKind, number>;
}

/** Count unique exposed line cells, matching the devices-and-lines inventory. */
export function countLineCells(layout: Layout, buildings: BuildingIndex): Record<PortKind, number> {
  const occupied = buildingCells(layout, buildings);
  const cells = { item: new Set<string>(), fluid: new Set<string>() };
  for (const line of layout.conveyors) {
    const key = `${line.x},${line.z}`;
    if (!occupied.has(key)) cells[line.kind].add(key);
  }
  return { item: cells.item.size, fluid: cells.fluid.size };
}

/**
 * Sum direct manufacturing ingredients, without assuming ownership or recursively refining ores.
 * Group demand by item before rounding recipe batches, including aliases of the same device item.
 * Missing or ambiguous recipes stay visible instead of silently becoming zero-cost equipment.
 */
export function constructionMaterials(
  layout: Layout,
  buildings: BuildingIndex,
  payload: MaterialsPayload,
): ConstructionMaterials {
  const demand = new Map<string, Omit<MissingMaterialRecipe, 'reason'>>();
  const add = (id: string, name: string, count: number, unit: '个' | '格') => {
    if (!count) return;
    const existing = demand.get(id);
    if (existing) existing.count += count;
    else demand.set(id, { id, name, count, unit });
  };
  for (const node of layout.nodes) {
    const building = buildings[node.templateId]!;
    add(building.itemId || building.id, building.name, 1, '个');
  }
  const lineCells = countLineCells(layout, buildings);
  for (const kind of ['item', 'fluid'] as const) {
    const item = payload.lineItems[kind];
    add(item?.id ?? kind, item?.name ?? (kind === 'item' ? '传送带' : '管道'), lineCells[kind], '格');
  }

  const materials = new Map<string, MaterialTotal>();
  const missing: MissingMaterialRecipe[] = [];
  for (const requirement of demand.values()) {
    const recipe = payload.constructionRecipes?.[requirement.id];
    if (!recipe) {
      missing.push({ ...requirement, reason: recipe === null ? '存在多个配方' : '未提供材料配方' });
      continue;
    }
    if (
      !Number.isSafeInteger(recipe.outputCount) ||
      recipe.outputCount <= 0 ||
      !Array.isArray(recipe.ingredients) ||
      recipe.ingredients.some(item => !item.id || !Number.isSafeInteger(item.count) || item.count <= 0)
    ) {
      missing.push({ ...requirement, reason: '材料配方数据不完整' });
      continue;
    }
    const batches = Math.ceil(requirement.count / recipe.outputCount);
    for (const ingredient of recipe.ingredients) {
      const existing = materials.get(ingredient.id);
      if (existing) existing.count += ingredient.count * batches;
      else {
        const item = payload.materialItems?.[ingredient.id] ?? payload.products[ingredient.id];
        materials.set(ingredient.id, {
          id: ingredient.id,
          name: item?.name || ingredient.id,
          badge: item?.badge ?? null,
          count: ingredient.count * batches,
        });
      }
    }
  }
  return {
    materials: [...materials.values()].sort((a, b) => b.count - a.count || a.id.localeCompare(b.id)),
    missing,
    lineCells,
  };
}

/** Plain-text copy keeps the scope and missing-data caveat attached to the quantities. */
export function materialsText(layout: Layout, buildings: BuildingIndex, payload: MaterialsPayload): string {
  const summary = constructionMaterials(layout, buildings, payload);
  const lines = [
    `${layout.name || '未命名蓝图'} · 建造材料`,
    '按设备直接制造配方汇总，未扣除已有库存。',
    ...summary.materials.map(item => `${item.name} × ${item.count}`),
  ];
  if (!summary.materials.length) lines.push('暂无可汇总的材料。');
  if (summary.lineCells.item || summary.lineCells.fluid) {
    lines.push(`线路需求：传送带 ${summary.lineCells.item} 格，管道 ${summary.lineCells.fluid} 格。`);
  }
  if (summary.missing.length) {
    lines.push('以下项目未计入材料合计：');
    lines.push(...summary.missing.map(item => `${item.name} × ${item.count} ${item.unit}（${item.reason}）`));
  }
  return lines.join('\n');
}
