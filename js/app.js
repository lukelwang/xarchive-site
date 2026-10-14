(() => {
  "use strict";

  const ACCOUNTS = {
    "1chartmaster": { name: "1ChartMaster", global: "ARCHIVE_POSTS", src: "data/posts.js" },
    "1chartmaster-public": { name: "1ChartMaster (Public)", handle: "1ChartMaster", global: "ARCHIVE_POSTS_1CHARTMASTER_PUBLIC", src: "data/posts-1chartmaster-public.js" },
    "ohiain": { name: "ohiain", global: "ARCHIVE_POSTS_OHIAIN", src: "data/posts-ohiain.js" },
    "ohiain-public": { name: "ohiain (Public)", handle: "ohiain", global: "ARCHIVE_POSTS_OHIAIN_PUBLIC", src: "data/posts-ohiain-public.js" },
    "mmonis": { name: "mmonis (Public)", handle: "mmonis", global: "ARCHIVE_POSTS_MMONIS", src: "data/posts-mmonis.js" }
  };
  const DEFAULT_ACCOUNT = "1chartmaster";
  const TICKER_TOKEN = /^\$[a-z][a-z0-9.-]{0,9}$/i;
  const DATE_TOKEN = /^\d{4}-\d{2}-\d{2}$/;
  const TEXT_TOKENS = /(https?:\/\/[^\s]+)|(\$[A-Za-z][A-Za-z0-9]*(?:[.-][A-Za-z0-9]+)*)/g;
  const views = {};
  const scripts = {};
  let view = null;
  const byId = id => document.getElementById(id);
  const feed = byId("feed");
  const postsSlot = byId("posts");
  const search = byId("search");
  const from = byId("from");
  const to = byId("to");
  const sidebar = byId("sidebar");
  const dayIndex = byId("day-index");
  const filterBar = byId("filter-bar");
  const lightbox = byId("lightbox");
  const lightboxContent = byId("lightbox-content");
  const lightboxImage = byId("lightbox-image");
  const noDays = element("p", "help", "No days match the current filters.");
  const highlight = typeof Highlight === "function" && window.CSS && CSS.highlights ? new Highlight() : null;
  if (highlight) CSS.highlights.set("search", highlight);
  let state = { a: DEFAULT_ACCOUNT, q: "", from: "", to: "", images: "all", sort: "desc", p: "" };
  let debounce;
  let anchorTimer;
  let scrollPending = false;
  let navSeq = 0;
  let routeUrl = "";
  let routing = false;
  let entryKey = "";
  const anchors = new Map();
  let settleSeq = 0;
  let lastUrl = "";
  let currentDay = null;
  let jumpTarget = null;
  let highlightGen = 0;
  const nearDays = new Set();
  const pendingMeasure = new Set();
  const pendingIntrinsic = new Set();
  let gallery = [];
  let imageIndex = 0;
  let galleryLabel = "";
  let lightboxOpener;
  let zoomed = false;

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function validDate(value) {
    if (!DATE_TOKEN.test(value || "")) return "";
    const date = new Date(value + "T12:00:00Z");
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? value : "";
  }

  function dateLabel(key, options) {
    if (!validDate(key)) return "";
    return new Intl.DateTimeFormat("en-US", { ...options, timeZone: "UTC" }).format(new Date(key + "T12:00:00Z"));
  }

  const formatCount = number => number.toLocaleString("en-US");
  const normalizeTicker = value => value.replace(/[.-]+$/, "").toLowerCase();

  // Search is AND of word prefixes, "exact phrase", $TICKER (exact ticker). An unquoted
  // YYYY-MM-DD token matches the post's own date. Ticker tokens drop trailing "." / "-" like the data.
  function tokens(query) {
    return Array.from(query.matchAll(/"([^"]*)"|(\S+)/g), match => {
      const quoted = match[1] !== undefined;
      let value = (quoted ? match[1] : match[2]).toLowerCase();
      const ticker = !quoted && TICKER_TOKEN.test(value);
      if (ticker) value = "$" + normalizeTicker(value.slice(1));
      return { value, raw: match[0], index: match.index, quoted, ticker, date: !quoted && DATE_TOKEN.test(value) };
    }).filter(token => token.value);
  }

  function wordStarts(text) {
    const starts = new Set([0]);
    for (const match of text.matchAll(/[^\p{L}\p{N}]/gu)) starts.add(match.index + match[0].length);
    return starts;
  }

  function textMatch(text, starts, token, from = 0) {
    let index = text.indexOf(token.value, from);
    if (token.quoted) return index;
    while (index !== -1 && !starts.has(index)) index = text.indexOf(token.value, index + 1);
    return index;
  }

  function matchesSearch(entry, queryTokens) {
    return queryTokens.every(token => token.ticker ? entry.tickers.has(token.value.slice(1))
      : token.date ? entry.post.dateKey === token.value
      : textMatch(entry.search, entry.searchStarts, token) !== -1);
  }

  function matchesImages(entry) {
    return state.images === "all" || (state.images === "with" ? entry.hasImages : !entry.hasImages);
  }

  function matchesFilters(entry, queryTokens) {
    return matchesSearch(entry, queryTokens) && matchesImages(entry)
      && (!state.from || entry.post.dateKey >= state.from) && (!state.to || entry.post.dateKey <= state.to);
  }

  function filterKey() {
    return JSON.stringify([tokens(state.q).map(token => [token.value, token.quoted, token.ticker, token.date]), state.from, state.to, state.images]);
  }

  function readHash() {
    const params = new URLSearchParams(location.hash.slice(1));
    state = {
      a: ACCOUNTS.hasOwnProperty(params.get("a")) ? params.get("a") : DEFAULT_ACCOUNT,
      q: params.get("q") || "",
      from: validDate(params.get("from")),
      to: validDate(params.get("to")),
      images: ["with", "without"].includes(params.get("images")) ? params.get("images") : "all",
      sort: params.get("sort") === "asc" ? "asc" : "desc",
      p: params.get("p") || ""
    };
  }

  function hashFor(values) {
    const params = new URLSearchParams();
    if (values.a && values.a !== DEFAULT_ACCOUNT) params.set("a", values.a);
    if (values.q) params.set("q", values.q);
    if (values.from) params.set("from", values.from);
    if (values.to) params.set("to", values.to);
    if (values.images && values.images !== "all") params.set("images", values.images);
    if (values.sort === "asc") params.set("sort", values.sort);
    if (values.p) params.set("p", values.p);
    const hash = params.toString();
    return hash ? "#" + hash : "";
  }

  const newEntryKey = () => Math.random().toString(36).slice(2);

  // Every history entry carries a key; its scroll anchor lives in history.state and in `anchors`.
  // Replacing keeps the anchor unless the view changed underneath it.
  function writeHash(push = false, keepAnchor = false) {
    const url = location.pathname + location.search + hashFor(state);
    if (push) {
      entryKey = newEntryKey();
      history.pushState({ key: entryKey }, "", url);
    } else {
      if (!keepAnchor) anchors.delete(entryKey);
      history.replaceState({ ...(history.state || {}), key: entryKey, anchor: keepAnchor ? (history.state || {}).anchor || null : null }, "", url);
    }
    lastUrl = location.href;
  }

  // Called when history moves to another entry: remember where the user was on the one left.
  function leaveEntry(nextState) {
    const leaving = captureAnchor();
    if (leaving && entryKey) anchors.set(entryKey, leaving);
    entryKey = (nextState && nextState.key) || newEntryKey();
    return anchors.get(entryKey) || (nextState && nextState.anchor) || null;
  }

  function syncControls() {
    search.value = state.q;
    from.value = state.from;
    to.value = state.to;
    document.querySelectorAll('input[name="images"]').forEach(input => { input.checked = input.value === state.images; });
    document.querySelectorAll('input[name="sort"]').forEach(input => { input.checked = input.value === state.sort; });
  }

  function readControls() {
    state.q = search.value;
    state.from = validDate(from.value);
    state.to = validDate(to.value);
    if (state.from && state.to && state.from > state.to) {
      [state.from, state.to] = [state.to, state.from];
      from.value = state.from;
      to.value = state.to;
    }
    state.images = document.querySelector('input[name="images"]:checked').value;
    state.sort = document.querySelector('input[name="sort"]:checked').value;
  }

  // ---- Data loading ------------------------------------------------------------------------

  function dataFor(account) {
    return window[ACCOUNTS[account].global];
  }

  function loadData(account) {
    if (dataFor(account)) return Promise.resolve();
    if (!scripts[account]) {
      scripts[account] = new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src = ACCOUNTS[account].src;
        script.async = true;
        script.onload = () => dataFor(account) ? resolve() : reject(new Error("No data in " + script.src));
        script.onerror = () => reject(new Error("Could not load " + script.src));
        document.head.append(script);
      }).catch(error => { delete scripts[account]; error.account = account; throw error; });
    }
    return scripts[account];
  }

  function showFeedStatus(text, retry) {
    byId("feed-status").hidden = !text;
    byId("feed-status-text").textContent = text || "";
    byId("feed-status-retry").hidden = !retry;
  }

  function showArchiveStatus(account, failed = false) {
    unmount();
    markAccount(account);
    const text = failed ? "Couldn't load the " + ACCOUNTS[account].name + " archive." : "Loading " + ACCOUNTS[account].name + " archive…";
    byId("archive-summary").textContent = text;
    byId("result-count").textContent = failed ? "Posts unavailable" : "Loading posts…";
    showFeedStatus(text, failed);
  }

  // A hash can change before its navigation event runs, so check the URL as well as generation.
  function isCurrentRoute(seq) {
    return seq === navSeq && location.href === routeUrl;
  }

  async function ensureView(account, seq) {
    if (views[account]) return views[account];
    if (!dataFor(account)) {
      showArchiveStatus(account);
      try { await loadData(account); }
      catch (error) {
        if (isCurrentRoute(seq)) showArchiveStatus(account, true);
        return null;
      }
    }
    if (!views[account]) views[account] = buildView(account);
    return views[account];
  }

  async function findAccount(id, seq) {
    const order = [state.a, ...Object.keys(ACCOUNTS).filter(account => account !== state.a)];
    let failed = null;
    for (const account of order) {
      if (!isCurrentRoute(seq)) return null;
      if (views[account]) {
        if (views[account].byId.has(id)) return account;
        continue;
      }
      if (!dataFor(account)) showArchiveStatus(account);
      try { await loadData(account); }
      catch (error) { failed = error; continue; }
      if (!isCurrentRoute(seq)) return null;
      if ((dataFor(account) || []).some(post => post.id === id)) return account;
    }
    if (failed) throw failed;
    return null;
  }

  // ---- Building cards (once per account) -----------------------------------------------------

  function prepare(post) {
    const tickers = new Set(post.tickers.map(normalizeTicker).filter(Boolean));
    const quoteText = (post.quote && post.quote.text) || "";
    const textLower = post.text.toLowerCase();
    const quoteLower = quoteText.toLowerCase();
    const searchText = [post.text, Array.from(tickers, ticker => "$" + ticker).join(" "), quoteText].join("\n").toLowerCase();
    return {
      post,
      tickers,
      textLower, quoteLower, search: searchText,
      textStarts: wordStarts(textLower), quoteStarts: wordStarts(quoteLower), searchStarts: wordStarts(searchText),
      hasImages: post.images.length > 0 || Boolean(post.quote && post.quote.images.length),
      card: null, quoteText: null, more: null, paragraphs: [],
      measured: false, needsMore: false, autoExpanded: false, estimate: 0
    };
  }

  function buildView(account) {
    const data = dataFor(account) || [];
    // This public dataset is stored oldest first; views use newest first.
    const posts = account === "1chartmaster-public" ? data.slice().reverse() : data;
    const v = {
      account, entries: [], byId: new Map(), days: [], months: [], order: [], cards: null,
      container: element("div", "account-posts"), index: element("div", "day-index-list"),
      sort: "desc", filterKey: null, visible: 0, estimateWidth: 0
    };
    const dayMap = new Map();
    const monthMap = new Map();
    posts.forEach(post => {
      const entry = prepare(post);
      v.entries.push(entry);
      v.byId.set(post.id, entry);
    });
    v.entries.forEach(entry => {
      const key = entry.post.dateKey;
      let day = dayMap.get(key);
      if (!day) {
        const monthKey = key.slice(0, 7);
        let month = monthMap.get(monthKey);
        if (!month) {
          month = makeMonth(monthKey);
          monthMap.set(monthKey, month);
          v.months.push(month);
        }
        day = makeDay(key, month);
        dayMap.set(key, day);
        v.days.push(day);
        month.days.push(day);
      }
      entry.day = day;
      day.entries.push(entry);
    });
    v.days.forEach(day => {
      day.entries.forEach(entry => {
        entry.card = postCard(entry, v);
        day.section.append(entry.card);
      });
      v.container.append(day.section);
    });
    v.months.forEach(month => {
      month.days.forEach(day => month.list.append(day.link));
      v.index.append(month.details);
    });
    return v;
  }

  function makeMonth(key) {
    const details = element("details", "month-group");
    const summary = element("summary");
    const count = element("span", "day-count");
    summary.append(element("span", "month-name", dateLabel(key + "-15", { month: "long", year: "numeric" })), count);
    const list = element("div", "month-days");
    details.append(summary, list);
    const month = { key, details, count, list, days: [], auto: false, expectOpen: false };
    details.addEventListener("toggle", () => {
      if (details.open !== month.expectOpen) month.auto = false;
      month.expectOpen = details.open;
    });
    return month;
  }

  function makeDay(key, month) {
    const section = element("section", "day-section");
    section.id = "day-" + key;
    const heading = element("h2", "day-heading");
    heading.id = "heading-" + key;
    section.setAttribute("aria-labelledby", heading.id);
    section.append(heading);
    const link = element("a", "day-link");
    link.href = "#day-" + key;
    const count = element("span", "day-count");
    link.append(element("span", "", dateLabel(key, { weekday: "short", month: "short", day: "numeric" })), count);
    const day = {
      key, month, section, heading, link, count, entries: [], visible: 0, signature: "", estimate: 0,
      label: dateLabel(key, { weekday: "long", month: "short", day: "numeric", year: "numeric" }), highlightGen: -1
    };
    section.dayRef = day;
    link.addEventListener("click", event => {
      event.preventDefault();
      closeFilters();
      scrollElementTo(section, stickyTop());
    });
    return day;
  }

  function textWithTickers(text, className) {
    const paragraph = element("p", className);
    let position = 0;
    for (const match of text.matchAll(TEXT_TOKENS)) {
      let value = match[0];
      if (match[1]) value = value.replace(/[.,;:!?)\]}'"”’]+$/, "");
      paragraph.append(document.createTextNode(text.slice(position, match.index)));
      if (match[1]) {
        const link = element("a", "text-link", value);
        link.href = value;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        paragraph.append(link);
      } else {
        const button = element("button", "cashtag", value);
        button.type = "button";
        button.title = "Filter by " + value;
        button.dataset.ticker = normalizeTicker(value.slice(1));
        button.addEventListener("click", () => addTicker(value));
        paragraph.append(button);
      }
      position = match.index + value.length;
    }
    paragraph.append(document.createTextNode(text.slice(position)));
    return paragraph;
  }

  function originalLink(url, text) {
    const link = element("a", "", text);
    if (/^https:\/\/(?:www\.)?(?:x\.com|twitter\.com)\//i.test(url || "")) {
      link.href = url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
    }
    return link;
  }

  const IMAGE_CDN_BASE = "https://cdn.jsdelivr.net/gh/lukelwang/xarchive@main/";

  function localImageSource(image) {
    return /^images\/[A-Za-z0-9_.-]+$/.test(image.src) ? IMAGE_CDN_BASE + image.src : "";
  }

  function imageGrid(images, label) {
    const grid = element("div", "image-grid count-" + images.length);
    images.forEach((image, index) => {
      const button = element("button", "image-button");
      button.type = "button";
      button.setAttribute("aria-label", "Enlarge " + label + ", image " + (index + 1));
      const img = element("img");
      img.alt = label + ", image " + (index + 1);
      img.width = image.width;
      img.height = image.height;
      img.loading = "lazy";
      img.decoding = "async";
      const unavailable = () => {
        button.replaceChildren(element("span", "image-unavailable", "Image unavailable."));
      };
      img.addEventListener("error", unavailable, { once: true });
      const src = localImageSource(image);
      if (src) { img.src = src; button.append(img); }
      else unavailable();
      button.addEventListener("click", () => openLightbox(images, index, label, button));
      grid.append(button);
    });
    return grid;
  }

  function postLink(id, account) {
    return hashFor({ a: account, p: id });
  }

  function postCard(entry, v) {
    const post = entry.post;
    const article = element("article", "post");
    article.id = "p-" + post.id;
    article.tabIndex = -1;
    const header = element("header", "post-header");
    const permalink = element("a", "post-time", post.timestampLabel);
    permalink.href = postLink(post.id, v.account);
    permalink.title = "Link to this archived post";
    permalink.addEventListener("click", event => { event.preventDefault(); jumpToPost(post.id); });
    header.append(permalink, originalLink(post.url, "View original on X ↗"));
    const text = textWithTickers(post.text, "post-text");
    article.append(header, text);
    entry.paragraphs.push(text);
    if (post.images.length) article.append(imageGrid(post.images, "Post from " + post.timestampLabel));
    if (post.quote) {
      const quote = post.quote;
      const box = element("section", "quote");
      box.setAttribute("aria-label", "Quoted post");
      const quoteHeader = element("div", "quote-header");
      const inArchive = quote.inArchive && v.byId.has(quote.id);
      const quoteLabel = quote.timestampLabel || "Quoted post";
      quoteHeader.append(element("span", "", inArchive ? "@" + (ACCOUNTS[v.account].handle || ACCOUNTS[v.account].name) + " · " + quoteLabel : quoteLabel));
      if (inArchive) {
        const jump = element("a", "archive-jump", "In archive");
        jump.href = postLink(quote.id, v.account);
        jump.addEventListener("click", event => { event.preventDefault(); jumpToPost(quote.id); });
        quoteHeader.append(jump);
      } else quoteHeader.append(originalLink(quote.url, "Open on X ↗"));
      const quoteText = textWithTickers(quote.text, "quote-text clamped");
      quoteText.id = "quote-text-" + post.id;
      const more = element("button", "show-more", "Show more");
      more.type = "button";
      more.hidden = true;
      more.setAttribute("aria-expanded", "false");
      more.setAttribute("aria-controls", quoteText.id);
      more.addEventListener("click", () => {
        entry.autoExpanded = false;
        setQuoteExpanded(entry, more.getAttribute("aria-expanded") !== "true");
      });
      box.append(quoteHeader, quoteText, more);
      if (quote.images.length) box.append(imageGrid(quote.images, "Quoted post in " + post.timestampLabel));
      article.append(box);
      entry.quoteText = quoteText;
      entry.more = more;
      entry.paragraphs.push(quoteText);
    }
    return article;
  }

  function setQuoteExpanded(entry, expanded) {
    entry.quoteText.classList.toggle("clamped", !expanded);
    entry.more.setAttribute("aria-expanded", String(expanded));
    entry.more.textContent = expanded ? "Show less" : "Show more";
    if (expanded) entry.more.hidden = false;
    else if (entry.measured) entry.more.hidden = !entry.needsMore;
    else { entry.more.hidden = true; pendingMeasure.add(entry.day); }
  }

  // ---- Placeholder heights for content-visibility:auto ---------------------------------------

  function layoutMetrics() {
    const style = getComputedStyle(feed);
    const feedInner = feed.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    const narrow = window.innerWidth <= 520;
    const postPad = narrow ? 16 : 22;
    const quotePad = narrow ? 12 : 16;
    const inner = Math.max(200, feedInner - 2 * postPad - 2);
    const quoteInner = Math.max(150, inner - 2 * quotePad - 4);
    return {
      width: Math.round(feedInner), narrow, postPad, quotePad, inner, quoteInner,
      textWidth: Math.min(inner, 700), quoteTextWidth: Math.min(quoteInner, 620)
    };
  }

  function lineCount(text, width, charWidth) {
    if (!text) return 0;
    const perLine = Math.max(10, Math.floor(width / charWidth));
    return text.split("\n").reduce((lines, line) => lines + Math.max(1, Math.ceil(line.length / perLine)), 0);
  }

  function gridHeight(images, width, twoColumn, firstFull) {
    if (!images.length) return 0;
    const height = (image, w) => (image.width && image.height ? w * image.height / image.width : w * .625) + 2;
    if (!twoColumn) return 18 + images.reduce((sum, image) => sum + height(image, width), 0) + 10 * (images.length - 1);
    const column = (width - 10) / 2;
    let total = 18;
    let rest = images;
    if (firstFull) { total += height(images[0], width) + 10; rest = images.slice(1); }
    for (let i = 0; i < rest.length; i += 2) total += Math.max(height(rest[i], column), rest[i + 1] ? height(rest[i + 1], column) : 0) + 10;
    return total - 10;
  }

  function estimateEntry(entry, metrics, account) {
    const post = entry.post;
    const count = post.images.length;
    const stacked = account === "ohiain" || account === "ohiain-public";
    let height = 2 + 2 * metrics.postPad + 24 + 33;
    height += lineCount(post.text, metrics.textWidth, 8.3) * 27.2;
    height += gridHeight(post.images, metrics.inner, (count === 3 || count === 4) && !stacked, count === 3 && !stacked);
    if (post.quote) {
      const lines = lineCount(post.quote.text, metrics.quoteTextWidth, 7.3);
      const expanded = !entry.quoteText.classList.contains("clamped");
      height += 20 + 2 * metrics.quotePad + 4 + 30 + (expanded ? lines : Math.min(lines, 6)) * 24 + (lines > 6 ? 31 : 0);
      height += gridHeight(post.quote.images, metrics.quoteInner, true, false);
    }
    return Math.round(height);
  }

  // Off-screen days keep an estimated height; "auto" lets the browser remember the real one once
  // rendered. When a day's visible posts change, drop the remembered size for one frame first.
  function setIntrinsic(day, reset) {
    if (reset) {
      day.section.style.containIntrinsicHeight = day.estimate + "px";
      pendingIntrinsic.add(day);
      if (pendingIntrinsic.size === 1) requestAnimationFrame(() => requestAnimationFrame(flushIntrinsic));
    } else day.section.style.containIntrinsicHeight = "auto " + day.estimate + "px";
  }

  function flushIntrinsic() {
    pendingIntrinsic.forEach(day => setIntrinsic(day, false));
    pendingIntrinsic.clear();
  }

  function refreshEstimates(v, force, metrics = layoutMetrics()) {
    const widthChanged = v.estimateWidth !== metrics.width;
    if (widthChanged) {
      v.estimateWidth = metrics.width;
      v.entries.forEach(entry => {
        entry.measured = false;
        if (entry.quoteText) entry.quoteLines = lineCount(entry.post.quote.text, metrics.quoteTextWidth, 7.3);
      });
    }
    v.days.forEach(day => {
      if (!force && !widthChanged && !day.dirty) return;
      day.dirty = false;
      day.estimate = 65;
      day.entries.forEach(entry => {
        entry.estimate = estimateEntry(entry, metrics, v.account);
        if (!entry.card.hidden) day.estimate += entry.estimate;
      });
      setIntrinsic(day, true);
    });
  }

  // ---- Filtering, sorting, presenting --------------------------------------------------------

  function autoExpand(entry, show, terms) {
    if (!entry.quoteText) return;
    const long = entry.measured ? entry.needsMore : entry.quoteLines > 6;
    const want = show && long && terms.some(term => textMatch(entry.quoteLower, entry.quoteStarts, term) !== -1
      && textMatch(entry.textLower, entry.textStarts, term) === -1);
    if (want && entry.quoteText.classList.contains("clamped")) {
      entry.autoExpanded = true;
      setQuoteExpanded(entry, true);
    } else if (!want && entry.autoExpanded) {
      entry.autoExpanded = false;
      setQuoteExpanded(entry, false);
    }
  }

  function applyFilter(v) {
    const key = filterKey();
    if (v.filterKey === key) return false;
    v.filterKey = key;
    const queryTokens = tokens(state.q);
    const terms = queryTokens.filter(token => !token.ticker && !token.date);
    const metrics = layoutMetrics();
    if (v.estimateWidth !== metrics.width) refreshEstimates(v, true, metrics);
    let total = 0;
    v.days.forEach(day => {
      let visible = 0;
      let signature = 0;
      day.entries.forEach((entry, index) => {
        const show = matchesFilters(entry, queryTokens);
        if (entry.card.hidden === show) entry.card.hidden = !show;
        autoExpand(entry, show, terms);
        if (show) {
          visible += 1;
          signature = (signature * 31 + (index + 1) * (entry.quoteText && !entry.quoteText.classList.contains("clamped") ? 2 : 1)) | 0;
        }
      });
      day.visible = visible;
      total += visible;
      day.section.hidden = !visible;
      day.link.hidden = !visible;
      if (visible) {
        const heading = day.label + " · " + visible + (visible === 1 ? " post" : " posts");
        if (day.heading.textContent !== heading) day.heading.textContent = heading;
        if (day.count.textContent !== String(visible)) day.count.textContent = String(visible);
      }
      const nextSignature = visible + ":" + signature;
      if (day.signature !== nextSignature) { day.signature = nextSignature; day.dirty = true; }
    });
    v.months.forEach(month => {
      const visible = month.days.reduce((sum, day) => sum + day.visible, 0);
      month.details.hidden = !visible;
      month.count.textContent = formatCount(visible);
    });
    v.visible = total;
    refreshEstimates(v, false, metrics);
    return true;
  }

  function displayDays(v) {
    return v.sort === "asc" ? v.days.slice().reverse() : v.days;
  }

  function displayEntries(v, day) {
    return v.sort === "asc" ? day.entries.slice().reverse() : day.entries;
  }

  function applySort(v) {
    if (v.sort === state.sort) return false;
    v.sort = state.sort;
    const sections = document.createDocumentFragment();
    displayDays(v).forEach(day => {
      displayEntries(v, day).forEach(entry => day.section.append(entry.card));
      sections.append(day.section);
    });
    v.container.append(sections);
    const months = v.sort === "asc" ? v.months.slice().reverse() : v.months;
    const index = document.createDocumentFragment();
    months.forEach(month => {
      (v.sort === "asc" ? month.days.slice().reverse() : month.days).forEach(day => month.list.append(day.link));
      index.append(month.details);
    });
    v.index.append(index);
    return true;
  }

  function unmount() {
    if (currentDay) currentDay.link.removeAttribute("aria-current");
    currentDay = null;
    view = null;
    nearDays.clear();
    sectionObserver.disconnect();
    postsSlot.replaceChildren();
    dayIndex.replaceChildren();
    byId("empty-state").hidden = true;
    byId("archive-summary").textContent = "";
    byId("result-count").textContent = "";
    filterBar.hidden = true;
    document.body.classList.remove("filters-active");
    byId("filter-count").textContent = "";
    byId("filter-chips").replaceChildren();
    byId("filters-toggle").textContent = "Filters";
    byId("filters-toggle").setAttribute("aria-label", "Filters");
    from.min = to.min = from.max = to.max = "";
    showNote("");
  }

  function markAccount(account) {
    document.querySelectorAll(".account-tab").forEach(button => {
      button.setAttribute("aria-pressed", String(button.dataset.account === account));
    });
    document.body.dataset.account = account;
    document.title = ACCOUNTS[account].name + " · X Archive";
  }

  function mount(v) {
    unmount();
    view = v;
    markAccount(v.account);
    showFeedStatus("");
    postsSlot.replaceChildren(v.container);
    dayIndex.replaceChildren(v.index, noDays);
    const posts = v.entries;
    if (posts.length) {
      const newest = posts[0].post.dateKey;
      const oldest = posts[posts.length - 1].post.dateKey;
      const sameYear = newest.slice(0, 4) === oldest.slice(0, 4);
      byId("archive-summary").textContent = formatCount(posts.length) + " posts · "
        + dateLabel(oldest, sameYear ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" })
        + " – " + dateLabel(newest, { month: "short", day: "numeric", year: "numeric" });
      from.min = to.min = oldest;
      from.max = to.max = newest;
    } else byId("archive-summary").textContent = "No archive data loaded";
    highlightGen += 1;
    if (highlight) highlight.clear();
    if (v.estimateWidth !== layoutMetrics().width) refreshEstimates(v, true);
    v.days.forEach(day => sectionObserver.observe(day.section));
  }

  function present(v) {
    state.from = validDate(state.from);
    state.to = validDate(state.to);
    if (view !== v) mount(v);
    const sorted = applySort(v);
    const filtered = applyFilter(v);
    document.body.dataset.sort = state.sort;
    if (sorted || filtered || !v.cards) {
      v.order = displayDays(v).filter(day => day.visible);
      v.cards = null;
    }
    if (jumpTarget && (!state.p || jumpTarget.id !== "p-" + state.p)) { jumpTarget.classList.remove("jump-target"); jumpTarget = null; }
    renderStatus(v);
    if (filtered) refreshHighlights();
    if (currentDay && currentDay.section.hidden) { currentDay.link.removeAttribute("aria-current"); currentDay = null; }
    updateScroll();
  }

  function filterChips() {
    const chips = [];
    tokens(state.q).forEach((token, index) => chips.push({
      label: token.raw,
      remove: () => { state.q = tokens(state.q).filter((_, other) => other !== index).map(other => other.raw).join(" "); }
    }));
    if (state.images !== "all") chips.push({ label: state.images === "with" ? "With images" : "Without images", remove: () => { state.images = "all"; } });
    if (state.from || state.to) {
      const label = key => dateLabel(key, { month: "short", day: "numeric", year: "numeric" });
      const text = state.from && state.to ? label(state.from) + " – " + label(state.to) : state.from ? "From " + label(state.from) : "Until " + label(state.to);
      chips.push({ label: text, remove: () => { state.from = ""; state.to = ""; } });
    }
    return chips;
  }

  function renderStatus(v) {
    const counts = formatCount(v.visible) + " of " + formatCount(v.entries.length);
    byId("result-count").textContent = counts + " posts";
    const chips = filterChips();
    const active = chips.length > 0;
    filterBar.hidden = !active;
    document.body.classList.toggle("filters-active", active);
    byId("filter-count").textContent = counts;
    byId("filter-chips").replaceChildren(...chips.map(chip => {
      const button = element("button", "filter-chip", chip.label + " ✕");
      button.type = "button";
      button.setAttribute("aria-label", "Remove filter: " + chip.label);
      button.addEventListener("click", () => {
        readControls();
        chip.remove();
        syncControls();
        applyFilters(true);
        const next = filterBar.hidden ? null : filterBar.querySelector(".filter-chip, .filter-bar-clear");
        (next || feed).focus({ preventScroll: true });
      });
      return button;
    }));
    const toggle = byId("filters-toggle");
    toggle.textContent = active ? "Filters · " + chips.length : "Filters";
    toggle.setAttribute("aria-label", active ? "Filters, " + chips.length + " active" : "Filters");
    byId("empty-state").hidden = v.visible > 0;
    noDays.hidden = v.visible > 0;
  }

  // ---- Lazy per-day work: quote "Show more" measurement and search highlighting -------------

  const sectionObserver = new IntersectionObserver(observed => {
    observed.forEach(item => {
      const day = item.target.dayRef;
      if (!day) return;
      if (item.isIntersecting) { nearDays.add(day); processDay(day); }
      else nearDays.delete(day);
    });
  }, { rootMargin: "100% 0px" });

  function processDay(day) {
    if (day.highlightGen !== highlightGen) {
      day.highlightGen = highlightGen;
      highlightDay(day);
    }
    measureDay(day);
  }

  function measureDay(day) {
    let pending = false;
    day.entries.forEach(entry => {
      if (!entry.quoteText || entry.measured || entry.card.hidden || !entry.quoteText.classList.contains("clamped")) return;
      const text = entry.quoteText;
      if (!text.clientHeight) { pending = true; return; }
      entry.measured = true;
      entry.needsMore = text.scrollHeight > text.clientHeight + 1;
      entry.more.hidden = !entry.needsMore;
    });
    if (pending) pendingMeasure.add(day);
    else pendingMeasure.delete(day);
  }

  function highlightTerms() {
    const queryTokens = tokens(state.q);
    return {
      terms: queryTokens.filter(token => !token.ticker && !token.date),
      tickers: new Set(queryTokens.filter(token => token.ticker).map(token => token.value.slice(1)))
    };
  }

  function refreshHighlights() {
    highlightGen += 1;
    if (highlight) highlight.clear();
    nearDays.forEach(processDay);
  }

  function highlightDay(day) {
    if (!highlight) return;
    const { terms, tickers } = highlightTerms();
    if (!terms.length && !tickers.size) return;
    day.entries.forEach(entry => {
      if (!entry.card.hidden) entry.paragraphs.forEach(paragraph => highlightParagraph(paragraph, terms, tickers));
    });
  }

  function highlightParagraph(paragraph, terms, tickers) {
    if (terms.length) {
      const nodes = [];
      const starts = [];
      let text = "";
      const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        starts.push(text.length);
        nodes.push(walker.currentNode);
        text += walker.currentNode.data;
      }
      const lower = text.toLowerCase();
      if (lower.length === text.length) {
        const wordOffsets = wordStarts(lower);
        const locate = position => {
          let low = 0;
          let high = starts.length - 1;
          while (low < high) {
            const mid = (low + high + 1) >> 1;
            if (starts[mid] <= position) low = mid; else high = mid - 1;
          }
          return [nodes[low], position - starts[low]];
        };
        terms.forEach(term => {
          for (let index = textMatch(lower, wordOffsets, term); index !== -1;
            index = textMatch(lower, wordOffsets, term, index + (term.quoted ? term.value.length : 1))) {
            const range = new Range();
            const [startNode, startOffset] = locate(index);
            const [endNode, endOffset] = locate(index + term.value.length - 1);
            range.setStart(startNode, startOffset);
            range.setEnd(endNode, endOffset + 1);
            highlight.add(range);
          }
        });
      }
    }
    if (tickers.size) {
      paragraph.querySelectorAll(".cashtag").forEach(button => {
        if (!tickers.has(button.dataset.ticker)) return;
        const range = new Range();
        range.selectNodeContents(button);
        highlight.add(range);
      });
    }
  }

  // ---- Scrolling: sticky offsets, scrollspy, anchors -----------------------------------------

  function stickyTop() {
    return (window.innerWidth < 960 ? 168 : 0) + (filterBar.hidden ? 0 : filterBar.offsetHeight);
  }

  function dayIndexAt(order, offset) {
    let low = 0;
    let high = order.length - 1;
    let found = 0;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (order[mid].section.getBoundingClientRect().top <= offset) { found = mid; low = mid + 1; }
      else high = mid - 1;
    }
    return found;
  }

  function visibleCards() {
    if (!view) return [];
    if (!view.cards) {
      view.cards = [];
      view.order.forEach(day => displayEntries(view, day).forEach(entry => {
        if (!entry.card.hidden) { entry.cardIndex = view.cards.length; view.cards.push(entry); }
      }));
    }
    return view.cards;
  }

  // First visible post whose top is at or below `offset` (index into visibleCards()).
  function cardIndexAt(offset) {
    const cards = visibleCards();
    if (!cards.length) return -1;
    const order = view.order;
    const start = dayIndexAt(order, offset);
    for (let d = start; d < Math.min(order.length, start + 3); d += 1) {
      for (const entry of displayEntries(view, order[d])) {
        if (!entry.card.hidden && entry.card.getBoundingClientRect().top >= offset) return entry.cardIndex;
      }
    }
    return cards.length - 1;
  }

  function topVisibleEntry() {
    if (!view || !view.order.length) return null;
    const offset = stickyTop() + 50;
    const order = view.order;
    const start = dayIndexAt(order, offset);
    for (let d = start; d < Math.min(order.length, start + 3); d += 1) {
      for (const entry of displayEntries(view, order[d])) {
        if (!entry.card.hidden && entry.card.getBoundingClientRect().bottom > offset) return entry;
      }
    }
    return null;
  }

  function captureAnchor() {
    if (!view) return null;
    if (window.scrollY < 2) return { a: view.account, top0: true };
    const entry = topVisibleEntry();
    return entry ? { a: view.account, id: entry.post.id, top: Math.round(entry.card.getBoundingClientRect().top) } : null;
  }

  function saveAnchor() {
    clearTimeout(anchorTimer);
    const anchor = captureAnchor();
    if (!anchor) return;
    anchors.set(entryKey, anchor);
    try { history.replaceState({ ...(history.state || {}), key: entryKey, anchor }, ""); } catch (error) { /* rate-limited */ }
  }

  function restoreAnchor(anchor) {
    if (!anchor || !view || anchor.a !== view.account) return false;
    if (anchor.top0) { window.scrollTo({ top: 0, behavior: "instant" }); return true; }
    const entry = view.byId.get(anchor.id);
    if (!entry || entry.card.hidden) return false;
    scrollElementTo(entry.card, anchor.top);
    return true;
  }

  // Scroll so `target`'s top sits at viewport y = `top`, then re-correct for a few frames while
  // content-visibility sections near it render and replace their placeholder heights.
  function scrollElementTo(target, top) {
    const seq = ++settleSeq;
    target.scrollIntoView({ block: "start", behavior: "instant" });
    const correct = () => {
      const delta = target.getBoundingClientRect().top - top;
      if (Math.abs(delta) >= 1) window.scrollBy({ top: delta, behavior: "instant" });
    };
    correct();
    let frames = 0;
    const step = () => {
      if (seq !== settleSeq) return;
      correct();
      updateScroll();
      if (++frames < 5) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  function cancelSettle() { settleSeq += 1; }

  function scrollToTarget() {
    const entry = view && view.byId.get(state.p);
    if (!entry || entry.card.hidden) return;
    jumpTarget = entry.card;
    jumpTarget.classList.add("jump-target");
    scrollElementTo(jumpTarget, stickyTop() + (window.innerWidth < 960 ? 60 : 70));
    jumpTarget.focus({ preventScroll: true });
  }

  function openMonth(month) {
    if (month.details.open) return;
    month.expectOpen = true;
    month.auto = true;
    month.details.open = true;
  }

  function followDay(day) {
    if (!sidebar.getClientRects().length) return;
    const box = sidebar.getBoundingClientRect();
    const link = day.link.getBoundingClientRect();
    if (link.top < box.top + 8) sidebar.scrollTop += link.top - box.top - 8;
    else if (link.bottom > box.bottom - 8) sidebar.scrollTop += link.bottom - box.bottom + 8;
  }

  function updateScroll() {
    byId("back-to-top").hidden = window.scrollY < window.innerHeight;
    if (!view) return;
    const order = view.order;
    const day = order.length ? order[dayIndexAt(order, stickyTop() + 65)] : null;
    if (day !== currentDay) {
      const previous = currentDay;
      if (previous) previous.link.removeAttribute("aria-current");
      currentDay = day;
      if (day) {
        day.link.setAttribute("aria-current", "true");
        if (previous && previous.month !== day.month && previous.month.auto) {
          previous.month.expectOpen = false;
          previous.month.auto = false;
          previous.month.details.open = false;
        }
        openMonth(day.month);
        followDay(day);
      }
    }
    pendingMeasure.forEach(pending => { if (nearDays.has(pending)) measureDay(pending); });
  }

  // ---- Navigation entry points ---------------------------------------------------------------

  // History entries for user actions (tab click, jump) are pushed by the caller before this runs,
  // so a slow lazy load never leaves the URL behind; route() itself only replaces.
  async function route({ scroll = "target", anchor = null, jump = false } = {}) {
    const seq = ++navSeq;
    routeUrl = location.href;
    routing = true;
    clearTimeout(anchorTimer);
    const previous = view && view.account;
    let missing = false;
    if (state.p) {
      let account;
      try { account = await findAccount(state.p, seq); }
      catch (error) {
        if (!isCurrentRoute(seq)) return;
        routing = false;
        showArchiveStatus(error.account, true);
        return;
      }
      if (!isCurrentRoute(seq)) return;
      if (account) state.a = account;
      else missing = true;
    }
    const v = await ensureView(state.a, seq);
    if (!isCurrentRoute(seq)) return;
    routing = false;
    if (!v) return;
    const cleared = revealTarget(v);
    syncControls();
    writeHash(false, true);
    present(v);
    showNote(missing ? "missing" : jump && cleared ? "cleared" : "");
    if (anchor && restoreAnchor(anchor)) return;
    if (scroll === "target" && state.p && !missing) scrollToTarget();
    else if (scroll === "top" || previous !== v.account) window.scrollTo({ top: 0, behavior: "instant" });
  }

  function showNote(kind) {
    byId("jump-note").hidden = !kind;
    byId("jump-note-text").textContent = kind === "missing" ? "That post isn't in this archive." : "Filters were cleared to show this post.";
    byId("jump-restore").hidden = kind !== "cleared";
  }

  function revealTarget(v) {
    const target = v.byId.get(state.p);
    if (!target) return false;
    const before = JSON.stringify(state);
    if (!matchesSearch(target, tokens(state.q))) state.q = "";
    if (!matchesImages(target)) state.images = "all";
    if (state.from && target.post.dateKey < state.from) state.from = "";
    if (state.to && target.post.dateKey > state.to) state.to = "";
    return before !== JSON.stringify(state);
  }

  function jumpToPost(id) {
    clearTimeout(debounce);
    readControls();
    saveAnchor();
    closeFilters();
    state.p = id;
    writeHash(true);
    route({ jump: true });
  }

  function switchAccount(account) {
    if (!ACCOUNTS.hasOwnProperty(account) || (account === state.a && view && view.account === account)) return;
    clearTimeout(debounce);
    saveAnchor();
    state = { a: account, q: "", from: "", to: "", images: "all", sort: state.sort, p: "" };
    syncControls();
    writeHash(true);
    route({ scroll: "top" });
  }

  function applyFilters(force = false) {
    clearTimeout(debounce);
    readControls();
    state.p = "";
    showNote("");
    // Loading unmounts the view; supersede that route before deciding how to render the filters.
    if (routing) { navSeq += 1; routing = false; }
    if (!view || view.account !== state.a) { writeHash(); route({ scroll: "none" }); return; }
    if (!force && view.filterKey === filterKey() && view.sort === state.sort) { writeHash(false, true); return; }
    writeHash();
    present(view);
  }

  function clearFilters() {
    clearTimeout(debounce);
    state = { a: state.a, q: "", from: "", to: "", images: "all", sort: state.sort, p: "" };
    syncControls();
    applyFilters(true);
  }

  function addTicker(tag) {
    const value = "$" + normalizeTicker(tag.slice(1));
    const tickers = tokens(search.value).filter(token => token.ticker);
    if (tickers.length === 1 && tickers[0].value === value) return;
    clearTimeout(debounce);
    readControls();
    if (!tickers.length) state.q = (state.q.trim() + " " + tag).trim();
    else {
      let query = "";
      let position = 0;
      tickers.forEach((token, index) => {
        query += state.q.slice(position, token.index) + (index === 0 ? tag : "");
        position = token.index + token.raw.length;
      });
      state.q = (query + state.q.slice(position)).trim();
    }
    syncControls();
    applyFilters(true);
    window.scrollTo({ top: 0, behavior: "instant" });
  }

  function closeFilters() {
    const wasOpen = sidebar.classList.contains("is-open");
    sidebar.classList.remove("is-open");
    sidebar.removeAttribute("role");
    sidebar.removeAttribute("aria-modal");
    feed.inert = false;
    byId("overlay-backdrop").hidden = true;
    byId("filters-toggle").setAttribute("aria-expanded", "false");
    if (!lightbox.open) document.body.classList.remove("modal-open");
    if (wasOpen) byId("filters-toggle").focus();
  }

  // ---- Lightbox ------------------------------------------------------------------------------

  function canZoom() {
    return lightboxImage.naturalWidth > lightboxImage.clientWidth + 1 || lightboxImage.naturalHeight > lightboxImage.clientHeight + 1;
  }

  function setZoom(on, point) {
    const zoomButton = byId("image-zoom");
    if (on && (lightboxImage.hidden || !lightboxImage.naturalWidth || (!zoomed && !canZoom()))) on = false;
    if (on && !zoomed) {
      const rect = lightboxImage.getBoundingClientRect();
      const fx = point ? Math.min(1, Math.max(0, (point.x - rect.left) / rect.width)) : .5;
      const fy = point ? Math.min(1, Math.max(0, (point.y - rect.top) / rect.height)) : .5;
      zoomed = true;
      lightboxContent.classList.add("zoomed");
      lightboxImage.style.width = lightboxImage.naturalWidth + "px";
      lightboxImage.style.height = lightboxImage.naturalHeight + "px";
      lightboxContent.scrollLeft = fx * lightboxImage.naturalWidth - lightboxContent.clientWidth / 2;
      lightboxContent.scrollTop = fy * lightboxImage.naturalHeight - lightboxContent.clientHeight / 2;
    } else if (!on && zoomed) {
      zoomed = false;
      lightboxContent.classList.remove("zoomed");
      lightboxImage.style.width = "";
      lightboxImage.style.height = "";
    }
    zoomButton.setAttribute("aria-pressed", String(zoomed));
    zoomButton.textContent = zoomed ? "Fit" : "100%";
    updateZoomable();
  }

  function updateZoomable() {
    const zoomable = zoomed || (!lightboxImage.hidden && lightboxImage.complete && lightboxImage.naturalWidth > 0 && canZoom());
    lightboxContent.classList.toggle("zoomable", zoomable);
    byId("image-zoom").disabled = !zoomable;
  }

  function showImage() {
    const image = gallery[imageIndex];
    const error = byId("lightbox-error");
    const open = byId("image-open");
    setZoom(false);
    lightboxImage.hidden = false;
    error.hidden = true;
    lightboxImage.alt = galleryLabel + ", image " + (imageIndex + 1);
    lightboxImage.width = image.width;
    lightboxImage.height = image.height;
    lightboxImage.onerror = () => { lightboxImage.hidden = true; error.hidden = false; open.hidden = true; updateZoomable(); };
    lightboxImage.onload = updateZoomable;
    const src = localImageSource(image);
    if (src) { lightboxImage.src = src; open.href = src; open.hidden = false; }
    else { lightboxImage.removeAttribute("src"); lightboxImage.hidden = true; error.hidden = false; open.hidden = true; }
    byId("image-counter").textContent = (imageIndex + 1) + " / " + gallery.length;
    byId("image-previous").disabled = imageIndex === 0;
    byId("image-next").disabled = imageIndex === gallery.length - 1;
    [imageIndex - 1, imageIndex + 1].forEach(index => {
      const neighbour = gallery[index] && localImageSource(gallery[index]);
      if (neighbour) new Image().src = neighbour;
    });
    updateZoomable();
  }

  function openLightbox(images, index, label, opener) {
    gallery = images;
    imageIndex = index;
    galleryLabel = label;
    lightboxOpener = opener;
    showImage();
    lightbox.showModal();
    document.body.classList.add("modal-open");
    byId("lightbox-close").focus();
    updateZoomable();
  }

  function moveImage(direction) {
    const next = imageIndex + direction;
    if (next >= 0 && next < gallery.length) { imageIndex = next; showImage(); }
  }

  let pointer = null;
  lightboxImage.draggable = false;
  lightboxImage.addEventListener("dragstart", event => event.preventDefault());
  let pressedBackdrop = false;
  lightbox.addEventListener("pointerdown", event => { pressedBackdrop = event.target === lightbox; });
  lightboxContent.addEventListener("pointerdown", event => {
    if (event.button !== 0) return;
    if (zoomed && event.pointerType === "mouse") lightboxContent.setPointerCapture(event.pointerId);
    pointer = { id: event.pointerId, type: event.pointerType, x: event.clientX, y: event.clientY, left: lightboxContent.scrollLeft, top: lightboxContent.scrollTop, moved: false };
  });
  lightboxContent.addEventListener("pointermove", event => {
    if (!pointer || pointer.id !== event.pointerId) return;
    const dx = event.clientX - pointer.x;
    const dy = event.clientY - pointer.y;
    if (Math.abs(dx) > 5 || Math.abs(dy) > 5) pointer.moved = true;
    if (zoomed && pointer.type === "mouse" && pointer.moved) {
      lightboxContent.scrollLeft = pointer.left - dx;
      lightboxContent.scrollTop = pointer.top - dy;
    }
  });
  lightboxContent.addEventListener("pointerup", event => {
    if (!pointer || pointer.id !== event.pointerId) return;
    const dx = event.clientX - pointer.x;
    const dy = event.clientY - pointer.y;
    if (!zoomed && pointer.type !== "mouse" && Math.abs(dx) > 50 && Math.abs(dx) > 1.5 * Math.abs(dy)) moveImage(dx < 0 ? 1 : -1);
    lightboxContent.dataset.dragged = pointer.moved ? "true" : "";
    pointer = null;
  });
  lightboxContent.addEventListener("pointercancel", () => { pointer = null; });
  lightboxImage.addEventListener("click", event => {
    if (lightboxContent.dataset.dragged) { lightboxContent.dataset.dragged = ""; return; }
    setZoom(!zoomed, { x: event.clientX, y: event.clientY });
  });
  byId("image-zoom").addEventListener("click", () => setZoom(!zoomed));

  // ---- Event wiring --------------------------------------------------------------------------

  byId("filter-form").addEventListener("submit", event => { event.preventDefault(); applyFilters(); });
  document.querySelector(".skip-link").addEventListener("click", event => {
    event.preventDefault();
    feed.scrollIntoView({ block: "start", behavior: "instant" });
    feed.focus({ preventScroll: true });
  });
  search.addEventListener("input", () => {
    clearTimeout(debounce);
    if (routing) applyFilters();
    else debounce = setTimeout(applyFilters, 150);
  });
  from.addEventListener("change", () => applyFilters());
  to.addEventListener("change", () => applyFilters());
  document.querySelectorAll('input[name="images"]').forEach(input => input.addEventListener("change", () => applyFilters()));
  document.querySelectorAll('input[name="sort"]').forEach(input => input.addEventListener("change", () => {
    applyFilters();
    byId("sort-status").textContent = state.sort === "asc" ? "Showing oldest first" : "Showing newest first";
    window.scrollTo({ top: 0, behavior: "instant" });
  }));
  byId("clear-filters").addEventListener("click", clearFilters);
  byId("filter-bar-clear").addEventListener("click", () => { clearFilters(); feed.focus({ preventScroll: true }); });
  byId("empty-clear").addEventListener("click", clearFilters);
  byId("jump-restore").addEventListener("click", () => history.back());
  byId("jump-note-close").addEventListener("click", () => { byId("jump-note").hidden = true; });
  byId("feed-status-retry").addEventListener("click", () => route());
  document.querySelectorAll(".account-tab").forEach(button => {
    button.addEventListener("click", () => switchAccount(button.dataset.account));
  });
  byId("filters-toggle").addEventListener("click", () => {
    if (sidebar.classList.contains("is-open")) { closeFilters(); return; }
    sidebar.classList.add("is-open");
    sidebar.setAttribute("role", "dialog");
    sidebar.setAttribute("aria-modal", "true");
    feed.inert = true;
    byId("overlay-backdrop").hidden = false;
    byId("filters-toggle").setAttribute("aria-expanded", "true");
    document.body.classList.add("modal-open");
    search.focus({ preventScroll: true });
    updateScroll();
    if (currentDay) followDay(currentDay);
  });
  byId("filters-close").addEventListener("click", () => { closeFilters(); byId("filters-toggle").focus(); });
  byId("overlay-backdrop").addEventListener("click", closeFilters);
  byId("back-to-top").addEventListener("click", () => window.scrollTo({ top: 0, behavior: "instant" }));
  byId("lightbox-close").addEventListener("click", () => lightbox.close());
  byId("image-previous").addEventListener("click", () => moveImage(-1));
  byId("image-next").addEventListener("click", () => moveImage(1));
  lightbox.addEventListener("close", () => {
    setZoom(false);
    if (!sidebar.classList.contains("is-open")) document.body.classList.remove("modal-open");
    if (lightboxOpener && lightboxOpener.isConnected) lightboxOpener.focus();
  });
  lightbox.addEventListener("click", event => { if (event.target === lightbox && pressedBackdrop) lightbox.close(); });
  document.addEventListener("keydown", event => {
    if (lightbox.open) {
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); moveImage(event.key === "ArrowLeft" ? -1 : 1); }
      if (event.key === "Escape") { event.preventDefault(); lightbox.close(); }
      return;
    }
    cancelSettle();
    if (event.key === "Escape" && sidebar.classList.contains("is-open")) {
      closeFilters();
      byId("filters-toggle").focus();
      return;
    }
    if (sidebar.classList.contains("is-open") && event.key === "Tab") {
      const controls = Array.from(sidebar.querySelectorAll("a[href], button, input, summary")).filter(node => !node.disabled && node.getClientRects().length);
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      return;
    }
    if (event.ctrlKey || event.metaKey || event.altKey || /^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(event.target.tagName) || event.target.isContentEditable || sidebar.classList.contains("is-open")) return;
    if (event.key === "j" || event.key === "k") {
      const cards = visibleCards();
      if (!cards.length) return;
      const offset = stickyTop() + (window.innerWidth < 960 ? 60 : 65);
      let index = cardIndexAt(offset - 8);
      const current = cards[index];
      if (event.key === "j" && current && Math.abs(current.card.getBoundingClientRect().top - offset) < 20) index += 1;
      if (event.key === "k") index -= 1;
      const target = cards[Math.max(0, Math.min(cards.length - 1, index))];
      if (target) {
        event.preventDefault();
        scrollElementTo(target.card, stickyTop() + (window.innerWidth < 960 ? 60 : 70));
        target.card.focus({ preventScroll: true });
      }
    }
  });
  ["wheel", "touchstart", "pointerdown"].forEach(type => window.addEventListener(type, cancelSettle, { passive: true }));
  window.addEventListener("scroll", () => {
    clearTimeout(anchorTimer);
    anchorTimer = setTimeout(saveAnchor, 300);
    if (!scrollPending) {
      scrollPending = true;
      requestAnimationFrame(() => { updateScroll(); scrollPending = false; });
    }
  }, { passive: true });
  let resizeTimer;
  window.addEventListener("resize", () => {
    if (window.innerWidth >= 960) closeFilters();
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      updateZoomable();
      if (!view) return;
      const metrics = layoutMetrics();
      if (metrics.width !== view.estimateWidth) {
        refreshEstimates(view, false, metrics);
        nearDays.forEach(measureDay);
      }
      updateScroll();
    }, 150);
  });
  window.addEventListener("pagehide", saveAnchor);
  window.addEventListener("popstate", event => {
    clearTimeout(debounce);
    cancelSettle();
    lastUrl = location.href;
    const anchor = leaveEntry(event.state);
    readHash();
    route({ anchor });
  });
  window.addEventListener("hashchange", () => {
    if (location.href === lastUrl) return;
    clearTimeout(debounce);
    cancelSettle();
    lastUrl = location.href;
    leaveEntry(history.state);
    readHash();
    route();
  });

  if ("scrollRestoration" in history) history.scrollRestoration = "manual";
  entryKey = (history.state && history.state.key) || newEntryKey();
  readHash();
  route({ anchor: history.state && history.state.anchor });
})();
