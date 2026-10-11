(function (token, origin, marker) {
  'use strict';
  function link(event) {
    if (!event.isTrusted || (event.type === 'click' ? event.button !== 0 : event.button !== 1)) return;
    const anchor = event.composedPath().find(node =>
      node instanceof Element && (node.localName === 'a' || node.localName === 'area') &&
      (node.hasAttribute('href') || node.hasAttribute('xlink:href')));
    if (!anchor) return;
    const href = anchor.getAttribute('href') ?? anchor.getAttribute('xlink:href');
    const download = anchor.hasAttribute('download');
    const target = anchor.getAttribute('target') ??
      document.querySelector('base[target]')?.getAttribute('target');
    if (href.startsWith('#') && !download && !event.ctrlKey && !event.metaKey &&
        !event.shiftKey && !event.altKey && event.button === 0 &&
        (!target || target.toLowerCase() === '_self')) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    // The parent validates schemes and resolves this raw attribute against the
    // capability's canonical project path, never against an authored <base>.
    window.parent.postMessage({ type: 'artiface:preview-link', token, href, download, keyboard: event.detail === 0 }, origin);
  }
  window.addEventListener('click', link, true);
  window.addEventListener('auxclick', link, true);
  let complete = false;
  function inspect(records) {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node instanceof HTMLMetaElement &&
            node.name === 'artiface-preview-complete' && node.content === marker) {
          complete = true;
          observer.disconnect();
          return;
        }
      }
    }
  }
  // Remember arrival even when a report's module later replaces document.body.
  const observer = new MutationObserver(inspect);
  observer.observe(document, { childList: true, subtree: true });
  document.addEventListener('DOMContentLoaded', () => {
    inspect(observer.takeRecords());
    observer.disconnect();
    if (!complete) return;
    window.parent.postMessage({ type: 'artiface:preview-ready', token }, origin);
  }, { once: true });
})
