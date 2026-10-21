(() => {
  const api = window.MaiWorkBadgeRuntime;
  if (api && (api.brand !== 'mai-work-badges/2' || typeof api.status !== 'function')) {
    return {kind: 'conflict'};
  }
  // Metadata only. No message text, other conversation links, or navigation lists.
  return {url: location.href, title: document.title,
    ready: Boolean(document.body) && document.readyState !== 'loading',
    runtime: api ? api.status() : null};
})()
