// Prints meshes, triangle counts and bounds of processed GLBs.
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
import { getBounds } from '@gltf-transform/functions';
await MeshoptDecoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
for (const f of process.argv.slice(2)) {
  const doc = await io.read(f);
  const root = doc.getRoot();
  let tris = 0;
  for (const m of root.listMeshes()) for (const p of m.listPrimitives()) tris += (p.getIndices()?.getCount() ?? p.getAttribute('POSITION').getCount()) / 3;
  const nodes = root.listNodes().filter((n) => n.getMesh()).map((n) => {
    const b = getBounds(n);
    const s = b.max.map((v, i) => (v - b.min[i]).toFixed(2)).join('x');
    return `${n.getName()}[${s}]`;
  });
  console.log(`${f.split('/').pop()}: ${Math.round(tris)} tris, materials ${root.listMaterials().map((m) => m.getName()).join(',')}`);
  console.log('   ', nodes.join('  '));
}
