import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { gzipSync, gunzipSync } from 'node:zlib'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import * as THREE from 'three'

// 실제 TS 구현을 실행하되 WebGL·React 마운트는 필요하지 않다.
function compile(path, dependencies, globals = {}) {
  const code = ts.transpileModule(readFileSync(path, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText
  const exports = {}
  runInNewContext(
    code,
    {
      exports,
      require: (id) => {
        assert.ok(id in dependencies, `예상하지 않은 의존성: ${id}`)
        return dependencies[id]
      },
      Blob,
      Response,
      DecompressionStream,
      TextDecoder,
      Uint8Array,
      ArrayBuffer,
      DataView,
      atob,
      AbortController,
      performance,
      setTimeout,
      clearTimeout,
      ...globals,
    },
    { filename: path },
  )
  return exports
}

// createImageBitmap은 브라우저 전용이다. 디코드 대신 받은 바이트·옵션·close를 기록한다.
const bitmaps = []
const imageBytes = []
let imageSize = [512, 256]
let imageGate = null
async function createImageBitmap(source, options = {}) {
  await imageGate
  if (source instanceof Blob) imageBytes.push(new Uint8Array(await source.arrayBuffer()))
  const bitmap = {
    width: options.resizeWidth ?? imageSize[0],
    height: options.resizeHeight ?? imageSize[1],
    options,
    closed: false,
    close() {
      this.closed = true
    },
  }
  bitmaps.push(bitmap)
  return bitmap
}
const protocol = compile('src/components/viewer/sceneProtocol.ts', { three: THREE }, { createImageBitmap })
const bytes = new Uint8Array(readFileSync(process.argv[2]))
const manifest = JSON.parse(readFileSync(process.argv[3], 'utf8'))
const id = '00112233-4455-6677-8899-aabbccddeeff'
const texturedId = 'ffeeddcc-bbaa-9988-7766-554433221100'
const textured = manifest.materials[texturedId]
assert.equal(textured.kind, 1)
assert.deepEqual(textured.colorMap.transform, [2, 0, -0.2, 0, 3, -0.6])
assert.equal(protocol.validateManifest(manifest), manifest)
const decoded = await protocol.decodeObject(bytes)
assert.equal(decoded.parts[0].materialId, '00000000-0000-0000-0000-000000000000')
assert.equal(decoded.parts[1].materialId, id)
assert.equal(decoded.parts[1].kind, manifest.materials[id].kind)
assert.equal(decoded.parts[1].geometry.getAttribute('position').count, 3)
assert.deepEqual([...decoded.parts[0].geometry.getAttribute('uv').array], [0, 0, 1, 0, 0, 1])
assert.equal(decoded.parts[1].geometry.getAttribute('uv'), undefined)
assert.deepEqual(Array.from(decoded.parts, (part) => part.smooth), [false, true])
decoded.parts.forEach((part) => part.geometry.dispose())
for (const change of [
  (m) => {
    delete m.materials
  },
  (m) => {
    m.materials = []
  },
  (m) => {
    m.materials[id].color = [1, NaN, 0]
  },
  (m) => {
    m.materials[id].ior = Infinity
  },
  (m) => {
    m.materials[id].opacity = -1
  },
  (m) => {
    m.materials[id].kind = 0
  },
  (m) => {
    m.materials.invalid = m.materials[id]
  },
  (m) => {
    delete m.materials[texturedId].colorMap
  },
  (m) => {
    m.materials[texturedId].colorMap.texture = '../state.json'
  },
  (m) => {
    m.materials[texturedId].colorMap.transform.pop()
  },
  (m) => {
    m.materials[texturedId].colorMap.transform[2] = NaN
  },
]) {
  const invalid = structuredClone(manifest)
  change(invalid)
  assert.throws(() => protocol.validateManifest(invalid))
}
const raw = gunzipSync(bytes)
const second = 32 + 28 + raw.readUInt32LE(52) * (raw[33] & 1 ? 32 : 24) + raw.readUInt32LE(56) * 4
for (const change of [
  (b) => {
    b[3] = 0x32
  },
  (b) => {
    b[33] = 0
  },
  (b) => {
    b[34] = 1
  },
  (b) => {
    b[32] = 3
  },
  (b) => {
    b[second + 1] = 4
  },
  (b) => {
    b.writeFloatLE(NaN, 32 + 28 + 3 * 24)
  },
]) {
  const invalid = Buffer.from(raw)
  change(invalid)
  await assert.rejects(protocol.decodeObject(new Uint8Array(gzipSync(invalid))))
}
const rvs = readFileSync(resolve(dirname(process.argv[2]), 'material.rvs'))
const exported = protocol.decodeExport(rvs.toString('base64'))
assert.equal(exported.manifest.materials[id].ior, 1.76)
const block = await protocol.decodeObject([...exported.blocks.values()][0])
assert.equal(block.parts[1].materialId, id)
assert.equal(block.parts[1].smooth, true)
block.parts.forEach((part) => part.geometry.dispose())
const textureBytes = exported.textures.get(textured.colorMap.texture)
assert.deepEqual([...textureBytes], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
imageSize = [4096, 1024]
const large = await protocol.decodeTexture(textureBytes)
assert.deepEqual([large.image.width, large.image.height], [2048, 512])
assert.equal(bitmaps[0].closed, true)
assert.equal(bitmaps[0].options.imageOrientation, 'flipY')
assert.equal(large.colorSpace, THREE.SRGBColorSpace)
assert.equal(large.wrapS, THREE.RepeatWrapping)
large.dispose()
bitmaps.length = imageBytes.length = 0
imageSize = [512, 256]

class TestDiamond extends THREE.MeshBasicMaterial {
  constructor() {
    super()
  }
  update(options) {
    this.color.set(options.color ?? '#fff')
    this.ior = options.ior
  }
}
let bakes = 0
const splitSmooth = []
let frame = 0
const frames = new Map()
const fetched = []
const floor = compile('src/components/canvas/ContactFloorShadow.tsx', {
  three: THREE,
  react: {},
  'react/jsx-runtime': {},
  '@react-three/fiber': {},
  'three/examples/jsm/postprocessing/Pass.js': {},
  'three/examples/jsm/shaders/HorizontalBlurShader.js': {},
  'three/examples/jsm/shaders/VerticalBlurShader.js': {},
})
const live = compile(
  'src/components/viewer/LiveModel.tsx',
  {
    three: THREE,
    react: {},
    'react/jsx-runtime': {},
    '@/config': { ringPlusplasticConfig: { metal: { envMapIntensity: 0.8 }, diamond: {} } },
    '../canvas/gem/DiamondMaterial': { DiamondMaterial: TestDiamond },
    '../canvas/gem/gemGeometry': {
      splitFacetedStones: (geometry, smooth) => {
        splitSmooth.push(smooth)
        const copy = geometry.clone()
        copy.computeBoundingSphere()
        return [copy]
      },
    },
    '../canvas/gem/GemEnvironment': {},
    '../canvas/gem/settingOcclusion': {
      createOccluder: ({ geometry }) => ({ geometry: geometry.clone() }),
      occluderIndex: () => {
        bakes++
        return () => false
      },
    },
    '../canvas/jewelryMaterials': {
      createMetalMaterial: (v) => new THREE.MeshPhysicalMaterial(v),
      gemControlDefaults: () => ({}),
      gemMaterialOptions: () => ({ center: { color: '#fff', ior: 2.417 }, pave: {} }),
      connectedGemOptions: (options) => options,
    },
    './sceneProtocol': protocol,
    '../canvas/ContactFloorShadow': floor,
  },
  {
    requestAnimationFrame: (callback) => {
      frames.set(++frame, callback)
      return frame
    },
    cancelAnimationFrame: (id) => frames.delete(id),
    fetch: async (url) => {
      fetched.push(url)
      const bytes = exported.textures.get(url.split('/').pop())
      return bytes ? { ok: true, status: 200, arrayBuffer: async () => bytes.slice().buffer } : { ok: false, status: 404 }
    },
  },
)
const flush = () => {
  const pending = [...frames.values()]
  frames.clear()
  pending.forEach((callback) => callback())
}
const refs = [{ id: 'object', rev: 1, url: '' }]
async function loadScene(materials, payload, textures) {
  const scene = new live.LiveScene()
  scene.setEnvironment({})
  scene.reconcile({ ...manifest, materials, objects: refs }, new Map([['object', payload]]), textures)
  while (scene.active) await new Promise((done) => setTimeout(done, 1))
  flush()
  return scene
}
const gems = await loadScene(manifest.materials, bytes)
const gemEntry = gems.entries.get('object')
const stone = gemEntry.stones[0]
const ruby = new THREE.Color().setRGB(0.878, 0.067, 0.373, THREE.SRGBColorSpace)
assert.ok(stone.mesh.material.color.equals(ruby))
assert.equal(stone.mesh.material.ior, 1.76)
assert.equal(gemEntry.group.children[0].material, gems.metal)

// 같은 id인 일반 리프 두 개도 실제 RVM3 디코드·load 경로로 만든다.
const generalRaw = Buffer.from(raw)
generalRaw[32] = generalRaw[second] = 1
generalRaw.copy(generalRaw, 36, second + 4, second + 20)
const faceted = Buffer.from(raw)
faceted[second + 1] = 0
const facetedScene = await loadScene(manifest.materials, new Uint8Array(gzipSync(faceted)))
assert.deepEqual(splitSmooth, [true, false])
facetedScene.dispose()
// 둥근 플래그가 켜진 파트만 입력 정점 법선(Rhino 렌더메시)을 스톤별로 옮기고, 꺼진 파트는 면 법선이다.
const gemGeometry = compile('src/components/canvas/gem/gemGeometry.ts', { three: THREE })
const lathe = (profile) =>
  new THREE.LatheGeometry(profile.map(([x, y]) => new THREE.Vector2(x, y)), 8).toNonIndexed().getAttribute('position')
    .array
const cabochonPositions = []
const cabochonNormals = []
for (const x of [0, 5]) {
  const dome = lathe([
    [1, 0],
    [0.7, 0.7],
    [0, 1],
  ])
  const base = lathe([
    [0, 0],
    [1, 0],
  ])
  for (let i = 0; i < dome.length; i += 3) {
    cabochonPositions.push(dome[i] + x, dome[i + 1], dome[i + 2])
    cabochonNormals.push(dome[i], dome[i + 1], dome[i + 2])
  }
  for (let i = 0; i < base.length; i += 3) {
    cabochonPositions.push(base[i] + x, base[i + 1], base[i + 2])
    cabochonNormals.push(0, -1, 0)
  }
}
const cabochons = new THREE.BufferGeometry()
cabochons.setAttribute('position', new THREE.Float32BufferAttribute(cabochonPositions, 3))
cabochons.setAttribute('normal', new THREE.Float32BufferAttribute(cabochonNormals, 3))
cabochons.setIndex([...Array(cabochonPositions.length / 3).keys()])
const triangle = (array, tri) => String([...array.slice(tri * 9, tri * 9 + 9)])
const inputNormals = new Map()
for (let tri = 0; tri < cabochonPositions.length / 9; tri++)
  inputNormals.set(
    triangle(cabochons.getAttribute('position').array, tri),
    triangle(cabochons.getAttribute('normal').array, tri),
  )
const smoothStones = gemGeometry.splitFacetedStones(cabochons, true)
assert.equal(smoothStones.length, 2)
for (const stone of smoothStones) {
  assert.equal(stone.userData.smoothNormals, true)
  const position = stone.getAttribute('position').array
  for (let tri = 0; tri < position.length / 9; tri++)
    assert.equal(triangle(stone.getAttribute('normal').array, tri), inputNormals.get(triangle(position, tri)))
}
for (const stone of gemGeometry.splitFacetedStones(cabochons)) {
  assert.equal(stone.userData.smoothNormals, undefined)
  const faceted = stone.clone()
  faceted.deleteAttribute('normal')
  faceted.computeVertexNormals()
  assert.deepEqual([...stone.getAttribute('normal').array], [...faceted.getAttribute('normal').array])
}
const updated = structuredClone(manifest)
updated.materials[id] = { ...updated.materials[id], kind: 1, color: [0.1, 0.2, 0.3], opacity: 0.25 }
const scene = await loadScene(updated.materials, new Uint8Array(gzipSync(generalRaw)))
const entry = scene.entries.get('object')
assert.equal(entry.stones.length, 0)
assert.equal(entry.surfaces.length, 2)
assert.equal(entry.occluders.length, 2)
const [surface1, surface2] = entry.surfaces.map((surface) => surface.mesh)
const shared = surface1.material
assert.equal(shared, surface2.material)
assert.equal(shared.transmission, 0.75)
assert.equal(shared.ior, 1.76)
assert.equal(shared.envMapIntensity, 0.8)
const baked = bakes
updated.materials[id].color = [0.8, 0.2, 0.1]
updated.materials[id].ior = 1.577
scene.reconcile({ ...updated, version: 3, objects: refs })
flush()
assert.equal(surface1.material, shared)
assert.equal(shared.ior, 1.577)
assert.equal(bakes, baked)
assert.ok(shared.color.equals(new THREE.Color().setRGB(0.8, 0.2, 0.1, THREE.SRGBColorSpace)))
gems.reconcile({
  ...updated,
  materials: { [id]: { ...updated.materials[id], kind: 2 } },
  version: 3,
  objects: refs,
})
flush()
gems.setEnvironment({})
assert.equal(stone.mesh.material.ior, 1.577)
assert.ok(stone.mesh.material.color.equals(shared.color))
assert.equal(bakes, baked)
// 불투명이면 Rhino의 IOR=1을 쓰지 않고, 투과와 왕복해도 기본값으로 돌아온다.
updated.materials[id].opacity = 1
updated.materials[id].ior = 1
scene.reconcile({ ...updated, version: 4, objects: refs })
flush()
assert.equal(surface1.material, shared)
assert.equal(shared.transmission, 0)
assert.equal(shared.ior, 1.5)
updated.materials[id].opacity = 0.5
updated.materials[id].ior = 1.523
scene.reconcile({ ...updated, version: 5, objects: refs })
flush()
assert.equal(shared.transmission, 0.5)
assert.equal(shared.ior, 1.523)
updated.materials[id].opacity = 1
updated.materials[id].ior = 1
scene.reconcile({ ...updated, version: 6, objects: refs })
flush()
assert.equal(shared.transmission, 0)
assert.equal(shared.ior, 1.5)
assert.equal(bakes, baked)
let disposed = 0
shared.addEventListener('dispose', () => disposed++)
scene.reconcile({ ...updated, materials: {}, version: 7, objects: refs })
flush()
assert.equal(surface1.material, scene.metal)
assert.equal(disposed, 1)
scene.reconcile({ ...updated, version: 8, objects: refs })
flush()
const unused = surface1.material
let unusedDisposed = 0
unused.addEventListener('dispose', () => unusedDisposed++)
scene.reconcile({ ...updated, version: 9, objects: [] })
flush()
assert.equal(unusedDisposed, 1)
scene.dispose()
gems.dispose()

// 색 맵: 내보내기는 RVS1 텍스처 블록, 라이브는 /live/tex/<hash>에서 같은 이미지를 받아 map에 건다.
for (const textures of [exported.textures, undefined]) {
  fetched.length = bitmaps.length = imageBytes.length = 0
  let releaseImage
  imageGate = new Promise((done) => (releaseImage = done))
  const scene = await loadScene({ [id]: structuredClone(textured) }, new Uint8Array(gzipSync(generalRaw)), textures)
  const material = scene.entries.get('object').surfaces[0].mesh.material
  const untextured = scene.appearance.revision
  releaseImage()
  while (!scene.images.get(textured.colorMap.texture)?.texture) await new Promise((done) => setTimeout(done, 1))
  flush()
  assert.equal(scene.appearance.revision, untextured + 1)
  assert.deepEqual(fetched, textures ? [] : [`/live/tex/${textured.colorMap.texture}`])
  assert.deepEqual([...imageBytes[0]], [...textureBytes])
  assert.equal(material.map.image, bitmaps[0])
  assert.equal(material.map.colorSpace, THREE.SRGBColorSpace)
  assert.equal(material.version, 1)
  const [a, b, c, d, e, f] = textured.colorMap.transform
  assert.deepEqual(material.map.matrix.elements, [a, d, 0, b, e, 0, c, f, 1])
  assert.ok(material.color.equals(new THREE.Color(1, 1, 1)))
  const map = material.map
  let mapDisposed = 0
  map.addEventListener('dispose', () => mapDisposed++)
  const version = material.version
  scene.reconcile({ ...manifest, materials: { [id]: { ...textured, colorMap: null } }, version: 2, objects: refs })
  flush()
  assert.equal(material.map, null)
  assert.equal(material.version, version + 1)
  assert.equal(mapDisposed, 1)
  assert.equal(bitmaps[0].closed, true)
  assert.equal(scene.images.size, 0)
  assert.ok(material.color.equals(new THREE.Color().setRGB(...textured.color, THREE.SRGBColorSpace)))
  scene.dispose()
}

// 보석 환경 조절값이 보석에 비치는 흑백 비율을 바꾼다 — 원점에서 본 white_gem 환경을 방향마다 샘플한다.
const studio = compile('src/components/canvas/gem/studioEnv.ts', { three: THREE })
function sampleStudio(params) {
  const env = studio.buildStudioEnvScene('white_gem', { ...studio.WHITE_GEM_PARAMS, ...params })
  env.updateMatrixWorld(true)
  const dome = env.children.find((obj) => obj.material.isShaderMaterial)
  const props = env.children.filter((obj) => obj !== dome)
  const { topColor, bottomColor, floorY, power } = dome.material.uniforms
  const raycaster = new THREE.Raycaster()
  const samples = 2000
  let dark = 0
  let luminance = 0
  let at60 = 0
  let darkAt60 = 0
  for (let i = 0; i < samples; i++) {
    const y = 1 - (2 * i + 1) / samples
    const phi = i * Math.PI * (3 - Math.sqrt(5))
    const r = Math.sqrt(1 - y * y)
    raycaster.set(new THREE.Vector3(), new THREE.Vector3(Math.cos(phi) * r, y, Math.sin(phi) * r))
    const hit = raycaster.intersectObjects(props, false)[0]
    const t = Math.pow(THREE.MathUtils.clamp((y - floorY.value) / (1 - floorY.value), 0, 1), power.value)
    const color = hit ? hit.object.material.color : bottomColor.value.clone().lerp(topColor.value, t)
    const l = color.r * 0.2126 + color.g * 0.7152 + color.b * 0.0722
    const near60 = Math.abs(THREE.MathUtils.radToDeg(Math.asin(y)) - 60) < 3
    luminance += l
    at60 += near60
    if (l < 0.02) {
      dark++
      darkAt60 += near60
    }
  }
  return { dark: dark / samples, darkAt60: darkAt60 / at60, luminance: luminance / samples }
}
const studioBase = sampleStudio({})
for (const [params, metric] of [
  [{ flagCount: 10 }, 'dark'],
  [{ flagWidth: 10 }, 'dark'],
  [{ ringThickness: 5 }, 'dark'],
  [{ ringElevation: 60 }, 'darkAt60'],
  [{ floorBrightness: 3 }, 'luminance'],
  [{ panelIntensity: 2 }, 'luminance'],
]) {
  const changed = sampleStudio(params)[metric]
  assert.ok(changed - studioBase[metric] > 0.02, `${JSON.stringify(params)} ${metric}: ${studioBase[metric]} → ${changed}`)
}
// 바닥(그림자·컬러 브리딩)은 형상·박스·재질이 바뀔 때만 다시 굽는다 — 같은 내용을 다시 받은 flush는 신호를 내지 않는다.
const watched = new live.LiveScene()
let appearanceSignals = 0
watched.onAppearance(() => appearanceSignals++)
watched.reconcile({ ...manifest, version: 1, objects: [] })
flush()
assert.equal(appearanceSignals, 1)
watched.setEnvironment({})
assert.equal(appearanceSignals, 2)
watched.reconcile({ ...manifest, version: 2, objects: refs }, new Map([['object', bytes]]))
while (watched.active) await new Promise((done) => setTimeout(done, 1))
flush()
assert.equal(appearanceSignals, 3)
assert.ok(watched.appearance.box?.equals(watched.box))
watched.reconcile({ ...structuredClone(manifest), version: 3, objects: refs })
flush()
assert.equal(appearanceSignals, 3)
const recolored = {
  ...manifest,
  materials: { ...manifest.materials, [id]: { ...manifest.materials[id], color: [0.1, 0.2, 0.3] } },
}
watched.reconcile({ ...recolored, version: 4, objects: refs })
flush()
assert.equal(appearanceSignals, 4)
watched.reconcile({ ...recolored, scale: 2, version: 5, objects: refs })
flush()
assert.equal(appearanceSignals, 5)
watched.reconcile({ ...recolored, scale: 2, version: 6, objects: [] })
flush()
assert.equal(appearanceSignals, 6)
assert.equal(watched.appearance.box, null)
watched.dispose()

// 바닥은 박스 바닥면(min y) 중심에 놓이고 크기·그림자 높이는 모델 반경에 비례한다.
const radius = Math.sqrt(116) / 2
const placed = floor.floorFrame(new THREE.Box3(new THREE.Vector3(-1, -2, -3), new THREE.Vector3(3, 4, 5)), {
  scale: 4,
  far: 0.5,
})
assert.deepEqual(
  { center: placed.center.toArray(), size: placed.size, far: placed.far },
  { center: [1, -2, 1], size: radius * 4, far: radius * 0.5 },
)

// 컬러 브리딩 색 패스는 금속 환경을 비추므로, 첫 굽기 뒤에 HDR이 도착하면 같은 바닥을 다시 굽는다.
const hdr = new THREE.Texture()
assert.equal(floor.bakeDue(null, null, hdr), false)
assert.equal(floor.bakeDue(placed, null, null), true)
assert.equal(floor.bakeDue(placed, { frame: placed, environment: null }, null), false)
assert.equal(floor.bakeDue(placed, { frame: placed, environment: null }, hdr), true)
assert.equal(floor.bakeDue({ ...placed }, { frame: placed, environment: hdr }, hdr), true)
