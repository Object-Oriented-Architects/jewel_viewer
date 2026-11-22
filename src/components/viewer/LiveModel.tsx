'use client'

import { useLayoutEffect, useSyncExternalStore } from 'react'
import * as THREE from 'three'
import { ringPlusplasticConfig as config } from '@/config'
import { ContactFloorShadow } from '../canvas/ContactFloorShadow'
import { DiamondMaterial } from '../canvas/gem/DiamondMaterial'
import { splitFacetedStones } from '../canvas/gem/gemGeometry'
import { useGemEnv, type GemEnv } from '../canvas/gem/GemEnvironment'
import {
  createOccluder,
  occluderIndex,
  settingBake,
  type Occluder,
  type PlacedGeometry,
} from '../canvas/gem/settingOcclusion'
import {
  createMetalMaterial,
  gemControlDefaults,
  gemMaterialOptions,
  connectedGemOptions,
} from '../canvas/jewelryMaterials'
import {
  decodeObject,
  decodeTexture,
  textureUrl,
  validateManifest,
  type ColorMap,
  type Manifest,
  type ObjectRef,
  type ExportScene,
} from './sceneProtocol'

type Stone = {
  mesh: THREE.Mesh<THREE.BufferGeometry, DiamondMaterial>
  placed: PlacedGeometry
  radius: number
  map: THREE.DataTexture | null
  materialId: string
}
type Entry = {
  id: string
  rev: number
  origin: THREE.Vector3
  group: THREE.Group
  stones: Stone[]
  occluders: Occluder[]
  surfaces: { mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshPhysicalMaterial>; materialId: string }[]
  box: THREE.Box3
}
type Failure = { count: number; next: number }
type TextureImage = { texture: THREE.Texture | null; controller: AbortController }

function releaseTexture(texture: THREE.Texture) {
  texture.dispose()
  ;(texture.image as ImageBitmap).close()
}

/** Imperative ownership keeps unchanged materials and the Canvas mounted across pulls. */
export class LiveScene {
  readonly root = new THREE.Group()
  readonly entries = new Map<string, Entry>()
  readonly errors: string[] = []
  box: THREE.Box3 | null = null
  radius = 1.5
  manifest: Manifest | null = null
  /** Replaced only when visible shapes, bounds, materials or textures change, never on a same-content re-pull. */
  appearance: { revision: number; box: THREE.Box3 | null } = { revision: 0, box: null }
  onChange: () => void = () => {}
  on404: () => void = () => {}
  private appearanceListeners = new Set<() => void>()
  private appearanceDirty = false
  private metal = createMetalMaterial(config.metal ?? {})
  private materials = new Map<string, THREE.MeshPhysicalMaterial>()
  private options = gemMaterialOptions(gemControlDefaults(config.diamond), config.diamond?.neutralSpectrum)
  private env: GemEnv | null = null
  private desired = new Map<string, ObjectRef>()
  private pending = new Map<string, AbortController>()
  private failures = new Map<string, Failure>()
  private blocks: ExportScene['blocks'] | undefined
  private textures: ExportScene['textures'] | undefined
  private images = new Map<string, TextureImage>()
  // Reconcile alone rebuilds the queue. Completions advance a cursor, not desired.
  private queue: ObjectRef[] = []
  private cursor = 0
  private retries = new Map<string, ObjectRef>()
  private active = 0
  private stopped = false
  private flushFrame = 0
  private bakeFrame = 0
  private retryTimer: ReturnType<typeof setTimeout> | undefined
  private retryAt = Infinity
  private metalDirty = false
  private gemDirty = false
  private newStones = new Set<Stone>()
  private bakeQueue: Stone[] = []
  private currentBake: { stone: Stone; bake: ReturnType<typeof settingBake> } | null = null
  private blocked: (ray: THREE.Ray) => boolean = () => false

  readonly onAppearance = (listener: () => void) => {
    this.appearanceListeners.add(listener)
    return () => {
      this.appearanceListeners.delete(listener)
    }
  }

  private appearanceChanged() {
    this.appearance = { revision: this.appearance.revision + 1, box: this.box }
    for (const listener of this.appearanceListeners) listener()
  }

  setEnvironment(env: GemEnv | null) {
    const stonesToggle = !env !== !this.env
    this.env = env
    for (const entry of this.entries.values()) for (const stone of entry.stones) this.updateStone(stone)
    if (stonesToggle) this.appearanceChanged()
  }

  private updateStone(stone: Stone) {
    stone.mesh.visible = !!this.env
    if (this.env) {
      const material = this.manifest?.materials[stone.materialId]
      const options = connectedGemOptions(
        stone.mesh.userData.pave ? this.options.pave : this.options.center,
        this.env,
        stone.map,
      )
      stone.mesh.material.update({
        ...options,
        ...(material
          ? {
              color: new THREE.Color().setRGB(...material.color, THREE.SRGBColorSpace),
              ior: material.ior,
            }
          : {}),
      })
    }
  }

  private surfaceMaterial(id: string) {
    const value = this.manifest?.materials[id]
    if (!value) return this.metal
    let material = this.materials.get(id)
    if (!material) {
      material = createMetalMaterial(config.metal ?? {})
      this.materials.set(id, material)
    }
    const transmission = 1 - value.opacity
    const changedTransmission = material.transmission > 0 !== transmission > 0
    const map = value.colorMap ? this.colorMap(material, value.colorMap) : null
    if (material.map !== map) {
      if (!material.map !== !map) material.needsUpdate = true
      material.map?.dispose()
      material.map = map
    }
    if (map) material.color.set(0xffffff)
    else material.color.setRGB(...value.color, THREE.SRGBColorSpace)
    material.metalness = value.metallic
    material.roughness = value.roughness
    material.clearcoat = value.clearcoat
    material.clearcoatRoughness = value.clearcoatRoughness
    material.transmission = transmission
    material.ior = transmission > 0 ? value.ior : 1.5
    if (changedTransmission) material.needsUpdate = true
    return material
  }

  private colorMap(material: THREE.MeshPhysicalMaterial, value: ColorMap) {
    const image = this.image(value.texture).texture
    if (!image) return null
    const map = material.map?.source === image.source ? material.map : image.clone()
    const [a, b, c, d, e, f] = value.transform
    map.matrix.set(a, b, c, d, e, f, 0, 0, 1)
    return map
  }

  private image(id: string) {
    let image = this.images.get(id)
    if (!image) {
      image = { texture: null, controller: new AbortController() }
      this.images.set(id, image)
      void this.loadImage(id, image)
    }
    return image
  }

  private async loadImage(id: string, image: TextureImage) {
    try {
      let bytes = this.textures?.get(id)
      if (!bytes) {
        const response = await fetch(textureUrl(id), { cache: 'no-store', signal: image.controller.signal })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        bytes = new Uint8Array(await response.arrayBuffer())
      }
      const texture = await decodeTexture(bytes)
      if (this.stopped || this.images.get(id) !== image) {
        releaseTexture(texture)
        return
      }
      image.texture = texture
      this.appearanceDirty = true
      this.scheduleFlush()
    } catch (cause) {
      if (this.stopped || this.images.get(id) !== image) return
      // The color stays visible; the next material refresh asks for the image again.
      this.images.delete(id)
      this.report(`texture ${id}: ${cause instanceof Error ? cause.message : String(cause)}`)
    }
  }

  private report(message: string) {
    this.errors.push(message)
    this.errors.splice(0, Math.max(0, this.errors.length - 100))
    const w = window as unknown as { __RHINOVIEW_ERRORS?: string[] }
    if (w.__RHINOVIEW_ERRORS) {
      w.__RHINOVIEW_ERRORS.push(message)
      w.__RHINOVIEW_ERRORS.splice(0, Math.max(0, w.__RHINOVIEW_ERRORS.length - 100))
    }
  }

  private refreshMaterials() {
    const used = new Set<string>()
    for (const entry of this.entries.values()) {
      for (const surface of entry.surfaces) {
        used.add(surface.materialId)
        surface.mesh.material = this.surfaceMaterial(surface.materialId)
      }
      for (const stone of entry.stones) this.updateStone(stone)
    }
    for (const [id, material] of this.materials) {
      if (!used.has(id) || !this.manifest?.materials[id]) {
        material.map?.dispose()
        material.dispose()
        this.materials.delete(id)
      }
    }
    const textures = new Set([...this.materials.keys()].map((id) => this.manifest?.materials[id]?.colorMap?.texture))
    for (const [id, image] of this.images) {
      if (!textures.has(id)) {
        image.controller.abort()
        if (image.texture) releaseTexture(image.texture)
        this.images.delete(id)
      }
    }
  }

  reconcile(manifest: Manifest, blocks?: ExportScene['blocks'], textures?: ExportScene['textures']) {
    validateManifest(manifest)
    if (this.stopped || (this.manifest && manifest.version < this.manifest.version)) return
    if (
      !this.manifest ||
      this.manifest.scale !== manifest.scale ||
      this.manifest.center.some((value, axis) => value !== manifest.center[axis]) ||
      JSON.stringify(this.manifest.materials) !== JSON.stringify(manifest.materials)
    )
      this.appearanceDirty = true
    this.manifest = manifest
    this.blocks = blocks
    this.textures = textures
    this.desired = new Map(manifest.objects.map((o) => [o.id, o]))
    const desiredKeys = new Set(manifest.objects.map((o) => `${o.id}:${o.rev}`))
    for (const key of this.failures.keys()) if (!desiredKeys.has(key)) this.failures.delete(key)
    for (const key of this.retries.keys()) if (!desiredKeys.has(key)) this.retries.delete(key)
    for (const [key, request] of this.pending) if (!desiredKeys.has(key)) request.abort()
    for (const [id, entry] of this.entries) if (!this.desired.has(id)) this.remove(entry)
    this.refreshMaterials()
    this.root.rotation.x = -Math.PI / 2
    this.root.scale.setScalar(manifest.scale)
    for (const entry of this.entries.values()) this.place(entry)
    this.refreshBounds()
    this.scheduleFlush()
    this.queue = manifest.objects.filter(
      (ref) => this.entries.get(ref.id)?.rev !== ref.rev && !this.pending.has(`${ref.id}:${ref.rev}`),
    )
    this.cursor = 0
    this.pump()
  }

  private place(entry: Entry) {
    // JS arithmetic stays double until Three uploads the matrix. Never subtract Float32 centers.
    entry.group.position.set(
      entry.origin.x - this.manifest!.center[0],
      entry.origin.y - this.manifest!.center[1],
      entry.origin.z - this.manifest!.center[2],
    )
  }

  private refreshBounds() {
    const box = new THREE.Box3()
    for (const entry of this.entries.values()) box.union(entry.box)
    if (box.isEmpty() || !this.manifest) {
      this.box = null
      this.radius = 1.5
      return
    }
    const c = this.manifest.center
    this.root.updateMatrix()
    this.box = box.translate(new THREE.Vector3(-c[0], -c[1], -c[2])).applyMatrix4(this.root.matrix)
    this.radius = this.box.getSize(new THREE.Vector3()).length() / 2
  }

  private pump() {
    if (this.stopped) return
    while (this.active < 6 && this.cursor < this.queue.length) {
      const ref = this.queue[this.cursor++]
      const key = `${ref.id}:${ref.rev}`
      if (
        this.desired.get(ref.id)?.rev !== ref.rev ||
        this.entries.get(ref.id)?.rev === ref.rev ||
        this.pending.has(key)
      )
        continue
      if ((this.failures.get(key)?.next ?? 0) > performance.now()) {
        this.defer(ref, key)
        continue
      }
      this.retries.delete(key)
      const controller = new AbortController()
      this.pending.set(key, controller)
      this.active++
      void this.load(ref, key, controller)
    }
    if (this.cursor === this.queue.length) {
      this.queue = []
      this.cursor = 0
    }
  }

  private defer(ref: ObjectRef, key: string) {
    this.retries.set(key, ref)
    this.scheduleRetry(this.failures.get(key)?.next ?? 0)
  }

  private scheduleRetry(at: number) {
    // Completions do not scan failed refs either. Only the earliest timer drains this queue.
    if (at >= this.retryAt) return
    clearTimeout(this.retryTimer)
    this.retryAt = at
    this.retryTimer = setTimeout(
      () => {
        this.retryAt = Infinity
        const now = performance.now()
        let next = Infinity
        for (const [key, ref] of this.retries) {
          const due = this.failures.get(key)?.next ?? 0
          if (due > now) {
            next = Math.min(next, due)
            continue
          }
          this.retries.delete(key)
          this.queue.push(ref)
        }
        this.scheduleRetry(next)
        this.pump()
      },
      Math.max(0, at - performance.now()),
    )
  }

  private async load(ref: ObjectRef, key: string, controller: AbortController) {
    try {
      let bytes = this.blocks?.get(ref.id)
      if (!bytes) {
        const response = await fetch(ref.url, { cache: 'no-store', signal: controller.signal })
        if (!response.ok) {
          if (response.status === 404) this.on404()
          throw new Error(`HTTP ${response.status}`)
        }
        bytes = new Uint8Array(await response.arrayBuffer())
      }
      const decoded = await decodeObject(bytes)
      if (this.stopped || controller.signal.aborted || this.desired.get(ref.id)?.rev !== ref.rev) {
        decoded.parts.forEach((p) => p.geometry.dispose())
        return
      }
      const entry: Entry = {
        id: ref.id,
        rev: ref.rev,
        origin: decoded.origin,
        group: new THREE.Group(),
        stones: [],
        occluders: [],
        surfaces: [],
        box: new THREE.Box3(),
      }
      try {
        for (const part of decoded.parts) {
          entry.box.union(part.geometry.boundingBox!.clone().translate(entry.origin))
          if (part.kind === 2) {
            for (const geometry of splitFacetedStones(part.geometry, part.smooth)) {
              const mesh = new THREE.Mesh(geometry, new DiamondMaterial(geometry))
              mesh.userData = { isGem: true, pave: false }
              const placed = {
                geometry,
                position: entry.origin.clone(),
                rotation: new THREE.Euler(),
                scale: new THREE.Vector3(1, 1, 1),
              }
              const stone = {
                mesh,
                placed,
                radius: geometry.boundingSphere!.radius,
                map: null,
                materialId: part.materialId,
              }
              entry.stones.push(stone)
              entry.group.add(mesh)
              this.updateStone(stone)
            }
            part.geometry.dispose()
          } else {
            const mesh = new THREE.Mesh(
              part.geometry,
              part.kind === 1 ? this.surfaceMaterial(part.materialId) : this.metal,
            )
            entry.group.add(mesh)
            if (part.kind === 1) entry.surfaces.push({ mesh, materialId: part.materialId })
            entry.occluders.push(
              createOccluder({
                geometry: part.geometry,
                position: entry.origin.clone(),
                rotation: new THREE.Euler(),
                scale: new THREE.Vector3(1, 1, 1),
              }),
            )
          }
        }
      } catch (error) {
        this.disposeEntry(entry)
        decoded.parts.forEach((p) => p.geometry.dispose())
        throw error
      }
      // Retire the old revision only when the replacement is fully ready.
      const previous = this.entries.get(ref.id)
      if (previous) this.remove(previous)
      this.entries.set(ref.id, entry)
      this.place(entry)
      this.root.add(entry.group)
      this.appearanceDirty = true
      if (entry.occluders.length) this.metalDirty = true
      if (entry.stones.length) this.gemDirty = true
      for (const stone of entry.stones) this.newStones.add(stone)
      this.failures.delete(key)
      this.scheduleFlush()
    } catch (cause) {
      if (!this.stopped && !controller.signal.aborted && this.desired.get(ref.id)?.rev === ref.rev) {
        this.report(`${ref.id}@${ref.rev}: ${cause instanceof Error ? cause.message : String(cause)}`)
        const count = (this.failures.get(key)?.count ?? 0) + 1
        this.failures.set(key, { count, next: performance.now() + Math.min(5000, 250 * 2 ** Math.min(count - 1, 5)) })
        // Failed replacements never enter the screen set. Keep the old mesh and bounds;
        // even a same-version pull still sees a mismatch and retries after backoff.
        this.defer(ref, key)
      }
    } finally {
      this.active--
      this.pending.delete(key)
      // The id can be removed and restored with the same rev while an aborted request settles.
      if (
        controller.signal.aborted &&
        this.desired.get(ref.id)?.rev === ref.rev &&
        this.entries.get(ref.id)?.rev !== ref.rev
      )
        this.queue.push(ref)
      this.pump()
    }
  }

  private remove(entry: Entry) {
    this.root.remove(entry.group)
    this.entries.delete(entry.id)
    this.appearanceDirty = true
    if (entry.occluders.length) this.metalDirty = true
    if (entry.stones.length) this.gemDirty = true
    this.disposeEntry(entry)
  }

  private disposeEntry(entry: Entry) {
    entry.group.traverse((o) => {
      if (o instanceof THREE.Mesh) o.geometry.dispose()
    })
    // A bake RAF may precede the coalesced flush. Never publish a texture to a dead stone.
    const removed = new Set(entry.stones)
    if (this.currentBake && removed.has(this.currentBake.stone)) this.currentBake = null
    this.bakeQueue = this.bakeQueue.filter((stone) => !removed.has(stone))
    for (const stone of entry.stones) {
      stone.mesh.material.dispose()
      stone.map?.dispose()
      this.newStones.delete(stone)
    }
    entry.occluders.forEach((o) => o.geometry.dispose())
  }

  private scheduleFlush() {
    if (!this.flushFrame && !this.stopped)
      this.flushFrame = requestAnimationFrame(() => {
        this.flushFrame = 0
        this.refreshBounds()
        this.refreshMaterials()
        const stones = [...this.entries.values()].flatMap((e) => e.stones)
        if (this.gemDirty) {
          let maxRadius = 0
          for (const stone of stones) maxRadius = Math.max(maxRadius, stone.radius)
          for (const stone of stones) {
            const pave = stone.radius < maxRadius * 0.5
            if (stone.mesh.userData.pave !== pave) {
              stone.mesh.userData.pave = pave
              this.updateStone(stone)
            }
          }
        }
        if (this.metalDirty || this.gemDirty) {
          cancelAnimationFrame(this.bakeFrame)
          this.bakeFrame = 0
          this.currentBake = null
          if (this.metalDirty) this.blocked = occluderIndex([...this.entries.values()].flatMap((e) => e.occluders))
          // A canceled partial queue must be retained, even if only the gem set changed.
          const alive = new Set(stones)
          const wanted = this.metalDirty ? stones : [...this.newStones, ...this.bakeQueue]
          this.bakeQueue = [...new Set(wanted)].filter((s) => alive.has(s))
          this.newStones.clear()
          this.metalDirty = this.gemDirty = false
          if (config.diamond?.settingOcclusion) this.scheduleBake()
        }
        if (this.appearanceDirty) {
          this.appearanceDirty = false
          this.appearanceChanged()
        }
        this.onChange()
      })
  }

  private scheduleBake() {
    if (this.stopped || this.bakeFrame || !this.bakeQueue.length) return
    this.bakeFrame = requestAnimationFrame(() => {
      this.bakeFrame = 0
      // Leave headroom below C2's 8ms ceiling for texture publication and GC safepoints.
      const deadline = performance.now() + 2
      while (this.bakeQueue.length && performance.now() < deadline) {
        const stone = this.bakeQueue[0]
        this.currentBake ??= { stone, bake: settingBake(stone.placed, this.blocked) }
        if (!this.currentBake.bake.step(deadline)) break
        const texture = this.currentBake.bake.texture()
        stone.map?.dispose()
        stone.map = texture
        this.updateStone(stone)
        this.currentBake = null
        this.bakeQueue.shift()
      }
      if (this.bakeQueue.length) this.scheduleBake()
    })
  }

  dispose() {
    this.stopped = true
    for (const request of this.pending.values()) request.abort()
    clearTimeout(this.retryTimer)
    cancelAnimationFrame(this.flushFrame)
    cancelAnimationFrame(this.bakeFrame)
    for (const entry of this.entries.values()) this.disposeEntry(entry)
    this.entries.clear()
    this.bakeQueue = []
    this.currentBake = null
    this.newStones.clear()
    this.blocked = () => false
    this.blocks = undefined
    this.textures = undefined
    this.failures.clear()
    this.retries.clear()
    this.queue = []
    this.root.clear()
    this.metal.dispose()
    for (const material of this.materials.values()) {
      material.map?.dispose()
      material.dispose()
    }
    this.materials.clear()
    for (const image of this.images.values()) {
      image.controller.abort()
      if (image.texture) releaseTexture(image.texture)
    }
    this.images.clear()
  }
}

export function LiveModel({ scene }: { scene: LiveScene }) {
  const env = useGemEnv()
  useLayoutEffect(() => {
    scene.setEnvironment(env)
  }, [scene, env])
  return <primitive object={scene.root} dispose={null} />
}

export function LiveFloorShadow({ scene }: { scene: LiveScene }) {
  const appearance = useSyncExternalStore(scene.onAppearance, () => scene.appearance)
  if (!config.floorShadow) return null
  return <ContactFloorShadow box={appearance.box} revision={appearance.revision} settings={config.floorShadow} />
}
