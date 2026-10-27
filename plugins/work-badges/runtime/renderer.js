/* Original work-badge renderer. Import defines an API only; it never reads chats. */
(() => {
  'use strict';
  /* Adapted from LerSent001/holo-card, commit 9d2b79997c2cb97453777ea6225b369e747cb1ce.
 * Copyright (c) 2026 Holo Card contributors. MIT; see ../licenses/Holo-Card-MIT.txt.
 * Actual upstream layered WebGL/HDR renderer. Host owns accessible DOM text,
 * flipping, dragging and persistence. Canvas uses the upstream 160% overscan.
 * No window registration, timers, continuous RAF, network loads or page reads.
 */
async function createBadgeHoloRenderer(canvas, assets, options = {}) {
  const vertex = `attribute vec2 position; varying vec2 uv; void main(){uv=position*.5+.5;gl_Position=vec4(position,0.,1.);}`;
  const fragment = `precision highp float;
  varying vec2 uv; uniform sampler2D art,bg,uiTex,bloomNear,bloomWide,structureTex; uniform float extracted, cardAspect; uniform vec2 view; uniform float depth, contourBrightness, power, glowPass, pixelWidth, foregroundFoil, subjectGlow;
  vec4 encodeHDR(vec3 c){float m=clamp(ceil(max(max(c.r,c.g),c.b)/64.*255.)/255.,1./255.,1.);return vec4(c/(64.*m),m);}
  vec3 decodeHDR(vec4 c){return c.rgb*c.a*64.;}
  vec3 hsv(vec3 c){vec4 K=vec4(0.,-1./3.,2./3.,-1.);vec4 p=mix(vec4(c.bg,K.wz),vec4(c.gb,K.xy),step(c.b,c.g));vec4 q=mix(vec4(p.xyw,c.r),vec4(c.r,p.yzx),step(p.x,c.r));float d=q.x-min(q.w,q.y);return vec3(abs(q.z+(q.w-q.y)/(6.*d+.00001)),d/(q.x+.00001),q.x);}
  float ink(vec2 p){vec4 c=texture2D(art,p);vec3 h=hsv(pow(c.rgb,vec3(2.2)));return smoothstep(.035,.065,h.x)*(1.-smoothstep(.17,.21,h.x))*smoothstep(.4,.67,h.y)*smoothstep(.065,.25,h.z)*c.a;}
  // Structure inputs may be white alpha lines OR opaque white-on-black masks.
  // Alpha alone turns every black interior of an opaque mask into HDR emission.
  float structure(vec2 p){if(extracted>.5){vec4 c=texture2D(structureTex,p);return dot(c.rgb,vec3(.2126,.7152,.0722))*c.a;}float a=ink(p);float b=min(min(ink(p+vec2(.0025,0.)),ink(p-vec2(.0025,0.))),min(ink(p+vec2(0.,.0018)),ink(p-vec2(0.,.0018))));return smoothstep(.025,.22,max(0.,a-b));}
  vec3 rainbow(float t){return .52+.48*cos(6.28318*(t+vec3(0.,.33,.67)));}
  float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
  float band(vec2 p){float f=p.x*.65+p.y*.4+view.x*1.9+view.y*.85;return pow(max(0.,1.-abs(fract(f+.16)-.5)*2.),3.);}
  void main(){
   vec2 p=(uv-.5)*1.6+.5;vec2 u=p;
   vec2 edge=abs((p-.5)*vec2(1.,cardAspect))-(vec2(.5,cardAspect*.5)-vec2(.045));
   float edgeDistance=length(max(edge,0.))+min(max(edge.x,edge.y),0.)-.045;
   float cardMask=1.-smoothstep(-pixelWidth,pixelWidth,edgeDistance);
   float foregroundMask=depth>0.?1.:cardMask;vec2 a=(p-.5)*1.25+.5+view*.40;vec2 b=(p-.5)*.5+.5-view*.25;
   if(extracted>.5){a=p-view*(depth<0.?.06:.08)*depth;u=p-view*.14*max(depth,0.);b=(p-.5)*.5+.5-view*.25;}
   vec4 ch=texture2D(art,a);ch.a*=step(0.,a.x)*step(a.x,1.)*step(0.,a.y)*step(a.y,1.);
   ch.a*=foregroundMask;
   vec4 background=texture2D(bg,b);background.a*=cardMask;background.a*=step(0.,b.x)*step(b.x,1.)*step(0.,b.y)*step(b.y,1.);
   float baseAlpha=cardMask+(1.-cardMask)*ch.a;
   vec3 base=mix(background.rgb*cardMask,ch.rgb,ch.a);
   vec3 ui=texture2D(uiTex,u).rgb;vec3 uh=hsv(ui);float um=max(smoothstep(.105,.23,uh.y),1.-smoothstep(.35,.62,uh.z));
   if(extracted>.5)um=texture2D(uiTex,u).a*step(0.,u.x)*step(u.x,1.)*step(0.,u.y)*step(u.y,1.);
   // The text/frame plate has its own rounded boundary, moving with its UVs.
   vec2 uiEdge=abs((u-.5)*vec2(1.,cardAspect))-(vec2(.5,cardAspect*.5)-vec2(.045));
   float uiDistance=length(max(uiEdge,0.))+min(max(uiEdge.x,uiEdge.y),0.)-.045;
   float uiMask=1.-smoothstep(-pixelWidth,pixelWidth,uiDistance);
   um*=uiMask*foregroundMask;
   float finalAlpha=clamp(baseAlpha+(1.-baseAlpha)*um,0.,1.);
   // Transparent overscan must contain zero RGB, including on Safari/Metal.
   if(finalAlpha<=0.){gl_FragColor=glowPass>.5?encodeHDR(vec3(0.)):vec4(0.);return;}
   float phase=p.x*.62+p.y*.36+view.x*1.9+view.y*.8;
   vec3 spectrum=rainbow(phase*2.2);float light=band(p);
   float micro=pow(hash(floor(p*vec2(620.,868.))),28.);
   // At zero foreground foil, opaque subject pixels retain their original RGB.
   // Background foil and sparkles remain independent of the subject setting.
   float foilCoverage=mix(1.,foregroundFoil,ch.a);
   base=mix(base,base*(.64+spectrum*.7)+spectrum*.07*baseAlpha,light*.48*power*foilCoverage);
   float line=structure(a)*ch.a;
   float envelope=smoothstep(.025,.42,light);
   vec3 emission=(spectrum*.85+vec3(.15))*line*envelope*power*40.*contourBrightness*subjectGlow;
   vec2 cell=fract(p*vec2(24.,34.))-.5;float seed=hash(floor(p*vec2(24.,34.)));float star=pow(max(0.,1.-abs(cell.x)*18.),14.)*pow(max(0.,1.-abs(cell.y)*2.),6.)+pow(max(0.,1.-abs(cell.y)*18.),14.)*pow(max(0.,1.-abs(cell.x)*2.),6.);
   base+=spectrum*(star*step(.965,seed)*light*.65+micro*light*.12)*power*(1.-ch.a)*cardMask;
   base=mix(base,ui,um);
  
   float glare=pow(max(0.,1.-length((p-vec2(.5+view.x,.6+view.y))*vec2(1.,.75))),5.);
   base+=vec3(glare*.12*power*foilCoverage)*finalAlpha;
   base/=max(finalAlpha,.0001);
   // Concentric rounded border in card-width units, matching the CSS outer radius.
   // Outer radius .045, uniform inset .015, inner radius .030.
   vec2 corner=abs((p-.5)*vec2(1.,cardAspect))-(vec2(.485,cardAspect*.5-.015)-vec2(.030));
   float distanceToInner=length(max(corner,0.))+min(max(corner.x,corner.y),0.)-.030;
   float inside=1.-smoothstep(-pixelWidth,pixelWidth,distanceToInner);
   float rim=(1.-inside)*(1.-extracted);
   base=mix(base,mix(vec3(.76,.67,.32),spectrum*.5+.5,.35*power)+glare*.15,rim);
   emission*=(1.-um)*foregroundMask;
   if(glowPass>.5){gl_FragColor=encodeHDR(max(emission-vec3(1.),vec3(0.)));return;}
   vec3 bloom=decodeHDR(texture2D(bloomNear,uv))*.55+decodeHDR(texture2D(bloomWide,uv))*.8;
   bloom*=foregroundMask*(1.-um)*line;
   // Display mapping is applied AFTER the HDR light and two-scale bloom are composed.
   vec3 linear=pow(clamp(base,0.,1.),vec3(2.2));
   vec3 combined=1.-(1.-linear)*exp(-(emission*.38+bloom*.85));
   gl_FragColor=vec4(pow(clamp(combined,0.,1.),vec3(1./2.2))*finalAlpha,finalAlpha);
  }`;
  const blurFragment = `precision highp float; varying vec2 uv;uniform sampler2D source;uniform vec2 stepSize;
  vec3 decodeHDR(vec4 c){return c.rgb*c.a*64.;}
  vec4 encodeHDR(vec3 c){float m=clamp(ceil(max(max(c.r,c.g),c.b)/64.*255.)/255.,1./255.,1.);return vec4(c/(64.*m),m);}
  void main(){vec3 c=vec3(0.);float total=0.;for(int i=-4;i<=4;i++){float f=float(i);float w=exp(-f*f/8.);c+=decodeHDR(texture2D(source,uv+stepSize*f))*w;total+=w;}gl_FragColor=encodeHDR(c/total);}`;
  const finite = (value, fallback, min, max) => Number.isFinite(value)
    ? Math.min(max, Math.max(min, value)) : fallback;
  const abortError = () => {
    const error = new Error('Holographic renderer initialization cancelled');
    error.name = 'AbortError';
    return error;
  };
  if (!canvas || typeof canvas.getContext !== 'function') throw new TypeError('Canvas required');
  const names = ['character', 'background', 'ui', 'structure'];
  if (!assets || names.some(name => typeof assets[name] !== 'string'
    || assets[name].length > 12 * 1024 * 1024
    || !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(assets[name])))
    throw new TypeError('Four local RGBA PNG layers required');
  if (options.signal?.aborted) throw abortError();
  const gl = canvas.getContext('webgl', {
    alpha: true, premultipliedAlpha: true, antialias: false,
    powerPreference: 'low-power', preserveDrawingBuffer: false,
  });
  if (!gl) throw new Error('WebGL unavailable');
  const shaders = [], programs = [], textures = [], frames = [], buffers = [];
  const imageCancels = new Set();
  let disposed = false, lost = false, notified = false, ready = false, lastDraw = '';
  let state = { x: 0, y: 0, pointerX: .5, pointerY: .5, active: false };
  const power = finite(options.power, 1.3, 0, 2);
  const depth = finite(options.depth, 1.25, -3, 3);
  const contourBrightness = finite(options.contourBrightness, .15, 0, 1);
  const foregroundFoil = finite(options.foregroundFoil, 1, 0, 1);
  const subjectGlow = finite(options.subjectGlow, 1, 0, 1);

  function release() {
    if (disposed) return;
    disposed = true; ready = false;
    for (const cancel of [...imageCancels]) cancel();
    imageCancels.clear();
    canvas.removeEventListener('webglcontextlost', contextLost);
    options.signal?.removeEventListener('abort', signalAbort);
    // A lost context already owns no usable GL resources. Explicit deletes
    // normally run once, also for partial compilation/upload/FBO failures.
    for (const [items, method] of [[frames, 'deleteFramebuffer'], [textures, 'deleteTexture'],
      [shaders, 'deleteShader'], [programs, 'deleteProgram'], [buffers, 'deleteBuffer']]) {
      for (const item of items) { try { gl[method](item); } catch {} }
      items.length = 0;
    }
    try {
      if (!lost && !gl.isContextLost()) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
      }
    } catch {}
  }
  function notifyLost() {
    if (notified) return;
    notified = true;
    try { options.onLost?.(); } catch {}
  }
  function contextLost(event) {
    event.preventDefault(); lost = true; release(); notifyLost();
  }
  function signalAbort() { release(); }
  canvas.addEventListener('webglcontextlost', contextLost);
  options.signal?.addEventListener('abort', signalAbort, { once: true });
  function assertLive() {
    if (disposed || options.signal?.aborted) throw abortError();
    if (gl.isContextLost()) { lost = true; release(); notifyLost(); throw new Error('WebGL context lost'); }
  }
  function allocate(kind, list, label) {
    assertLive(); const resource = gl[kind]();
    if (!resource) throw new Error(label + ' unavailable');
    list.push(resource); return resource;
  }
  function compile(type, source) {
    assertLive(); const shader = gl.createShader(type);
    if (!shader) throw new Error('Shader unavailable');
    shaders.push(shader); gl.shaderSource(shader, source); gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error('Holographic shader compilation failed');
    return shader;
  }
  function program(source) {
    const p = allocate('createProgram', programs, 'Program');
    gl.attachShader(p, compile(gl.VERTEX_SHADER, vertex));
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, source)); gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('Holographic shader link failed');
    return p;
  }
  function texture(filter) {
    const t = allocate('createTexture', textures, 'Texture');
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }
  function loadImage(source) {
    return new Promise((resolve, reject) => {
      assertLive(); const image = new Image(); let settled = false;
      const finish = (error) => {
        if (settled) return; settled = true;
        image.onload = image.onerror = null; imageCancels.delete(cancel);
        if (error) { try { image.src = ''; } catch {} reject(error); }
        else resolve(image);
      };
      const cancel = () => finish(abortError()); imageCancels.add(cancel);
      image.onload = () => finish();
      image.onerror = () => finish(new Error('Holographic layer unavailable'));
      image.decoding = 'async'; image.src = source;
    });
  }
  try {
    const images = await Promise.all(names.map(name => loadImage(assets[name])));
    assertLive();
    const width = images[0].naturalWidth || images[0].width;
    const height = images[0].naturalHeight || images[0].height;
    const maxTexture = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    if (!width || !height || width > maxTexture || height > maxTexture
      || images.some(image => (image.naturalWidth || image.width) !== width
        || (image.naturalHeight || image.height) !== height))
      throw new Error('Holographic layers must share one supported canvas');
    const buffer = allocate('createBuffer', buffers, 'Vertex buffer');
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
    const scene = program(fragment), blur = program(blurFragment);
    function use(p) {
      gl.useProgram(p); gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      const a = gl.getAttribLocation(p, 'position');
      gl.enableVertexAttribArray(a); gl.vertexAttribPointer(a, 2, gl.FLOAT, false, 0, 0);
    }
    const artTextures = images.map(image => {
      const t = texture(gl.LINEAR); gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image); return t;
    });
    const cssWidth = canvas.getBoundingClientRect?.().width || finite(options.width, 800, 64, 800) / 2;
    const dpr = finite(globalThis.devicePixelRatio, 1, 1, 2);
    canvas.width = Math.round(Math.min(800, finite(options.width, 800, 64, 800), Math.max(64, cssWidth * dpr)));
    canvas.height = Math.round(canvas.width * height / width);
    if (canvas.height > maxTexture) throw new Error('Holographic canvas exceeds GPU limit');
    function target(scale) {
      const w = Math.max(1, Math.round(canvas.width * scale)), h = Math.max(1, Math.round(canvas.height * scale));
      const t = texture(gl.NEAREST);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      const f = allocate('createFramebuffer', frames, 'Framebuffer');
      gl.bindFramebuffer(gl.FRAMEBUFFER, f);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE)
        throw new Error('Holographic bloom framebuffer unavailable');
      return { t, f, w, h };
    }
    const emission = target(.5), temp = target(.5), near = target(.5), wideTemp = target(.25), wide = target(.25);
    const sceneU = Object.fromEntries(['view', 'power', 'depth', 'contourBrightness', 'glowPass', 'foregroundFoil', 'subjectGlow']
      .map(name => [name, gl.getUniformLocation(scene, name)]));
    use(scene); gl.uniform1f(gl.getUniformLocation(scene, 'cardAspect'), height / width);
    gl.uniform1f(gl.getUniformLocation(scene, 'extracted'), 1);
    gl.uniform1i(gl.getUniformLocation(scene, 'structureTex'), 5);
    gl.uniform1f(gl.getUniformLocation(scene, 'pixelWidth'), 1 / canvas.width);
    ['art', 'bg', 'uiTex', 'bloomNear', 'bloomWide'].forEach((name, i) =>
      gl.uniform1i(gl.getUniformLocation(scene, name), i));
    use(blur); gl.uniform1i(gl.getUniformLocation(blur, 'source'), 0);
    const step = gl.getUniformLocation(blur, 'stepSize');
    function bind(t, unit = 0) { gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, t); }
    function blurPass(src, dst, x, y) {
      use(blur); bind(src.t); gl.bindFramebuffer(gl.FRAMEBUFFER, dst.f);
      gl.viewport(0, 0, dst.w, dst.h); gl.uniform2f(step, x / src.w, y / src.h);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }
    function draw() {
      if (disposed || lost || !ready) return false;
      if (gl.isContextLost()) { lost = true; release(); notifyLost(); return false; }
      try {
        use(scene); artTextures.forEach((t, i) => bind(t, i === 3 ? 5 : i)); bind(near.t, 3); bind(wide.t, 4);
        gl.uniform2f(sceneU.view, Math.sin(state.y * Math.PI / 180) * .65, Math.sin(state.x * Math.PI / 180) * .65);
        gl.uniform1f(sceneU.power, power * (state.active ? 1 : .72));
        gl.uniform1f(sceneU.depth, depth); gl.uniform1f(sceneU.contourBrightness, contourBrightness);
        gl.uniform1f(sceneU.foregroundFoil, foregroundFoil); gl.uniform1f(sceneU.subjectGlow, subjectGlow);
        gl.uniform1f(sceneU.glowPass, 1); gl.bindFramebuffer(gl.FRAMEBUFFER, emission.f);
        gl.viewport(0, 0, emission.w, emission.h); gl.drawArrays(gl.TRIANGLES, 0, 6);
        blurPass(emission, temp, 1.2, 0); blurPass(temp, near, 0, 1.2);
        blurPass(near, wideTemp, 5, 0); blurPass(wideTemp, wide, 0, 2.5);
        use(scene); artTextures.forEach((t, i) => bind(t, i === 3 ? 5 : i)); bind(near.t, 3); bind(wide.t, 4);
        gl.uniform1f(sceneU.glowPass, 0); gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, canvas.width, canvas.height); gl.drawArrays(gl.TRIANGLES, 0, 6);
        return true;
      } catch {
        lost = true; release(); notifyLost(); return false;
      }
    }
    function setView(next = {}) {
      if (disposed || lost) return false;
      state = { x: finite(next.x, state.x, -65, 65), y: finite(next.y, state.y, -65, 65),
        pointerX: finite(next.pointerX, state.pointerX, 0, 1), pointerY: finite(next.pointerY, state.pointerY, 0, 1),
        active: typeof next.active === 'boolean' ? next.active : state.active };
      // Quantize well below one visible pixel to avoid idle duplicate passes.
      const signature = [state.x.toFixed(3), state.y.toFixed(3), state.active].join('/');
      if (signature === lastDraw) return false;
      lastDraw = signature; return draw();
    }
    assertLive(); ready = true;
    const api = Object.freeze({ setView, draw, dispose: release });
    setView(); return api;
  } catch (error) { release(); throw error; }
}

  /* Scoped navigation decoration. Native rows, labels, status icons and handlers stay owned by the host. */
function createMaiSidebarCards({signatureForRole, projectTitle = ''} = {}) {
  const token = 'mai-sidebar-' + Math.random().toString(36).slice(2);
  const INTERACTIVE = 'a,button,[role="button"],[role="link"]';
  const LANDMARK = 'nav,aside,[role="navigation"],[data-sidebar],[data-testid*="sidebar"],[id*="sidebar" i],[class*="sidebar" i]';
  const EXCLUDED = 'article,textarea,input,[contenteditable="true"],[contenteditable=""],[contenteditable="plaintext-only"],[role="textbox"],[data-message-author-role],[data-testid^="conversation-turn"],[data-mai-work-badges]';
  const ROW = 'data-mai-sidebar-row', LABEL = 'data-mai-sidebar-label', CARD = 'data-mai-sidebar-card';
  const HEADERS = 'span,div,p,strong,label,h1,h2,h3,h4,h5,h6,a,button,[role="heading"],[title],[aria-label]';
  const SCAN_INTERVAL_MS = 160;
  // A role's identifier selects only a neutral tint, never bundled identity art.
  const palettes = [['#c6b379', '#ffedac'], ['#a6bedb', '#dbefff'], ['#c6acd3', '#f2dcff']];
  function paletteForRole(id) {
    let hash = 0;
    for (const character of id) hash = (Math.imul(hash, 31) + character.codePointAt(0)) >>> 0;
    return palettes[hash % palettes.length];
  }
  const mounts = new Map();
  const projectConfigured = projectTitle !== '';
  const projectName = typeof projectTitle === 'string' && Array.from(projectTitle).length <= 2048 && !projectTitle.includes('\0') ? projectTitle : null;
  let projectScope = {configured: projectConfigured, headers: 0, roots: 0, matches: 0};
  const reduced = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
  let items = [], sheet = null, observer = null, headObserver = null, scanFrame = 0, scanTimer = 0, motionFrame = 0, removed = false;
  let scanRoots = [], discoverRoots = true, candidatesDirty = true, cachedCandidates = [], cachedHeaders = [], lastScanAt = -Infinity;
  const clock = () => typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now();
  const performanceStats = {scans: 0, fullScans: 0, scopedScans: 0, mutationBatches: 0, observedMutations: 0, ignoredMutations: 0, coalescedRequests: 0, lastScanMs: 0, maxScanMs: 0, lastCandidateNodes: 0, lastHeaderNodes: 0, geometryReads: 0, clientRectReads: 0, computedStyleReads: 0};
  let lastTitle = document.title,ambiguityDetails=[];
  let pendingMotion = new Map(), errors = 0, lastError = null;
  let diagnostics = {candidates: 0, semanticCandidates: 0, fallbackCandidates: 0, matched: 0, ambiguous: 0, missingLabel: 0};
  const CSS = `
    [${ROW}="${token}"] > [${CARD}="${token}"]{position:absolute;inset:0;z-index:0;isolation:isolate;overflow:hidden;border-radius:inherit;pointer-events:none;background:#182322;color:#fff8e5;transform:perspective(850px) rotateX(var(--mai-rx,0deg)) rotateY(var(--mai-ry,0deg));transition:transform 300ms cubic-bezier(.16,1,.3,1);font-family:-apple-system,BlinkMacSystemFont,'PingFang SC',sans-serif}
    [${CARD}="${token}"] *{box-sizing:border-box;pointer-events:none}
    [${CARD}="${token}"] .mai-sidebar-material,[${CARD}="${token}"] .mai-sidebar-shade,[${CARD}="${token}"] .mai-sidebar-foil{position:absolute;pointer-events:none}
    [${CARD}="${token}"] .mai-sidebar-material{inset:-5px;z-index:0;background-position:center 42%;background-size:cover;transform:translate(var(--mai-bg-x,0px),var(--mai-bg-y,0px)) scale(1.035);transition:transform 300ms cubic-bezier(.16,1,.3,1)}
    [${CARD}="${token}"] .mai-sidebar-shade{inset:0;z-index:1;background:linear-gradient(90deg,rgb(2 10 14 / 3%) 0%,rgb(2 10 14 / 12%) 25%,rgb(2 10 14 / 65%) 43%,rgb(2 10 14 / 73%) 100%)}
    [${CARD}="${token}"] .mai-sidebar-foil{inset:0;z-index:2;opacity:0;background:linear-gradient(118deg,transparent 7%,rgb(219 243 255 / 12%) 31%,rgb(255 230 155 / 42%) 42%,rgb(231 211 255 / 24%) 48%,transparent 63%);background-size:230% 140%;background-position:var(--mai-shine-x,50%) var(--mai-shine-y,35%);mask-image:linear-gradient(90deg,#000 0%,#000 25%,transparent 43%,transparent 93%,#000 100%);transition:opacity 180ms}
    [${CARD}="${token}"] .mai-sidebar-avatar{position:absolute;left:0;bottom:0;z-index:3;width:100px;height:66px;overflow:visible}
    [${CARD}="${token}"] .mai-sidebar-avatar img{position:absolute;left:-2px;top:var(--mai-portrait-top,-11px);width:104px;height:auto;max-width:none;transform:translateX(var(--mai-person-x,0px));transition:transform 300ms cubic-bezier(.16,1,.3,1);user-select:none;-webkit-user-drag:none}
    [${CARD}="${token}"] .mai-sidebar-copy{position:absolute;z-index:4;left:103px;right:28px;top:7px;height:52px;display:flex;flex-direction:column;justify-content:center;gap:0;min-width:0;text-align:left}
    [${CARD}="${token}"] .mai-sidebar-name{display:block;height:35px;flex:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:1.05;letter-spacing:0;transform:rotate(var(--mai-signature-angle,0deg));transform-origin:18% 65%;text-shadow:0 1px 5px rgb(0 0 0 / 65%)}
    [${CARD}="${token}"] .mai-sidebar-role{display:block;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#e0e1d9;font-size:12px;line-height:17px;font-weight:400;text-shadow:0 1px 4px rgb(0 0 0 / 65%)}
    [${CARD}="${token}"]::after{content:'';position:absolute;inset:0;z-index:5;border-radius:inherit;padding:1px;pointer-events:none;background:linear-gradient(118deg,rgb(255 247 207 / 82%),rgb(208 241 239 / 40%) 24%,rgb(183 207 233 / 40%) 51%,rgb(231 202 255 / 65%) 77%,rgb(255 239 190 / 90%));mask:linear-gradient(#fff 0 0) content-box,linear-gradient(#fff 0 0);mask-composite:exclude;opacity:.38;transition:opacity 180ms}
    [${ROW}="${token}"]:is(:hover,:focus-visible,[aria-current="true"],[aria-current="page"],[aria-selected="true"]) > [${CARD}="${token}"]::after{opacity:1}
    [${ROW}="${token}"][data-mai-sidebar-current="${token}"] > [${CARD}="${token}"]::after{opacity:1}
    [${ROW}="${token}"]:is(:hover,:focus-visible) > [${CARD}="${token}"] .mai-sidebar-foil{opacity:1}
    [${ROW}="${token}"]:is([aria-current="true"],[aria-current="page"],[aria-selected="true"]) > [${CARD}="${token}"] .mai-sidebar-name{color:var(--mai-glint,#efffe9)}
    [${CARD}="${token}"][data-mai-motion],[${CARD}="${token}"][data-mai-motion] .mai-sidebar-material,[${CARD}="${token}"][data-mai-motion] .mai-sidebar-avatar img{transition-duration:75ms;transition-timing-function:linear}
    @media(prefers-reduced-motion:reduce){[${CARD}="${token}"],[${CARD}="${token}"] *{transition:none!important;transform:none!important}}
  `;

  function element(name, className, text) {
    const node = document.createElement(name);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function ownStyle(record, node, name, value, priority = 'important') {
    let styles = record.styles.get(node);
    if (!styles) record.styles.set(node, styles = new Map());
    let entry = styles.get(name);
    if (entry && (node.style.getPropertyValue(name) !== entry.value || node.style.getPropertyPriority(name) !== entry.ownedPriority)) return;
    if (!entry) {
      entry = {before: node.style.getPropertyValue(name), priority: node.style.getPropertyPriority(name)};
      styles.set(name, entry);
    }
    if (node.style.getPropertyValue(name) !== value || node.style.getPropertyPriority(name) !== priority) node.style.setProperty(name, value, priority);
    entry.value = node.style.getPropertyValue(name); entry.ownedPriority = node.style.getPropertyPriority(name);
  }
  function ownAttribute(record, node, name, value) {
    let attributes = record.attributes.get(node);
    if (!attributes) record.attributes.set(node, attributes = new Map());
    if (attributes.has(name) && node.getAttribute(name) !== attributes.get(name).value) return;
    if (!attributes.has(name)) attributes.set(name, {before: node.getAttribute(name), had: node.hasAttribute(name)});
    if (node.getAttribute(name) !== value) {
      if (value === null) node.removeAttribute(name); else node.setAttribute(name, value);
    }
    attributes.get(name).value = value;
  }
  function restore(record) {
    record.events.abort(); pendingMotion.delete(record);
    record.card.remove();
    for (const [node, styles] of record.styles) for (const [name, entry] of styles) {
      if (node.style.getPropertyValue(name) !== entry.value || node.style.getPropertyPriority(name) !== entry.ownedPriority) continue;
      if (entry.before) node.style.setProperty(name, entry.before, entry.priority); else node.style.removeProperty(name);
    }
    for (const [node, attributes] of record.attributes) for (const [name, entry] of attributes) {
      if (node.getAttribute(name) !== entry.value) continue;
      if (entry.had) node.setAttribute(name, entry.before); else node.removeAttribute(name);
    }
    mounts.delete(record.row);
  }
  function isOwn(node) {
    return node?.nodeType === 1 && (node === sheet || node.getAttribute?.(CARD) === token || Boolean(node.closest?.(`[${CARD}="${token}"]`)));
  }
  function visible(row) {
    if (!row.isConnected || row.hidden || row.getAttribute('aria-hidden') === 'true' || !clientRects(row).length) return false;
    const style = computedStyle(row), rect = geometry(row);
    return style.display !== 'none' && style.visibility !== 'hidden' && style.visibility !== 'collapse' && rect.width >= 110 && rect.height > 0;
  }
  function geometry(node) { performanceStats.geometryReads++; return node.getBoundingClientRect(); }
  function clientRects(node) { performanceStats.clientRectReads++; return node.getClientRects(); }
  function computedStyle(node) { performanceStats.computedStyleReads++; return getComputedStyle(node); }
  function elementOf(node) { return node?.nodeType === 1 ? node : node?.parentElement || null; }
  function insideRoots(node) { return Boolean(node && scanRoots.some(root => root === node || root.contains(node))); }
  function invalidateRoots() { discoverRoots = true; candidatesDirty = true; }
  function queryRoots(selector) {
    const roots = discoverRoots ? [document] : scanRoots;
    const result = new Set();
    for (const root of roots) {
      if (root.nodeType === 1 && root.matches(selector)) result.add(root);
      for (const node of root.querySelectorAll(selector)) result.add(node);
    }
    return [...result];
  }
  function rememberRoots(candidates) {
    const roots = new Set();
    // Retain all candidate navigation branches, including unbound rows, so a
    // later duplicate title cannot escape ambiguity checks in a cached scope.
    for (const {row} of candidates) {
      let root = row;
      for (let ancestor = row.parentElement; ancestor && ancestor !== document.body && ancestor !== document.documentElement; ancestor = ancestor.parentElement) {
        if (ancestor.matches('main,[role="main"],dialog,[role="dialog"],header,[role="toolbar"]') || ancestor.closest(EXCLUDED)) break;
        const rect = geometry(ancestor);
        if (rect.left < -1 || rect.left > 360 || rect.width > 450) break;
        root = ancestor;
      }
      roots.add(root);
    }
    // Empty and temporarily collapsed navigation must still be discoverable.
    for (const node of document.querySelectorAll(LANDMARK)) {
      if (isOwn(node) || node.closest(EXCLUDED) || !node.isConnected) continue;
      const rect = geometry(node);
      if (rect.left >= -1 && rect.left <= 360 && rect.width > 0 && rect.width <= 450) roots.add(node);
    }
    scanRoots = [...roots].filter(node => ![...roots].some(other => other !== node && other.contains(node)));
    // An app without a discoverable navigation area stays in discovery mode.
    // Its body observer still ignores conversation and editor mutations.
    discoverRoots = scanRoots.length === 0;
  }
  function possibleNavigation(node) {
    if (node?.nodeType !== 1 || isOwn(node) || node.closest(EXCLUDED)) return false;
    if (node.matches(LANDMARK) || node.querySelector(LANDMARK)) return true;
    if (node.closest('main,[role="main"],dialog,[role="dialog"],header,[role="toolbar"]')) return false;
    return node.matches(INTERACTIVE) || Boolean(node.querySelector(INTERACTIVE));
  }
  function relevantMutation(record) {
    const target = elementOf(record.target);
    if (!target || isOwn(target) || target.closest(EXCLUDED)) return false;
    const changed = record.type === 'childList' ? [...record.addedNodes, ...record.removedNodes].filter(node => !isOwn(node)) : [];
    if (record.type === 'childList' && !changed.length && (record.addedNodes.length || record.removedNodes.length)) return false;
    if (insideRoots(target)) {
      if (record.type === 'childList' || record.type === 'attributes' && ['role', 'title', 'aria-label', 'href'].includes(record.attributeName)) candidatesDirty = true;
      return true;
    }
    if (record.type === 'childList') {
      if (scanRoots.some(root => !root.isConnected || changed.some(node => node === root || node.nodeType === 1 && node.contains(root))) || changed.some(possibleNavigation)) {
        invalidateRoots(); return true;
      }
      return false;
    }
    // Streaming text and editing outside navigation never schedule a scan.
    // Metadata can reveal a newly visible/recycled navigation branch.
    if (record.type === 'attributes' && (target.closest(LANDMARK) || possibleNavigation(target))) {
      invalidateRoots(); return true;
    }
    return false;
  }
  function threadKeys(row) {
    const keys = new Set();
    for (const attribute of ['data-thread-id', 'data-conversation-id']) {
      const value = row.getAttribute(attribute); if (value) keys.add(value);
    }
    const href = row.getAttribute('href');
    if (href) {
      try {
        const url = new URL(href, location.href), match = url.pathname.match(/\/(?:threads|c)\/([^/?#]+)\/?$/);
        if (match) { keys.add(href); keys.add(url.pathname); keys.add(decodeURIComponent(match[1])); }
      } catch {} // Malformed navigation metadata is simply not a thread identity.
    }
    return keys;
  }
  function stableTarget(row) {
    for (const attribute of ['data-thread-id', 'data-conversation-id']) {
      const value = row.getAttribute(attribute); if (value) return value;
    }
    try {
      const href = row.getAttribute('href');
      const match = href && new URL(href, location.href).pathname.match(/\/(?:threads|c)\/([^/?#]+)\/?$/);
      return match ? decodeURIComponent(match[1]) : null;
    } catch { return null; }
  }
  function sameStableTarget(group) {
    const first = group.length ? stableTarget(group[0].row) : null;
    return Boolean(first && group.every(match => stableTarget(match.row) === first));
  }
  function ambiguitySummary(group) {
    const known = group.map(match=>stableTarget(match.row)).filter(Boolean);
    return {roleId:group[0]?.item.roleId,rows:group.length,knownTargets:known.length,distinctTargets:new Set(known).size,
      nestedPairs:group.reduce((count,a)=>count+group.filter(b=>a!==b&&a.row.contains(b.row)).length,0),
      sameLabelNode:new Set(group.map(match=>match.label)).size<group.length,
      structure:group.slice(0,6).map(({row,label})=>({tag:row.tagName,role:row.getAttribute('role'),hasHref:row.hasAttribute('href'),
        labelTag:label.tagName,labelSource:label.hasAttribute('title')?'title':label.hasAttribute('aria-label')?'aria':'text',
        hasThreadAttribute:row.hasAttribute('data-thread-id')||row.hasAttribute('data-conversation-id'),
        hrefKind:(()=>{try{const value=row.getAttribute('href');if(!value)return 'none';const u=new URL(value,location.href);return /\/(threads|c)\//.test(u.pathname)?'known-thread':u.hash?'hash':u.search?'query':'other-path';}catch{return 'invalid';}})()}))};
  }
  function leaves(row) {
    const result = [];
    for (const node of row.querySelectorAll('span,div,p')) {
      if (result.length >= 96) break;
      if (isOwn(node) || node.childElementCount || node.closest(INTERACTIVE) !== row || node.closest(EXCLUDED) || node.closest('[role="status"],[role="alert"],[aria-live]')) continue;
      const values = new Set();
      for (const attribute of ['title', 'aria-label']) { const value = node.getAttribute(attribute); if (value && value.length <= 2048) values.add(value); }
      const text = node.textContent;
      if (!values.size && text && text.length <= 2048) values.add(text);
      if (values.size) result.push({node, values});
    }
    return result;
  }
  function identify(row, entries) {
    const keys = threadKeys(row), labelEntries = leaves(row), titleValues = new Set();
    for (const attribute of ['title', 'aria-label']) { const value = row.getAttribute(attribute); if (value) titleValues.add(value); }
    // Prefer explicitly named title leaves. Adjacent native status copy can
    // coincidentally equal a role/chat name and never supplies a chat identity.
    const explicitLabels = labelEntries.filter(leaf => leaf.node.hasAttribute('title'));
    const titleLeaves = explicitLabels.length ? explicitLabels : labelEntries;
    for (const leaf of titleLeaves) for (const value of leaf.values) titleValues.add(value);
    const threadMatches = entries.filter(item => item.bindings.some(binding => binding.kind === 'thread' && keys.has(binding.key)));
    const matches = threadMatches.length ? threadMatches : entries.filter(item => item.bindings.some(binding => binding.kind === 'title' && titleValues.has(binding.key)));
    if (matches.length !== 1) return null;
    const item = matches[0];
    const exact = titleLeaves.find(leaf => item.bindings.some(binding => binding.kind === 'title' && leaf.values.has(binding.key)));
    const label = exact?.node || labelEntries.find(leaf => Boolean(leaf.node.textContent?.trim()))?.node;
    if (!label) { diagnostics.missingLabel++; return null; }
    const kind = threadMatches.length ? 'thread' : 'title';
    const binding = item.bindings.find(binding => binding.kind === kind && (kind === 'thread' ? keys : titleValues).has(binding.key));
    const titleIdentities = item.bindings.filter(binding => binding.kind === 'title' && titleValues.has(binding.key)).map(binding => JSON.stringify(['title', binding.key]));
    return {row, item, label, kind, identity: JSON.stringify([kind, binding.key]), titleIdentities};
  }
  function candidateRows() {
    const result = [];
    if (candidatesDirty) cachedCandidates = queryRoots(INTERACTIVE);
    performanceStats.lastCandidateNodes = cachedCandidates.length;
    for (const row of cachedCandidates) {
      if (isOwn(row) || row.closest(EXCLUDED) || !visible(row)) continue;
      const semantic = Boolean(row.closest(LANDMARK)), keys = threadKeys(row), rect = geometry(row);
      // Some apps wrap the entire shell in <main>; its nested navigation is
      // still navigation. Unscoped links inside the conversation remain out.
      if (!semantic && row.closest('main,[role="main"]')) continue;
      if (row.closest('dialog,[role="dialog"]') || !semantic && row.closest('header,[role="toolbar"]')) continue;
      if (semantic && (rect.left < -1 || rect.left > 360)) continue;
      const left = rect.left >= -1 && rect.left <= 360 && rect.right <= Math.min(450, Math.max(360, (window.innerWidth || 1024) * .4));
      const fallback = left && !row.closest('header,[role="toolbar"],dialog,[role="dialog"]');
      if (!semantic && !keys.size && !fallback) continue;
      diagnostics.candidates++;
      if (semantic) diagnostics.semanticCandidates++; else diagnostics.fallbackCandidates++;
      result.push({row, semantic});
    }
    return result;
  }
  function exactProjectMetadata(node) {
    return node.getAttribute('title') === projectName || node.getAttribute('aria-label') === projectName ||
      !node.childElementCount && node.textContent === projectName;
  }
  function projectMatches(matches) {
    if (!projectConfigured) { projectScope.matches = matches.length; return matches; }
    if (!projectName || !matches.length) return [];
    const rawHeaders = [];
    if (candidatesDirty) cachedHeaders = queryRoots(HEADERS);
    performanceStats.lastHeaderNodes = cachedHeaders.length;
    for (const node of cachedHeaders) {
      // Read only navigation metadata; never aggregate a container's copy.
      if (isOwn(node) || node.closest(EXCLUDED) || !node.isConnected || node.hidden || node.getAttribute('aria-hidden') === 'true' || !clientRects(node).length) continue;
      const semantic = Boolean(node.closest(LANDMARK)), rect = geometry(node), style = computedStyle(node);
      if (rect.left < -1 || rect.left > 360 || !rect.width || !rect.height || style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') continue;
      if (node.closest('dialog,[role="dialog"]') || !semantic && node.closest('main,[role="main"],header,[role="toolbar"]')) continue;
      if (!semantic && rect.right > Math.min(450, Math.max(360, (window.innerWidth || 1024) * .4))) continue;
      if (matches.some(match => match.row.contains(node)) || !exactProjectMetadata(node)) continue;
      rawHeaders.push(node);
    }
    // A title attribute on a heading control and its identical leaf are one
    // heading. Separate project branches with the same name remain ambiguous.
    const leaves = rawHeaders.filter(node => !rawHeaders.some(other => node !== other && node.contains(other)));
    const headers = [...new Set(leaves.map(node => node.closest('button,a,[role="button"],[role="link"],[role="heading"],h1,h2,h3,h4,h5,h6') || node))];
    projectScope.headers = headers.length;
    const roots = new Set();
    let unresolved = false;
    for (const header of headers) {
      let root = null;
      for (let ancestor = header; ancestor && ancestor !== document.body && ancestor !== document.documentElement; ancestor = ancestor.parentElement) {
        if (ancestor.closest(EXCLUDED) || ancestor.getAttribute('aria-expanded') === 'false') break;
        // Never let a collapsed/empty project expand its scope to the shared
        // sidebar navigation, where an identically titled recent chat may live.
        if (ancestor.matches('nav,aside,[role="navigation"]') && ancestor.getAttribute('title') !== projectName && ancestor.getAttribute('aria-label') !== projectName) break;
        if (matches.some(match => ancestor.contains(match.row))) { root = ancestor; break; }
        if (ancestor.matches('section,[role="group"],[data-project-id],[data-project-group]')) break;
      }
      if (root) roots.add(root); else unresolved = true;
    }
    projectScope.roots = roots.size;
    if (unresolved || roots.size !== 1) return [];
    const root = roots.values().next().value;
    const scoped = matches.filter(match => root.contains(match.row));
    projectScope.matches = scoped.length;
    return scoped;
  }
  function resetMotion(record) {
    if (!record) return;
    pendingMotion.delete(record); record.card.removeAttribute('data-mai-motion');
    for (const name of ['--mai-rx', '--mai-ry', '--mai-person-x', '--mai-bg-x', '--mai-bg-y', '--mai-shine-x', '--mai-shine-y']) record.card.style.removeProperty(name);
  }
  function resetAllMotion() {
    if (motionFrame) cancelAnimationFrame(motionFrame); motionFrame = 0; pendingMotion.clear();
    for (const record of mounts.values()) resetMotion(record);
  }
  function queueMotion(record, event) {
    if (event.pointerType !== 'mouse' || reduced?.matches || document.hidden || !record.row.isConnected) return;
    const bounds = geometry(record.row);
    if (!bounds.width || !bounds.height) return;
    const x = Math.max(-1, Math.min(1, (event.clientX - bounds.left) / bounds.width * 2 - 1));
    const y = Math.max(-1, Math.min(1, (event.clientY - bounds.top) / bounds.height * 2 - 1));
    pendingMotion.set(record, {x, y});
    if (motionFrame) return;
    motionFrame = requestAnimationFrame(() => {
      motionFrame = 0;
      for (const [record, point] of pendingMotion) {
        if (!mounts.has(record.row) || document.hidden || reduced?.matches) continue;
        const {x, y} = point, style = record.card.style;
        record.card.setAttribute('data-mai-motion', '');
        style.setProperty('--mai-rx', `${(-y * 3).toFixed(2)}deg`); style.setProperty('--mai-ry', `${(x * 4).toFixed(2)}deg`);
        style.setProperty('--mai-person-x', `${(x * 1.8).toFixed(2)}px`); style.setProperty('--mai-bg-x', `${(-x * 2).toFixed(2)}px`); style.setProperty('--mai-bg-y', `${(-y * 1.3).toFixed(2)}px`);
        style.setProperty('--mai-shine-x', `${(50 + x * 38).toFixed(1)}%`); style.setProperty('--mai-shine-y', `${(35 + y * 18).toFixed(1)}%`);
      }
      pendingMotion.clear();
    });
  }
  function raiseNativeIcons(record) {
    // Host task state may be text or a CSS shape rather than an SVG. Keep all
    // native row children above the decorative card; only its title is hidden.
    const nativeNodes = new Set([...record.row.children, ...record.row.querySelectorAll('svg,[role="status"],[role="alert"],[aria-live]')]);
    for (const icon of nativeNodes) {
      if (isOwn(icon) || icon === record.label) continue;
      const path = [];
      for (let container = icon; container && container !== record.row; container = container.parentElement) path.push(container);
      const previous = record.iconPaths.get(icon);
      if (previous && previous.length === path.length && path.every((container, index) => container === previous[index])) continue;
      for (const container of path) {
        if (computedStyle(container).position === 'static') ownStyle(record, container, 'position', 'relative');
        ownStyle(record, container, 'z-index', container === icon ? '4' : '3');
      }
      record.iconPaths.set(icon, path);
    }
  }
  function markCurrent(record, match) {
    const titleIdentity = JSON.stringify(['title', document.title]);
    let current = match.titleIdentities.includes(titleIdentity);
    if (!current && match.kind === 'thread') {
      try {
        const path = new URL(location.href).pathname, currentKey = path.match(/\/(?:threads|c)\/([^/?#]+)\/?$/);
        const rowKeys = threadKeys(record.row);
        current = Boolean(currentKey && (rowKeys.has(path) || rowKeys.has(decodeURIComponent(currentKey[1]))));
      } catch {}
    }
    ownAttribute(record, record.row, 'data-mai-sidebar-current', current ? token : null);
  }
  function mount(match) {
    const {row, item, label} = match;
    const record = {row, label, item, styles: new Map(), attributes: new Map(), iconPaths: new WeakMap(), events: new AbortController(), card: element('span')};
    mounts.set(row, record);
    record.card.setAttribute(CARD, token); record.card.setAttribute('aria-hidden', 'true');
    record.card.style.pointerEvents = 'none';
    ownAttribute(record, row, ROW, token); ownAttribute(record, label, LABEL, token);
    if (computedStyle(row).position === 'static') ownStyle(record, row, 'position', 'relative');
    for (const [name, value] of Object.entries({'height': '68px', 'min-height': '68px', 'margin-top': '0px', 'margin-bottom': '8px', 'box-sizing': 'border-box', 'border-radius': '12px', 'overflow': 'hidden', 'isolation': 'isolate', 'padding-left': '103px', 'padding-right': '12px', 'background-color': '#182322'})) ownStyle(record, row, name, value);
    ownStyle(record, label, 'opacity', '0');
    const [edge, glint] = paletteForRole(item.roleId);
    record.card.style.setProperty('--mai-edge', edge); record.card.style.setProperty('--mai-glint', glint); record.card.style.setProperty('--mai-portrait-top', '-11px');
    const material = element('span', 'mai-sidebar-material');
    if (item.backgroundDataUrl) material.style.backgroundImage = `url("${item.backgroundDataUrl}")`;
    const avatar = element('span', 'mai-sidebar-avatar');
    if (item.characterDataUrl) {
      const image = element('img'); image.alt = ''; image.draggable = false; image.decoding = 'async';
      image.src = item.characterDataUrl; avatar.append(image);
    }
    const copy = element('span', 'mai-sidebar-copy'), name = element('span', 'mai-sidebar-name', item.name);
    let signature = null;
    try { signature = typeof signatureForRole === 'function' ? signatureForRole(item.roleId) : null; } catch {}
    const family = signature && typeof signature.family === 'string' && /^[a-zA-Z0-9 _-]{1,100}$/.test(signature.family) ? signature.family : null;
    const size = parseFloat(signature?.size), weight = parseFloat(signature?.weight), angle = parseFloat(signature?.angle);
    name.style.fontFamily = family ? `"${family}",cursive` : '"MaiWorkBadgesDisplay",-apple-system,BlinkMacSystemFont,sans-serif';
    name.style.fontSize = (family && Number.isFinite(size) ? Math.max(16, Math.min(44, size)) : 21) + 'px';
    name.style.fontWeight = String(family && Number.isFinite(weight) ? Math.max(100, Math.min(900, weight)) : 650);
    name.style.setProperty('--mai-signature-angle', (family && Number.isFinite(angle) ? Math.max(-12, Math.min(12, angle)) : 0) + 'deg');
    copy.append(name, element('span', 'mai-sidebar-role', item.role));
    record.card.append(material, element('span', 'mai-sidebar-shade'), element('span', 'mai-sidebar-foil'), avatar, copy);
    row.append(record.card); mounts.set(row, record); raiseNativeIcons(record);
    const options = {signal: record.events.signal, passive: true};
    row.addEventListener('pointerenter', event => queueMotion(record, event), options);
    row.addEventListener('pointermove', event => queueMotion(record, event), options);
    for (const type of ['pointerleave', 'pointercancel', 'dragstart']) row.addEventListener(type, () => resetMotion(record), options);
    return record;
  }
  function ensureSheet() {
    if (sheet?.isConnected) return;
    sheet = element('style'); sheet.setAttribute('data-mai-sidebar-style', token); sheet.textContent = CSS;
    (document.head || document.body).append(sheet);
  }
  function sameItem(left, right) {
    return left.roleId === right.roleId && left.name === right.name && left.role === right.role && left.characterDataUrl === right.characterDataUrl && left.backgroundDataUrl === right.backgroundDataUrl && JSON.stringify(left.bindings) === JSON.stringify(right.bindings);
  }
  function reconcile() {
    scanFrame = 0; if (removed) return; ambiguityDetails=[];
    const started = clock(); lastScanAt = started; performanceStats.scans++;
    if (scanRoots.some(root => !root.isConnected)) invalidateRoots();
    const fullScan = discoverRoots;
    if (fullScan) { candidatesDirty = true; performanceStats.fullScans++; } else performanceStats.scopedScans++;
    performanceStats.lastHeaderNodes = 0;
    projectScope = {configured: projectConfigured, headers: 0, roots: 0, matches: 0};
    diagnostics = {candidates: 0, semanticCandidates: 0, fallbackCandidates: 0, matched: 0, ambiguous: 0, missingLabel: 0};
    try {
      if (!items.length) { for (const record of [...mounts.values()]) restore(record); return; }
      ensureSheet();
      const candidates = candidateRows(), allMatches = [];
      if (fullScan) {
        rememberRoots(candidates);
        if (!discoverRoots) cachedCandidates = cachedCandidates.filter(insideRoots);
      }
      for (const {row, semantic} of candidates) { const match = identify(row, items); if (match) allMatches.push({...match, semantic}); }
      const matches = projectMatches(allMatches);
      candidatesDirty = false;
      const desired = new Map(), byIdentity = new Map(), titleGroups = new Map();
      for (const match of matches) for (const identity of match.titleIdentities) {
        if (!titleGroups.has(identity)) titleGroups.set(identity, []);
        titleGroups.get(identity).push(match);
      }
      for (const match of matches) { if (!byIdentity.has(match.identity)) byIdentity.set(match.identity, []); byIdentity.get(match.identity).push(match); }
      for (const group of byIdentity.values()) {
        const thread = group.filter(match => match.kind === 'thread');
        const preferred = thread.length ? thread : group.some(match => match.semantic) ? group.filter(match => match.semantic) : group;
        const titled = preferred[0]?.kind === 'title' ? titleGroups.get(preferred[0].identity) : null;
        if (titled?.length > 1 && !sameStableTarget(titled)) { diagnostics.ambiguous += preferred.length;if(ambiguityDetails.length<10)ambiguityDetails.push(ambiguitySummary(titled));continue; }
        if (sameStableTarget(group)) {
          for (const match of group) desired.set(match.row, match);
        } else if (preferred.length === 1) {
          const match = preferred[0]; desired.set(match.row, match);
        } else {diagnostics.ambiguous += preferred.length;if(ambiguityDetails.length<10)ambiguityDetails.push(ambiguitySummary(preferred));}
      }
      for (const record of [...mounts.values()]) {
        const match = desired.get(record.row);
        if (!match || match.label !== record.label || !sameItem(match.item, record.item) || !record.card.isConnected) restore(record);
      }
      for (const [row, match] of desired) {
        if (!mounts.has(row)) mount(match); else raiseNativeIcons(mounts.get(row));
        markCurrent(mounts.get(row), match);
      }
      diagnostics.matched = mounts.size; lastError = null;
    } catch {
      errors++; lastError = 'sidebar-reconcile-failed';
      for (const record of [...mounts.values()]) restore(record);
      invalidateRoots();
    } finally {
      performanceStats.lastScanMs = Math.max(0, clock() - started);
      performanceStats.maxScanMs = Math.max(performanceStats.maxScanMs, performanceStats.lastScanMs);
    }
  }
  function cancelScan() {
    if (scanFrame) cancelAnimationFrame(scanFrame); scanFrame = 0;
    if (scanTimer) clearTimeout(scanTimer); scanTimer = 0;
  }
  function scheduleScan() {
    if (removed || !items.length || document.hidden) return;
    if (scanFrame || scanTimer) { performanceStats.coalescedRequests++; return; }
    const queue = () => { scanTimer = 0; if (!removed && items.length && !document.hidden) scanFrame = requestAnimationFrame(reconcile); };
    const delay = Math.max(0, SCAN_INTERVAL_MS - (clock() - lastScanAt));
    if (delay > 0) scanTimer = setTimeout(queue, delay); else queue();
  }
  function watch() {
    if (observer || !document.body) return;
    observer = new MutationObserver(records => {
      performanceStats.mutationBatches++; performanceStats.observedMutations += records.length;
      let relevant = false;
      for (const record of records) { if (relevantMutation(record)) relevant = true; else performanceStats.ignoredMutations++; }
      if (relevant) scheduleScan();
    });
    observer.observe(document.body, {subtree: true, childList: true, characterData: true, attributes: true,
      attributeFilter: ['title', 'aria-label', 'aria-current', 'aria-selected', 'aria-hidden', 'aria-expanded', 'href', 'hidden', 'role', 'data-thread-id', 'data-conversation-id']});
    if (document.head) {
      headObserver = new MutationObserver(() => {
        if (document.title !== lastTitle) { lastTitle = document.title; scheduleScan(); }
      });
      headObserver.observe(document.head, {subtree: true, childList: true, characterData: true});
    }
  }
  const lifecycle = new AbortController();
  document.addEventListener('visibilitychange', () => { if (document.hidden) { cancelScan(); resetAllMotion(); } else { candidatesDirty = true; scheduleScan(); } }, {signal: lifecycle.signal});
  window.addEventListener('resize', () => { resetAllMotion(); invalidateRoots(); scheduleScan(); }, {signal: lifecycle.signal});
  window.addEventListener('blur', resetAllMotion, {signal: lifecycle.signal});
  // Route changes update the current marker inside the same navigation. The
  // mutation observer and connectivity check invalidate roots only if the host
  // actually replaces or extends that navigation.
  for (const event of ['popstate', 'hashchange']) window.addEventListener(event, scheduleScan, {signal: lifecycle.signal});
  reduced?.addEventListener?.('change', resetAllMotion, {signal: lifecycle.signal});
  function status() { return {mounted: mounts.size, items: items.length, errors, error: lastError, diagnostics: {...diagnostics}, projectScope: {...projectScope}, ambiguityDetails:ambiguityDetails.slice(), performance: {...performanceStats, scopeCount: scanRoots.length, scanPending: Boolean(scanFrame || scanTimer)}, removed}; }
  function update(next = []) {
    if (removed) return status();
    if (!Array.isArray(next)) { errors++; lastError = 'invalid-sidebar-items'; return status(); }
    items = next.filter(item => item && typeof item.roleId === 'string' && typeof item.name === 'string' && typeof item.role === 'string' && Array.isArray(item.bindings));
    cancelScan(); candidatesDirty = true;
    resetAllMotion();
    if (items.length) watch(); else { observer?.disconnect(); observer = null; headObserver?.disconnect(); headObserver = null; }
    reconcile();
    if (!items.length) { sheet?.remove(); sheet = null; scanRoots = []; cachedCandidates = []; cachedHeaders = []; invalidateRoots(); }
    return status();
  }
  function uninstall() {
    if (removed) return status();
    update([]); removed = true; lifecycle.abort(); observer?.disconnect(); observer = null; headObserver?.disconnect(); headObserver = null;
    return status();
  }
  return Object.freeze({update, status, uninstall});
}

  const BUILD = '0.8.0';
  const REVISION = 'cc67553c2aefd715d031022b5b1771727261f13453a5921828dbd46f8c92ae3e';
  const BRAND_AVATAR = 'data:image/png;base64,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';
  const BRAND = 'mai-work-badges/2';
  const GLOBAL = 'MaiWorkBadgeRuntime';
  const incumbent = window[GLOBAL];
  if (incumbent) {
    if (incumbent.brand !== BRAND || incumbent.version !== 2 || typeof incumbent.uninstall !== 'function')
      throw new Error('Work badge runtime global is already in use.');
    if (incumbent.build === BUILD && incumbent.revision === REVISION) return;
    incumbent.uninstall();
  }
  const DEFAULT = Object.freeze({width:266});
  const DEFAULT_HOLO_MATERIAL=Object.freeze({power:1.3,depth:1.75,contourBrightness:.15});
  // Asset-authored tuning only: keep the authored demo preset in sync with the
  // other product surface. Role names and user-provided options never select it.
  const HOLO_MATERIAL_PRESETS=Object.freeze({
    'bad02c86952324615efafffa529bcd2249529066dded16c645d61978c4667cb2':Object.freeze({power:.35,depth:1.5,contourBrightness:0,foregroundFoil:0,subjectGlow:0})
  });
  function holoMaterialPreset(imageId){return Object.hasOwn(HOLO_MATERIAL_PRESETS,imageId)?HOLO_MATERIAL_PRESETS[imageId]:DEFAULT_HOLO_MATERIAL;}

  const IMAGE = /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/;
  const LAYER_IMAGE = /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/;
  const HOLO_PROPERTIES = ['--rx','--ry','--px','--py','--fg-x','--fg-y','--bg-x','--bg-y','--foil-angle','--foil-shift','--holo-color','--view-x','--view-y'];
  const FONT = /^data:font\/(?:ttf|otf|woff|woff2);base64,[A-Za-z0-9+/]+={0,2}$/;
  const RESOURCE_FIELDS=['avatarDataUrl','foregroundDataUrl','contourDataUrl','holoAssets'];
  const ASSET_CACHE_LIMIT=6,ASSET_CACHE_BYTES=32*1024*1024,UI_CACHE_LIMIT=6;
  const CSS = `
    :host{font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif;color:#233d30;color-scheme:light;-webkit-font-smoothing:antialiased}
    *,*::before,*::after{box-sizing:border-box}[hidden]{display:none!important}button{font:inherit;color:inherit;touch-action:manipulation;-webkit-tap-highlight-color:transparent}button:focus-visible{outline:2px solid #b77a2d;outline-offset:3px}::selection{background:#d7a14d;color:#233d30}
    svg{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round;flex:none}
    .panel{position:absolute;pointer-events:auto;max-height:calc(100vh - 24px);overflow:visible;container-type:inline-size}
    .card-header{position:relative;z-index:2;flex:0 0 46px;height:46px;display:flex;align-items:center;gap:0;min-height:46px;padding:6px 8px 5px 13px;border-radius:16px 16px 0 0;background:#f8eed9}.drag{flex:1;min-width:0;align-self:stretch;display:flex;align-items:center;gap:6px;padding:0;border:0;border-radius:5px;background:transparent;text-align:left;font-size:11px;line-height:16px;font-weight:600;cursor:grab;touch-action:none;user-select:none}.drag[data-dragging]{cursor:grabbing}.brand-mark{display:flex;flex:none}.brand-mark svg{width:15px;height:15px}.brand-avatar{display:block;width:24px;height:24px;object-fit:contain;border-radius:50%;user-select:none;-webkit-user-drag:none}.brand-caption{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.mini-profile{display:none;align-items:center;gap:8px;min-width:0}.control{display:grid;place-items:center;flex:none;width:30px;height:32px;padding:0;border:0;border-radius:8px;background:transparent;color:var(--muted);cursor:pointer}.control:hover{background:rgb(35 61 48 / 8%);color:var(--ink)}.control:active{background:rgb(35 61 48 / 13%)}.drag:focus-visible,.control:focus-visible{outline-offset:-2px}
    .shell{position:relative;perspective:1100px;--paper:#f4f0e5;--ink:#233d30;--muted:#5c695b;--rule:#d5d7c8;--gold:#d7a14d}.stage{position:relative;aspect-ratio:266/372;max-height:var(--available-height,calc(100vh - 24px));transform-style:preserve-3d;transform:rotateX(var(--rx,0deg)) rotateY(var(--ry,0deg));transition:none}.shell[data-hover] .stage{will-change:transform}.rotator{position:absolute;inset:0;transform-style:preserve-3d;transition:transform 420ms cubic-bezier(.2,.75,.25,1)}.shell[data-back] .rotator{transform:rotateY(180deg)}
    .face{position:absolute;inset:0;width:100%;height:100%;display:flex;flex-direction:column;text-align:left;padding:0;border:0;background:var(--paper);border-radius:16px;overflow:hidden;box-shadow:0 12px 28px rgb(0 0 0 / 20%);backface-visibility:hidden;-webkit-backface-visibility:hidden}.back-face{transform:rotateY(180deg)}.flip-surface{position:relative;display:flex;flex:1;flex-direction:column;min-height:0;width:100%;padding:0;border:0;text-align:left;background:transparent;cursor:pointer}.flip-surface:disabled{color:var(--ink);opacity:1;cursor:default}.flip-surface:focus-visible{outline-offset:-3px}.face::before,.face::after{content:'';position:absolute;inset:0;z-index:5;border-radius:inherit;padding:1px;pointer-events:none;mask:linear-gradient(#fff 0 0) content-box,linear-gradient(#fff 0 0);mask-composite:exclude;-webkit-mask:linear-gradient(#fff 0 0) content-box,linear-gradient(#fff 0 0);-webkit-mask-composite:xor}.face::before{background:linear-gradient(145deg,#d7c795 2%,#dcead9 22%,#a9c8bf 45%,#dac4db 68%,#c4b789 100%)}.face::after{background:conic-gradient(from var(--foil-angle,125deg) at var(--px,50%) var(--py,30%),#e3c38b,#d7f1e8,#9dbed8,#e0b4d2,#e9d49a,#e3c38b);opacity:.28;transition:opacity 180ms}.shell[data-hover]:not([data-back]) .face::after{opacity:.9}.shell[data-back] .face::after{opacity:0}
    .photo{position:relative;isolation:isolate;display:flex;align-items:flex-end;justify-content:center;flex:0 0 38%;min-height:0;background:#f8eed9;overflow:hidden}.scene{position:absolute;inset:-12px;z-index:0;pointer-events:none;background:radial-gradient(ellipse at 18% 25%,#fffae8 0,transparent 54%),radial-gradient(ellipse at 85% 82%,#d3dec8 0,transparent 58%),linear-gradient(135deg,#ede1bd,#f8eed9 52%,#dbe4d6);transform:translate(var(--bg-x,0px),var(--bg-y,0px));transition:none}.avatar{position:relative;z-index:1;display:flex;align-items:flex-end;justify-content:center;width:100%;height:100%;transform:translate(var(--fg-x,0px),var(--fg-y,0px));transition:none}.portrait{user-select:none;-webkit-user-drag:none;display:block;width:auto;height:100%;max-width:100%;object-fit:contain}.photo:not([data-layered]) .avatar{transform:none}.photo:not([data-layered]) .portrait{width:100%;height:100%;object-fit:cover;object-position:center top}.initial{display:grid;place-items:center;align-self:center;width:100%;height:100%;font-family:'MaiWorkBadgesDisplay',sans-serif;font-size:clamp(60px,34cqw,96px);font-weight:550;color:#45634c}.foil{position:absolute;inset:0;z-index:3;pointer-events:none;background:linear-gradient(var(--foil-angle,125deg),transparent 10%,#7da8ce 25%,#d0b3d9 37%,#efca8c 48%,#b4ddbf 60%,#8cbdd3 73%,transparent 88%);background-size:220% 220%;background-position:var(--foil-shift,50%) 50%;mix-blend-mode:soft-light;opacity:.25;transition:opacity 180ms}.foil::after{content:'';position:absolute;inset:0;background:linear-gradient(115deg,transparent 18%,rgb(255 255 255 / 8%) 36%,rgb(255 255 255 / 80%) 47%,transparent 60%),radial-gradient(ellipse at var(--px,50%) var(--py,30%),rgb(255 255 255 / 65%),transparent 63%);background-size:220% 160%;background-position:var(--foil-shift,50%) 50%;mix-blend-mode:screen}.shell[data-hover]:not([data-back]) .foil{opacity:.68}.contour{position:absolute;inset:0;pointer-events:none;mask-size:contain;mask-position:center bottom;mask-repeat:no-repeat;mask-mode:luminance;-webkit-mask-size:contain;-webkit-mask-position:center bottom;-webkit-mask-repeat:no-repeat;background:linear-gradient(var(--foil-angle,125deg),transparent 12%,var(--holo-color,#d6e8cf) 43%,#fff9df 55%,transparent 77%);opacity:0;transition:opacity 180ms}.shell[data-hover]:not([data-back]) .contour{opacity:.5}

    .loading{position:absolute;z-index:4;left:12px;right:12px;bottom:8px;display:flex;align-items:center;justify-content:center;gap:6px;padding:5px 8px;border-radius:6px;background:rgb(248 238 217 / 94%);color:#455b4b;font-size:10px;line-height:14px;pointer-events:none}.loading-dot{width:4px;height:4px;flex:none;border-radius:50%;background:currentColor;animation:mai-badge-loading 900ms ease-in-out infinite alternate}.shell[data-loading-paused] .loading-dot{animation-play-state:paused}@keyframes mai-badge-loading{from{opacity:.35}to{opacity:1}}@media(prefers-reduced-motion:reduce){.loading-dot{animation:none;opacity:.7}}
    .body{position:relative;z-index:4;background:var(--paper);flex:1;display:flex;flex-direction:column;min-height:0;padding:14px 17px 13px}.body>*{flex-shrink:0}.body,.back-content{overflow-x:hidden;overflow-y:auto;overscroll-behavior:contain;scrollbar-width:thin;scrollbar-color:#79816e var(--paper)}.names{display:flex;align-items:baseline;gap:9px;line-height:1;min-width:0}.english{font-family:'MaiWorkBadgesDisplay',sans-serif;font-size:clamp(31px,15cqw,42px);font-weight:650;letter-spacing:-.035em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}.chinese{font-size:15px;font-weight:600;white-space:nowrap;letter-spacing:.04em;flex:none}.role{display:block;margin-top:7px;font-size:12px;font-weight:600;line-height:1.4;overflow-wrap:anywhere}.bio{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:3;overflow:hidden;margin-top:12px;font-size:12px;line-height:1.8;white-space:pre-line;color:var(--muted)}
    .footer{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-top:auto;padding-top:10px;border-top:1px solid var(--rule);font-size:11px;line-height:14px;color:var(--muted);font-variant-numeric:tabular-nums}.signature{display:flex;align-items:center;gap:5px;white-space:nowrap}.signature::before{content:'';height:4px;width:4px;border-radius:50%;background:var(--gold);flex:none}.serial{font-family:'MaiWorkBadgesDisplay',sans-serif;letter-spacing:.04em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.turn-hint{display:flex;align-items:center;gap:4px;white-space:nowrap}.turn-hint svg{width:13px;height:13px}.front .turn-hint{display:none}.shell[data-hover] .front .serial,.front:focus-visible .serial{display:none}.shell[data-hover] .front .turn-hint,.front:focus-visible .turn-hint{display:flex}
    .collapse svg{transform:rotate(180deg)}.back-content{position:relative;z-index:4;background:var(--paper);height:100%;width:100%;display:flex;flex-direction:column;padding:10px 18px 15px}.back-heading{display:flex;align-items:baseline;gap:8px;flex:none}.back-heading .english{font-size:30px}.back-heading .chinese{font-size:13px}.duties{display:flex;flex-direction:column;margin-top:14px;gap:13px;flex:none}.duty,.duty-title,.duty-copy{display:block}.duty-title{font-size:12px;line-height:1.5;font-weight:600}.duty-copy{color:var(--muted);font-size:12px;line-height:1.75;margin-top:3px;overflow-wrap:anywhere}.approval{font-size:11px;line-height:1.6;color:var(--muted);display:block;margin-top:auto;padding-top:10px;flex:none;overflow-wrap:anywhere}.back .footer{margin-top:10px;flex:none}
    .shell[data-collapsed]{background:var(--paper);border-radius:12px;box-shadow:0 8px 20px rgb(0 0 0 / 18%)}.shell[data-collapsed] .card-header{position:relative;height:64px;min-height:64px;margin-bottom:0;padding:8px 8px 8px 12px;border-radius:12px;background:var(--paper)}.shell[data-collapsed] .brand-mark,.shell[data-collapsed] .brand-caption{display:none}.shell[data-collapsed] .mini-profile{display:flex}.mini-avatar{display:grid;place-items:center;width:38px;height:40px;overflow:hidden;border-radius:8px;background:#f8eed9;flex:none}.mini-avatar .portrait{width:38px;height:40px;object-fit:cover;transform:none}.mini-avatar .initial{font-size:25px;margin:0;width:38px;height:40px}.mini-identity{display:flex;flex-direction:column;gap:4px;min-width:0}.mini-name{font-family:'MaiWorkBadgesDisplay',sans-serif;font-weight:650;font-size:19px;line-height:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.mini-role{font-size:11px;line-height:1.3;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .recovery{width:98px;max-width:calc(100vw - 24px);overflow:visible;container-type:normal}.restore{display:flex;align-items:center;gap:6px;min-height:32px;padding:6px 10px;border:0;border-radius:9px;background:#f4f0e5;color:#455b4b;font-size:11px;line-height:16px;white-space:nowrap;box-shadow:0 5px 15px rgb(0 0 0 / 16%);cursor:pointer}.restore svg{width:14px;height:14px}.restore:hover{background:#eae6d9;color:#233d30}.restore:active{background:#dfdfd0}
    @container(max-width:234px){.body{padding:11px 14px}.bio{margin-top:8px}.duties{gap:9px;margin-top:10px}.back-content{padding:7px 14px 12px}.card-header{padding-left:11px}.brand-caption{font-size:10px}.role{font-size:11px;margin-top:5px}.footer{padding-top:8px}.back .footer{margin-top:7px}}
    @media(prefers-reduced-motion:reduce){.stage,.rotator,.back-face{transform:none!important;transition:none!important}.scene,.avatar{transform:none!important;transition:none!important}.foil,.contour,.face::after{display:none}.face[aria-hidden=true]{visibility:hidden}}

    .flip-surface{user-select:none;touch-action:pan-y}.flip-surface[data-inspecting]{cursor:grabbing}
    .holo-canvas{display:none;position:absolute;width:160%;height:160%;max-width:none;left:-30%;top:-30%;pointer-events:none;z-index:0}
    .front-face[data-material=webgl]{overflow:visible;background:transparent}
    .front-face[data-material=webgl] .holo-canvas{display:block}
    .front-face[data-material=webgl]::before,.front-face[data-material=webgl]::after{display:none}
    .front-face[data-material=webgl] .card-header{z-index:7;background:transparent;color:#fff6d8;text-shadow:0 1px 3px rgb(0 0 0 / 65%)}
    .front-face[data-material=webgl] .control{color:#fff6d8;background:rgb(22 48 37 / 30%)}
    .front-face[data-material=webgl] .photo{visibility:hidden;flex-basis:56%}
    .front-face[data-material=webgl] .front{position:relative}
    .front-face[data-material=webgl] .body{position:absolute;left:12px;right:12px;bottom:12px;height:42%;padding:10px 7px 8px;background:rgb(255 246 216 / 94%);border-radius:8px;transform:translate(calc(var(--view-x,0) * 24.5cqw),calc(var(--view-y,0) * -34.26cqw))}
    .front-face[data-material=webgl] .body .english{font-size:clamp(28px,13cqw,36px)}
    .front-face[data-material=webgl] .body .chinese{font-size:13px}
    .front-face[data-material=webgl] .body .role{font-size:11px;line-height:1.4;margin-top:4px}
    .front-face[data-material=webgl] .body .bio{font-size:11px;line-height:1.65;margin-top:7px;-webkit-line-clamp:2}
    .front-face[data-material=webgl] .body .footer{font-size:10px;line-height:12px;padding-top:6px}
    .front-face[data-material=webgl][data-subject-protected] .body{background:#fff6d8}
    @media(prefers-reduced-motion:reduce){.front-face[data-material=webgl] .body{transform:none!important}}
    @media(hover:none){.front .serial{display:none}.front .turn-hint{display:flex}}
  `;
  let ui=null, recovery=null, restoreTarget=null, contextKey=null, roleId=null, roleSignature=null;
  let layout={...DEFAULT}, cardState={flipped:false,collapsed:false};
  let stale=false, failed=false, error=null, removed=false, frame=null, tiltFrame=null, tiltState=null, drag=null;
  let watchers=null, titleObserver=null, headObserver=null, titleNode=null, lastTitle=null;
  let fontDataUrl='', font=null, fontToken=0, fontRequested=false;
  let sidebar=null,sidebarProjectTitle=null,sidebarItems=[];
  const assetCache=new Map(),readyCards=new Map();
  let assetBytes=0,assetCacheMiss=false,assetCacheHit=false,uiCacheHit=false;
  const dismissedContexts=new Set();
  const dismissalKey=(context,role)=>JSON.stringify([context,role]);

  function node(tag,className,text) {
    const element=document.createElement(tag);
    if(className)element.className=className;
    if(text!==undefined)element.textContent=text;
    return element;
  }
  function icon(path) {
    const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');
    svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('aria-hidden','true');
    const line=document.createElementNS('http://www.w3.org/2000/svg','path');line.setAttribute('d',path);svg.append(line);return svg;
  }
  function button(className,label,path) {
    const element=node('button',className);element.type='button';element.setAttribute('aria-label',label);element.title=label;
    if(path)element.append(icon(path));return element;
  }
  function bounded(value,max,optional=false) {
    if(optional&&(value===undefined||value===null))return '';
    if(typeof value!=='string'||Array.from(value).length>max||value.includes('\0')||(!optional&&!value.trim()))throw new TypeError('invalid-profile');
    return value;
  }
  function cleanRole(input) {
    if(!input||typeof input!=='object'||Array.isArray(input))throw new TypeError('invalid-profile');
    const duties=input.duties??[];
    if(!Array.isArray(duties)||duties.length>30||typeof input.enabled!=='boolean'||typeof input.id!=='string'||!/^[a-z0-9][a-z0-9_-]{0,79}$/.test(input.id))throw new TypeError('invalid-profile');
    const imageId=input.imageId??null;if(imageId!==null&&(typeof imageId!=='string'||!/^[a-f0-9]{64}$/.test(imageId)))throw new TypeError('invalid-profile');
    return {id:input.id,name:bounded(input.name,80),chineseName:bounded(input.chineseName,80,true),
      role:bounded(input.role,160,true),bio:bounded(input.bio,4000,true),serial:bounded(input.serial,80,true),
      approval:bounded(input.approval,2000,true),enabled:input.enabled,imageId,
      duties:duties.map(row=>{if(!Array.isArray(row)||row.length!==2)throw new TypeError('invalid-profile');return [bounded(row[0],160,true),bounded(row[1],4000,true)];})};
  }
  function cleanLayout(input={}) {
    if(!input||typeof input!=='object'||Array.isArray(input))throw new TypeError('invalid-layout');
    const clean={};
    for(const key of ['x','y','width'])if(input[key]!==undefined){
      if(!Number.isFinite(input[key])||Math.abs(input[key])>1000000)throw new TypeError('invalid-layout');
      clean[key]=key==='width'?Math.max(200,Math.min(320,input[key])):input[key];
    }
    return clean;
  }
  function cleanState(input={}) {
    if(!input||typeof input!=='object'||Array.isArray(input))throw new TypeError('invalid-card-state');
    const clean={};for(const key of ['flipped','collapsed'])if(input[key]!==undefined){if(typeof input[key]!=='boolean')throw new TypeError('invalid-card-state');clean[key]=input[key];}return clean;
  }
  function cleanContext(value) {return bounded(value,2048);}
  function asset(value,pattern,max,code) {
    if(value==='')return '';
    if(typeof value!=='string'||value.length>max||!pattern.test(value))throw new TypeError(code);
    return value;
  }
  function viewport() {
    const visual=window.visualViewport;
    const width=visual&&Number.isFinite(visual.width)?visual.width:window.innerWidth;
    const height=visual&&Number.isFinite(visual.height)?visual.height:window.innerHeight;
    if(!Number.isFinite(width)||!Number.isFinite(height)||width<224||height<96)throw new Error('viewport-too-small');
    return {width,height,left:visual?.offsetLeft||0,top:visual?.offsetTop||0};
  }
  function clampPosition(measured=true) {
    const area=viewport(),margin=12,width=Math.min(layout.width??266,area.width-margin*2);
    const height=Math.min((measured&&ui?ui.panel.getBoundingClientRect().height:0)||(cardState.collapsed?64:width*372/266),area.height-margin*2);
    layout={x:Math.min(Math.max(layout.x??area.left+area.width-width-36,area.left+margin),area.left+area.width-width-margin),
      y:Math.min(Math.max(layout.y??area.top+378,area.top+margin),Math.max(area.top+margin,area.top+area.height-height-margin)),width};
  }
  function paintPosition() {
    if(!ui&&!recovery)return;
    const availableHeight=Math.max(0,viewport().height-24)+'px';
    if(ui){ui.panel.style.width=layout.width+'px';ui.panel.style.setProperty('--available-height',availableHeight);}clampPosition();
    const panel=ui?.panel||recovery.panel;
    panel.style.left=layout.x+'px';panel.style.top=layout.y+'px';
    panel.style.maxHeight=availableHeight;
  }
  function emit(name) {
    window.dispatchEvent(new CustomEvent(name,{detail:status()}));
  }
  function schedulePosition() {
    if((!ui&&!recovery)||frame!==null)return;
    frame=requestAnimationFrame(()=>{frame=null;if(!ui&&!recovery)return;try{paintPosition();}catch{fail('viewport-too-small');}});
  }
  function resetTilt() {
    if(tiltFrame!==null)cancelAnimationFrame(tiltFrame);tiltFrame=null;tiltState=null;
    if(!ui)return;ui.cancelInspect?.();ui.shell.removeAttribute('data-hover');
    for(const prop of HOLO_PROPERTIES)ui.stage.style.removeProperty(prop);
    ui.material?.setView({x:0,y:0,pointerX:.5,pointerY:.5,active:false});
  }
  function paintTilt(instance,state) {
    const rx=state.x,ry=state.y,viewX=Math.sin(ry*Math.PI/180)*.65,viewY=Math.sin(rx*Math.PI/180)*.65;
    const phase=(state.pointerX*.62+state.pointerY*.36+viewX*1.9+viewY*.8)*2.2;
    const spectrum=[0,.33,.67].map(offset=>Math.round((.52+.48*Math.cos(2*Math.PI*(phase+offset)))*255));
    const values={'--rx':`${rx}deg`,'--ry':`${ry}deg`,'--px':`${state.pointerX*100}%`,'--py':`${state.pointerY*100}%`,
      '--fg-x':`${viewX*28}px`,'--fg-y':`${-viewY*28}px`,'--bg-x':`${-viewX*70}px`,'--bg-y':`${viewY*70}px`,
      '--foil-angle':`${125+viewX*360-viewY*120}deg`,'--foil-shift':`${50+(viewX*1.9+viewY*.8)*180}%`,
      '--holo-color':`rgb(${spectrum.join(' ')})`,'--view-x':String(viewX),'--view-y':String(viewY)};
    for(const [property,value] of Object.entries(values))instance.stage.style.setProperty(property,value);
    instance.shell.toggleAttribute('data-hover',state.active);
    if(!cardState.flipped&&!document.hidden)instance.material?.setView({x:rx,y:ry,pointerX:state.pointerX,pointerY:state.pointerY,active:state.active});
  }
  function followTilt(instance,x,y,pointerX=.5,pointerY=.5,active=true) {
    if(ui!==instance||drag||cardState.collapsed)return;
    if(!tiltState||tiltState.instance!==instance)tiltState={instance,x:0,y:0,vx:0,vy:0,targetX:0,targetY:0,pointerX:.5,pointerY:.5,active:false,lastTime:null};
    Object.assign(tiltState,{targetX:x,targetY:y,pointerX,pointerY,active});
    if(tiltFrame!==null)return;
    const tick=time=>{
      tiltFrame=null;const state=tiltState;
      if(!state||state.instance!==instance||ui!==instance)return;
      // A damped spring gives the foil a little material weight. It only runs
      // while following input or returning; a still card owns no animation loop.
      const dt=state.lastTime===null?1/60:Math.min(.034,Math.max(.001,((Number.isFinite(time)?time:state.lastTime+1000/60)-state.lastTime)/1000));
      state.lastTime=Number.isFinite(time)?time:(state.lastTime??0)+1000/60;
      for(const [position,velocity,target]of [['x','vx','targetX'],['y','vy','targetY']]){
        state[velocity]+=(300*(state[target]-state[position])-28*state[velocity])*dt;
        state[position]+=state[velocity]*dt;
      }
      const settled=Math.abs(state.targetX-state.x)<.008&&Math.abs(state.targetY-state.y)<.008&&Math.abs(state.vx)<.025&&Math.abs(state.vy)<.025;
      if(settled){state.x=state.targetX;state.y=state.targetY;state.vx=state.vy=0;state.lastTime=null;}
      paintTilt(instance,state);
      if(settled){if(!state.active)resetTilt();return;}
      tiltFrame=requestAnimationFrame(tick);
    };
    tiltFrame=requestAnimationFrame(tick);
  }
  function finishDrag() {
    if(!drag)return;const previous=drag;drag=null;
    previous.handle.removeAttribute('data-dragging');
    try{if(previous.handle.hasPointerCapture(previous.pointer))previous.handle.releasePointerCapture(previous.pointer);}catch{}
  }
  function canRetain(instance) {
    return Boolean(instance&&!instance.disposed&&instance.assetKey&&
      assetCache.get(instance.assetKey)?.imageId===instance.profile.imageId&&
      (instance.materialState==='webgl'||instance.materialState==='css'&&instance.imagesPending===0));
  }
  function destroyInstance(instance) {
    if(!instance||instance.disposed)return;
    instance.disposed=true;
    if(readyCards.get(instance.signature)===instance)readyCards.delete(instance.signature);
    instance.events.abort();instance.material?.dispose();instance.material=null;
    instance.resize.disconnect();instance.layer.remove();
  }
  function pruneReady(limit=UI_CACHE_LIMIT) {
    while(readyCards.size>limit)destroyInstance(readyCards.values().next().value);
  }
  function discardAssets(key) {
    const entry=assetCache.get(key);if(entry){assetBytes-=entry.bytes;assetCache.delete(key);}
    for(const instance of [...readyCards.values()])if(instance.assetKey===key)destroyInstance(instance);
    if(ui?.assetKey===key)removeUI();
  }
  function cacheAssets(key,entry) {
    const previous=assetCache.get(key);
    const same=previous&&previous.imageId===entry.imageId&&previous.avatar===entry.avatar&&previous.foreground===entry.foreground&&previous.contour===entry.contour&&
      ['character','background','ui','structure'].every(name=>previous.holoAssets?.[name]===entry.holoAssets?.[name]);
    if(previous&&!same)discardAssets(key);
    else if(previous){assetBytes-=previous.bytes;assetCache.delete(key);}
    const strings=new Set([entry.avatar,entry.foreground,entry.contour,...Object.values(entry.holoAssets||{})]);
    entry.bytes=[...strings].reduce((sum,value)=>sum+value.length*2,0);
    if(entry.bytes>ASSET_CACHE_BYTES)return;
    assetCache.set(key,entry);assetBytes+=entry.bytes;
    while(assetCache.size>ASSET_CACHE_LIMIT||assetBytes>ASSET_CACHE_BYTES){
      // The currently visible portrait keeps its backing resources. A large
      // incoming bundle can remain uncached without blanking the current card.
      const oldest=[...assetCache.keys()].find(candidate=>candidate!==ui?.assetKey);
      if(oldest===undefined)break;discardAssets(oldest);
    }
  }
  function purgeRole(id,exceptSignature=null) {
    for(const instance of [...readyCards.values()])if(instance.profile.id===id&&instance.signature!==exceptSignature)destroyInstance(instance);
    if(ui?.profile.id===id&&ui.signature!==exceptSignature)removeUI();
  }
  function removeUI(park=false) {
    finishDrag();resetTilt();if(frame!==null)cancelAnimationFrame(frame);frame=null;
    const previous=ui;ui=null;
    if(previous){
      previous.resize.disconnect();previous.layer.remove();previous.syncLoading();
      if(park&&canRetain(previous)){previous.needsRedraw=true;readyCards.delete(previous.signature);readyCards.set(previous.signature,previous);pruneReady();}
      else destroyInstance(previous);
    }
    roleSignature=null;
  }
  function removeRecovery() {const previous=recovery;recovery=null;if(previous){previous.events.abort();previous.layer.remove();}}
  // A restore target is valid only until the host explicitly hides or replaces
  // this context. Dismissal memory alone never grants permission to render it.
  function clearRestore() {restoreTarget=null;removeRecovery();}
  function fail(code) {clearRestore();purgeRole(roleId);removeUI();failed=true;error=code;emit('mai-work-badges-state');return status();}
  function markStale(reason) {
    if(removed)return;clearRestore();removeUI(true);stale=true;
    emit('mai-work-badges-context-stale');
  }
  function watchMetadata() {
    if(watchers)return;
    watchers=new AbortController();lastTitle=document.title;
    function attachTitle() {
      titleObserver?.disconnect();titleNode=document.head?.querySelector('title')||null;
      if(titleNode)titleObserver.observe(titleNode,{childList:true,characterData:true,subtree:true});
    }
    const changed=()=>{const next=document.title;if(next!==lastTitle){lastTitle=next;markStale('title-changed');}};
    titleObserver=new MutationObserver(changed);
    headObserver=new MutationObserver(records=>{
      if(records.some(record=>[...record.addedNodes,...record.removedNodes].some(item=>item.nodeName==='TITLE'))){attachTitle();changed();}
    });
    attachTitle();if(document.head)headObserver.observe(document.head,{childList:true});
    window.addEventListener('popstate',()=>markStale('navigation'),{signal:watchers.signal});
    window.addEventListener('hashchange',()=>markStale('navigation'),{signal:watchers.signal});
    window.addEventListener('resize',()=>{if(ui||recovery){try{clampPosition();schedulePosition();}catch{fail('viewport-too-small');}}},{signal:watchers.signal});
    window.addEventListener('blur',()=>{finishDrag();resetTilt();},{signal:watchers.signal});
    document.addEventListener('visibilitychange',()=>{
      if(document.hidden){finishDrag();resetTilt();if(ui)ui.needsRedraw=true;}
      else if(ui)syncCard(false);
      ui?.syncLoading();
    },{signal:watchers.signal});
    for(const event of ['resize','scroll'])window.visualViewport?.addEventListener(event,()=>{if(ui||recovery){try{clampPosition();schedulePosition();}catch{fail('viewport-too-small');}}},{signal:watchers.signal});
  }
  function loadFont() {
    if(!fontDataUrl||fontRequested||typeof FontFace!=='function')return;
    fontRequested=true;const token=++fontToken;
    try{
      new FontFace('MaiWorkBadgesDisplay',`url(${fontDataUrl})`,{weight:'200 800'}).load().then(loaded=>{
        if(removed||token!==fontToken)return;font=loaded;document.fonts.add(loaded);
      }).catch(()=>{});
    }catch{} // Font is optional; system fallback keeps the card operable.
  }
  function configureSidebar(options={}) {
    if(removed)throw new Error('Runtime was uninstalled.');
    if(!options||typeof options!=='object'||Array.isArray(options)||!Array.isArray(options.items)||options.items.length>200)throw new TypeError('invalid-sidebar-items');
    if(options.append!==undefined&&typeof options.append!=='boolean')throw new TypeError('invalid-sidebar-items');
    const projectTitle=bounded(options.projectTitle,2048,true);
    if(options.append&&sidebarProjectTitle!==null&&sidebarProjectTitle!==projectTitle)throw new TypeError('invalid-sidebar-project');
    const items=options.items.map(item=>{
      if(!item||typeof item!=='object'||Array.isArray(item)||!Array.isArray(item.bindings)||item.bindings.length>200)throw new TypeError('invalid-sidebar-items');
      const roleId=bounded(item.roleId,80),name=bounded(item.name,80),role=bounded(item.role,160,true);
      if(!/^[a-z0-9][a-z0-9_-]{0,79}$/.test(roleId))throw new TypeError('invalid-sidebar-items');
      const bindings=item.bindings.map(binding=>{
        if(!binding||typeof binding!=='object'||Array.isArray(binding)||!['title','thread'].includes(binding.kind))throw new TypeError('invalid-sidebar-items');
        return {kind:binding.kind,key:bounded(binding.key,2048)};
      });
      return {roleId,name,role,bindings,characterDataUrl:asset(item.characterDataUrl??'',IMAGE,4*1024*1024+128,'invalid-sidebar-art'),backgroundDataUrl:asset(item.backgroundDataUrl??'',IMAGE,4*1024*1024+128,'invalid-sidebar-art')};
    });
    if(new Set(items.map(item=>item.roleId)).size!==items.length)throw new TypeError('invalid-sidebar-items');
    const merged=new Map((options.append?sidebarItems:[]).map(item=>[item.roleId,item]));
    for(const item of items)merged.set(item.roleId,item);
    if(merged.size>200)throw new TypeError('invalid-sidebar-items');
    const next=[...merged.values()];
    if(sidebar&&sidebarProjectTitle!==projectTitle){sidebar.uninstall();sidebar=null;}
    sidebarProjectTitle=projectTitle;
    if(!sidebar&&typeof createMaiSidebarCards==='function')sidebar=createMaiSidebarCards({projectTitle});
    sidebar?.update(next);sidebarItems=next;
    return status();
  }
  function syncCard(focus=false) {
    if(!ui)return;
    if(cardState.collapsed||ui.shell.getAttribute('data-collapsed')!==null)resetTilt();
    ui.shell.toggleAttribute('data-back',cardState.flipped);ui.shell.toggleAttribute('data-collapsed',cardState.collapsed);
    ui.syncLoading();
    ui.stage.hidden=cardState.collapsed;ui.compact.header.hidden=!cardState.collapsed;
    ui.compact.header.inert=!cardState.collapsed;ui.compact.header.setAttribute('aria-hidden',String(!cardState.collapsed));
    for(const control of ui.compact.controls)control.disabled=!cardState.collapsed;
    for(const [backSide,face,flip,header] of [[false,ui.frontFace,ui.front,ui.headers[0]],[true,ui.backFace,ui.back,ui.headers[1]]]){
      const inactive=cardState.collapsed||backSide!==cardState.flipped;
      face.inert=inactive;face.setAttribute('aria-hidden',String(inactive));flip.disabled=inactive;flip.setAttribute('aria-hidden',String(inactive));
      for(const control of header.controls)control.disabled=inactive;
      header.collapse.setAttribute('aria-expanded',String(!cardState.collapsed));
    }
    if(cardState.flipped||cardState.collapsed||document.hidden)ui.needsRedraw=true;
    else if(ui.material){
      const drawn=ui.material.setView({x:tiltState?.x??0,y:tiltState?.y??0,active:tiltState?.active??false});
      // Detached/hidden WebGL canvases need a fresh presentation even when the
      // quantized view has not changed (preserveDrawingBuffer is false).
      if(ui.needsRedraw){if(drawn!==true)ui.material?.draw?.();ui.needsRedraw=false;}
    }
    if(focus)(cardState.collapsed?ui.compact.mini:cardState.flipped?ui.back:ui.front).focus({preventScroll:true});
    clampPosition(false);schedulePosition();
  }
  function makeLayer() {
    const layer=node('div');layer.setAttribute('data-mai-work-badges','');
    Object.assign(layer.style,{all:'initial',position:'fixed',inset:'0',overflow:'clip',pointerEvents:'none',zIndex:'1000',isolation:'isolate',direction:'ltr',fontFamily:"-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif",fontSize:'14px',lineHeight:'normal',color:'#233d30',colorScheme:'light'});
    const root=layer.attachShadow({mode:'open'}),style=node('style');style.textContent=CSS;
    root.append(style);return {layer,root};
  }
  function makeRecovery(focus=false) {
    removeRecovery();if(!restoreTarget||failed||stale||removed)return;
    const {layer,root}=makeLayer(),panel=node('section','panel recovery');panel.setAttribute('aria-label','已关闭工牌');
    const restoreButton=button('restore','显示本会话工牌','M12 5v14M5 12h14');restoreButton.append(node('span','','显示工牌'));
    const events=new AbortController();
    for(const type of ['pointerdown','pointerup','click','dblclick'])panel.addEventListener(type,event=>event.stopPropagation(),{signal:events.signal});
    restoreButton.addEventListener('click',event=>{event.preventDefault();event.stopPropagation();restore();},{signal:events.signal});
    panel.append(restoreButton);root.append(panel);recovery={layer,root,panel,events};document.body.append(layer);paintPosition();
    if(getComputedStyle(layer).position!=='fixed'||getComputedStyle(layer).pointerEvents!=='none'||getComputedStyle(panel).position!=='absolute')throw new Error('style-blocked');
    if(focus)restoreButton.focus({preventScroll:true});
  }
  function makeUI(profile,avatarDataUrl,foregroundDataUrl,contourDataUrl,holoAssets) {
    const {layer,root}=makeLayer();
    const panel=node('section','panel');panel.setAttribute('aria-label',`${profile.name} 身份卡`);
    const shell=node('section','shell'),stage=node('div','stage'),rotator=node('div','rotator');
    const frontFace=node('div','face front-face'),backFace=node('div','face back-face');
    const canvas=holoAssets?node('canvas','holo-canvas'):null;
    if(canvas){canvas.setAttribute('aria-hidden','true');frontFace.toggleAttribute('data-subject-protected',holoMaterialPreset(profile.imageId).foregroundFoil===0);frontFace.append(canvas);}
    const front=button('flip-surface front',`${profile.name} ${profile.chineseName}，${profile.role}。点击查看职责`);
    const back=button('flip-surface back',`${profile.name} 的日常职责。点击返回工牌`);
    const photo=node('span','photo');
    const imageEvents=[];
    function avatar(className,source=avatarDataUrl) {
      const container=node('span',className);
      if(source){const image=node('img','portrait');image.alt='';image.draggable=false;image.decoding='async';imageEvents.push({image,source});container.append(image);}
      else container.append(node('span','initial',Array.from(profile.name.trim())[0].toLocaleUpperCase()));
      return container;
    }
    // Colored foreground, scenery and DOM identity are independent planes. A
    // full opaque avatar is never duplicated as a pretend repaired background.
    const portrait=avatar('avatar',foregroundDataUrl||avatarDataUrl);
    if(foregroundDataUrl||!avatarDataUrl){
      photo.setAttribute('data-layered','');photo.append(node('span','scene'));
    }
    if(foregroundDataUrl&&contourDataUrl){
      const contour=node('span','contour');contour.setAttribute('aria-hidden','true');
      contour.style.setProperty('mask-image',`url(${contourDataUrl})`);contour.style.setProperty('-webkit-mask-image',`url(${contourDataUrl})`);
      // The supplied aligned line asset is already clipped to foreground alpha.
      // No blur or drop-shadow can leak contour emission into scenery or text.
      portrait.append(contour);
    }
    const foil=node('span','foil');foil.setAttribute('aria-hidden','true');photo.append(portrait,foil);
    const loading=node('span','loading');loading.setAttribute('role','status');loading.setAttribute('aria-live','polite');loading.hidden=true;
    const loadingDot=node('span','loading-dot');loadingDot.setAttribute('aria-hidden','true');loading.append(loadingDot,node('span','','正在加载工牌'));photo.append(loading,foil);
    const body=node('span','body'),names=node('span','names');
    names.append(node('span','english',profile.name),node('span','chinese',profile.chineseName));
    const bio=node('span','bio',profile.bio);bio.id='work-badge-bio';bio.title=profile.bio;
    function footer(backSide=false) {
      const element=node('span','footer');element.append(node('span',backSide?'serial':'signature',backSide?profile.serial:'AI 运营搭档'));
      if(!backSide)element.append(node('span','serial',profile.serial));
      const hint=node('span','turn-hint',backSide?'返回工牌':'查看职责');hint.append(icon('M4 10a8 8 0 1 1 1 8M4 4v6h6'));element.append(hint);return element;
    }
    body.append(names,node('span','role',profile.role),bio,footer());front.append(photo,body);front.setAttribute('aria-describedby',bio.id);
    const backContent=node('span','back-content'),heading=node('span','back-heading');heading.append(node('span','english',profile.name),node('span','chinese','的职责'));
    const duties=node('span','duties');duties.id='work-badge-duties';
    for(const [title,text] of profile.duties){const row=node('span','duty');row.append(node('span','duty-title',title),node('span','duty-copy',text));duties.append(row);}
    const approval=node('span','approval',profile.approval);approval.id='work-badge-approval';approval.hidden=!profile.approval;
    backContent.append(heading,duties,approval,footer(true));back.append(backContent);back.setAttribute('aria-describedby',`${duties.id} ${approval.id}`);
    stage.id='work-badge-stage';
    function makeHeader(compact=false) {
      const header=node('header',compact?'card-header compact-header':'card-header');
      const handle=button('drag',`拖动 ${profile.name} 工牌；方向键移动，Shift 加速`);
      if(compact){
        const identity=node('span','mini-identity');identity.append(node('span','mini-name',profile.name),node('span','mini-role',profile.role));
        const miniProfile=node('span','mini-profile');miniProfile.append(avatar('mini-avatar'),identity);handle.append(miniProfile);
      }else{
        const brand=node('span','brand-mark'),brandImage=node('img','brand-avatar');brandImage.src=BRAND_AVATAR;brandImage.alt='';brandImage.draggable=false;brand.append(brandImage);
        handle.append(brand,node('span','brand-caption','MaiBadges'));
      }
      const toggle=button(compact?'control mini':'control collapse',compact?`展开 ${profile.name} 身份卡`:'收起身份卡','m8 10 4 4 4-4');
      toggle.setAttribute('aria-expanded',String(!compact));toggle.setAttribute('aria-controls',stage.id);
      const close=button('control close',`关闭本会话的 ${profile.name} 工牌`,'m6 6 12 12M18 6 6 18');
      header.append(handle,toggle,close);
      return {header,handle,close,controls:[handle,toggle,close],...(compact?{mini:toggle}:{collapse:toggle})};
    }
    // Header controls belong to each non-button face. The native flip target is
    // their sibling, keeping a complete card plane without nested buttons.
    const headers=[makeHeader(),makeHeader()],compact=makeHeader(true);
    frontFace.append(headers[0].header,front);backFace.append(headers[1].header,back);
    rotator.append(frontFace,backFace);stage.append(rotator);shell.append(stage,compact.header);panel.append(shell);root.append(panel);
    const events=new AbortController(),eventOptions={signal:events.signal};
    const instance={layer,root,panel,shell,stage,frontFace,backFace,front,back,headers,compact,events,profile,resize:null,material:null,materialState:holoAssets?'loading':'css',imagesPending:imageEvents.length,disposed:false,materialStarted:false,needsRedraw:false};
    instance.syncLoading=()=>{
      const paused=ui!==instance||document.hidden||cardState.flipped||cardState.collapsed;
      const pending=instance.materialState==='loading'||['css','fallback'].includes(instance.materialState)&&instance.imagesPending>0;
      shell.toggleAttribute('data-loading-paused',paused);loading.hidden=paused||!pending;
    };
    instance.startMaterial=()=>{
      if(instance.materialStarted)return;instance.materialStarted=true;
      if(!canvas){instance.syncLoading();return;}
      if(typeof canvas.getContext!=='function'){instance.materialState='fallback';instance.syncLoading();return;}
      const fallback=()=>{
        if(instance.disposed)return;
        if(ui!==instance){destroyInstance(instance);return;}
        instance.materialState='fallback';frontFace.removeAttribute('data-material');instance.material?.dispose();instance.material=null;instance.syncLoading();
      };
      createBadgeHoloRenderer(canvas,holoAssets,{width:800,...holoMaterialPreset(profile.imageId),signal:events.signal,onLost:fallback}).then(material=>{
        if(ui!==instance||events.signal.aborted){material.dispose();return;}
        instance.material=material;instance.materialState='webgl';frontFace.setAttribute('data-material','webgl');
        instance.syncLoading();
        if(cardState.flipped||cardState.collapsed||document.hidden)instance.needsRedraw=true;
        else material.setView({x:tiltState?.instance===instance?tiltState.x:0,y:tiltState?.instance===instance?tiltState.y:0,active:false});
        emit('mai-work-badges-state');
      }).catch(()=>{fallback();});
    };
    function changeState(changes){
      cardState={...cardState,...changes};
      try{syncCard(true);emit('mai-work-badges-state');}catch{fail('viewport-too-small');}
    }
    let inspect=null,suppressedClickUntil=0;
    function flip(value,event){
      if(event.detail!==0&&Date.now()<suppressedClickUntil){event.preventDefault();event.stopPropagation();suppressedClickUntil=0;return;}
      changeState({flipped:value});
    }
    front.addEventListener('click',event=>{if(front.disabled||ui!==instance)return;event.stopPropagation();flip(true,event);},eventOptions);
    back.addEventListener('click',event=>{if(back.disabled||ui!==instance)return;event.stopPropagation();flip(false,event);},eventOptions);
    shell.addEventListener('keydown',event=>{if(ui===instance&&event.key==='Escape'&&cardState.flipped&&!cardState.collapsed){event.preventDefault();event.stopPropagation();changeState({flipped:false});}},eventOptions);
    for(const type of ['pointerdown','pointerup','click','dblclick'])panel.addEventListener(type,event=>event.stopPropagation(),eventOptions);
    for(const controls of [...headers,compact]){
      const {handle,close,collapse,mini}=controls;
      collapse?.addEventListener('click',event=>{if(collapse.disabled||ui!==instance)return;event.stopPropagation();changeState({collapsed:true});},eventOptions);
      mini?.addEventListener('click',event=>{if(mini.disabled||ui!==instance)return;event.stopPropagation();changeState({collapsed:false});},eventOptions);
      handle.addEventListener('click',event=>{event.preventDefault();event.stopPropagation();},eventOptions);
      handle.addEventListener('pointerdown',event=>{
        if(handle.disabled||ui!==instance||event.button!==0||drag)return;event.preventDefault();event.stopPropagation();handle.focus({preventScroll:true});
        resetTilt();try{handle.setPointerCapture(event.pointerId);}catch{return;}
        drag={pointer:event.pointerId,clientX:event.clientX,clientY:event.clientY,x:layout.x,y:layout.y,handle};handle.setAttribute('data-dragging','');
      },eventOptions);
      handle.addEventListener('pointermove',event=>{
        if(!drag||drag.handle!==handle||event.pointerId!==drag.pointer)return;event.preventDefault();event.stopPropagation();
        layout={...layout,x:drag.x+event.clientX-drag.clientX,y:drag.y+event.clientY-drag.clientY};
        try{clampPosition();schedulePosition();}catch{fail('viewport-too-small');}
      },eventOptions);
      for(const type of ['pointerup','pointercancel','lostpointercapture'])handle.addEventListener(type,event=>{if(drag&&drag.handle===handle&&event.pointerId===drag.pointer){finishDrag();schedulePosition();}},eventOptions);
      handle.addEventListener('keydown',event=>{
        if(handle.disabled||ui!==instance)return;
        const delta={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]}[event.key];if(!delta)return;
        event.preventDefault();event.stopPropagation();const step=event.shiftKey?20:4;
        layout={...layout,x:layout.x+delta[0]*step,y:layout.y+delta[1]*step};try{clampPosition();schedulePosition();}catch{fail('viewport-too-small');}
      },eventOptions);
      close.addEventListener('click',event=>{if(close.disabled||ui!==instance)return;event.preventDefault();event.stopPropagation();dismissedContexts.add(dismissalKey(contextKey,roleId));removeUI(true);try{makeRecovery(true);emit('mai-work-badges-state');}catch(problem){fail(problem.message==='style-blocked'?'style-blocked':'viewport-too-small');}},eventOptions);
    }
    const motion=matchMedia('(prefers-reduced-motion: reduce)');motion.addEventListener('change',()=>{if(ui===instance)resetTilt();},eventOptions);
    function pointerFollow(event,checkInside=false) {
      const bounds=shell.getBoundingClientRect();if(!bounds.width||!bounds.height)return;
      const px=Math.max(0,Math.min(1,(event.clientX-bounds.left)/bounds.width)),py=Math.max(0,Math.min(1,(event.clientY-bounds.top)/bounds.height));
      const inside=event.clientX>=bounds.left&&event.clientX<=bounds.right&&event.clientY>=bounds.top&&event.clientY<=bounds.bottom;
      const active=!checkInside||inside;
      followTilt(instance,active?-(py-.5)*28:0,active?(px-.5)*36:0,px,py,active);
    }
    function releaseInspection() {
      if(!inspect)return;const previous=inspect;inspect=null;
      previous.surface.removeAttribute('data-inspecting');
      try{if(previous.surface.hasPointerCapture(previous.pointer))previous.surface.releasePointerCapture(previous.pointer);}catch{}
    }
    instance.cancelInspect=releaseInspection;
    // Card-body press/drag inspects its material. The header's separate capture
    // still moves the overlay; a genuine drag cannot fall through into a flip.
    for(const surface of [front,back]){
      surface.addEventListener('pointerdown',event=>{
        if(surface.disabled||ui!==instance||motion.matches||drag||inspect||event.pointerType!=='mouse'||event.button!==0)return;
        suppressedClickUntil=0;
        try{surface.setPointerCapture(event.pointerId);}catch{return;}
        inspect={surface,pointer:event.pointerId,startX:event.clientX,startY:event.clientY,x:tiltState?.x||0,y:tiltState?.y||0,moved:false};
      },eventOptions);
      surface.addEventListener('pointermove',event=>{
        if(!inspect||inspect.surface!==surface||inspect.pointer!==event.pointerId)return;
        const dx=event.clientX-inspect.startX,dy=event.clientY-inspect.startY;
        if(!inspect.moved&&Math.hypot(dx,dy)<=6)return;
        inspect.moved=true;surface.setAttribute('data-inspecting','');event.preventDefault();event.stopPropagation();
        const bounds=shell.getBoundingClientRect(),px=Math.max(0,Math.min(1,(event.clientX-bounds.left)/bounds.width)),py=Math.max(0,Math.min(1,(event.clientY-bounds.top)/bounds.height));
        followTilt(instance,Math.max(-22,Math.min(22,inspect.x-dy*.18)),Math.max(-28,Math.min(28,inspect.y+dx*.24)),px,py,true);
      },eventOptions);
      for(const type of ['pointerup','pointercancel','lostpointercapture'])surface.addEventListener(type,event=>{
        if(!inspect||inspect.surface!==surface||inspect.pointer!==event.pointerId)return;
        const moved=inspect.moved;releaseInspection();if(moved)suppressedClickUntil=Date.now()+600;
        if(type==='pointerup'&&Number.isFinite(event.clientX)&&Number.isFinite(event.clientY))pointerFollow(event,true);
        else followTilt(instance,0,0,.5,.5,false);
      },eventOptions);
    }
    shell.addEventListener('pointermove',event=>{
      if(event.pointerType!=='mouse'||motion.matches||cardState.collapsed||drag||inspect||ui!==instance)return;
      // Stable, untransformed shell geometry avoids feedback at tilted edges.
      // The inner rotator owns flip; this controller never edits its transform.
      pointerFollow(event);
    },eventOptions);
    shell.addEventListener('pointerleave',()=>{if(!inspect&&!motion.matches)followTilt(instance,0,0,.5,.5,false);},eventOptions);
    shell.addEventListener('pointercancel',()=>{if(ui===instance)resetTilt();},eventOptions);
    instance.resize=new ResizeObserver(()=>{if(ui!==instance)return;if(!layer.isConnected){removeUI();return;}try{clampPosition();schedulePosition();}catch{fail('viewport-too-small');}});
    for(const {image,source} of imageEvents){
      let settled=false;const ready=()=>{if(settled)return;settled=true;instance.imagesPending--;instance.syncLoading();};
      image.addEventListener('load',ready,eventOptions);
      image.addEventListener('error',()=>{if(ui===instance)fail('portrait-load-failed');else destroyInstance(instance);},eventOptions);image.src=source;
      if(image.complete&&image.naturalWidth>0)ready();
    }
    return instance;
  }
  function status() {
    if(ui&&!ui.layer.isConnected)removeUI();if(recovery&&!recovery.layer.isConnected)removeRecovery();
    const snapshot={x:layout.x??Math.max(12,(window.innerWidth||1024)-(layout.width??266)-36),y:layout.y??378,width:layout.width??266};
    return {brand:BRAND,version:2,build:BUILD,revision:REVISION,sidebarVersion:1,sidebar:sidebar?.status()??{mounted:0,items:0},assetCacheVersion:1,assetCacheMiss,assetCacheHit,uiCacheHit,cacheStats:{entries:assetCache.size,bytes:assetBytes,retainedUI:readyCards.size+(canRetain(ui)?1:0)},material:ui?.materialState??'none',mounted:Boolean(ui),restorable:Boolean(recovery),roleId,contextKey,layout:snapshot,cardState:{...cardState},dismissed:dismissedContexts.has(dismissalKey(contextKey,roleId)),failed,stale,...(error?{error}:{})};
  }
  function configure(options={}) {
    if(removed)throw new Error('Runtime was uninstalled.');
    if(options.fontDataUrl!==undefined){const next=asset(options.fontDataUrl,FONT,8*1024*1024,'invalid-font');if(next!==fontDataUrl){fontDataUrl=next;fontToken++;fontRequested=false;if(font){document.fonts.delete(font);font=null;}if(ui)loadFont();}}
    return status();
  }
  function show(options={}) {
    if(removed)throw new Error('Runtime was uninstalled.');
    assetCacheMiss=false;assetCacheHit=false;uiCacheHit=false;
    let nextContext,profile,avatar,foreground,contour,holoAssets,nextLayout,nextState,signature,assetKey=null;
    try{
      nextContext=cleanContext(options.contextKey);profile=cleanRole(options.role);
      nextLayout=cleanLayout(options.layout??{});nextState=cleanState(options.cardState??{});
      if(options.assetKey!==undefined){if(typeof options.assetKey!=='string'||!/^[a-f0-9]{64}$/.test(options.assetKey))throw new TypeError('invalid-asset-key');assetKey=options.assetKey;}
      if(assetKey&&!RESOURCE_FIELDS.some(name=>Object.hasOwn(options,name))){
        const entry=assetCache.get(assetKey);
        if(!entry||entry.imageId!==profile.imageId){
          clearRestore();removeUI(true);contextKey=nextContext;roleId=profile.id;stale=false;failed=false;error=null;assetCacheMiss=true;
          return status();
        }
        ({avatar,foreground,contour,holoAssets}=entry);assetCache.delete(assetKey);assetCache.set(assetKey,entry);assetCacheHit=true;
      }else{
        avatar=asset(options.avatarDataUrl??'',IMAGE,8*1024*1024,'invalid-avatar');
        foreground=asset(options.foregroundDataUrl??'',LAYER_IMAGE,5*1024*1024,'invalid-foreground');
        contour=asset(options.contourDataUrl??'',LAYER_IMAGE,5*1024*1024,'invalid-contour');
        if(contour&&!foreground)throw new TypeError('invalid-contour');
        holoAssets=null;
        if(options.holoAssets!==undefined&&options.holoAssets!==null){
          if(typeof options.holoAssets!=='object'||Array.isArray(options.holoAssets))throw new TypeError('invalid-holo-assets');
          holoAssets=Object.fromEntries(['character','background','ui','structure'].map(key=>[key,asset(options.holoAssets[key],LAYER_IMAGE,3*1024*1024,'invalid-holo-assets')]));
          if(Object.values(holoAssets).some(value=>!value))throw new TypeError('invalid-holo-assets');
        }
        if(assetKey)cacheAssets(assetKey,{imageId:profile.imageId,avatar,foreground,contour,holoAssets});
      }
      if(options.fontDataUrl!==undefined)configure({fontDataUrl:options.fontDataUrl});
      signature=assetKey?JSON.stringify([profile,assetKey]):JSON.stringify([profile,avatar,foreground,contour,holoAssets]);
    }catch(problem){if(nextContext)contextKey=nextContext;return fail(['invalid-profile','invalid-layout','invalid-card-state','invalid-avatar','invalid-foreground','invalid-contour','invalid-font','invalid-holo-assets','invalid-asset-key'].includes(problem.message)?problem.message:'invalid-show-options');}
    const unchanged=ui&&roleSignature===signature&&contextKey===nextContext;
    const hadFocus=Boolean(ui?.root.activeElement||recovery?.root.activeElement),sameIdentity=roleId===profile.id&&contextKey===nextContext;
    contextKey=nextContext;stale=false;failed=false;error=null;
    layout={...layout,...nextLayout};cardState={...(sameIdentity?cardState:{flipped:false,collapsed:false}),...nextState};
    if(!profile.enabled){clearRestore();purgeRole(profile.id);removeUI(true);roleId=profile.id;return status();}
    try{
      watchMetadata();clampPosition(false);
      purgeRole(profile.id,signature);
      // Only an explicit, validated show can authorize a recovery control.
      restoreTarget={profile,avatar,foreground,contour,holoAssets,assetKey,contextKey:nextContext,title:document.title};
      if(dismissedContexts.has(dismissalKey(contextKey,profile.id))){removeUI(true);roleId=profile.id;makeRecovery(hadFocus);return status();}
      removeRecovery();
      if(unchanged){uiCacheHit=canRetain(ui);syncCard(false);paintPosition();return status();}
      removeUI(true);
      let instance=readyCards.get(signature);
      if(instance){readyCards.delete(signature);uiCacheHit=true;}else instance=makeUI(profile,avatar,foreground,contour,holoAssets);
      pruneReady(UI_CACHE_LIMIT-1);ui=instance;instance.assetKey=assetKey;instance.signature=signature;roleId=profile.id;roleSignature=signature;
      document.body.append(instance.layer);syncCard(hadFocus);paintPosition();instance.resize.observe(instance.panel);
      if(getComputedStyle(instance.layer).position!=='fixed'||getComputedStyle(instance.layer).pointerEvents!=='none'||getComputedStyle(instance.panel).position!=='absolute'||getComputedStyle(instance.frontFace).position!=='absolute'||getComputedStyle(instance.front).position!=='relative')return fail('style-blocked');
      const pictures=instance.root.querySelectorAll('img');if([...pictures].some(image=>image.complete&&image.naturalWidth===0))return fail('portrait-load-failed');
      loadFont();instance.startMaterial();return status();
    }catch(problem){return fail(['viewport-too-small','style-blocked'].includes(problem.message)?problem.message:'render-failed');}
  }
  function restore() {
    if(removed)throw new Error('Runtime was uninstalled.');
    const target=restoreTarget;
    if(!target||failed||stale||contextKey!==target.contextKey||roleId!==target.profile.id)return status();
    if(document.title!==target.title){markStale('title-changed');return status();}
    dismissedContexts.delete(dismissalKey(contextKey,roleId));
    const result=show({role:target.profile,avatarDataUrl:target.avatar,foregroundDataUrl:target.foreground,contourDataUrl:target.contour,holoAssets:target.holoAssets,...(target.assetKey?{assetKey:target.assetKey}:{}),contextKey:target.contextKey,layout:{...layout},cardState:{...cardState}});
    if(ui)(cardState.collapsed?ui.compact.mini:cardState.flipped?ui.back:ui.front).focus({preventScroll:true});
    emit('mai-work-badges-state');return result;
  }
  function hide(options={}) {
    if(removed)return status();clearRestore();removeUI(true);
    if(options.contextKey!==undefined){const next=options.contextKey===null?null:cleanContext(options.contextKey);if(next!==contextKey){failed=false;error=null;}contextKey=next;}
    if(options.reason==='stale')stale=true;
    return status();
  }
  function uninstall() {
    if(removed)return;clearRestore();removeUI();for(const instance of [...readyCards.values()])destroyInstance(instance);assetCache.clear();assetBytes=0;removed=true;watchers?.abort();titleObserver?.disconnect();headObserver?.disconnect();watchers=null;
    fontToken++;if(font)document.fonts.delete(font);font=null;dismissedContexts.clear();roleId=null;contextKey=null;
    sidebar?.uninstall();sidebar=null;sidebarItems=[];sidebarProjectTitle=null;
    if(window[GLOBAL]===api)delete window[GLOBAL];
  }
  const api=Object.freeze({brand:BRAND,version:2,build:BUILD,revision:REVISION,configure,configureSidebar,show,hide,restore,status,uninstall});
  Object.defineProperty(window,GLOBAL,{value:api,configurable:true});
})();
