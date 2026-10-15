/**
 * Instanced trees for the buildings layer: one shared low-poly tree (trunk + crown, 32 triangles)
 * drawn once per tile with per-instance position, height, crown radius, tint and ground.
 *
 * The vertex shader places each instance itself (no instance matrices):
 *   x = lx + px · crown,  y = aGround + py · height · uExaggeration,  z = −ly + pz · crown
 * where (px, py, pz) is the unit tree (y in 0..1, x/z in −1..1), so trees stand on the rendered
 * terrain and scale with the relief exaggeration exactly like the buildings.
 */
import * as THREE from 'three';

/** Unit tree: a brown hexagonal trunk and a green icosahedral crown, with vertex colours. */
export function createUnitTree() {
  const trunk = new THREE.CylinderGeometry(0.12, 0.16, 0.4, 6, 1, true);
  trunk.translate(0, 0.2, 0);
  const crown = new THREE.IcosahedronGeometry(1, 0);
  crown.scale(1, 0.42, 1);
  crown.translate(0, 0.6, 0);
  const parts = [
    [trunk.index ? trunk.toNonIndexed() : trunk, [0.36, 0.27, 0.19]],
    [crown.index ? crown.toNonIndexed() : crown, [0.22, 0.38, 0.17]],
  ];
  const position = [];
  const normal = [];
  const color = [];
  for (const [g, c] of parts) {
    g.computeVertexNormals();
    position.push(...g.attributes.position.array);
    normal.push(...g.attributes.normal.array);
    for (let i = 0; i < g.attributes.position.count; i += 1) color.push(...c);
    g.dispose();
  }
  trunk.dispose();
  crown.dispose();
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(position, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normal, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(color, 3));
  return geo;
}

const PLACE = `
  transformed = vec3(
    aTree.x + position.x * aTree.w,
    aGround + position.y * aTree.z * uExaggeration,
    -aTree.y + position.z * aTree.w
  );`;

function treeShader(material, uniforms, key, tint) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uExaggeration = uniforms.uExaggeration;
    let vs = shader.vertexShader.replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>${PLACE}`,
    );
    if (tint)
      vs = vs.replace(
        '#include <color_vertex>',
        '#include <color_vertex>\n  if (position.y > 0.35) vColor.rgb *= aTreeTint * 1.25;',
      );
    shader.vertexShader = `attribute vec4 aTree;\nattribute float aGround;\n${tint ? 'attribute vec3 aTreeTint;\n' : ''}uniform float uExaggeration;\n${vs}`;
  };
  material.customProgramCacheKey = () => key;
  return material;
}

export function createTreeMaterials(uniforms) {
  return {
    color: treeShader(
      new THREE.MeshStandardMaterial({
        vertexColors: true,
        roughness: 0.92,
        metalness: 0,
        flatShading: true,
      }),
      uniforms,
      'flatworld-trees',
      true,
    ),
    depth: treeShader(
      new THREE.MeshDepthMaterial(),
      uniforms,
      'flatworld-trees-depth',
      false,
    ),
  };
}

/**
 * One tile's trees as an instanced mesh. `data` is [lx, ly, height, crown] per tree (display
 * metres, tile-local), `tint` RGB bytes. Ground heights are filled later (re-base).
 */
export function createTreeMesh(unit, materials, { data, tint, count }) {
  const geo = new THREE.InstancedBufferGeometry();
  geo.index = unit.index;
  for (const name of ['position', 'normal', 'color'])
    geo.setAttribute(name, unit.attributes[name]);
  geo.setAttribute('aTree', new THREE.InstancedBufferAttribute(data, 4));
  geo.setAttribute(
    'aTreeTint',
    new THREE.InstancedBufferAttribute(tint, 3, true),
  );
  const ground = new THREE.InstancedBufferAttribute(new Float32Array(count), 1);
  ground.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('aGround', ground);
  geo.instanceCount = count;
  const mesh = new THREE.Mesh(geo, materials.color);
  mesh.customDepthMaterial = materials.depth;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return { mesh, ground };
}
