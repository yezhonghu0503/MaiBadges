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
