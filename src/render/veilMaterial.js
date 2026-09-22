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
    // live projection (active only with the VEIL_PROJECTION define)
    uProjMap0: { value: null },
    uProjMap1: { value: null },
    uProjDepth0: { value: null },
    uProjDepth1: { value: null },
    uProjDepthLive: { value: null },
    uProjMat0: { value: new THREE.Matrix4() },
    uProjMat1: { value: new THREE.Matrix4() },
    uProjHas0: { value: 0 },
    uProjHas1: { value: 0 },
    uProjMix: { value: 0 },
    uProjLive: { value: 0 },
    uProjPower: { value: 1.3 },
    uProjCatch: { value: 0.55 },
    uProjBias: { value: 0.035 },
    uProjTexel: { value: 1 / 512 },
    uProjSoft: { value: 1.5 },
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
      .replace('#include <common>', /* glsl */`#include <common>
        attribute float aDensity;
        varying float vDensity;
        #ifdef VEIL_PROJECTION
          attribute vec3 aCap0;
          attribute vec3 aCap1;
          uniform mat4 uProjMat0;
          uniform mat4 uProjMat1;
          uniform float uProjLive;
          varying vec4 vProj0;
          varying vec4 vProj1;
        #endif`)
      .replace('#include <begin_vertex>', /* glsl */`#include <begin_vertex>
        vDensity = aDensity;
        #ifdef VEIL_PROJECTION
          // woven: the image stays on the fabric point it was generated for (capture position)
          // physical projector: the image stays in projector space (current position)
          vec3 veilWorldNow = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
          vProj0 = uProjMat0 * vec4( mix( aCap0, veilWorldNow, uProjLive ), 1.0 );
          vProj1 = uProjMat1 * vec4( mix( aCap1, veilWorldNow, uProjLive ), 1.0 );
        #endif`);

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
        vec3 veilBacklight = vec3( 0.0 );
        #ifdef VEIL_PROJECTION
          varying vec4 vProj0;
          varying vec4 vProj1;
          uniform sampler2D uProjMap0;
          uniform sampler2D uProjMap1;
          uniform sampler2D uProjDepth0;
          uniform sampler2D uProjDepth1;
          uniform sampler2D uProjDepthLive;
          uniform float uProjHas0;
          uniform float uProjHas1;
          uniform float uProjMix;
          uniform float uProjLive;
          uniform float uProjPower;
          uniform float uProjCatch;
          uniform float uProjBias;
          uniform float uProjTexel;
          uniform float uProjSoft;
          vec3 veilProjectSample( vec4 clipPos, sampler2D map, sampler2D slotDepth ) {
            if ( clipPos.w <= 0.0 ) return vec3( 0.0 );
            vec2 uv = clipPos.xy / clipPos.w * 0.5 + 0.5;
            if ( uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0 ) return vec3( 0.0 );
            // occlusion: only the fold nearest to the projector receives light.
            // 3x3 percentage-closer filter, so fold shadows do not step along
            // the projector's pixel grid.
            float step = uProjTexel * uProjSoft;
            float visible = 0.0;
            for ( int j = -1; j <= 1; j ++ ) {
              for ( int i = -1; i <= 1; i ++ ) {
                vec2 offset = uv + vec2( float( i ), float( j ) ) * step;
                float stored = mix( texture2D( slotDepth, offset ).r, texture2D( uProjDepthLive, offset ).r, uProjLive );
                visible += 1.0 - smoothstep( uProjBias, uProjBias * 4.0, clipPos.w - stored );
              }
            }
            visible /= 9.0;
            return texture2D( map, uv ).rgb * visible;
          }
        #endif`)
      .replace('#include <map_fragment>', /* glsl */`#ifdef VEIL_WHITE
        diffuseColor.rgb = vec3( 1.0 );
        #else
        #include <map_fragment>
        #endif`)
      .replace('#include <lights_fragment_begin>', lightsBegin)
      .replace('#include <opaque_fragment>', /* glsl */`
        float veilNdotV = abs( dot( geometryNormal, geometryViewDir ) );
        float veilFresnel = pow( 1.0 - veilNdotV, uFresnelPower );
        diffuseColor.a = mix( diffuseColor.a, 1.0, veilFresnel * uFresnelAlpha );
        diffuseColor.a = saturate( diffuseColor.a * ( 1.0 + uDensityGain * vDensity ) );
        vec3 veilGlow = veilBacklight * uBacklightColor * uBacklightStrength * diffuseColor.rgb;
        vec3 veilProjected = vec3( 0.0 );
        #ifdef VEIL_PROJECTION
          vec3 veilP0 = uProjHas0 > 0.5 ? veilProjectSample( vProj0, uProjMap0, uProjDepth0 ) : vec3( 0.0 );
          vec3 veilP1 = uProjHas1 > 0.5 ? veilProjectSample( vProj1, uProjMap1, uProjDepth1 ) : vec3( 0.0 );
          veilProjected = mix( veilP0, veilP1, uProjMix ) * uProjPower;
        #endif
        #include <opaque_fragment>`)
      .replace('#include <premultiplied_alpha_fragment>', /* glsl */`
        #include <premultiplied_alpha_fragment>
        gl_FragColor.rgb += veilGlow * 0.5;
        #ifdef VEIL_PROJECTION
          #ifdef VEIL_PROJECTION_ONLY
            // the final image is the diffusion result alone, floating in the studio
            // (halved: the sheet is double sided, so front and back both emit).
            // Until a frame arrives, the lit veil stays, so an offline service
            // never leaves an invisible sheet.
            float veilHasImage = max( uProjHas0, uProjHas1 );
            gl_FragColor = mix( gl_FragColor, vec4( veilProjected * 0.6, 0.0 ), veilHasImage );
          #else
            // projected light scatters in the fabric: sheer areas catch less, folds catch it all
            gl_FragColor.rgb += veilProjected * mix( uProjCatch, 1.0, diffuseColor.a );
          #endif
        #endif`);
  };
  material.customProgramCacheKey = () =>
    `venus-veil-v4${Object.keys(material.defines || {}).sort().join('-')}`;
  material.userData.uniforms = uniforms;
  material.userData.defaults = d;
  material.userData.weave = weave || null;
  return material;
}
