import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';

export const POST_DEFAULTS = {
  bloomStrength: 0.35,
  bloomRadius: 0.5,
  bloomThreshold: 1.0,
  grain: 0.035,
  vignette: 0.35,
  vignetteSoft: 0.6,
  exposure: 1.0,
};

export const GrainVignetteShader = {
  name: 'GrainVignette',
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uGrain: { value: POST_DEFAULTS.grain },
    uVignette: { value: POST_DEFAULTS.vignette },
    uVignetteSoft: { value: POST_DEFAULTS.vignetteSoft },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform float uTime, uGrain, uVignette, uVignetteSoft;
    varying vec2 vUv;
    float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233)) + uTime) * 43758.5453); }
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      float lum = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
      c.rgb += (hash(gl_FragCoord.xy) - 0.5) * uGrain * (1.0 - 0.7 * lum);
      vec2 q = (vUv - 0.5) * 2.0;
      c.rgb *= 1.0 - smoothstep(uVignetteSoft, 1.4, length(q)) * uVignette;
      gl_FragColor = c;
    }`,
};

export function createPost(renderer, scene, camera) {
  const params = { ...POST_DEFAULTS };
  const size = renderer.getSize(new THREE.Vector2());
  const target = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: 4 });
  const composer = new EffectComposer(renderer, target);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), params.bloomStrength, params.bloomRadius, params.bloomThreshold);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());
  const grain = new ShaderPass(GrainVignetteShader);
  composer.addPass(grain);

  function apply() {
    bloom.strength = params.bloomStrength;
    bloom.radius = params.bloomRadius;
    bloom.threshold = params.bloomThreshold;
    grain.uniforms.uGrain.value = params.grain;
    grain.uniforms.uVignette.value = params.vignette;
    grain.uniforms.uVignetteSoft.value = params.vignetteSoft;
    renderer.toneMappingExposure = params.exposure;
  }
  apply();

  return {
    params, composer, bloom, grain, apply,
    setSize(w, h) { composer.setSize(w, h); },
    render(time) { grain.uniforms.uTime.value = time; composer.render(); },
    dispose() { composer.dispose(); bloom.dispose(); target.dispose(); },
  };
}
