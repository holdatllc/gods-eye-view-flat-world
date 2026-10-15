/**
 * Terrain material: physically based shading from three.js plus
 * - a real day/night terminator from each vertex's geocentric up-vector and the true sun direction
 *   (GPS domain), or the configured polar sun of the hypothetical ice domain;
 * - low-roughness glinting water where the elevation sources mark ocean;
 * - an optional distortion overlay (tangential scale factor k of the projection).
 */
import * as THREE from 'three';

export function createTerrainMaterial() {
  const uniforms = {
    uSunEcef: { value: new THREE.Vector3(1, 0, 0) },
    uIceDay: { value: 1 },
    uNightLevel: { value: 0.12 },
    // City-light strength: full from far away, faded close up where the 5 km Black Marble pixels
    // would otherwise smear into blobs.
    uNightLights: { value: 1 },
    uDistortion: { value: 0 },
    uDomainTint: { value: 0 },
    uBoundary: { value: 20003931.4586 },
    uGrid: { value: 0 },
    uGlobalLight: { value: 0 },
    uIceSun: { value: new THREE.Vector3(0.3, 0.8, 0.24) },
    uSunStrength: { value: 3.4 },
    uIceFixedSun: { value: 0 },
  };

  const onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
attribute vec3 aUp;
attribute float aDomain;
attribute float aWater;
varying vec3 vUp;
varying float vDomain;
varying float vWater;
varying vec2 vPlane;
varying vec3 vWorldNormal;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
vUp = aUp;
vDomain = aDomain;
vWater = aWater;
vec4 planeWorld = modelMatrix * vec4(position, 1.0);
vPlane = vec2(planeWorld.x, -planeWorld.z);
vWorldNormal = objectNormal;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
uniform vec3 uSunEcef;
uniform float uIceDay;
uniform float uNightLevel;
uniform float uNightLights;
uniform float uDistortion;
uniform float uDomainTint;
uniform float uBoundary;
uniform float uGrid;
uniform float uGlobalLight;
uniform vec3 uIceSun;
uniform float uSunStrength;
uniform float uIceFixedSun;
varying vec3 vWorldNormal;
varying vec3 vUp;
varying float vDomain;
varying float vWater;
varying vec2 vPlane;`,
      )
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
// The map's alpha carries night-light intensity, not opacity (OPAQUE later forces alpha to 1).
float nightLights = diffuseColor.a;
diffuseColor.a = 1.0;`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
roughnessFactor = mix(roughnessFactor, 0.14, clamp(vWater, 0.0, 1.0));`,
      )
      .replace(
        '#include <opaque_fragment>',
        `#include <opaque_fragment>
{
  vec3 up = normalize(vUp + vec3(1e-6));
  float sunDot = dot(up, uSunEcef);
  float dayGps = smoothstep(-0.105, 0.035, sunDot);
  float iceFixed = clamp(vDomain, 0.0, 1.0) * uIceFixedSun;
  float day = mix(dayGps, uIceDay, iceFixed);
  if (uGlobalLight > 0.001) {
    // Per-fragment sun: the true local sun direction (east/north/up) mapped into the flat frame,
    // where local north is toward the disc centre and east is north rotated clockwise.
    vec3 E = vec3(-up.y, up.x, 0.0);
    E = length(E) < 1e-5 ? vec3(0.0, 1.0, 0.0) : normalize(E);
    vec3 N = cross(up, E);
    vec3 sl = vec3(dot(E, uSunEcef), dot(N, uSunEcef), sunDot);
    sl = mix(sl, uIceSun, iceFixed);
    vec2 n2 = length(vPlane) > 1.0 ? -normalize(vPlane) : vec2(0.0, 1.0);
    vec2 e2 = vec2(n2.y, -n2.x);
    vec3 L = normalize(vec3(e2.x * sl.x + n2.x * sl.y, sl.z, -(e2.y * sl.x + n2.y * sl.y)));
    float lambert = max(dot(normalize(vWorldNormal), L), 0.0);
    vec3 lit = diffuseColor.rgb * (uSunStrength * pow(lambert, 0.5) + 0.35) * day + diffuseColor.rgb * 0.04;
    gl_FragColor.rgb = mix(gl_FragColor.rgb, lit, uGlobalLight);
  }
  // Night side: dim moonlit tint plus real city lights (Black Marble, stored in the map's alpha).
  vec3 night = gl_FragColor.rgb * vec3(0.55, 0.65, 1.0) * uNightLevel;
  // Close up (uNightLights < 1), the ~500 m Black Marble glow is shaped by the daytime imagery so
  // streets and blocks read instead of one flat amber blob, and it stays off open water.
  float closeUp = clamp((1.0 - uNightLights) / 0.8, 0.0, 1.0);
  float luma = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114));
  float shape = mix(1.0, smoothstep(0.1, 0.5, luma) * 1.6, closeUp);
  float lightsOn = pow(nightLights, 2.0) * shape * (1.0 - clamp(vWater, 0.0, 1.0));
  night += vec3(1.0, 0.72, 0.38) * lightsOn * 1.4 * uNightLights;
  gl_FragColor.rgb = mix(night, gl_FragColor.rgb, day);
  gl_FragColor.a = 1.0;
  float r = length(vPlane);
  if (uDistortion > 0.5 && vDomain < 0.5) {
    // Tangential scale factor k = rho / (R cos(lat)) on a sphere, from the plane radius.
    float colat = r / uBoundary * 3.14159265;
    float k = colat / max(sin(colat), 1e-4);
    float t = clamp(log2(k) / 4.0, 0.0, 1.0);
    vec3 ramp = mix(vec3(0.1, 0.8, 0.4), vec3(1.0, 0.85, 0.1), smoothstep(0.0, 0.5, t));
    ramp = mix(ramp, vec3(0.95, 0.15, 0.1), smoothstep(0.5, 1.0, t));
    gl_FragColor.rgb = mix(gl_FragColor.rgb, ramp, 0.45);
  }
  if (uDomainTint > 0.5) {
    gl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(0.55, 0.75, 1.0), 0.25 * vDomain);
  }
}`,
      );
  };

  const cache = new Map();
  return {
    uniforms,
    forTexture(texture) {
      const material = new THREE.MeshStandardMaterial({
        map: texture,
        roughness: 0.92,
        metalness: 0.0,
      });
      material.onBeforeCompile = onBeforeCompile;
      material.customProgramCacheKey = () => 'flatworld-terrain-v1';
      return material;
    },
    cache,
  };
}
