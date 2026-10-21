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
