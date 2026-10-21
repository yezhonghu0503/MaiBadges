import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';

const source = await readFile(new URL('../plugins/work-badges/runtime/holo-engine.js', import.meta.url), 'utf8');
const imageData = 'data:image/png;base64,YQ==';
const assets = Object.fromEntries(['character', 'background', 'ui', 'structure'].map(name => [name, imageData]));

function harness({ shaderFailure = false, imageFailure = false, delayImages = false } = {}) {
  const created = [], deleted = [], listeners = new Map(), images = [], shaderSources = [], uniforms = new Map();
  let draws = 0, nextId = 0;
  const constants = ['ARRAY_BUFFER', 'STATIC_DRAW', 'VERTEX_SHADER', 'FRAGMENT_SHADER', 'COMPILE_STATUS', 'LINK_STATUS',
    'TEXTURE_2D', 'TEXTURE_MIN_FILTER', 'TEXTURE_MAG_FILTER', 'TEXTURE_WRAP_S', 'TEXTURE_WRAP_T', 'CLAMP_TO_EDGE',
    'LINEAR', 'NEAREST', 'UNPACK_FLIP_Y_WEBGL', 'RGBA', 'UNSIGNED_BYTE', 'FRAMEBUFFER', 'COLOR_ATTACHMENT0',
    'FRAMEBUFFER_COMPLETE', 'MAX_TEXTURE_SIZE', 'FLOAT', 'TEXTURE0', 'TRIANGLES', 'COLOR_BUFFER_BIT'];
  const gl = Object.fromEntries(constants.map((name, index) => [name, index + 1]));
  for (const kind of ['Buffer', 'Shader', 'Program', 'Texture', 'Framebuffer']) {
    gl['create' + kind] = () => { const item = { kind, id: ++nextId }; created.push(item); return item; };
    gl['delete' + kind] = item => deleted.push(item);
  }
  for (const name of ['bindBuffer', 'bufferData', 'shaderSource', 'compileShader', 'attachShader', 'linkProgram',
    'bindTexture', 'texParameteri', 'pixelStorei', 'texImage2D', 'useProgram', 'enableVertexAttribArray',
    'vertexAttribPointer', 'bindFramebuffer', 'framebufferTexture2D', 'uniform1f', 'uniform1i', 'uniform2f',
    'activeTexture', 'viewport', 'clearColor', 'clear']) gl[name] = () => {};
  gl.shaderSource = (_, code) => shaderSources.push(code);
  gl.uniform1f = (name, value) => uniforms.set(name, value);
  gl.getShaderParameter = () => !shaderFailure;
  gl.getProgramParameter = () => true;
  gl.getAttribLocation = () => 0;
  gl.getUniformLocation = (_, name) => name;
  gl.checkFramebufferStatus = () => gl.FRAMEBUFFER_COMPLETE;
  gl.getParameter = () => 4096;
  gl.isContextLost = () => false;
  gl.drawArrays = () => { draws++; };
  const canvas = {
    width: 0, height: 0,
    getContext: () => gl,
    getBoundingClientRect: () => ({ width: 600 }),
    addEventListener: (name, fn) => listeners.set(name, fn),
    removeEventListener: (name, fn) => { if (listeners.get(name) === fn) listeners.delete(name); },
  };
  class FakeImage {
    constructor() { this.naturalWidth = 800; this.naturalHeight = 1120; images.push(this); }
    set src(value) {
      this.value = value;
      if (value && !delayImages) queueMicrotask(() => imageFailure ? this.onerror?.() : this.onload?.());
    }
  }
  const context = vm.createContext({ Image: FakeImage, devicePixelRatio: 3, AbortController,
    setTimeout: () => { throw new Error('Engine must not schedule timers'); },
    requestAnimationFrame: () => { throw new Error('Engine must not schedule animation frames'); } });
  vm.runInContext(source + '\n globalThis.factory = createBadgeHoloRenderer;', context);
  return { factory: context.factory, canvas, gl, created, deleted, listeners, images, shaderSources, uniforms, get draws() { return draws; } };
}

test('real six-pass pipeline renders on change, caps backing size, then fully disposes', async () => {
  const h = harness(); const api = await h.factory(h.canvas, assets, { width: 5000 });
  assert.equal(h.canvas.width, 800); assert.equal(h.canvas.height, 1120);
  assert.equal(h.draws, 6); assert.equal(api.setView({}), false);
  api.setView({ x: 8, y: -12, active: true }); assert.equal(h.draws, 12);
  api.setView({ x: 8, y: -12, active: true }); assert.equal(h.draws, 12);
  api.draw(); assert.equal(h.draws, 18);
  api.dispose(); api.dispose(); api.setView({ x: 5 }); api.draw();
  assert.equal(h.draws, 18); assert.equal(h.listeners.size, 0);
  assert.deepEqual(h.deleted.map(item => item.id).sort((a, b) => a - b), h.created.map(item => item.id));
});

test('partial shader compilation failure releases programs, shaders and buffers', async () => {
  const h = harness({ shaderFailure: true });
  await assert.rejects(h.factory(h.canvas, assets), /compilation failed/);
  assert.equal(h.listeners.size, 0); assert.equal(h.draws, 0);
  assert.deepEqual(h.deleted.map(item => item.id).sort((a, b) => a - b), h.created.map(item => item.id));
});

test('one failed image cancels every pending image and releases listeners', async () => {
  const h = harness({ imageFailure: true });
  await assert.rejects(h.factory(h.canvas, assets), /layer unavailable/);
  assert.equal(h.listeners.size, 0); assert.equal(h.draws, 0);
  assert.ok(h.images.every(image => image.onload === null && image.onerror === null));
});

test('abort during asynchronous image loading rejects promptly without residual handlers', async () => {
  const h = harness({ delayImages: true }); const controller = new AbortController();
  const pending = h.factory(h.canvas, assets, { signal: controller.signal }); controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(h.listeners.size, 0); assert.equal(h.draws, 0);
  assert.ok(h.images.every(image => image.onload === null && image.onerror === null));
});

test('context loss notifies once, removes own resources and leaves methods safe', async () => {
  const h = harness(); let notified = 0;
  const api = await h.factory(h.canvas, assets, { onLost: () => { notified++; } });
  const lost = h.listeners.get('webglcontextlost'); let prevented = 0;
  lost({ preventDefault: () => prevented++ });
  lost({ preventDefault: () => prevented++ });
  assert.equal(notified, 1); assert.equal(prevented, 2);
  assert.equal(api.draw(), false); assert.equal(api.setView({ x: 20 }), false);
  assert.equal(h.listeners.size, 0);
  assert.equal(new Set(h.deleted.map(item => item.id)).size, h.created.length);
});

test('invalid sources never make external requests or allocate GPU objects', async () => {
  const h = harness();
  await assert.rejects(h.factory(h.canvas, { ...assets, background: 'https://example.test/image.png' }), /local RGBA PNG/);
  assert.equal(h.created.length, 0); assert.equal(h.images.length, 0);
});

test('foreground protection accepts zero, clamps independently, and preserves legacy defaults', async () => {
  for (const [options, expected] of [
    [{}, [1, 1]],
    [{ foregroundFoil: 0, subjectGlow: 0 }, [0, 0]],
    [{ foregroundFoil: .2, subjectGlow: .35 }, [.2, .35]],
    [{ foregroundFoil: -2, subjectGlow: 6 }, [0, 1]],
    [{ foregroundFoil: Infinity, subjectGlow: NaN }, [1, 1]],
  ]) {
    const h = harness(), api = await h.factory(h.canvas, assets, options);
    assert.deepEqual([h.uniforms.get('foregroundFoil'), h.uniforms.get('subjectGlow')], expected);
    assert.equal(h.draws, 6);
    api.setView({ x: -18, y: 22, active: true });
    assert.deepEqual([h.uniforms.get('foregroundFoil'), h.uniforms.get('subjectGlow')], expected);
    assert.equal(h.draws, 12);
    api.dispose();
    assert.equal(h.deleted.length, h.created.length);
  }
});

test('structure masks reject opaque black interiors without changing white alpha coverage', async () => {
  const h = harness(), api = await h.factory(h.canvas, assets);
  const fragment = h.shaderSources.find(code => code.includes('float structure('));
  // This input contract prevents an opaque white-on-black structure plate
  // from turning every skin/clothing pixel into a 40x HDR emitter again.
  const weights = fragment.match(/return dot\(c\.rgb,vec3\(([^)]+)\)\)\*c\.a;/)?.[1].split(',').map(Number);
  assert.ok(weights?.length === 3, 'Structure coverage must combine luminance and alpha');
  const coverage = ([r, g, b, a]) => (r * weights[0] + g * weights[1] + b * weights[2]) * a;
  assert.equal(coverage([0, 0, 0, 1]), 0, 'opaque black mask interior stays dark');
  assert.equal(coverage([1, 1, 1, 1]), 1, 'opaque white structural line is retained');
  assert.equal(coverage([1, 1, 1, .3]), .3, 'legacy white alpha line retains its original coverage');
  assert.equal(coverage([1, 1, 1, 0]), 0, 'transparent overscan cannot emit');
  api.dispose();
});
