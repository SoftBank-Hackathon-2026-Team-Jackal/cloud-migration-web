'use client'

import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { useT } from '../lib/i18n'

type Props = {
  morphToSphere: boolean; analysisMode: boolean
  voiceLevel: { current: number }; voiceActive: { current: boolean }
  /** 사용자가 말하는 크기(0~1)와 '듣는 중' 여부 */
  micLevel?: { current: number }; listenMode?: { current: boolean }
  onStart: () => void; onSphereFormed: () => void
}

const RINGS = 220
const EQUATOR_DOTS = 470
const RADIUS = 2.8
const FOV = 43
const CAMERA_Z = 11
/** 동시에 퍼질 수 있는 음절 파문 수 */
const RINGS_MAX = 6

/** 시연장 화면에 맞춰 반응 세기를 주소로 조절한다: ?fx=1.5 (0.3~3, 기본 1) */
function readFx() {
  if (typeof window === 'undefined') return 1
  const value = Number(new URLSearchParams(window.location.search).get('fx'))
  return Number.isFinite(value) && value > 0 ? Math.min(3, Math.max(.3, value)) : 1
}

function randomGenerator(seed: number) {
  let value = seed >>> 0
  return () => {
    value = (1664525 * value + 1013904223) >>> 0
    return value / 4294967296
  }
}

function makeGeometry(aspect: number) {
  const random = randomGenerator(2026)
  const directions: number[] = []
  for (let ring = 1; ring < RINGS; ring++) {
    const polar = Math.PI * ring / RINGS
    const rowCount = Math.max(8, Math.round(EQUATOR_DOTS * Math.sin(polar)))
    for (let column = 0; column < rowCount; column++) {
      const azimuth = Math.PI * 2 * (column + (ring % 2) * .5) / rowCount
      directions.push(Math.sin(polar) * Math.cos(azimuth), Math.cos(polar), Math.sin(polar) * Math.sin(azimuth))
    }
  }

  const count = directions.length / 3
  const initial = new Float32Array(count * 3)
  const target = new Float32Array(directions)
  const seeds = new Float32Array(count)
  const sizes = new Float32Array(count)
  const worldHeight = 2 * Math.tan(THREE.MathUtils.degToRad(FOV / 2)) * CAMERA_Z

  for (let i = 0; i < count; i++) {
    const p = i * 3
    initial[p] = (random() - .5) * worldHeight * aspect * 1.15
    initial[p + 1] = (random() - .5) * worldHeight * 1.15
    initial[p + 2] = (random() - .5) * 3.8
    seeds[i] = random()
    sizes[i] = .65 + random() * .85
  }

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(initial, 3))
  geometry.setAttribute('aDirection', new THREE.BufferAttribute(target, 3))
  geometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1))
  geometry.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1))
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 100)
  return { geometry, initial, count }
}

const NO_LEVEL = { current: 0 }
const NO_LISTEN = { current: false }

export default function ParticleField({ morphToSphere, analysisMode, voiceLevel, voiceActive, micLevel = NO_LEVEL, listenMode = NO_LISTEN, onStart, onSphereFormed }: Props) {
  const t = useT()
  const host = useRef<HTMLDivElement>(null)
  const sphere = useRef(morphToSphere)
  const start = useRef(onStart)
  const formed = useRef(onSphereFormed)
  const analysis = useRef(analysisMode)
  useEffect(() => { sphere.current = morphToSphere }, [morphToSphere])
  useEffect(() => { start.current = onStart }, [onStart])
  useEffect(() => { formed.current = onSphereFormed }, [onSphereFormed])
  useEffect(() => { analysis.current = analysisMode }, [analysisMode])

  useEffect(() => {
    const element = host.current
    if (!element) return

    const scene = new THREE.Scene()
    scene.background = new THREE.Color('#f7f7f7')
    const camera = new THREE.PerspectiveCamera(FOV, 1, .1, 100)
    camera.position.z = CAMERA_Z
    const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.6))
    element.appendChild(renderer.domElement)

    let aspect = Math.max(1, element.clientWidth / Math.max(1, element.clientHeight))
    const { geometry, initial, count } = makeGeometry(aspect)
    const uniforms = {
      uTime: { value: 0 },
      uMorph: { value: 0 },
      uPointer: { value: new THREE.Vector2(100, 100) },
      uPointerVelocity: { value: new THREE.Vector2() },
      uVoiceLevel: { value: 0 },
      uOuterLevel: { value: 0 },
      uVoiceActive: { value: 0 },
      uGlowLayer: { value: 0 },
      uPixelRatio: { value: renderer.getPixelRatio() },
      uExit: { value: 0 },
      uListen: { value: 0 },
      uMicLevel: { value: 0 },
      uFx: { value: readFx() },
      uRingTime: { value: new Array(RINGS_MAX).fill(-10) as number[] },
      uRingAmp: { value: new Array(RINGS_MAX).fill(0) as number[] },
    }

    const material = new THREE.ShaderMaterial({
      uniforms,
      transparent: true,
      depthWrite: false,
      vertexShader: `
        attribute vec3 aDirection;
        attribute float aSeed;
        attribute float aSize;
        uniform float uTime;
        uniform float uMorph;
        uniform vec2 uPointer;
        uniform vec2 uPointerVelocity;
        uniform float uVoiceLevel;
        uniform float uOuterLevel;
        uniform float uVoiceActive;
        uniform float uGlowLayer;
        uniform float uPixelRatio;
        uniform float uExit;
        uniform float uListen;
        uniform float uMicLevel;
        uniform float uFx;
        uniform float uRingTime[${RINGS_MAX}];
        uniform float uRingAmp[${RINGS_MAX}];
        varying float vListenGlow;
        varying float vAlpha;
        varying float vLight;
        varying float vSeed;
        varying float vMorph;
        varying vec3 vDirection;
        varying float vVoiceGlow;

        void main() {
          float t = uMorph * uMorph * (3.0 - 2.0 * uMorph);
          vec3 drift = vec3(
            sin(uTime * .26 + position.y * .57 + position.z * .34) * .29 + cos(uTime * .17 + aSeed * 22.0) * .07,
            cos(uTime * .21 + position.x * .48 - position.z * .27) * .25 + sin(uTime * .22 + aSeed * 18.0) * .07,
            sin(uTime * .23 + position.x * .36 + position.y * .42) * .24
          );
          vec3 scattered = position + drift;

          // 쉴 때도 살아 있게: 약 40초에 한 바퀴 도는 자전. 빛은 고정이라 표면 명암이 천천히 흐른다.
          float spin = uTime * .157;
          vec3 base = normalize(aDirection);
          vec3 dir = vec3(base.x * cos(spin) + base.z * sin(spin), base.y, -base.x * sin(spin) + base.z * cos(spin));
          float frontMask = smoothstep(-.1, .45, dir.z);
          float radial = length(dir.xy);
          float angle = atan(dir.y, dir.x);
          float innerStrength = uVoiceActive * (.15 + .85 * smoothstep(.03, .38, uVoiceLevel));
          float outerStrength = uVoiceActive * (.25 + .75 * smoothstep(.03, .38, uOuterLevel));
          float innerMask = 1.0 - smoothstep(.58, .85, radial);
          float outerMask = smoothstep(.60, .86, radial);

          // 중심부: 위치마다 위상이 달라 균일한 고리가 되지 않는 빠른 파문.
          float spatialWarp =
            sin(dir.x * 4.1 + uTime * .65) * .55 +
            sin(dir.y * 5.3 - uTime * .52) * .42 +
            sin((dir.x - dir.y) * 7.2 + uTime * .38) * .22;
          float angularWarp = sin(angle * 3.0 + uTime * .48) * .60 + sin(angle * 7.0 - uTime * .32) * .30;
          float handoff = smoothstep(.40, .80, radial);
          float innerWave = sin(radial * 17.0 + (1.0 - dir.z) * 1.1 - uTime * 6.1 + spatialWarp * (1.10 + .85 * handoff));

          // 바깥 둘레: 위치마다 위상이 다른 느린 움직임. 구 전체가 동시에 늘어나지 않는다.
          float outerWave =
            sin(radial * 11.0 - uTime * 1.9 + angularWarp + spatialWarp * .45) * .45 +
            sin(angle * 5.0 + radial * 6.0 - uTime * 1.2 + dir.z * 1.4) * .35 +
            sin(angle * 9.0 - uTime * .85 + dir.z * 3.0) * .20;
          // 음절 파문: 소리가 튀는 순간마다 가운데에서 바깥으로 고리가 하나씩 퍼진다.
          float ring = 0.0;
          for (int i = 0; i < ${RINGS_MAX}; i++) {
            float age = uTime - uRingTime[i];
            if (age < 0.0 || age > 1.15) continue;
            float front = age * 1.05;
            float d = radial - front;
            ring += exp(-d * d / .0045) * (1.0 - age / 1.15) * uRingAmp[i];
          }
          ring *= frontMask * uVoiceActive;

          // 듣는 중: 말할 때와 반대로 물결이 바깥에서 안쪽으로 모이고 구가 살짝 오므라든다.
          float listenStrength = uListen * (.75 + .5 * uMicLevel);
          float listenWave = sin(radial * 13.0 + uTime * 4.2 + spatialWarp * .35) * smoothstep(.04, .3, radial) * (1.0 - smoothstep(.93, 1.0, radial));

          // 쉴 때의 숨: 약 4.6초 주기로 반지름이 1% 남짓 부풀었다 줄어든다.
          float breath = 1.0 + .012 * sin(uTime * 1.36) - .035 * listenStrength;
          vec3 shaped = dir * (${RADIUS.toFixed(2)} * breath + outerMask * outerWave * outerStrength * .19 * uFx);
          shaped.xy += normalize(dir.xy + vec2(.001)) * (innerWave * innerMask * innerStrength * .11 + ring * .12) * uFx;
          shaped.z += (innerWave * innerMask * innerStrength * .16 + ring * .32 + listenWave * listenStrength * .2) * uFx;
          vec3 p = mix(scattered, shaped, t);
          p += dir * (uExit * 3.2) + drift * uExit * .7;

          vec2 delta = p.xy - uPointer;
          float influence = exp(-dot(delta, delta) / (.96 * .96));
          vec2 away = normalize(delta + vec2(.001));
          p.xy += (away * (.32 + length(uPointerVelocity) * .11) + uPointerVelocity * .06) * influence * (1.0 - t);
          p.z += influence * .14 * (1.0 - t);

          vec4 view = modelViewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * view;
          float innerGlow = pow(max(0.0, innerWave), 2.0) * innerMask * .90;
          float outerGlow = pow(max(0.0, outerWave), 2.0) * outerMask * .55;
          float voiceGlow = (innerGlow * innerStrength + outerGlow * outerStrength + ring * 1.1) * min(1.6, uFx);
          gl_PointSize = min(18.0, aSize * uPixelRatio * (25.0 / -view.z) * (1.0 + voiceGlow * .28) * (1.0 + uGlowLayer * .7));
          float front = smoothstep(-.35, .32, dir.z);
          vAlpha = mix(.53 + aSeed * .29, mix(.08, .85, front), t);
          vAlpha *= 1.0 - smoothstep(.08, .92, uExit);
          vLight = clamp(dot(dir, normalize(vec3(-.55, .75, .7))), 0.0, 1.0);
          vSeed = aSeed;
          vMorph = t;
          vDirection = dir;
          vVoiceGlow = voiceGlow * front;
          vListenGlow = smoothstep(.25, .95, listenWave) * listenStrength * front * min(1.6, uFx);
        }
      `,
      fragmentShader: `
        varying float vAlpha;
        varying float vLight;
        varying float vSeed;
        varying float vMorph;
        varying vec3 vDirection;
        varying float vVoiceGlow;
        varying float vListenGlow;

        void main() {
          float d = length(gl_PointCoord - vec2(.5));
          float disc = 1.0 - smoothstep(.24, .5, d);
          vec3 silver = mix(vec3(.18), vec3(.68), vSeed);
          // 프로젝터에서도 입체로 읽히도록 그림자 면은 더 어둡게, 가장자리는 밝게.
          vec3 surface = mix(vec3(.08), vec3(.88), pow(vLight, .8));
          surface = mix(surface, vec3(.96), .16 * pow(1.0 - abs(vDirection.z), 3.0) * step(0.0, vDirection.z));
          surface = mix(surface, vec3(.94), .13 * smoothstep(-.5, .8, vDirection.x));
          surface = mix(surface, vec3(.26), .10 * (1.0 - smoothstep(-.8, .2, vDirection.y)));
          vec3 color = mix(silver, surface, vMorph);
          // 은색 표면 위의 파문 마루에만 절제된 어두운 황금빛을 얹는다.
          // 금빛은 '자칼이 말할 때'만. 듣는 중에는 밝은 표면 위에서도 보이도록 먹색 물결이 안쪽으로 모인다.
          color = mix(color, vec3(.74, .51, .12), min(1.0, vVoiceGlow));
          color += vec3(.16, .11, .03) * vVoiceGlow;
          color = mix(color, vec3(.06), min(.9, vListenGlow));
          float halo = (1.0 - smoothstep(.08, .50, d)) * vVoiceGlow * .26;
          gl_FragColor = vec4(min(color, vec3(1.0)), min(1.0, disc * vAlpha + halo));
        }
      `,
    })
    const mainPoints = new THREE.Points(geometry, material)
    mainPoints.renderOrder = 2
    scene.add(mainPoints)
    const glowMaterial = new THREE.ShaderMaterial({
      uniforms: { ...uniforms, uGlowLayer: { value: 1 } },
      vertexShader: material.vertexShader,
      fragmentShader: `
        varying float vVoiceGlow;
        varying float vAlpha;
        void main() {
          if (vVoiceGlow < .002) discard;
          float d = length(gl_PointCoord - vec2(.5));
          float glow = exp(-d * d * 16.0) * vVoiceGlow * vAlpha * .62;
          gl_FragColor = vec4(.76, .52, .12, min(1.0, glow));
        }
      `,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.NormalBlending,
    })
    const glowPoints = new THREE.Points(geometry, glowMaterial)
    glowPoints.renderOrder = 1
    scene.add(glowPoints)
    const resize = () => {
      const width = element.clientWidth
      const height = element.clientHeight
      if (!width || !height) return
      const nextAspect = width / height
      if (Math.abs(nextAspect - aspect) > .01) {
        const scale = nextAspect / aspect
        for (let i = 0; i < count; i++) initial[i * 3] *= scale
        geometry.attributes.position.needsUpdate = true
        aspect = nextAspect
      }
      camera.aspect = nextAspect
      camera.updateProjectionMatrix()
      renderer.setSize(width, height, false)
    }
    const observer = new ResizeObserver(resize)
    observer.observe(element)
    resize()

    const pointer = new THREE.Vector2(100, 100)
    const previous = new THREE.Vector2(100, 100)
    const worldHeight = 2 * Math.tan(THREE.MathUtils.degToRad(FOV / 2)) * CAMERA_Z
    const onMove = (event: PointerEvent) => {
      const bounds = element.getBoundingClientRect()
      pointer.set(((event.clientX - bounds.left) / bounds.width - .5) * worldHeight * camera.aspect,
        (.5 - (event.clientY - bounds.top) / bounds.height) * worldHeight)
      if (previous.x > 50) previous.copy(pointer)
      uniforms.uPointerVelocity.value.subVectors(pointer, previous).multiplyScalar(1.8).clampLength(0, 2.2)
      previous.copy(pointer)
    }
    const onLeave = () => pointer.set(100, 100)
    const onPointerDown = () => { if (!sphere.current) start.current() }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Enter' && event.key !== ' ') return
      event.preventDefault()
      if (!sphere.current) start.current()
    }
    element.addEventListener('pointermove', onMove)
    element.addEventListener('pointerleave', onLeave)
    element.addEventListener('pointerdown', onPointerDown)
    element.addEventListener('keydown', onKeyDown)

    const clock = new THREE.Clock()
    let formedNotified = false
    // 음절 감지: 빠른 음량이 느린 평균보다 확 올라가는 순간을 파문 하나로 친다.
    let slowLevel = 0
    let lastRing = -10
    let ringSlot = 0
    renderer.setAnimationLoop(() => {
      const dt = Math.min(clock.getDelta(), .05)
      uniforms.uTime.value += dt
      // 커질 때는 바로, 작아질 때는 천천히: 말이 뭉개지지 않고 또박또박 보이게.
      const levelSpeed = voiceLevel.current > uniforms.uVoiceLevel.value ? 22 : 3.2
      uniforms.uVoiceLevel.value += (voiceLevel.current - uniforms.uVoiceLevel.value) * Math.min(1, dt * levelSpeed)
      uniforms.uOuterLevel.value += (voiceLevel.current - uniforms.uOuterLevel.value) * Math.min(1, dt * 1.6)
      uniforms.uVoiceActive.value += ((voiceActive.current ? 1 : 0) - uniforms.uVoiceActive.value) * Math.min(1, dt * 4)
      uniforms.uMorph.value += ((sphere.current ? 1 : 0) - uniforms.uMorph.value) * Math.min(1, dt * 1.8)
      uniforms.uExit.value += ((analysis.current ? 1 : 0) - uniforms.uExit.value) * Math.min(1, dt * 2.2)
      uniforms.uListen.value += ((listenMode.current ? 1 : 0) - uniforms.uListen.value) * Math.min(1, dt * 3)
      uniforms.uMicLevel.value += (micLevel.current - uniforms.uMicLevel.value) * Math.min(1, dt * (micLevel.current > uniforms.uMicLevel.value ? 14 : 3))
      const level = uniforms.uVoiceLevel.value
      slowLevel += (level - slowLevel) * Math.min(1, dt * 2.4)
      const now = uniforms.uTime.value
      if (voiceActive.current && level > .1 && level - slowLevel > .055 && now - lastRing > .16) {
        uniforms.uRingTime.value[ringSlot] = now
        uniforms.uRingAmp.value[ringSlot] = Math.min(1, .45 + level * 1.4)
        ringSlot = (ringSlot + 1) % RINGS_MAX
        lastRing = now
      }
      if (!sphere.current) formedNotified = false
      if (sphere.current && !formedNotified && uniforms.uMorph.value >= .98) {
        formedNotified = true
        formed.current()
      }
      uniforms.uPointer.value.lerp(pointer, Math.min(1, dt * 12))
      uniforms.uPointerVelocity.value.multiplyScalar(Math.max(0, 1 - dt * 5))
      renderer.render(scene, camera)
    })

    return () => {
      renderer.setAnimationLoop(null)
      observer.disconnect()
      element.removeEventListener('pointermove', onMove)
      element.removeEventListener('pointerleave', onLeave)
      element.removeEventListener('pointerdown', onPointerDown)
      element.removeEventListener('keydown', onKeyDown)
      geometry.dispose()
      material.dispose()
      glowMaterial.dispose()
      renderer.dispose()
      renderer.domElement.remove()
    }
  }, [voiceLevel, voiceActive, micLevel, listenMode])

  return <div ref={host} className="particle-field" role={morphToSphere ? 'img' : 'button'} tabIndex={morphToSphere ? -1 : 0}
    aria-label={morphToSphere ? t('field.sphere') : t('field.start')} />
}
