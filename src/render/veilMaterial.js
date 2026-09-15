import * as THREE from 'three';

/**
 * Translucent organza-like material built on MeshPhysicalMaterial with three
 * shader injections:
 *   (a) fresnel-driven opacity — grazing folds go opaque and glow
 *   (b) thin-sheet back-light — light hitting the far side bleeds through
 *   (c) fold density (from the solver) — stacked cloth is more opaque
 *
 * Shader anchors verified against three r182 and r186.
 */

const RE_DIRECT_CALL =
  'RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );';

export const VEIL_DEFAULTS = {
  color: '#e2ded6',
  opacity: 0.16,
  roughness: 0.5,
  sheen: 1.0,
  sheenRoughness: 0.6,
  sheenColor: '#fff6ea',
  ior: 1.5,
  specularIntensity: 0.7,
  iridescence: 0.12,
  envMapIntensity: 0.5,
  fresnelPower: 2.2,
  fresnelAlpha: 1.0,
  densityGain: 2.5,
  backlightStrength: 0.6,
  backlightWrap: 0.5,
  backlightForward: 0.6,
  backlightSharpness: 6,
  densityOcclusion: 0.7,
  weaveStrength: 0.35,
};

/** Deterministic tileable weave: normal map (RGB) + thread alpha (G of a second texture). */
export function createWeaveTextures(size = 512) {
  const normalData = new Uint8Array(size * size * 4);
  const alphaData = new Uint8Array(size * size * 4);
  const height = (x, y) => {
    const warp = Math.sin(x * Math.PI / 2) * 0.28;
    const weft = Math.sin(y * Math.PI / 2) * 0.22;
    const slub = Math.sin(y * Math.PI / 24 + Math.sin(x * Math.PI / 96) * 0.7) * 0.12;
    const grain = Math.sin(x * 0.37 + y * 0.91) * Math.sin(x * 0.11 - y * 0.23) * 0.08;
    return warp + weft + slub + grain;
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const dx = (height(x + 1, y) - height(x - 1, y)) * 0.8;
      const dy = (height(x, y + 1) - height(x, y - 1)) * 0.8;
      const len = Math.hypot(dx, dy, 1);
      normalData[i] = (0.5 - dx / len * 0.5) * 255;
      normalData[i + 1] = (0.5 - dy / len * 0.5) * 255;
      normalData[i + 2] = (0.5 + 1 / len * 0.5) * 255;
      normalData[i + 3] = 255;
      // gauze: warp threads run along the length (x); weft is fainter and finer
      const yy = y + 2.5 * Math.sin(x * Math.PI / 64) + 1.2 * Math.sin(x * Math.PI / 23);
      const warp = Math.pow(Math.abs(Math.sin(yy * Math.PI / 16)), 0.45);
      const weft = Math.pow(Math.abs(Math.sin(x * Math.PI / 8)), 0.6);
      const thread = 0.55 + 0.45 * Math.max(warp, 0.55 * weft);
      const a = Math.round(thread * 255);
      alphaData[i] = a; alphaData[i + 1] = a; alphaData[i + 2] = a; alphaData[i + 3] = 255;
    }
  }
  const make = (data, repeat, colorSpace) => {
    const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(repeat[0], repeat[1]);
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = true;
    tex.anisotropy = 8;
    if (colorSpace) tex.colorSpace = colorSpace;
    tex.needsUpdate = true;
    return tex;
  };
  return { normal: make(normalData, [12, 4.8]), alpha: make(alphaData, [4, 2]) };
}

export function createVeilMaterial(weave, overrides = {}) {
  const d = { ...VEIL_DEFAULTS, ...overrides };
  const uniforms = {
    uFresnelPower: { value: d.fresnelPower },
    uFresnelAlpha: { value: d.fresnelAlpha },
    uDensityGain: { value: d.densityGain },
    uBacklightColor: { value: new THREE.Color(1.0, 0.93, 0.85) },
    uBacklightStrength: { value: d.backlightStrength },
    uBacklightWrap: { value: d.backlightWrap },
    uBacklightForward: { value: d.backlightForward },
    uBacklightSharpness: { value: d.backlightSharpness },
    uDensityOcclusion: { value: d.densityOcclusion },
  };

  const material = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(d.color),
    roughness: d.roughness,
    metalness: 0,
    ior: d.ior,
    specularIntensity: d.specularIntensity,
    sheen: d.sheen,
    sheenRoughness: d.sheenRoughness,
    sheenColor: new THREE.Color(d.sheenColor),
    iridescence: d.iridescence,
    iridescenceIOR: 1.3,
    clearcoat: 0,
    transmission: 0,
    envMapIntensity: d.envMapIntensity,
    transparent: true,
    opacity: d.opacity,
    side: THREE.DoubleSide,
    depthWrite: false,
    premultipliedAlpha: true,
    normalMap: weave?.normal || null,
    normalScale: new THREE.Vector2(d.weaveStrength, d.weaveStrength),
    alphaMap: weave?.alpha || null,
  });

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aDensity;\nvarying float vDensity;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvDensity = aDensity;');

    const lightsBegin = THREE.ShaderChunk.lights_fragment_begin.replaceAll(RE_DIRECT_CALL, RE_DIRECT_CALL + /* glsl */`
      {
        float backNL = dot( - geometryNormal, directLight.direction );
        float wrapNL = saturate( ( backNL + uBacklightWrap ) / ( 1.0 + uBacklightWrap ) );
        float fwd = pow( saturate( dot( - geometryViewDir, directLight.direction ) ), uBacklightSharpness );
        float lobe = mix( wrapNL, wrapNL * fwd, uBacklightForward );
        veilBacklight += directLight.color * lobe * ( 1.0 - uDensityOcclusion * vDensity );
      }`);

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', /* glsl */`#include <common>
        varying float vDensity;
        uniform float uFresnelPower;
        uniform float uFresnelAlpha;
        uniform float uDensityGain;
        uniform vec3 uBacklightColor;
        uniform float uBacklightStrength;
        uniform float uBacklightWrap;
        uniform float uBacklightForward;
        uniform float uBacklightSharpness;
        uniform float uDensityOcclusion;
        vec3 veilBacklight = vec3( 0.0 );`)
      .replace('#include <lights_fragment_begin>', lightsBegin)
      .replace('#include <opaque_fragment>', /* glsl */`
        float veilNdotV = abs( dot( geometryNormal, geometryViewDir ) );
        float veilFresnel = pow( 1.0 - veilNdotV, uFresnelPower );
        diffuseColor.a = mix( diffuseColor.a, 1.0, veilFresnel * uFresnelAlpha );
        diffuseColor.a = saturate( diffuseColor.a * ( 1.0 + uDensityGain * vDensity ) );
        vec3 veilGlow = veilBacklight * uBacklightColor * uBacklightStrength * diffuseColor.rgb;
        #include <opaque_fragment>`)
      .replace('#include <premultiplied_alpha_fragment>', /* glsl */`
        #include <premultiplied_alpha_fragment>
        gl_FragColor.rgb += veilGlow * 0.5;`);
  };
  material.customProgramCacheKey = () => 'venus-veil-v1';
  material.userData.uniforms = uniforms;
  material.userData.defaults = d;
  material.userData.weave = weave || null;
  return material;
}
