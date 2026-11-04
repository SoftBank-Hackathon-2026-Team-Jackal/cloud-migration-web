'use client'

import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { useT } from '../lib/i18n'

type Props = { morphToSphere: boolean; analysisMode: boolean; voiceLevel: { current: number }; voiceActive: { current: boolean }; onStart: () => void; onSphereFormed: () => void }

const RINGS = 220
const EQUATOR_DOTS = 470
const RADIUS = 2.8
const FOV = 43
const CAMERA_Z = 11

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

export default function ParticleField({ morphToSphere, analysisMode, voiceLevel, voiceActive, onStart, onSphereFormed }: Props) {
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

          vec3 dir = normalize(aDirection);
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
          vec3 shaped = dir * (${RADIUS.toFixed(2)} + outerMask * outerWave * outerStrength * .22);
          shaped.xy += normalize(dir.xy + vec2(.001)) * innerWave * innerMask * innerStrength * .085;
          shaped.z += innerWave * innerMask * innerStrength * .13;
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
          float voiceGlow = innerGlow * innerStrength + outerGlow * outerStrength;
          gl_PointSize = min(18.0, aSize * uPixelRatio * (25.0 / -view.z) * (1.0 + voiceGlow * .28) * (1.0 + uGlowLayer * .7));
          float front = smoothstep(-.35, .32, dir.z);
          vAlpha = mix(.53 + aSeed * .29, mix(.08, .85, front), t);
          vAlpha *= 1.0 - smoothstep(.08, .92, uExit);
          vLight = clamp(dot(dir, normalize(vec3(-.55, .75, .7))), 0.0, 1.0);
          vSeed = aSeed;
          vMorph = t;
          vDirection = dir;
          vVoiceGlow = voiceGlow * front;
        }
      `,
      fragmentShader: `
        varying float vAlpha;
        varying float vLight;
        varying float vSeed;
        varying float vMorph;
        varying vec3 vDirection;
        varying float vVoiceGlow;

        void main() {
          float d = length(gl_PointCoord - vec2(.5));
          float disc = 1.0 - smoothstep(.24, .5, d);
          vec3 silver = mix(vec3(.18), vec3(.68), vSeed);
          vec3 surface = mix(vec3(.14), vec3(.84), pow(vLight, .8));
          surface = mix(surface, vec3(.94), .13 * smoothstep(-.5, .8, vDirection.x));
          surface = mix(surface, vec3(.26), .10 * (1.0 - smoothstep(-.8, .2, vDirection.y)));
          vec3 color = mix(silver, surface, vMorph);
          // 은색 표면 위의 파문 마루에만 절제된 어두운 황금빛을 얹는다.
          color = mix(color, vec3(.69, .48, .13), vVoiceGlow * .86);
          color += vec3(.10, .07, .02) * vVoiceGlow;
          float halo = (1.0 - smoothstep(.08, .50, d)) * vVoiceGlow * .16;
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
          float glow = exp(-d * d * 16.0) * vVoiceGlow * vAlpha * .42;
          gl_FragColor = vec4(.72, .50, .13, glow);
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
    renderer.setAnimationLoop(() => {
      const dt = Math.min(clock.getDelta(), .05)
      uniforms.uTime.value += dt
      const levelSpeed = voiceLevel.current > uniforms.uVoiceLevel.value ? 8 : 3.5
      uniforms.uVoiceLevel.value += (voiceLevel.current - uniforms.uVoiceLevel.value) * Math.min(1, dt * levelSpeed)
      uniforms.uOuterLevel.value += (voiceLevel.current - uniforms.uOuterLevel.value) * Math.min(1, dt * 1.6)
      uniforms.uVoiceActive.value += ((voiceActive.current ? 1 : 0) - uniforms.uVoiceActive.value) * Math.min(1, dt * 4)
      uniforms.uMorph.value += ((sphere.current ? 1 : 0) - uniforms.uMorph.value) * Math.min(1, dt * 1.8)
      uniforms.uExit.value += ((analysis.current ? 1 : 0) - uniforms.uExit.value) * Math.min(1, dt * 2.2)
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
  }, [voiceLevel, voiceActive])

  return <div ref={host} className="particle-field" role={morphToSphere ? 'img' : 'button'} tabIndex={morphToSphere ? -1 : 0}
    aria-label={morphToSphere ? t('field.sphere') : t('field.start')} />
}
