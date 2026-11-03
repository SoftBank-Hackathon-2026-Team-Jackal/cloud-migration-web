'use client'

import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { useT } from '../lib/i18n'

type Props = { morphToSphere: boolean; analysisMode: boolean; onStart: () => void; onSphereFormed: () => void }

const RINGS = 220
const EQUATOR_DOTS = 470
const RADIUS = 3.25
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

export default function ParticleField({ morphToSphere, analysisMode, onStart, onSphereFormed }: Props) {
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
      uRippleOrigin: { value: new THREE.Vector3(0, 0, 1) },
      uRippleStart: { value: -100 },
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
        uniform vec3 uRippleOrigin;
        uniform float uRippleStart;
        uniform float uPixelRatio;
        uniform float uExit;
        varying float vAlpha;
        varying float vLight;
        varying float vSeed;
        varying float vMorph;
        varying vec3 vDirection;
        varying float vWave;

        void main() {
          float t = uMorph * uMorph * (3.0 - 2.0 * uMorph);
          vec3 drift = vec3(
            sin(uTime * .26 + position.y * .57 + position.z * .34) * .29 + cos(uTime * .17 + aSeed * 22.0) * .07,
            cos(uTime * .21 + position.x * .48 - position.z * .27) * .25 + sin(uTime * .22 + aSeed * 18.0) * .07,
            sin(uTime * .23 + position.x * .36 + position.y * .42) * .24
          );
          vec3 scattered = position + drift;

          vec3 dir = normalize(aDirection);
          float organic =
            sin(dir.x * 4.5 + dir.y * 5.0 + uTime * .47) * .20 +
            sin(dir.y * 11.0 - dir.z * 7.0 - uTime * .71) * .11 +
            cos(dir.z * 13.0 + dir.x * 9.0 + uTime * .59) * .07;

          float age = uTime - uRippleStart;
          float angularDistance = acos(clamp(dot(dir, uRippleOrigin), -1.0, 1.0));
          float ring = exp(-pow((angularDistance - age * 1.75) * 4.2, 2.0));
          float ripple = cos(angularDistance * 18.0 - age * 16.0) * ring * exp(-age * .55) * .82;
          ripple *= step(0.0, age) * (1.0 - step(4.0, age));
          float radius = ${RADIUS.toFixed(2)} + organic + ripple;
          vec3 shaped = dir * radius;
          vec3 p = mix(scattered, shaped, t);
          p += dir * (uExit * 3.2) + drift * uExit * .7;

          vec2 delta = p.xy - uPointer;
          float influence = exp(-dot(delta, delta) / (.96 * .96));
          vec2 away = normalize(delta + vec2(.001));
          p.xy += (away * (.32 + length(uPointerVelocity) * .11) + uPointerVelocity * .06) * influence * (1.0 - t);
          p.z += influence * .14 * (1.0 - t);

          vec4 view = modelViewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * view;
          gl_PointSize = min(7.0, aSize * uPixelRatio * (25.0 / -view.z));
          float front = smoothstep(-.35, .32, dir.z);
          vAlpha = mix(.53 + aSeed * .29, mix(.08, .85, front), t);
          vAlpha *= 1.0 - smoothstep(.08, .92, uExit);
          vLight = clamp(dot(dir, normalize(vec3(-.55, .75, .7))), 0.0, 1.0);
          vSeed = aSeed;
          vMorph = t;
          vDirection = dir;
          vWave = organic + ripple;
        }
      `,
      fragmentShader: `
        varying float vAlpha;
        varying float vLight;
        varying float vSeed;
        varying float vMorph;
        varying vec3 vDirection;
        varying float vWave;

        void main() {
          float d = length(gl_PointCoord - vec2(.5));
          float disc = 1.0 - smoothstep(.24, .5, d);
          vec3 silver = mix(vec3(.18), vec3(.68), vSeed);
          vec3 surface = mix(vec3(.14), vec3(.84), pow(vLight, .8));
          surface = mix(surface, vec3(.94), .13 * smoothstep(-.5, .8, vDirection.x));
          surface = mix(surface, vec3(.26), .10 * (1.0 - smoothstep(-.8, .2, vDirection.y)));
          surface += max(0.0, vWave) * .06;
          vec3 color = mix(silver, surface, vMorph);
          gl_FragColor = vec4(color, disc * vAlpha);
        }
      `,
    })
    scene.add(new THREE.Points(geometry, material))
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
    const trigger = (x: number, y: number) => {
      if (!sphere.current) { start.current(); return }
      const bounds = element.getBoundingClientRect()
      let dx = ((x - bounds.left) / bounds.width - .5) * worldHeight * camera.aspect / RADIUS
      let dy = (.5 - (y - bounds.top) / bounds.height) * worldHeight / RADIUS
      const squared = dx * dx + dy * dy
      if (squared > .94) {
        const factor = Math.sqrt(.94 / squared)
        dx *= factor
        dy *= factor
      }
      uniforms.uRippleOrigin.value.set(dx, dy, Math.sqrt(1 - dx * dx - dy * dy)).normalize()
      uniforms.uRippleStart.value = uniforms.uTime.value
    }
    const onPointerDown = (event: PointerEvent) => trigger(event.clientX, event.clientY)
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Enter' && event.key !== ' ') return
      event.preventDefault()
      const bounds = element.getBoundingClientRect()
      trigger(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2)
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
      renderer.dispose()
      renderer.domElement.remove()
    }
  }, [])

  return <div ref={host} className="particle-field" role="button" tabIndex={0}
    aria-label={morphToSphere ? t('field.sphere') : t('field.start')} />
}
