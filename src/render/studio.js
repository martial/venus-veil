import * as THREE from 'three';
import { Reflector } from 'three/addons/objects/Reflector.js';

/**
 * The dark studio: one hard key spotlight low in front, a cool rim, a
 * softbox-built environment for the sheen, a raymarched volumetric beam,
 * and a two-layer polished floor (mirror + additive lit pool).
 */

const NOISE_GLSL = /* glsl */`
  float hash3(vec3 p) {
    p = fract(p * 0.3183099 + vec3(0.11, 0.17, 0.23));
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
  }
  float noise3(vec3 p) {
    vec3 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(mix(hash3(i), hash3(i + vec3(1,0,0)), f.x), mix(hash3(i + vec3(0,1,0)), hash3(i + vec3(1,1,0)), f.x), f.y),
      mix(mix(hash3(i + vec3(0,0,1)), hash3(i + vec3(1,0,1)), f.x), mix(hash3(i + vec3(0,1,1)), hash3(i + vec3(1,1,1)), f.x), f.y),
      f.z);
  }
`;

export const STUDIO_DEFAULTS = {
  keyIntensity: 60,
  keyColor: '#fff1dc',
  keyAngle: 0.34,
  keyPenumbra: 0.7,
  rimIntensity: 25,
  beamIntensity: 0.18,
  hazeIntensity: 0.35,
  environmentIntensity: 0.25,
  fogDensity: 0.035,
  mirrorStrength: 0.55,
  mirrorBlur: 2.5,
  poolIntensity: 1,
  beamSteps: 32,          // raymarch samples through the light cone
  mirrorInterval: 1,      // re-render the floor reflection every n frames
  mirrorScale: 1,         // reflection resolution factor
};

function createSoftboxEnvironment(renderer) {
  const studio = new THREE.Scene();
  studio.background = new THREE.Color('#0b1116');
  const softbox = (position, scale, color, intensity) => {
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({
      color: new THREE.Color(color).multiplyScalar(intensity), side: THREE.DoubleSide,
    }));
    mesh.position.set(...position); mesh.scale.set(scale[0], scale[1], 1); mesh.lookAt(0, 0, 0); studio.add(mesh);
  };
  softbox([-4, 2, 3], [0.6, 7], '#fff0dc', 9);      // tall warm strip, key side
  softbox([3, 4, -2], [6, 0.38], '#d2e9ff', 13);    // cool top rim bar
  softbox([2, -1, 4], [0.25, 5], '#f4efee', 4);
  softbox([-2, -3, -1], [1.6, 1.6], '#ffe9d0', 12); // warm bounce from the floor lamp
  softbox([0, 5, 2], [5, 1.4], '#9db2c5', 1.5);
  const pmrem = new THREE.PMREMGenerator(renderer);
  const env = pmrem.fromScene(studio, 0.04, 0.1, 30);
  pmrem.dispose();
  studio.traverse(o => { o.geometry?.dispose(); o.material?.dispose(); });
  return env;
}

function createBeam(key) {
  const box = { min: new THREE.Vector3(-6, -0.05, -5), max: new THREE.Vector3(6, 6.5, 4) };
  const material = new THREE.ShaderMaterial({
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: false,
    side: THREE.BackSide,
    forceSinglePass: true,
    defines: { BEAM_STEPS: String(STUDIO_DEFAULTS.beamSteps) },
    uniforms: {
      uTime: { value: 0 },
      uIntensity: { value: STUDIO_DEFAULTS.beamIntensity },
      uHaze: { value: STUDIO_DEFAULTS.hazeIntensity },
      uColor: { value: new THREE.Color(STUDIO_DEFAULTS.keyColor) },
      uOrigin: { value: new THREE.Vector3() },
      uDir: { value: new THREE.Vector3(0, 1, 0) },
      uTanAngle: { value: Math.tan(STUDIO_DEFAULTS.keyAngle) },
      uBoxMin: { value: box.min },
      uBoxMax: { value: box.max },
    },
    vertexShader: /* glsl */`
      varying vec3 vWorld;
      void main() {
        vec4 w = modelMatrix * vec4(position, 1.0);
        vWorld = w.xyz;
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: /* glsl */`
      precision highp float;
      varying vec3 vWorld;
      uniform float uTime, uIntensity, uHaze, uTanAngle;
      uniform vec3 uColor, uOrigin, uDir, uBoxMin, uBoxMax;
      ${NOISE_GLSL}
      void main() {
        vec3 ro = cameraPosition;
        vec3 rd = normalize(vWorld - ro);
        vec3 t0 = (uBoxMin - ro) / rd, t1 = (uBoxMax - ro) / rd;
        vec3 tmin = min(t0, t1), tmax = max(t0, t1);
        float nearT = max(0.0, max(tmin.x, max(tmin.y, tmin.z)));
        float farT = min(tmax.x, min(tmax.y, tmax.z));
        if (farT <= nearT) discard;
        const int STEPS = BEAM_STEPS;
        float stepSize = (farT - nearT) / float(STEPS);
        float jitter = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
        float light = 0.0, haze = 0.0;
        for (int i = 0; i < STEPS; i++) {
          vec3 p = ro + rd * (nearT + (float(i) + jitter) * stepSize);
          vec3 rel = p - uOrigin;
          float h = dot(rel, uDir);
          if (h > 0.0) {
            float radial = length(rel - uDir * h);
            float radius = 0.04 + h * uTanAngle;
            float q = radial / radius;
            if (q < 1.0) {
              float n = noise3(p * 2.1 + vec3(uTime * 0.10, -uTime * 0.14, uTime * 0.06));
              float density = (0.7 + n * 0.6) * (1.0 - smoothstep(0.25, 1.0, q));
              light += density * stepSize / (0.25 + h * h * 0.22);
            }
          }
          if ((i & 1) == 0) {
            float n2 = noise3(p * 0.7 + vec3(uTime * 0.02, -uTime * 0.027, 0.0));
            haze += n2 * stepSize * 2.0 * exp(-length(p - uOrigin) * 0.35);
          }
        }
        vec3 color = uColor * (light * uIntensity + haze * uHaze * 0.02);
        gl_FragColor = vec4(color, 1.0);
      }`,
  });
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material);
  mesh.position.copy(box.min).add(box.max).multiplyScalar(0.5);
  mesh.scale.copy(box.max).sub(box.min);
  mesh.frustumCulled = false;
  mesh.renderOrder = 3;
  const dir = new THREE.Vector3();
  return {
    mesh,
    update(time) {
      material.uniforms.uTime.value = time;
      material.uniforms.uOrigin.value.copy(key.position);
      dir.copy(key.target.position).sub(key.position).normalize();
      material.uniforms.uDir.value.copy(dir);
      material.uniforms.uTanAngle.value = Math.tan(key.angle);
      material.uniforms.uColor.value.copy(key.color);
    },
    material,
  };
}

function createMirrorFloor(renderer) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const reflectionSize = Math.round(768 * dpr * STUDIO_DEFAULTS.mirrorScale);
  const mirror = new Reflector(new THREE.PlaneGeometry(40, 40), {
    textureWidth: reflectionSize,
    textureHeight: reflectionSize,
    color: 0xffffff,
    clipBias: 0.003,
    multisample: 0,
    shader: {
      name: 'VenusMirror',
      uniforms: {
        color: { value: null },
        tDiffuse: { value: null },
        textureMatrix: { value: null },
        uStrength: { value: STUDIO_DEFAULTS.mirrorStrength },
        uBlur: { value: STUDIO_DEFAULTS.mirrorBlur },
        uTexel: { value: new THREE.Vector2(1 / 1024, 1 / 1024) },
      },
      vertexShader: /* glsl */`
        uniform mat4 textureMatrix;
        varying vec4 vUv;
        varying vec3 vWorld;
        #include <common>
        #include <logdepthbuf_pars_vertex>
        void main() {
          vUv = textureMatrix * vec4(position, 1.0);
          vec4 w = modelMatrix * vec4(position, 1.0);
          vWorld = w.xyz;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          #include <logdepthbuf_vertex>
        }`,
      fragmentShader: /* glsl */`
        uniform vec3 color;
        uniform sampler2D tDiffuse;
        uniform float uStrength, uBlur;
        uniform vec2 uTexel;
        varying vec4 vUv;
        varying vec3 vWorld;
        #include <logdepthbuf_pars_fragment>
        void main() {
          #include <logdepthbuf_fragment>
          vec2 uv = vUv.xy / vUv.w;
          vec3 acc = vec3(0.0);
          float w = 0.0;
          // 9-tap blur, weighted, in screen space of the reflection target
          for (int y = -1; y <= 1; y++) {
            for (int x = -1; x <= 1; x++) {
              vec2 o = vec2(float(x), float(y)) * uTexel * uBlur;
              float k = (x == 0 && y == 0) ? 2.0 : 1.0;
              acc += texture2D(tDiffuse, uv + o).rgb * k;
              w += k;
            }
          }
          vec3 base = acc / w;
          vec3 V = normalize(cameraPosition - vWorld);
          float grazing = pow(1.0 - max(dot(V, vec3(0.0, 1.0, 0.0)), 0.0), 3.0);
          float strength = uStrength * mix(0.3, 1.0, grazing);
          gl_FragColor = vec4(base * color * strength, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    },
  });
  mirror.rotation.x = -Math.PI / 2;
  mirror.position.y = 0;
  mirror.renderOrder = -1;
  mirror.material.uniforms.uTexel.value.set(1 / reflectionSize, 1 / reflectionSize);

  // additive lit layer: spotlight pool + veil shadow on top of the mirror
  const pool = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), new THREE.MeshPhysicalMaterial({
    color: 0x1a1a1c,
    roughness: 0.6,
    metalness: 0,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    envMapIntensity: 0,
  }));
  pool.rotation.x = -Math.PI / 2;
  pool.position.y = 0.002;
  pool.receiveShadow = true;
  pool.renderOrder = 0;
  return { mirror, pool };
}

export function createStudio(scene, renderer, camera) {
  const params = { ...STUDIO_DEFAULTS };

  scene.background = new THREE.Color('#030304');
  scene.fog = new THREE.FogExp2('#040405', params.fogDensity);

  const env = createSoftboxEnvironment(renderer);
  scene.environment = env.texture;
  scene.environmentIntensity = params.environmentIntensity;

  const key = new THREE.SpotLight(new THREE.Color(params.keyColor), params.keyIntensity, 0, params.keyAngle, params.keyPenumbra, 2);
  key.position.set(-2.2, 0.12, 4.0);
  key.target.position.set(0.4, 1.7, -0.3);
  key.castShadow = true;
  key.shadow.mapSize.set(1536, 1536);
  key.shadow.camera.near = 0.5;
  key.shadow.camera.far = 14;
  key.shadow.bias = -0.0004;
  key.shadow.normalBias = 0.015;
  key.shadow.intensity = 0.6;
  scene.add(key, key.target);

  const rim = new THREE.SpotLight(new THREE.Color('#cfd8ff'), params.rimIntensity, 0, 0.6, 0.8, 2);
  rim.position.set(2.5, 4.5, -3.5);
  rim.target.position.set(0, 1.4, 0);
  scene.add(rim, rim.target);

  scene.add(new THREE.HemisphereLight('#3a4a5a', '#050608', 0.12));

  // lamp glow sprite
  const glowCanvas = document.createElement('canvas');
  glowCanvas.width = glowCanvas.height = 128;
  const ctx = glowCanvas.getContext('2d');
  const grad = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.08, 'rgba(255,244,225,1)');
  grad.addColorStop(0.3, 'rgba(255,220,180,0.35)');
  grad.addColorStop(1, 'rgba(255,200,150,0)');
  ctx.fillStyle = grad; ctx.fillRect(0, 0, 128, 128);
  const glowTexture = new THREE.CanvasTexture(glowCanvas);
  glowTexture.colorSpace = THREE.SRGBColorSpace;
  const glow = new THREE.Sprite(new THREE.SpriteMaterial({
    map: glowTexture, color: '#ffe9c8', blending: THREE.AdditiveBlending, depthWrite: false, transparent: true,
  }));
  glow.position.copy(key.position);
  glow.scale.setScalar(0.7);
  glow.renderOrder = 4;
  scene.add(glow);

  const beam = createBeam(key);
  scene.add(beam.mesh);

  const { mirror, pool } = createMirrorFloor(renderer);
  scene.add(mirror, pool);
  // the beam and glow must not appear in the reflection
  const originalOnBeforeRender = mirror.onBeforeRender;
  let mirrorTick = 0;
  mirror.onBeforeRender = function (...args) {
    // the reflection is blurred, so refreshing it every n frames is invisible
    if (params.mirrorInterval > 1 && mirrorTick++ % params.mirrorInterval !== 0) return;
    beam.mesh.visible = false; glow.visible = false;
    originalOnBeforeRender.apply(this, args);
    beam.mesh.visible = true; glow.visible = true;
  };

  function apply() {
    key.intensity = params.keyIntensity;
    key.color.set(params.keyColor);
    key.angle = params.keyAngle;
    key.penumbra = params.keyPenumbra;
    rim.intensity = params.rimIntensity;
    beam.material.uniforms.uIntensity.value = params.beamIntensity;
    beam.material.uniforms.uHaze.value = params.hazeIntensity;
    scene.environmentIntensity = params.environmentIntensity;
    scene.fog.density = params.fogDensity;
    if (beam.material.defines.BEAM_STEPS !== String(params.beamSteps)) {
      beam.material.defines.BEAM_STEPS = String(params.beamSteps);
      beam.material.needsUpdate = true;
    }
    mirror.material.uniforms.uStrength.value = params.mirrorStrength;
    mirror.material.uniforms.uBlur.value = params.mirrorBlur;
    pool.material.color.setScalar(0.1 * params.poolIntensity);
    glow.material.opacity = Math.min(1, params.keyIntensity / 60);
  }
  apply();

  return {
    params, key, rim, beam, mirror, pool, glow, apply,
    update(time) { beam.update(time); },
    dispose() { env.dispose(); glowTexture.dispose(); mirror.dispose(); beam.material.dispose(); },
  };
}
