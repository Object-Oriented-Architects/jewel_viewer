'use client'

import { useEffect, useMemo, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js'
import { HorizontalBlurShader } from 'three/examples/jsm/shaders/HorizontalBlurShader.js'
import { VerticalBlurShader } from 'three/examples/jsm/shaders/VerticalBlurShader.js'
import type { FloorShadowConfig } from '@/config/types'

export type FloorFrame = { center: THREE.Vector3; size: number; far: number }

export function floorFrame(box: THREE.Box3, { scale, far }: Pick<FloorShadowConfig, 'scale' | 'far'>): FloorFrame {
  const radius = box.getSize(new THREE.Vector3()).length() / 2
  return {
    center: box.getCenter(new THREE.Vector3()).setY(box.min.y),
    size: radius * scale,
    far: radius * far,
  }
}

export type FloorBake = { frame: FloorFrame; environment: THREE.Texture | null }

// The color pass reflects the scene environment, and the metal HDR can arrive after the first bake.
export function bakeDue(
  frame: FloorFrame | null,
  baked: FloorBake | null,
  environment: THREE.Texture | null,
): frame is FloorFrame {
  return !!frame && (baked?.frame !== frame || baked.environment !== environment)
}

const blurMaterial = (shader: typeof HorizontalBlurShader | typeof VerticalBlurShader) =>
  new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.clone(shader.uniforms),
    vertexShader: shader.vertexShader,
    fragmentShader: shader.fragmentShader,
    depthTest: false,
    depthWrite: false,
  })

const uvVertexShader =
  'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }'

class FloorShadowBaker {
  readonly floor: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>
  private readonly target: THREE.WebGLRenderTarget
  private readonly scratch: THREE.WebGLRenderTarget
  private readonly color: THREE.WebGLRenderTarget
  private readonly bleed: THREE.WebGLRenderTarget
  private readonly camera = new THREE.OrthographicCamera()
  private readonly depth = new THREE.ShaderMaterial({
    side: THREE.DoubleSide,
    vertexShader: 'void main() { gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: 'void main() { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0 - gl_FragCoord.z); }',
  })
  private readonly fade = new THREE.ShaderMaterial({
    uniforms: { tColor: { value: null }, tDepth: { value: null } },
    vertexShader: uvVertexShader,
    fragmentShader: `
      uniform sampler2D tColor;
      uniform sampler2D tDepth;
      varying vec2 vUv;
      void main() { gl_FragColor = vec4(texture2D(tColor, vUv).rgb * texture2D(tDepth, vUv).a, 1.0); }
    `,
    depthTest: false,
    depthWrite: false,
  })
  private readonly horizontal = blurMaterial(HorizontalBlurShader)
  private readonly vertical = blurMaterial(VerticalBlurShader)
  private readonly quad = new FullScreenQuad()

  constructor(resolution: number) {
    this.target = new THREE.WebGLRenderTarget(resolution, resolution)
    this.scratch = new THREE.WebGLRenderTarget(resolution, resolution, { depthBuffer: false })
    this.color = new THREE.WebGLRenderTarget(resolution, resolution, { type: THREE.HalfFloatType })
    this.bleed = new THREE.WebGLRenderTarget(resolution, resolution, { type: THREE.HalfFloatType, depthBuffer: false })
    this.camera.up.set(0, 0, 1)
    // The camera looks up from the floor, so a downward plane's back face shares its UV orientation.
    // Premultiplied over: shadow alpha uncovers less background in BackgroundComposite, bleed adds light before tone mapping.
    this.floor = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1).rotateX(Math.PI / 2),
      new THREE.ShaderMaterial({
        uniforms: {
          tShadow: { value: this.target.texture },
          tBleed: { value: this.bleed.texture },
          shadowOpacity: { value: 0 },
          bleedStrength: { value: 0 },
        },
        vertexShader: uvVertexShader,
        fragmentShader: `
          uniform sampler2D tShadow;
          uniform sampler2D tBleed;
          uniform float shadowOpacity;
          uniform float bleedStrength;
          varying vec2 vUv;
          void main() {
            gl_FragColor = vec4(texture2D(tBleed, vUv).rgb * bleedStrength, texture2D(tShadow, vUv).a * shadowOpacity);
          }
        `,
        transparent: true,
        premultipliedAlpha: true,
        depthWrite: false,
        side: THREE.BackSide,
      }),
    )
    this.floor.visible = false
  }

  bake(gl: THREE.WebGLRenderer, scene: THREE.Scene, frame: FloorFrame, settings: FloorShadowConfig) {
    const half = frame.size / 2
    Object.assign(this.camera, { left: -half, right: half, top: half, bottom: -half, near: 0, far: frame.far })
    this.camera.updateProjectionMatrix()
    this.camera.position.copy(frame.center)
    this.camera.lookAt(frame.center.x, frame.center.y + 1, frame.center.z)

    const previousTarget = gl.getRenderTarget()
    const clearColor = gl.getClearColor(new THREE.Color())
    const clearAlpha = gl.getClearAlpha()
    const override = scene.overrideMaterial
    this.floor.visible = false
    gl.setClearColor(0x000000, 0)
    scene.overrideMaterial = this.depth
    this.render(gl, scene, this.target)
    scene.overrideMaterial = override
    this.render(gl, scene, this.color)
    this.fade.uniforms.tColor.value = this.color.texture
    this.fade.uniforms.tDepth.value = this.target.texture
    this.quad.material = this.fade
    gl.setRenderTarget(this.bleed)
    this.quad.render(gl)
    for (const spread of [settings.blur, settings.blur * 0.4]) {
      this.blur(gl, this.horizontal, 'h', spread, this.target, this.scratch)
      this.blur(gl, this.vertical, 'v', spread, this.scratch, this.target)
      this.blur(gl, this.horizontal, 'h', spread, this.bleed, this.color)
      this.blur(gl, this.vertical, 'v', spread, this.color, this.bleed)
    }
    gl.setRenderTarget(previousTarget)
    gl.setClearColor(clearColor, clearAlpha)

    this.floor.position.copy(frame.center)
    this.floor.scale.set(frame.size, 1, frame.size)
    this.floor.material.uniforms.shadowOpacity.value = settings.opacity
    this.floor.material.uniforms.bleedStrength.value = settings.colorBleed
    this.floor.visible = true
  }

  private render(gl: THREE.WebGLRenderer, scene: THREE.Scene, target: THREE.WebGLRenderTarget) {
    gl.setRenderTarget(target)
    gl.clear()
    gl.render(scene, this.camera)
  }

  private blur(
    gl: THREE.WebGLRenderer,
    material: THREE.ShaderMaterial,
    axis: 'h' | 'v',
    spread: number,
    from: THREE.WebGLRenderTarget,
    to: THREE.WebGLRenderTarget,
  ) {
    material.uniforms.tDiffuse.value = from.texture
    material.uniforms[axis].value = spread / 256
    this.quad.material = material
    gl.setRenderTarget(to)
    this.quad.render(gl)
  }

  dispose() {
    this.floor.geometry.dispose()
    this.floor.material.dispose()
    this.target.dispose()
    this.scratch.dispose()
    this.color.dispose()
    this.bleed.dispose()
    this.depth.dispose()
    this.fade.dispose()
    this.horizontal.dispose()
    this.vertical.dispose()
    this.quad.dispose()
  }
}

export function ContactFloorShadow({
  box,
  revision,
  settings,
}: {
  box: THREE.Box3 | null
  revision: number
  settings: FloorShadowConfig
}) {
  const gl = useThree((state) => state.gl)
  const scene = useThree((state) => state.scene)
  const baker = useMemo(() => new FloorShadowBaker(settings.resolution), [settings.resolution])
  useEffect(() => () => baker.dispose(), [baker])
  const settled = useRef<FloorFrame | null>(null)
  const baked = useRef<FloorBake | null>(null)
  useEffect(() => {
    settled.current = null
    if (!box) {
      baker.floor.visible = false
      return
    }
    const frame = floorFrame(box, settings)
    const timer = setTimeout(() => {
      settled.current = frame
    }, settings.debounceMs)
    return () => clearTimeout(timer)
  }, [baker, box, revision, settings])
  useFrame(() => {
    const frame = settled.current
    if (!bakeDue(frame, baked.current, scene.environment)) return
    baker.bake(gl, scene, frame, settings)
    baked.current = { frame, environment: scene.environment }
  })
  return <primitive object={baker.floor} dispose={null} />
}
