/* global document, location, getComputedStyle */
/** Run only in the documented browser read-only DOM evaluation scope.
 * This projection describes one rendered attachment message, never session history.
 * The caller supplies a fresh normal Account UI observation; no credentials are read.
 */
export function observeChatgptDownloadDOM({ filename, account, nativeMessageId, attachmentIndex }) {
  const fail = () => { throw new Error('HOST_DOWNLOAD_DOM_UNAVAILABLE'); };
  const attributes = new Set(['data-file-reference', 'data-markdown-copy-text',
    'data-chatgpt-copy-reference', 'data-markdown-copy', 'data-markdown-text-style',
    'data-chatgpt-selection-conversation-id', 'data-chatgpt-selection-message-id',
    'data-talvt-turn-state', 'data-turn-key', 'data-chatgpt-conversation-selection-target',
    'role', 'aria-busy', 'aria-label', 'aria-disabled', 'hidden', 'aria-hidden', 'data-state',
    'data-dil-source-message-id', 'data-dil-message-id', 'data-d-component', 'tabindex']);
  const groupAttributes = new Set([...attributes, 'id', 'aria-controls', 'aria-expanded', 'title', 'class']);
  const node = element => ({ tag: element.tagName,
    attributes: Array.from(element.attributes).filter(a => attributes.has(a.name)).map(a => [a.name, a.value]) });
  const groupNode = element => ({ tag: element.tagName,
    attributes: Array.from(element.attributes).filter(a => groupAttributes.has(a.name)).map(a => [a.name, a.value]) });
  const visible = element => {
    const style = getComputedStyle(element);
    return style.display !== 'none' && style.visibility === 'visible' && element.getClientRects().length > 0;
  };
  // SVG icons in the observed ZIP and PNG controls are decorative. They may have no
  // rectangle and aria-hidden=true; other hidden or loading descendants are content gaps.
  const decorative = element => {
    if (element.tagName.toUpperCase() !== 'SVG' || element.getAttribute('aria-hidden') !== 'true') return false;
    const visit = part => {
      if (Array.from(part.childNodes).some(n => n.nodeType === 3 && n.textContent.trim())) return false;
      return Array.from(part.children).every(child =>
        ['PATH', 'USE', 'G', 'CIRCLE', 'RECT', 'LINE', 'POLYLINE', 'POLYGON'].includes(child.tagName.toUpperCase()) && visit(child));
    };
    return visit(element);
  };
  const auxiliary = (element, kind) => {
    if (kind !== 'card' || element.tagName !== 'SPAN' ||
        element.getAttribute('data-markdown-copy') !== 'exclude' ||
        element.getAttribute('class') !== 'hidden group-focus-within/resource-row:inline group-hover/resource-row:inline' ||
        element.children.length !== 0 || element.childNodes.length !== 1 ||
        element.childNodes[0].nodeType !== 3 || element.childNodes[0].textContent !== 'Open file' ||
        getComputedStyle(element).display !== 'none' || !element.parentElement ||
        element.parentElement.tagName !== 'SPAN' ||
        element.parentElement.getAttribute('class') !== 'truncate text-secondary text-xs' ||
        element.parentElement.children.length !== 2 || element.parentElement.children[1] !== element) return false;
    const sibling = element.parentElement.children[0];
    return sibling.tagName === 'SPAN' &&
      sibling.getAttribute('class') === 'group-focus-within/resource-row:hidden group-hover/resource-row:hidden' &&
      sibling.innerText.trim() === 'Image' && getComputedStyle(sibling).display !== 'none';
  };
  const resourceLabels = (row, fileType) => {
    const labels = Array.from(row.querySelectorAll('span')).filter(el =>
      el.getAttribute('class') === 'truncate text-secondary text-xs');
    if (labels.length !== 1 || labels[0].children.length !== 2) fail();
    const [type, open] = labels[0].children;
    if (type.tagName !== 'SPAN' || open.tagName !== 'SPAN' ||
        type.getAttribute('class') !== 'group-focus-within/resource-row:hidden group-hover/resource-row:hidden' ||
        open.getAttribute('class') !== 'hidden group-focus-within/resource-row:inline group-hover/resource-row:inline' ||
        open.getAttribute('data-markdown-copy') !== 'exclude' || type.textContent !== fileType ||
        open.textContent !== 'Open file' || type.children.length || open.children.length) fail();
    for (const label of [type, open]) {
      if (label.getAttribute('hidden') !== null || label.getAttribute('aria-hidden') === 'true' ||
          label.getAttribute('aria-busy') === 'true' ||
          ['loading', 'open', 'pending', 'streaming'].includes(label.getAttribute('data-state')) ||
          getComputedStyle(label).visibility !== 'visible') fail();
    }
    const typeShown = visible(type), openShown = visible(open);
    if (typeShown === openShown) fail();
    if ((typeShown ? open : type).getClientRects().length ||
        getComputedStyle(typeShown ? open : type).display !== 'none') fail();
    return typeShown ? 'type' : 'open_file';
  };
  const contentsWrapper = (part, download) => part === download.parentElement &&
    part.tagName === 'SPAN' && part.getAttribute('class') === 'contents' &&
    part.getAttribute('data-state') === 'closed' &&
    part.children.length === 1 && part.children[0] === download &&
    part.getAttribute('hidden') === null && part.getAttribute('aria-hidden') !== 'true' &&
    part.getAttribute('aria-busy') !== 'true' &&
    !part.textContent.trim() && getComputedStyle(part).display === 'contents' &&
    getComputedStyle(part).visibility === 'visible' && visible(download);
  const rowIcon = (part, download) => {
    const svg = part.tagName.toUpperCase() === 'SVG' ? part : part.closest('svg');
    return svg && (svg.getAttribute('aria-hidden') === 'true' || svg.parentElement === download) &&
      svg.tagName.toUpperCase() === 'SVG' && !svg.textContent.trim() &&
      svg.getAttribute('hidden') === null && svg.getAttribute('aria-busy') !== 'true' &&
      svg.getAttribute('aria-hidden') !== 'false' &&
      !['loading', 'open', 'pending', 'streaming'].includes(svg.getAttribute('data-state')) &&
      Array.from(svg.children).every(child => child.tagName.toUpperCase() === 'PATH' &&
        !child.textContent.trim() && !child.children.length && child.getAttribute('hidden') === null &&
        child.getAttribute('aria-hidden') !== 'true' && child.getAttribute('aria-busy') !== 'true' &&
        child.getAttribute('role') !== 'button' &&
        !['loading', 'open', 'pending', 'streaming'].includes(child.getAttribute('data-state')));
  };
  const audit = (element, kind) => {
    if (decorative(element)) return false;
    if (auxiliary(element, kind)) return false;
    if (element.getAttribute('hidden') !== null || element.getAttribute('aria-hidden') === 'true' ||
        element.getAttribute('aria-busy') === 'true' ||
        ['loading', 'open', 'pending', 'streaming'].includes(element.getAttribute('data-state')) ||
        getComputedStyle(element).display === 'none' || getComputedStyle(element).visibility !== 'visible') fail();
    if (!['DIV', 'P', 'SPAN', 'BUTTON'].includes(element.tagName)) fail();
    if (kind === 'text' && (element.tagName === 'BUTTON' || element.getAttribute('role') === 'button')) fail();
    if (kind === 'text_analysis' && (element.tagName === 'BUTTON' || element.getAttribute('role') === 'button') &&
        (element.tagName !== 'BUTTON' || element.getAttribute('aria-label') !== 'View analysis' ||
          Array.from(element.children).some(child => !decorative(child)))) fail();
    if (kind === 'reference' && (element.tagName === 'BUTTON' ||
        (element.getAttribute('role') === 'button' && element.getAttribute('data-file-reference') !== 'true'))) fail();
    const ownText = Array.from(element.childNodes).some(n => n.nodeType === 3 && n.textContent.trim());
    const childContent = Array.from(element.children).map(child => audit(child, kind));
    if (element.tagName === 'DIV' && !ownText && !childContent.some(Boolean)) fail();
    if (element.tagName === 'SPAN' && !ownText && !childContent.some(Boolean) && element.children.length === 0) fail();
    return ownText || childContent.some(Boolean) || element.tagName === 'BUTTON' ||
      element.getAttribute('data-file-reference') === 'true';
  };
  const selectedMessage = element => nativeMessageId === undefined ||
    element.closest('[data-chatgpt-selection-message-id]')?.getAttribute('data-chatgpt-selection-message-id') === nativeMessageId;
  const controls = Array.from(document.querySelectorAll('[data-file-reference]'))
    .filter(el => el.getAttribute('data-markdown-copy-text') === filename && selectedMessage(el));
  const previews = Array.from(document.querySelectorAll('button'))
    .filter(el => el.getAttribute('aria-label') === `Open preview of ${filename}` && selectedMessage(el));
  const fileLinks = Array.from(document.querySelectorAll('[role="link"]')).filter(el =>
    filename.endsWith('.zip') && el.getAttribute('aria-label') === `Open ${filename}` &&
    el.closest('[data-dil-source-message-id]') && selectedMessage(el));
  const candidates = [...controls, ...previews, ...fileLinks];
  if (attachmentIndex !== undefined && (!nativeMessageId || !Number.isSafeInteger(attachmentIndex) ||
      attachmentIndex < 0 || attachmentIndex > 63)) fail();
  if (!candidates.length || (attachmentIndex === undefined && candidates.length !== 1)) fail();
  const selected = candidates[0];
  const message = selected.closest('[data-chatgpt-selection-message-id]');
  const turn = selected.closest('[data-turn-key]');
  const state = selected.closest('[data-talvt-turn-state]');
  const conversation = selected.closest('[data-chatgpt-conversation-selection-target]');
  if (!message || !turn || !state || !conversation || !visible(message) ||
      message.getAttribute('hidden') !== null) fail();
  const ids = Array.from(document.querySelectorAll('[data-chatgpt-selection-message-id]'))
    .filter(el => el.getAttribute('data-chatgpt-selection-message-id') === message.getAttribute('data-chatgpt-selection-message-id'));
  if (ids.length !== 1) fail();
  const chain = element => {
    const result = [];
    for (let parent = element; parent; parent = parent.parentElement) {
      result.push(node(parent));
      if (parent === conversation) return result;
      if (result.length > 32) fail();
    }
    fail();
  };
  const groupChain = element => {
    const result = [];
    for (let parent = element; parent; parent = parent.parentElement) {
      result.push(groupNode(parent));
      if (parent === conversation) return result;
      if (result.length > 32) fail();
    }
    fail();
  };
  const resourceRow = element => {
    for (let parent = element; parent && parent !== message; parent = parent.parentElement) {
      if ((parent.getAttribute('class') ?? '').split(/\s+/).includes('group/resource-row')) return parent;
    }
    return null;
  };
  if (previews.length === 1) {
    const row = resourceRow(selected);
    const buttons = row && Array.from(row.querySelectorAll('button,[role="button"]'));
    if (!row || !buttons || buttons.length !== 2 || buttons[0] !== selected ||
        buttons[1].getAttribute('aria-label') !== 'Download file' || !visible(buttons[1])) fail();
  }
  const blocks = [];
  const unknown = () => blocks.push({ kind: 'unknown' });
  const meaningfulText = element => Array.from(element.childNodes).some(n => n.nodeType === 3 && n.textContent.trim());
  const emptyHiddenSpan = element => element.tagName === 'SPAN' &&
    element.attributes.length === 1 && element.attributes[0].name === 'hidden' &&
    element.attributes[0].value === '' && element.childNodes.length === 0 &&
    element.textContent === '' && !visible(element);
  if (meaningfulText(message)) unknown();
  let markdownCount = 0;
  for (const [index, child] of Array.from(message.children).entries()) {
    if (index === 0 && emptyHiddenSpan(child)) {
      blocks.push({ kind: 'empty_hidden_span_v1', node: node(child), ancestry: chain(child) });
      continue;
    }
    if (!visible(child)) { unknown(); continue; }
    if (child.getAttribute('data-markdown-text-style') === 'assistant-message') {
      markdownCount++;
      if (meaningfulText(child)) unknown();
      for (const paragraph of child.children) {
        if (paragraph.getAttribute('data-dil-source-message-id') !== null) {
          if (paragraph.tagName !== 'DIV' || paragraph.getAttribute('data-dil-source-message-id') !==
              message.getAttribute('data-chatgpt-selection-message-id') ||
              paragraph.getAttribute('data-markdown-copy') !== 'contents' || !visible(paragraph)) fail();
          const renderers = paragraph.querySelectorAll('[data-dil-message-id]');
          if (renderers.length !== 1 || renderers[0].getAttribute('data-dil-message-id') !==
              message.getAttribute('data-chatgpt-selection-message-id')) fail();
          const parts = [paragraph, ...paragraph.querySelectorAll('*')];
          if (parts.length > 2048) fail();
          for (const part of parts) {
            // The observed renderer has a single empty, hidden placeholder; no hidden content is ignored.
            if (part.tagName === 'DIV' && part.getAttribute('hidden') === '' &&
                part.attributes.length === 1 && part.childNodes.length === 0) continue;
            if (part.getAttribute('class') === 'Edges-UXy4Ue') {
              if (part.tagName !== 'DIV' || part.getAttribute('aria-hidden') !== 'true' ||
                  part.attributes.length !== 3 ||
                  !Array.from(part.attributes).every(attr => ['aria-hidden', 'class', 'style'].includes(attr.name)) ||
                  !/^left: 0px; top: 0px; width: [1-9]\d{0,4}px; height: [1-9]\d{0,4}px;$/.test(
                    part.getAttribute('style') ?? '') || part.childNodes.length !== 0 || part.textContent !== '') fail();
              continue;
            }
            const svg = part.tagName.toUpperCase() === 'SVG' ? part : part.closest('svg');
            if (part.tagName.toUpperCase() === 'CIRCLE' && Array.from(part.attributes).some(attr =>
              /^on/i.test(attr.name) || ['href', 'xlink:href'].includes(attr.name))) fail();
            if (svg && !svg.textContent.trim() && ['SVG', 'PATH', 'CIRCLE'].includes(part.tagName.toUpperCase()) &&
                part.getAttribute('role') === null && part.getAttribute('aria-busy') !== 'true' &&
                part.getAttribute('hidden') === null && part.getAttribute('aria-hidden') !== 'false' &&
                part.getAttribute('tabindex') === null && part.getAttribute('contenteditable') === null &&
                part.getAttribute('data-d-component') !== 'pressable' &&
                !['loading', 'open', 'pending', 'streaming'].includes(part.getAttribute('data-state'))) continue;
            if (!['DIV', 'SPAN', 'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'TABLE', 'TBODY', 'THEAD',
              'TR', 'TH', 'TD', 'UL', 'OL', 'LI', 'CODE', 'PRE', 'STRONG', 'EM', 'BR', 'HR'].includes(part.tagName) ||
                !visible(part) || part.getAttribute('hidden') !== null || part.getAttribute('aria-hidden') === 'true' ||
                part.getAttribute('aria-busy') === 'true' ||
                ['loading', 'open', 'pending', 'streaming'].includes(part.getAttribute('data-state')) ||
                (part.getAttribute('contenteditable') !== null && part.getAttribute('contenteditable') !== 'false')) fail();
            const role = part.getAttribute('role');
            if (role !== null && role !== 'link') fail();
            if (role === null && (part.getAttribute('tabindex') !== null ||
                part.getAttribute('data-d-component') === 'pressable')) fail();
            if (role === 'link' && (part.tagName !== 'SPAN' || part.getAttribute('data-d-component') !== 'pressable' ||
                part.getAttribute('aria-label') !== `Open ${part.innerText.trim()}` ||
                part.getAttribute('tabindex') !== '0' || part.getAttribute('aria-disabled') === 'true')) fail();
          }
          const links = Array.from(paragraph.querySelectorAll('[role="link"]')).map(link => ({
            label: link.getAttribute('aria-label'), renderedText: link.innerText.trim(), ancestry: chain(link) }));
          if (!links.length || links.length > 64) fail();
          blocks.push({ kind: 'rendered_file_links_v1', referenceIndex: paragraph.getAttribute('data-chatgpt-copy-reference'),
            renderedText: paragraph.innerText, ancestry: chain(paragraph), links });
          continue;
        }
        if (paragraph.tagName !== 'P' || !visible(paragraph)) { unknown(); continue; }
        const refs = Array.from(paragraph.querySelectorAll('[data-file-reference]'));
        if (refs.length === 0) {
          const actions = Array.from(paragraph.querySelectorAll('button,[role="button"]'));
          if (actions.length > 1 || actions.some(action => action.tagName !== 'BUTTON' ||
              action.getAttribute('aria-label') !== 'View analysis' || !visible(action))) fail();
          const analysis = actions[0];
          if (analysis && (analysis.closest('[data-state="closed"]') === null ||
              !paragraph.contains(analysis.closest('[data-state="closed"]')))) fail();
          audit(paragraph, analysis ? 'text_analysis' : 'text');
          blocks.push({ kind: 'text', renderedText: paragraph.innerText,
            ...(analysis ? { analysisControl: { label: 'View analysis', ancestry: chain(analysis) } } : {}) });
        } else if (refs.length === 1) {
          const ref = refs[0];
          const reference = ref.closest('[data-chatgpt-copy-reference]');
          if (!reference || !paragraph.contains(reference)) { unknown(); continue; }
          audit(paragraph, 'reference');
          // The complete rendered paragraph must be the one reference plus passive icons.
          if (reference.innerText.trim() !== paragraph.innerText.trim() ||
              Array.from(paragraph.querySelectorAll('*')).some(el =>
            !reference.contains(el) && el !== reference &&
            (el.innerText.trim() || el.tagName === 'BUTTON' || el.getAttribute('role') === 'button')) ||
              Array.from(paragraph.childNodes).some(n => n.nodeType === 3 && n.textContent.trim())) fail();
          blocks.push({ kind: 'file_reference', filename: ref.getAttribute('data-markdown-copy-text'),
            referenceIndex: reference.getAttribute('data-chatgpt-copy-reference'),
            renderedText: paragraph.innerText, visible: visible(ref), ancestry: chain(ref) });
        } else unknown();
      }
    } else {
      const list = child.querySelector('[id]');
      const expand = Array.from(child.querySelectorAll('button')).filter(button =>
        button.getAttribute('aria-controls') !== null);
      if (list || expand.length) {
        if (child.tagName !== 'DIV' || !list || expand.length !== 1 ||
            child.children.length !== 1 || child.children[0].tagName !== 'DIV' ||
            child.children[0].children.length !== 2 || child.children[0].children[0] !== list ||
            child.children[0].children[1] !== expand[0] ||
            meaningfulText(child) || meaningfulText(child.children[0]) ||
            list.tagName !== 'DIV' || !list.getAttribute('id') ||
            expand[0].getAttribute('aria-controls') !== list.getAttribute('id') ||
            expand[0].getAttribute('aria-expanded') !== 'true' ||
            expand[0].innerText.trim() !== 'Show less' ||
            !visible(list) || !visible(expand[0]) ||
            list.parentElement !== expand[0].parentElement ||
            Array.from(child.querySelectorAll('[id]')).length !== 1 ||
            Array.from(child.querySelectorAll('button,[role="button"]')).length !== list.children.length * 2 + 1 ||
            list.children.length < 2 || list.children.length > 32 ||
            child.querySelector('iframe,pre,canvas,video,audio')) fail();
        const icon = Array.from(expand[0].children);
        if (icon.length !== 1 || icon[0].tagName.toUpperCase() !== 'SVG' ||
            icon[0].textContent.trim() ||
            Array.from(icon[0].children).some(x => x.tagName.toUpperCase() !== 'PATH' || x.textContent.trim())) fail();
        const rows = Array.from(list.children).map((row, rowIndex) => {
          if (row.tagName !== 'SPAN' || !(row.getAttribute('class') ?? '').split(/\s+/).includes('group/resource-row') ||
              !visible(row) || row.getAttribute('hidden') !== null || row.getAttribute('aria-hidden') === 'true') fail();
          const buttons = Array.from(row.querySelectorAll('button,[role="button"]'));
          if (buttons.length !== 2 || buttons.some(button => button.tagName !== 'BUTTON' || !visible(button) ||
              button.getAttribute('hidden') !== null || button.getAttribute('aria-hidden') === 'true' ||
              button.getAttribute('aria-busy') === 'true')) fail();
          const [preview, download] = buttons;
          const match = /^Open preview of (.+)$/.exec(preview.getAttribute('aria-label') ?? '');
          const filename = match?.[1];
          const title = Array.from(row.querySelectorAll('[title]'));
          const typeText = Array.from(row.querySelectorAll('span')).find(el =>
            el.getAttribute('class') === 'group-focus-within/resource-row:hidden group-hover/resource-row:hidden')?.textContent;
          if (!filename || title.length !== 1 || title[0].getAttribute('title') !== filename ||
              title[0].textContent !== filename || download.getAttribute('aria-label') !== 'Download file' ||
              !['Document', 'HTML', 'Code', 'Image'].includes(typeText) ||
              ![`${filename}\n${typeText}`, `${filename}\nOpen file`].includes(row.innerText.trim())) fail();
          const labelState = resourceLabels(row, typeText);
          if (row.innerText.trim() !== `${filename}\n${labelState === 'type' ? typeText : 'Open file'}`) fail();
          // Only the precisely paired label may be CSS hidden. Everything else is audited.
          const paired = Array.from(row.querySelectorAll('[data-markdown-copy="exclude"]'))[0];
          const type = paired.parentElement.children[0];
          for (const part of [row, ...row.querySelectorAll('*')]) {
            if (part === paired || part === type) continue;
            const svg = part.tagName.toUpperCase() === 'SVG' ? part : part.closest('svg');
            if (svg && rowIcon(part, download)) continue;
            if (contentsWrapper(part, download)) continue;
            if (part.getAttribute('hidden') !== null || part.getAttribute('aria-hidden') === 'true' ||
                part.getAttribute('aria-busy') === 'true' ||
                ['loading', 'open', 'pending', 'streaming'].includes(part.getAttribute('data-state')) ||
                !visible(part) || !['SPAN', 'BUTTON', 'DIV'].includes(part.tagName)) fail();
          }
          const previewRowIndex = Array.from(list.children).indexOf(resourceRow(preview));
          const downloadRowIndex = Array.from(list.children).indexOf(resourceRow(download));
          if (previewRowIndex !== rowIndex || downloadRowIndex !== rowIndex) fail();
          return { filename, fileType: typeText, labelState, renderedText: row.innerText,
            rowIndex, previewRowIndex, downloadRowIndex,
            rowNode: groupNode(row), rowAncestry: groupChain(row), previewNode: groupNode(preview),
            previewAncestry: groupChain(preview), downloadNode: groupNode(download),
            downloadAncestry: groupChain(download) };
        });
        blocks.push({ kind: 'resource_card_group_v1', listNode: groupNode(list), ancestry: groupChain(list),
          expandedControl: { label: 'Show less', node: groupNode(expand[0]), ancestry: groupChain(expand[0]) },
          renderedText: child.innerText, rows });
        continue;
      }
      // The current supported non-Markdown shape is a single passive image file card.
      const buttons = Array.from(child.querySelectorAll('button,[role="button"]'));
      const previews = buttons.filter(el => (el.getAttribute('aria-label') ?? '').startsWith('Open preview of '));
      const downloads = buttons.filter(el => el.getAttribute('aria-label') === 'Download file');
      if (child.tagName !== 'DIV' || buttons.length !== 2 || previews.length !== 1 || downloads.length !== 1 ||
          !visible(previews[0]) || !visible(downloads[0]) ||
          resourceRow(previews[0]) === null || resourceRow(previews[0]) !== resourceRow(downloads[0]) ||
          child.querySelector('iframe,pre,canvas,video,audio')) {
        unknown(); continue;
      }
      audit(child, 'card');
      const auxiliaries = Array.from(child.querySelectorAll('[data-markdown-copy="exclude"]'));
      if (auxiliaries.length > 1 || auxiliaries.some(el => !auxiliary(el, 'card'))) fail();
      const previewLabel = previews[0].getAttribute('aria-label');
      const cardFilename = previewLabel.slice('Open preview of '.length);
      if (child.innerText.trim() !== `${cardFilename}\nImage`) { unknown(); continue; }
      blocks.push({ kind: 'image_card', filename: cardFilename, typeImage: 'Image', previewLabel,
        downloadLabel: 'Download file', visible: true, ancestry: chain(downloads[0]),
        ...(auxiliaries.length ? { auxiliaryLabel: 'Open file' } : {}) });
    }
  }
  if (markdownCount !== 1 || blocks.length === 0 || blocks.length > 64) fail();
  const generationControls = Array.from(document.querySelectorAll('button,[role="button"]'))
    .filter(visible).map(el => el.getAttribute('aria-label') ?? el.innerText)
    .filter(label => /stop (generating|response|responding)|停止生成|停止回答/i.test(label));
  const dialogs = Array.from(document.querySelectorAll('[role="dialog"]')).filter(visible).map(el => el.innerText);
  const composers = Array.from(document.querySelectorAll('[contenteditable="true"]'));
  if (composers.length !== 1) fail();
  return { sourceKind: 'observed_chatgpt_dom_attachment_v1', account,
    ui: { url: location.href, dialogs, composerText: composers[0].textContent === '' ? '' : composers[0].innerText,
      turnStates: Array.from(document.querySelectorAll('[data-talvt-turn-state]')).map(el => el.getAttribute('data-talvt-turn-state')),
      generationControls },
    dom: { turn: node(turn), stateNode: node(state), message: node(message), blocks } };
}
