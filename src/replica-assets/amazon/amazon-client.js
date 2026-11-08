/*
 * Synthetic-world client for the Amazon.in-style shop adaptation.
 *
 * Upstream: https://github.com/Rohit-rockan/amazon-clone
 * Pinned:   399d31901ebfa2eb7fe481d5433e59a09fb09493 (MIT; see ../LICENSE,
 *           ../NOTICE.md and ../SOURCE.md).
 *
 * The presentation (layout, classes, product/cart/checkout templates and
 * responsive behaviour) is adapted from upstream js/app.js + index.html and
 * upstream css/styles.css. This file replaces upstream localStorage state and
 * simulated checkout with Sightline's isolated `/api/world/:agentId` contract:
 *
 *   GET  /api/world/:agentId
 *   POST /api/world/:agentId/action  {action, value?}
 *   POST /api/world/:agentId/ack     {revision}
 *
 * The backend only validates variants for notebook, bottle, backpack and lamp,
 * so the catalog is deliberately limited to those four contract product ids.
 * No account, payment, analytics or third-party service is used.
 *
 * The seeded out-of-stock world (`world.stock <= 0` plus its visible
 * "Out of stock" or "Backorder" notice) is the authored-defect presentation. A
 * clean world never exposes that combination, so the false add-to-cart success,
 * stuck checkout, inflated search count and clipped stock status stay dormant
 * during a clean verification rerun.
 */
(function () {
  'use strict';

  const SCENARIO = 'shop';
  const params = new URLSearchParams(window.location.search);
  const agentId = params.get('agent') || params.get('agentId') || params.get('id');
  const base = agentId ? '/api/world/' + encodeURIComponent(agentId) : '';

  // Upstream data.js categories, unchanged in shape and labels.
  const CATEGORIES = [
    { id: 'mobiles', name: 'Mobiles', icon: '📱', tint: '#e3f2fd' },
    { id: 'electronics', name: 'Electronics', icon: '🎧', tint: '#ede7f6' },
    { id: 'fashion', name: 'Fashion', icon: '👕', tint: '#fce4ec' },
    { id: 'home', name: 'Home & Kitchen', icon: '🍳', tint: '#fff3e0' },
    { id: 'beauty', name: 'Beauty', icon: '💄', tint: '#f3e5f5' },
    { id: 'books', name: 'Books', icon: '📚', tint: '#e8f5e9' },
    { id: 'toys', name: 'Toys & Games', icon: '🧸', tint: '#fffde7' },
    { id: 'grocery', name: 'Fresh', icon: '🥦', tint: '#e0f2f1' },
    { id: 'sports', name: 'Sports', icon: '🏏', tint: '#e1f5fe' },
    { id: 'appliances', name: 'Appliances', icon: '🧺', tint: '#efebe9' },
  ];

  // Upstream data.js banners, re-pointed at the four contract products.
  const BANNERS = [
    {
      title: 'Great Indian Festival',
      sub: 'Up to 80% off · Synthetic bank offers',
      bg: 'linear-gradient(135deg,#ffb84d,#ff6f3c)',
      icon: '🎉',
      link: '#/search?deal=1',
    },
    {
      title: 'Campus essentials from ₹449',
      sub: 'Notebooks, bottles and daypacks',
      bg: 'linear-gradient(135deg,#3a7bd5,#00d2ff)',
      icon: '🎒',
      link: '#/search?cat=books',
    },
    {
      title: 'Home makeover',
      sub: 'Kitchen & decor under ₹999',
      bg: 'linear-gradient(135deg,#11998e,#38ef7d)',
      icon: '🏡',
      link: '#/search?cat=home',
    },
  ];

  /*
   * Four products required by the backend variant contract:
   *   notebook  ruled | dot-grid
   *   bottle    slate | sand
   *   backpack  black | olive
   *   lamp      white | graphite
   *
   * bottle and backpack copy upstream data.js catalog rows (title, brand,
   * category, icon, tint, price, MRP, rating, reviews, prime, bought,
   * bullets). notebook and lamp are synthetic additions in the same shape.
   */
  const PRODUCTS = [
    {
      id: 'notebook',
      title: 'Campus Notebook — A5 Recycled Paper, 160 Pages',
      brand: 'Campus Supply',
      category: 'books',
      icon: '📒',
      tint: '#fff8e1',
      price: 449,
      mrp: 799,
      rating: 4.6,
      reviews: 98123,
      prime: true,
      bought: 2400,
      deal: true,
      variants: [
        { id: 'ruled', name: 'Ruled' },
        { id: 'dot-grid', name: 'Dot grid' },
      ],
      bullets: [
        'A5 recycled-paper notebook with 160 pages for lecture notes',
        'Lay-flat binding and a durable soft cover',
        'Ruled or dot-grid ruling selected above',
        'Synthetic catalog item for controlled Sightline testing',
      ],
    },
    {
      id: 'bottle',
      title: 'Stainless Steel Water Bottle 1L (Pack of 2)',
      brand: 'Milton',
      category: 'home',
      icon: '🍶',
      tint: '#e0f2f1',
      price: 699,
      mrp: 1220,
      rating: 4.3,
      reviews: 54320,
      prime: true,
      bought: 1400,
      deal: true,
      variants: [
        { id: 'slate', name: 'Slate' },
        { id: 'sand', name: 'Sand' },
      ],
      bullets: [
        'Genuine Milton product with brand warranty',
        'Free delivery on eligible orders and easy 7-day replacement',
        'Pay on delivery and UPI available at checkout',
        'Top rated by customers for quality and value',
      ],
    },
    {
      id: 'backpack',
      title: 'Laptop Backpack 30L with USB Charging Port',
      brand: 'Wildcraft',
      category: 'fashion',
      icon: '🎒',
      tint: '#fce4ec',
      price: 1349,
      mrp: 2999,
      rating: 4.2,
      reviews: 12045,
      prime: true,
      bought: 300,
      deal: false,
      variants: [
        { id: 'black', name: 'Black' },
        { id: 'olive', name: 'Olive' },
      ],
      bullets: [
        'Genuine Wildcraft product with brand warranty',
        'Free delivery on eligible orders and easy 7-day replacement',
        'Pay on delivery and UPI available at checkout',
        'Top rated by customers for quality and value',
      ],
    },
    {
      id: 'lamp',
      title: 'Desk Lamp — Adjustable LED, 3 Brightness Settings',
      brand: 'Campus Supply',
      category: 'home',
      icon: '💡',
      tint: '#fff3e0',
      price: 1999,
      mrp: 2999,
      rating: 4.4,
      reviews: 4310,
      prime: false,
      bought: 100,
      deal: false,
      variants: [
        { id: 'white', name: 'White' },
        { id: 'graphite', name: 'Graphite' },
      ],
      bullets: [
        'Adjustable LED desk lamp with three brightness settings',
        'Flexible neck and weighted base for a stable work surface',
        'White or graphite finish selected above',
        'Synthetic catalog item for controlled Sightline testing',
      ],
    },
  ];

  const PRODUCT_BY_ID = new Map(PRODUCTS.map((product) => [product.id, product]));

  const view = document.getElementById('view');
  const toastEl = document.getElementById('toast');
  const noticeEl = document.getElementById('noticeBanner');
  const errorEl = document.getElementById('errorBanner');
  const statusEl = document.getElementById('connectionStatus');
  const srStatusEl = document.getElementById('srStatus');
  const cartCountEl = document.getElementById('cartCount');
  const dCartCountEl = document.getElementById('dCartCount');
  const searchInput = document.getElementById('searchInput');
  const dSearchInput =
    document.getElementById('shopSearch') || document.getElementById('dSearchInput');
  const dSearchCat = document.getElementById('dSearchCat');
  const dSub = document.getElementById('dSub');

  const state = {
    world: null,
    route: '',
    busy: false,
    ackedRevision: -1,
    ackInFlight: -1,
    pollTimer: 0,
    pollFailures: 0,
    lastAddedProduct: '',
    carouselTimer: 0,
    lastEnsureRoute: '',
    checkoutStuck: false,
  };

  const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = (value) => String(value).replaceAll(/[&<>"']/g, (character) => ESCAPES[character]);
  const inr = (value) => Number(value).toLocaleString('en-IN');
  const offPct = (product) => Math.round((1 - product.price / product.mrp) * 100);
  const stars = (rating) =>
    '★'.repeat(Math.floor(rating)) +
    (rating % 1 >= 0.5 ? '⯪' : '') +
    '☆'.repeat(5 - Math.floor(rating) - (rating % 1 >= 0.5 ? 1 : 0));
  const shortCount = (value) =>
    value >= 1000 ? (value / 1000).toFixed(value >= 10000 ? 0 : 1) + 'K' : value;
  const tile = (product, className) =>
    '<div class="' +
    (className || 'tile') +
    '" style="background:' +
    product.tint +
    '">' +
    product.icon +
    '</div>';
  const priceHtml = (product) =>
    '<span class="price"><sup>₹</sup>' + inr(product.price) + '</span>';

  function deliveryDate(days) {
    const date = new Date();
    date.setDate(date.getDate() + days);
    return date.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' });
  }

  function toast(message) {
    toastEl.textContent = message;
    toastEl.hidden = false;
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => {
      toastEl.hidden = true;
    }, 2200);
  }

  function showError(message) {
    errorEl.textContent = message;
    errorEl.hidden = false;
    clearTimeout(errorEl._timer);
    errorEl._timer = setTimeout(clearError, 9000);
  }

  function clearError() {
    errorEl.textContent = '';
    errorEl.hidden = true;
  }

  function setStatus(message, offline) {
    statusEl.textContent = message;
    statusEl.classList.toggle('offline', !!offline);
  }

  function fatal(message) {
    view.innerHTML =
      '<div class="section empty"><div class="big">🛒</div><h2>Synthetic shop unavailable</h2><p class="muted">' +
      esc(message) +
      '</p></div>';
    setStatus('Replica server unavailable', true);
    showError(message);
  }

  function findProduct(id) {
    return PRODUCT_BY_ID.get(String(id || '')) || null;
  }

  // A clean world never shows an out-of-stock/backorder notice. The seeded
  // authored-defect world does, so these branches stay dormant during a clean
  // verification rerun even if a future clean world temporarily sells out.
  function outOfStockMode() {
    const world = state.world;
    if (!world || world.stock > 0) return false;
    const notice = typeof world.notice === 'string' ? world.notice : '';
    return /out of stock|backorder/i.test(notice);
  }

  function findVariant(product, id) {
    if (!product) return null;
    return product.variants.find((variant) => variant.id === id) || null;
  }

  function parseSelected(value) {
    const text = typeof value === 'string' ? value : '';
    const parts = text.split('/', 2);
    return { product: parts[0] || '', variant: parts[1] || '' };
  }

  function request(url, options) {
    return fetch(url, options).then((response) =>
      response.text().then((bodyText) => {
        let data = null;
        if (bodyText) {
          try {
            data = JSON.parse(bodyText);
          } catch (error) {
            throw new Error(
              'Replica server returned invalid JSON (status ' + response.status + ').',
              {
                cause: error,
              },
            );
          }
        }
        if (!response.ok) {
          const detail =
            data && typeof data.error === 'string' && data.error
              ? data.error
              : 'Request failed with status ' + response.status + '.';
          const requestError = new Error(detail);
          requestError.status = response.status;
          throw requestError;
        }
        return data;
      }),
    );
  }

  function postAction(action, value) {
    const payload = { action: action };
    if (value !== undefined && value !== null && value !== '') payload.value = value;
    return request(base + '/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(payload),
    });
  }

  function postAck(revision) {
    return request(base + '/ack', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ revision: revision }),
    });
  }

  function afterPaint(callback) {
    let called = false;
    const run = () => {
      if (called) return;
      called = true;
      callback();
    };
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => requestAnimationFrame(run));
      setTimeout(run, 250);
    } else {
      setTimeout(run, 0);
    }
  }

  function maybeAck(revision, appliedRevision) {
    if (!Number.isFinite(revision)) return;
    if (Number.isFinite(appliedRevision) && appliedRevision >= revision) {
      if (revision > state.ackedRevision) state.ackedRevision = revision;
      return;
    }
    if (revision <= state.ackedRevision || state.ackInFlight === revision) return;
    state.ackInFlight = revision;
    afterPaint(() => {
      void postAck(revision)
        .then(() => {
          if (revision > state.ackedRevision) state.ackedRevision = revision;
        })
        .catch(() => {
          // The next poll retries the acknowledgment; the render already happened.
        })
        .then(() => {
          if (state.ackInFlight === revision) state.ackInFlight = -1;
        });
    });
  }

  function acceptWorld(data) {
    if (!data || typeof data !== 'object')
      throw new Error('Replica server returned an empty world.');
    if (data.scenario !== SCENARIO)
      throw new Error('Replica world scenario does not match this page.');
    if (!Number.isFinite(data.revision)) throw new Error('Replica world revision is missing.');
    if (!Number.isFinite(data.stock)) throw new Error('Replica world stock is missing.');
    if (typeof data.notice !== 'string') throw new Error('Replica world notice is missing.');
    if (!Number.isFinite(data.cart)) throw new Error('Replica world cart is missing.');
    if (typeof data.selected !== 'string')
      throw new Error('Replica world selected value is missing.');
    if (typeof data.completed !== 'boolean')
      throw new Error('Replica world completion flag is missing.');
    if (!Array.isArray(data.panels)) throw new Error('Replica world panels are missing.');
    data.panels = data.panels.filter((item) => typeof item === 'string');
    if (!Number.isFinite(data.appliedRevision)) data.appliedRevision = 0;
    return data;
  }

  function worldChanged(previous, next) {
    if (!previous) return true;
    return (
      previous.revision !== next.revision ||
      previous.stock !== next.stock ||
      previous.notice !== next.notice ||
      previous.cart !== next.cart ||
      previous.selected !== next.selected ||
      previous.completed !== next.completed ||
      previous.appliedRevision !== next.appliedRevision
    );
  }

  function applyWorld(data) {
    const next = (() => {
      try {
        return acceptWorld(data);
      } catch (error) {
        showError(error.message);
        return null;
      }
    })();
    if (!next) return false;
    if (state.world && next.revision < state.world.revision) return false;
    const changed = worldChanged(state.world, next);
    state.world = next;
    const selected = parseSelected(next.selected);
    if (selected.product && PRODUCT_BY_ID.has(selected.product)) {
      state.lastAddedProduct = selected.product;
    }
    syncChrome();
    if (changed) render();
    maybeAck(next.revision, next.appliedRevision);
    return true;
  }

  function syncChrome() {
    const world = state.world;
    const cart = world ? world.cart : 0;
    cartCountEl.textContent = String(cart);
    dCartCountEl.textContent = String(cart);

    const notice = world && typeof world.notice === 'string' ? world.notice.trim() : '';
    noticeEl.textContent = notice ? 'Notice: ' + notice : '';
    noticeEl.hidden = !notice;

    if (!world) {
      setStatus('Connecting to synthetic world…', false);
    } else {
      setStatus(`Connected · revision ${world.revision} · ${world.stock} in stock`, false);
    }
    srStatusEl.textContent =
      'Cart ' +
      cart +
      (cart === 1 ? ' item' : ' items') +
      (world && world.completed ? '. Checkout complete.' : '.');
  }

  function updateCartBadges() {
    syncChrome();
  }

  function miniCard(product) {
    return (
      '<a class="mini" href="#/product/' +
      product.id +
      '" data-product="' +
      product.id +
      '">' +
      tile(product) +
      '<span class="badge-deal">' +
      offPct(product) +
      '% off</span><span class="deal-text">Deal</span>' +
      '<div class="price" style="font-size:17px"><sup>₹</sup>' +
      inr(product.price) +
      '</div>' +
      '<div class="muted" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' +
      esc(product.title) +
      '</div>' +
      '</a>'
    );
  }

  function productRow(product) {
    return (
      '<a class="prow" href="#/product/' +
      product.id +
      '" data-product="' +
      product.id +
      '">' +
      tile(product) +
      '<div class="info">' +
      '<p class="ptitle">' +
      esc(product.title) +
      '</p>' +
      '<div class="rating-line">' +
      product.rating +
      ' <span class="stars">' +
      stars(product.rating) +
      '</span> (' +
      shortCount(product.reviews) +
      ')</div>' +
      '<div class="muted">' +
      inr(product.bought) +
      '+ bought in past month</div>' +
      (product.deal ? '<span class="badge-deal">Limited time deal</span>' : '') +
      '<div>' +
      priceHtml(product) +
      ' <span class="mrp">M.R.P: <s>₹' +
      inr(product.mrp) +
      '</s></span> <span class="off">(' +
      offPct(product) +
      '% off)</span></div>' +
      (product.prime ? '<span class="prime">prime</span>' : '') +
      '<div class="muted">FREE delivery <b>' +
      deliveryDate(product.prime ? 1 : 4) +
      '</b></div>' +
      '<span class="btn btn-yellow btn-sm" aria-hidden="true">View options</span>' +
      '</div></a>'
    );
  }

  function quad(title, items, link) {
    return (
      '<section class="section"><h2>' +
      title +
      '</h2><div class="quad-grid">' +
      items
        .map(
          (product) =>
            '<a href="#/product/' +
            product.id +
            '" data-product="' +
            product.id +
            '">' +
            tile(product) +
            esc(product.brand) +
            ' · ' +
            offPct(product) +
            '% off</a>',
        )
        .join('') +
      '</div><a class="see" href="' +
      link +
      '">See all offers</a></section>'
    );
  }

  function homePage() {
    const deals = PRODUCTS.filter((product) => product.deal);
    return (
      '<div class="home-intro">Synthetic Amazon-style catalog for Sightline testing. Product, stock and order state are isolated per agent.</div>' +
      '<div class="chips">' +
      CATEGORIES.map(
        (category) =>
          '<a class="chip" href="#/search?cat=' +
          category.id +
          '"><div class="ci" style="background:' +
          category.tint +
          '">' +
          category.icon +
          '</div>' +
          category.name +
          '</a>',
      ).join('') +
      '</div>' +
      '<div class="carousel" id="carousel"><div class="slides">' +
      BANNERS.map(
        (banner) =>
          '<a class="slide" href="' +
          banner.link +
          '" style="background:' +
          banner.bg +
          '"><div><h3>' +
          banner.title +
          '</h3><p>' +
          banner.sub +
          '</p><span class="cta">Shop now ›</span></div><div class="big">' +
          banner.icon +
          '</div></a>',
      ).join('') +
      '</div><div class="dots">' +
      BANNERS.map((_, index) => '<i class="' + (index ? '' : 'on') + '"></i>').join('') +
      '</div></div>' +
      '<div class="home-cards first">' +
      quad('Up to 60% off | Campus essentials', PRODUCTS, '#/search') +
      quad(
        'Revamp your home in style',
        [PRODUCTS[1], PRODUCTS[3], PRODUCTS[0], PRODUCTS[2]],
        '#/search?cat=home',
      ) +
      quad(
        'Fashion for every occasion',
        [PRODUCTS[2], PRODUCTS[0], PRODUCTS[1], PRODUCTS[3]],
        '#/search?cat=fashion',
      ) +
      quad(
        'Study and work from home',
        [PRODUCTS[3], PRODUCTS[0], PRODUCTS[2], PRODUCTS[1]],
        '#/search?cat=books',
      ) +
      '</div>' +
      '<section class="section"><div class="row-head"><h2>Today\'s Deals</h2><span class="timer">Synthetic offers</span></div><div class="hscroll">' +
      (deals.length
        ? deals.map(miniCard).join('')
        : '<p class="muted">No deals in this world.</p>') +
      '</div><a class="see" href="#/search?deal=1">See all deals</a></section>' +
      '<section class="section"><h2>Best Sellers in Campus Essentials</h2><div class="hscroll">' +
      PRODUCTS.map(miniCard).join('') +
      '</div></section>' +
      '<div style="text-align:center;padding:20px" class="muted">You\'ve reached the end · <a class="see" href="#/search">Browse all products</a></div>'
    );
  }

  function searchPage(routeParams) {
    const query = (routeParams.get('q') || '').trim().toLowerCase();
    const category = routeParams.get('cat') || '';
    const deal = routeParams.get('deal') === '1';
    const prime = routeParams.get('prime') === '1';
    const sort = routeParams.get('sort') || '';

    let list = PRODUCTS.filter(
      (product) =>
        (!query ||
          (
            product.title +
            ' ' +
            product.brand +
            ' ' +
            product.category +
            ' ' +
            product.variants.map((variant) => variant.name).join(' ')
          )
            .toLowerCase()
            .includes(query)) &&
        (!category || product.category === category) &&
        (!deal || product.deal) &&
        (!prime || product.prime),
    );
    const sorts = {
      low: (a, b) => a.price - b.price,
      high: (a, b) => b.price - a.price,
      rating: (a, b) => b.rating - a.rating,
      discount: (a, b) => offPct(b) - offPct(a),
    };
    if (sorts[sort]) list = list.slice().sort(sorts[sort]);

    const link = (changes) => {
      const next = new URLSearchParams(routeParams);
      Object.entries(changes).forEach(([key, value]) => {
        if (value) next.set(key, value);
        else next.delete(key);
      });
      return '#/search?' + next.toString();
    };
    const categoryName = category
      ? (CATEGORIES.find((item) => item.id === category) || {}).name
      : '';
    // Authored defect: in the seeded out-of-stock world, a non-empty search
    // overstates its result count by one. The clean world keeps exact counts.
    const resultCount =
      outOfStockMode() && query && list.length > 0 ? list.length + 1 : list.length;

    return (
      '<div class="search-layout"><div class="filters">' +
      '<h3 class="dk-only">Filters</h3>' +
      '<a class="fchip ' +
      (prime ? 'on' : '') +
      '" href="' +
      link({ prime: prime ? '' : '1' }) +
      '"><span class="prime">prime</span></a>' +
      '<a class="fchip ' +
      (deal ? 'on' : '') +
      '" href="' +
      link({ deal: deal ? '' : '1' }) +
      '">Today\'s Deals</a>' +
      '<select class="fchip" id="sortSel" aria-label="Sort by"><option value="">Sort: Featured</option><option value="low" ' +
      (sort === 'low' ? 'selected' : '') +
      '>Price: Low to High</option><option value="high" ' +
      (sort === 'high' ? 'selected' : '') +
      '>Price: High to Low</option><option value="rating" ' +
      (sort === 'rating' ? 'selected' : '') +
      '>Avg. Customer Review</option><option value="discount" ' +
      (sort === 'discount' ? 'selected' : '') +
      '>Discount</option></select>' +
      '<h3 class="dk-only">Category</h3>' +
      CATEGORIES.map(
        (item) =>
          '<a class="fchip ' +
          (category === item.id ? 'on' : '') +
          '" href="' +
          link({ cat: category === item.id ? '' : item.id }) +
          '">' +
          item.name +
          '</a>',
      ).join('') +
      '</div><div class="results"><div class="result-count">' +
      resultCount +
      ' result' +
      (resultCount === 1 ? '' : 's') +
      (query ? ' for <b>"' + esc(query) + '"</b>' : '') +
      (categoryName ? ' in <b>' + categoryName + '</b>' : '') +
      '</div>' +
      '<div id="shopResults" class="plist">' +
      (list.length ? list.map(productRow).join('') : '') +
      '</div>' +
      (list.length
        ? ''
        : '<div class="empty section"><div class="big">🔎</div><h2>No results found</h2><p class="muted">Try checking your spelling or use more general terms.</p><a class="btn btn-yellow" href="#/">Continue shopping</a></div>') +
      '</div></div>'
    );
  }

  function productPage(product) {
    const world = state.world;
    const selected = parseSelected(world ? world.selected : '');
    const selectedHere = selected.product === product.id;
    const activeVariant = selectedHere ? findVariant(product, selected.variant) : null;
    const completed = !!(world && world.completed);
    const outOfStock = world ? world.stock <= 0 : false;
    const authoredOutOfStock = outOfStockMode();
    const canAdd = selectedHere && activeVariant && !completed;
    // Authored defect: after activation in the seeded out-of-stock world the
    // Checkout control stays stuck on "Checking out…" even if the world
    // re-renders. Clean worlds never enter this state.
    const checkoutStuck = state.checkoutStuck && authoredOutOfStock && !completed;
    const checkoutEnabled =
      !checkoutStuck &&
      (((world?.cart ?? 0) > 0 && !completed) || (authoredOutOfStock && !completed));
    const category = CATEGORIES.find((item) => item.id === product.category) || CATEGORIES[0];
    const similar = PRODUCTS.filter(
      (item) => item.category === product.category && item.id !== product.id,
    );
    const reviews = [
      [
        'Ankit S.',
        5,
        'Excellent product',
        'Value for money. Delivered before time and packaging was good.',
      ],
      ['Priya M.', 4, 'Good quality', 'Works as described. Would recommend to friends and family.'],
      [
        'Rahul K.',
        Math.max(2, Math.round(product.rating) - 1),
        'Decent',
        'Okay for the price, a couple of minor issues but overall fine.',
      ],
    ];

    return (
      '<div class="crumbs dk-only"><a href="#/search?cat=' +
      category.id +
      '">' +
      category.name +
      '</a> › <a href="#/search?q=' +
      encodeURIComponent(product.brand) +
      '">' +
      esc(product.brand) +
      '</a></div>' +
      '<div class="pd-layout">' +
      '<section class="section pd-head"><a class="pd-brand" href="#/search?q=' +
      encodeURIComponent(product.brand) +
      '">Visit the ' +
      esc(product.brand) +
      ' Store</a><div class="rating-line pd-rating">' +
      product.rating +
      ' <span class="stars">' +
      stars(product.rating) +
      '</span> ' +
      inr(product.reviews) +
      ' ratings</div><p class="pd-title">' +
      esc(product.title) +
      '</p></section>' +
      '<section class="section pd-gallery"><div class="pd-hero" style="background:' +
      product.tint +
      '">' +
      product.icon +
      '</div></section>' +
      '<section class="section pd-pricebox">' +
      (product.deal ? '<span class="badge-deal">Limited time deal</span>' : '') +
      '<div class="pd-price"><span class="off">-' +
      offPct(product) +
      '%</span>' +
      priceHtml(product) +
      '</div><div class="mrp">M.R.P.: <s>₹' +
      inr(product.mrp) +
      '</s></div><div class="muted">Inclusive of all taxes</div>' +
      (product.prime ? '<span class="prime">prime</span>' : '') +
      '</section>' +
      '<section class="section pd-offers"><h2 style="font-size:16px">Offers</h2><div class="offers"><div class="offer"><b>Bank Offer</b>Upto ₹1,500 discount on select Credit Cards</div><div class="offer"><b>Cashback</b>Upto ₹' +
      inr(Math.round(product.price * 0.05)) +
      ' cashback as Amazon Pay Balance</div><div class="offer"><b>No Cost EMI</b>Upto ₹' +
      inr(Math.round(product.price * 0.03)) +
      ' EMI interest savings</div></div></section>' +
      '<section class="section pd-buy' +
      (authoredOutOfStock ? ' pd-out-of-stock' : '') +
      '">' +
      '<div class="dk-only">' +
      priceHtml(product) +
      '</div>' +
      '<div>FREE delivery <b>' +
      deliveryDate(product.prime ? 1 : 4) +
      '</b>.</div>' +
      '<div class="muted">Synthetic delivery estimate. No real shipment is created.</div>' +
      '<p id="stockLine" class="stock-line ' +
      (outOfStock ? 'out' : '') +
      '">' +
      (world
        ? outOfStock
          ? 'Out of stock (0 available)'
          : world.stock + ' in stock'
        : 'Loading stock…') +
      '</p>' +
      '<div class="variant-row" id="variantButtons">' +
      product.variants
        .map(
          (variant) =>
            '<button class="variant-chip" type="button" data-variant="' +
            variant.id +
            '" data-product="' +
            product.id +
            '" aria-pressed="' +
            (activeVariant && activeVariant.id === variant.id ? 'true' : 'false') +
            '"' +
            (!selectedHere || completed ? ' disabled' : '') +
            '>' +
            variant.name +
            '</button>',
        )
        .join('') +
      '</div>' +
      '<div class="muted">' +
      (selectedHere
        ? activeVariant
          ? 'Selected: ' + esc(activeVariant.name)
          : 'Choose a variant to continue.'
        : 'Selecting this product…') +
      '</div>' +
      '<button class="btn btn-yellow" id="addToCartButton" type="button" data-add="' +
      product.id +
      '"' +
      (canAdd ? '' : ' disabled') +
      '>' +
      (completed ? 'Checkout complete' : 'Add to Cart') +
      '</button>' +
      '<button class="btn btn-orange" id="checkoutButton" type="button" data-go-checkout="1"' +
      (checkoutEnabled ? '' : ' disabled') +
      '>' +
      (checkoutStuck ? 'Checking out…' : 'Checkout') +
      '</button>' +
      '<div class="synthetic-note">Synthetic checkout only. No account, payment or personal data is collected.</div>' +
      '<div class="muted">🔒 Secure synthetic transaction · Ships from Synthetic Warehouse · Sold by ' +
      esc(product.brand) +
      ' Retail</div>' +
      '</section>' +
      '<section class="section pd-about"><h2>About this item</h2><ul class="bullets">' +
      product.bullets.map((bullet) => '<li>' + esc(bullet) + '</li>').join('') +
      '</ul></section>' +
      '<section class="section pd-details"><h2>Product details</h2><table class="specs"><tr><td>Brand</td><td>' +
      esc(product.brand) +
      '</td></tr><tr><td>Category</td><td>' +
      category.name +
      '</td></tr><tr><td>Customer rating</td><td>' +
      product.rating +
      ' out of 5</td></tr><tr><td>ASIN</td><td>B0' +
      (product.id + 'X7Q9KZ').toUpperCase().slice(0, 8) +
      '</td></tr></table></section>' +
      '</div>' +
      (similar.length
        ? '<section class="section"><h2>Products related to this item</h2><div class="hscroll">' +
          similar.map(miniCard).join('') +
          '</div></section>'
        : '') +
      '<section class="section"><h2>Customer reviews</h2><div class="rating-line" style="font-size:16px;color:var(--ink)"><span class="stars" style="font-size:18px">' +
      stars(product.rating) +
      '</span> ' +
      product.rating +
      ' out of 5</div><div class="muted">' +
      inr(product.reviews) +
      ' global ratings</div>' +
      reviews
        .map(
          ([name, rating, title, body]) =>
            '<div class="review"><b>👤 ' +
            name +
            '</b><div><span class="stars">' +
            stars(rating) +
            '</span> <b>' +
            title +
            '</b></div><div class="muted green">Verified Purchase</div><div>' +
            body +
            '</div></div>',
        )
        .join('') +
      '</section>'
    );
  }

  function cartPage() {
    const world = state.world;
    const cart = world ? world.cart : 0;
    const completed = !!(world && world.completed);
    const selected = parseSelected(world ? world.selected : '');
    const product = findProduct(selected.product) || findProduct(state.lastAddedProduct);
    const subtotal = product ? product.price * cart : 0;

    if (completed) {
      return '<section id="orderConfirmation" class="section empty order-complete"><div class="big">✅</div><h2>Order complete</h2><p class="muted">This synthetic world has completed checkout. No payment or personal data was processed.</p><a class="btn btn-yellow" href="#/">Continue shopping</a></section>';
    }

    if (cart <= 0) {
      return '<div class="empty section"><div class="big">🛒</div><h2>Your Amazon Cart is empty</h2><p class="muted">Select a product and variant, then add it to the cart.</p><a class="btn btn-yellow" href="#/search?deal=1">Shop Today\'s Deals</a><a class="btn btn-plain" href="#/">Continue shopping</a></div>';
    }

    return (
      '<div class="cart-layout"><section class="section cart-sub"><div class="subtotal">Subtotal <b>₹' +
      inr(subtotal) +
      '</b></div>' +
      '<div class="green" style="font-size:13px">✔ Synthetic cart holds ' +
      cart +
      ' item' +
      (cart === 1 ? '' : 's') +
      '.</div>' +
      '<button class="btn btn-yellow" id="checkoutButton" type="button" data-go-checkout="1">Proceed to checkout (' +
      cart +
      ' item' +
      (cart === 1 ? '' : 's') +
      ')</button>' +
      '<div class="muted">Synthetic checkout only. No payment or personal data is collected.</div></section>' +
      '<section class="section cart-items"><h2 class="dk-only">Shopping Cart</h2><div class="citem">' +
      (product
        ? '<a href="#/product/' + product.id + '">' + tile(product) + '</a>'
        : '<div class="tile">📦</div>') +
      '<div class="info"><a href="' +
      (product ? '#/product/' + product.id : '#/search') +
      '" class="ptitle" style="font-size:14px">' +
      (product ? esc(product.title) : 'Synthetic cart items') +
      '</a>' +
      (product
        ? '<div>' +
          priceHtml(product) +
          ' <span class="mrp"><s>₹' +
          inr(product.mrp) +
          '</s></span></div>'
        : '') +
      '<div class="green" style="font-size:12px">Synthetic line item tracked by the isolated world</div>' +
      '<div class="actions"><span class="cart-line-qty"><span>' +
      cart +
      '</span></span><span class="muted">Quantity is controlled by the world; this adaptation has no remove action.</span></div>' +
      '</div></div></section></div>'
    );
  }

  function checkoutPage() {
    const world = state.world;
    const cart = world ? world.cart : 0;
    const completed = !!(world && world.completed);
    const selected = parseSelected(world ? world.selected : '');
    const product = findProduct(selected.product) || findProduct(state.lastAddedProduct);
    const subtotal = product ? product.price * cart : 0;

    if (completed) {
      return '<section id="orderConfirmation" class="section empty order-complete"><div class="big">✅</div><h2>Order complete</h2><p class="muted">The isolated world already recorded checkout for this agent.</p><a class="btn btn-yellow" href="#/">Continue shopping</a></section>';
    }

    if (cart <= 0) {
      return '<div class="empty section"><div class="big">🛒</div><h2>Your cart is empty</h2><p class="muted">Add a selected product and variant before checkout.</p><a class="btn btn-yellow" href="#/search">Browse products</a></div>';
    }

    return (
      '<div class="steps"><span class="on">① Address</span><span class="on">② Payment</span><span class="on">③ Place order</span></div>' +
      '<div class="co-layout"><section class="section co-address"><h2>Delivery address</h2><ul class="synthetic-address"><strong>Demo Shopper</strong><li>100 Campus Loop</li><li>New Delhi 110016</li><li>No personal data is collected or stored.</li></ul></section>' +
      '<section class="section co-pay"><h2>Payment method</h2><p class="muted">No payment method, card, UPI or bank details are collected. Completing this step only advances the isolated synthetic world.</p></section>' +
      '<section class="section co-summary"><h2>Order Summary</h2><div class="sumline"><span>Items (' +
      cart +
      '):</span><span>₹' +
      inr(subtotal) +
      '</span></div><div class="sumline"><span>Delivery:</span><span>FREE</span></div><div class="sumline total"><span>Order Total:</span><span>₹' +
      inr(subtotal) +
      '</span></div><div class="muted">Synthetic delivery estimate ' +
      deliveryDate(2) +
      '</div><button class="btn btn-yellow" id="completeCheckoutButton" type="button" data-checkout="1">Complete synthetic checkout</button><div class="synthetic-note">No real payment is taken and no personal data is requested.</div></section></div>'
    );
  }

  function orderPage() {
    const world = state.world;
    if (!world)
      return '<div class="section empty"><div class="big">📦</div><h2>Loading order state…</h2></div>';
    if (!world.completed) {
      return '<div class="empty section"><div class="big">📦</div><h2>No completed order yet</h2><p class="muted">Complete synthetic checkout to advance this world.</p><a class="btn btn-yellow" href="#/cart">Go to cart</a></div>';
    }
    const selected = parseSelected(world.selected);
    const product = findProduct(selected.product) || findProduct(state.lastAddedProduct);
    const subtotal = product ? product.price * world.cart : 0;
    return (
      '<section id="orderConfirmation" class="section empty order-complete"><div class="big">✅</div><h2>Order placed, thank you!</h2><p>Synthetic confirmation for the isolated world. No account, payment or personal data was used.</p></section>' +
      '<section class="section"><div class="row-head"><b>Arriving ' +
      deliveryDate(2) +
      '</b><span class="muted">₹' +
      inr(subtotal) +
      '</span></div><div class="oi" style="font-size:30px;margin:8px 0">' +
      (product ? product.icon : '📦') +
      '</div><div class="muted order-id">Order # SYN-' +
      String(world.revision).padStart(4, '0') +
      '-' +
      String(world.cart).padStart(2, '0') +
      '</div><div class="muted">Items: ' +
      world.cart +
      ' · Status: ' +
      (world.completed ? 'complete' : 'pending') +
      '</div><a class="btn btn-yellow" href="#/">Continue shopping</a><a class="btn btn-plain" href="#/cart">Review cart</a></section>'
    );
  }

  function loadingPage() {
    return '<div class="section empty"><div class="big">🛒</div><h2>Connecting to the synthetic shop…</h2><p class="muted">Loading the isolated world state.</p></div>';
  }

  function updateTabs(route) {
    const active = route === 'home' ? 'home' : route === 'search' ? 'search' : 'cart';
    document.querySelectorAll('.tabbar a').forEach((link) => {
      link.classList.toggle('active', link.getAttribute('data-tab') === active);
    });
  }

  function updateBackButton(route) {
    document.body.classList.toggle('has-back', route !== 'home');
  }

  function fillSearchFields(route, routeParams) {
    const query = route === 'search' ? routeParams.get('q') || '' : '';
    searchInput.value = query;
    dSearchInput.value = query;
    dSearchCat.value = route === 'search' ? routeParams.get('cat') || '' : '';
  }

  function startCarousel(route) {
    if (state.carouselTimer) {
      clearInterval(state.carouselTimer);
      state.carouselTimer = 0;
    }
    if (route !== 'home') return;
    const root = document.getElementById('carousel');
    if (!root) return;
    const slides = root.querySelector('.slides');
    const dots = root.querySelectorAll('.dots i');
    if (!slides || !dots.length) return;
    let index = 0;
    const go = (next) => {
      index = (next + BANNERS.length) % BANNERS.length;
      slides.style.transform = 'translateX(-' + index * 100 + '%)';
      dots.forEach((dot, dotIndex) => dot.classList.toggle('on', dotIndex === index));
    };
    state.carouselTimer = setInterval(() => go(index + 1), 4500);
  }

  function render() {
    if (!state.world) {
      view.innerHTML = loadingPage();
      syncChrome();
      updateBackButton('home');
      updateTabs('home');
      return;
    }

    const rawHash = window.location.hash.slice(1) || '/';
    const hashParts = rawHash.split('?');
    const pathPart = hashParts[0] || '/';
    const queryPart = hashParts[1] || '';
    const routeParams = new URLSearchParams(queryPart);
    const routeParts = pathPart.split('/').filter(Boolean);
    const route = routeParts[0] || 'home';
    const routeKey = window.location.hash || '#/';
    const routeChanged = routeKey !== state.route;
    const scrollY = window.scrollY;
    let html;

    if (route === 'home') html = homePage();
    else if (route === 'search') html = searchPage(routeParams);
    else if (route === 'product') {
      const product = findProduct(routeParts[1]);
      html = product
        ? productPage(product)
        : '<div class="empty section"><div class="big">🤷</div><h2>Product not found</h2><a class="btn btn-yellow" href="#/">Go home</a></div>';
    } else if (route === 'cart') html = cartPage();
    else if (route === 'checkout') html = checkoutPage();
    else if (route === 'order') html = orderPage();
    else html = homePage();

    view.innerHTML = html;
    syncChrome();
    updateTabs(route);
    updateBackButton(route);
    if (routeChanged) {
      window.scrollTo(0, 0);
      fillSearchFields(route, routeParams);
    } else {
      window.scrollTo(0, scrollY);
    }
    state.route = routeKey;
    startCarousel(route);

    if (route === 'product' && routeParts[1]) {
      ensureSelected(routeParts[1]);
    }
  }

  function ensureSelected(productId) {
    const world = state.world;
    if (!world || world.completed || state.busy) return;
    if (!findProduct(productId)) return;
    if (state.lastEnsureRoute === window.location.hash) return;
    const selected = parseSelected(world.selected);
    if (selected.product === productId) return;
    state.lastEnsureRoute = window.location.hash;
    runAction('select', productId, { silent: true });
  }

  function runAction(action, value, options) {
    const settings = options || {};
    if (state.busy) {
      toast('Please wait for the previous action to finish.');
      return;
    }
    if (!base) {
      showError('This replica URL is missing an agent id.');
      return;
    }
    state.busy = true;
    if (!settings.silent) clearError();
    void postAction(action, value)
      .then((data) => {
        state.busy = false;
        applyWorld(data);
        if (settings.onSuccess) settings.onSuccess(data);
      })
      .catch((error) => {
        state.busy = false;
        if (settings.swallow) {
          if (settings.onSwallow) settings.onSwallow(error);
          return;
        }
        showError(error.message);
        fetchWorld();
      });
  }

  function addToCart(productId) {
    const world = state.world;
    if (!world) return;
    if (world.completed) {
      toast('Checkout is already complete.');
      return;
    }
    const selected = parseSelected(world.selected);
    const product = findProduct(productId);
    if (!product || selected.product !== productId || !selected.variant) {
      toast('Choose a product and variant first.');
      return;
    }
    const authoredOutOfStock = outOfStockMode();
    runAction('addToCart', productId, {
      swallow: authoredOutOfStock,
      onSwallow: () => {
        // Authored defect: a false success message without a cart change.
        toast('Added to Cart');
      },
      onSuccess: () => {
        state.lastAddedProduct = productId;
        toast('Added to Cart');
      },
    });
  }

  function completeCheckout() {
    const world = state.world;
    if (!world) return;
    if (world.completed) {
      window.location.hash = '#/order';
      return;
    }
    if (world.cart <= 0) {
      toast('Your cart is empty.');
      return;
    }
    runAction('checkout', 'synthetic', {
      onSuccess: () => {
        toast('Checkout complete');
        window.location.hash = '#/order';
      },
    });
  }

  function submitSearch(input, categorySelect) {
    const query = input.value.trim();
    const category = categorySelect ? categorySelect.value : '';
    const next = new URLSearchParams();
    if (query) next.set('q', query);
    if (category) next.set('cat', category);
    const hash = '#/search' + (next.toString() ? '?' + next.toString() : '');
    if (window.location.hash === hash) render();
    else window.location.hash = hash;
    if (state.world) runAction('search', query, { silent: true });
  }

  function renderSubNav() {
    dSub.innerHTML =
      '<a href="#/">☰ <b>All</b></a><a href="#/search?deal=1">Today\'s Deals</a>' +
      CATEGORIES.map(
        (category) => '<a href="#/search?cat=' + category.id + '">' + category.name + '</a>',
      ).join('') +
      '<a href="#/cart">Customer Service</a>';
    dSearchCat.innerHTML =
      '<option value="">All</option>' +
      CATEGORIES.map(
        (category) => '<option value="' + category.id + '">' + category.name + '</option>',
      ).join('');
  }

  function fetchWorld() {
    if (!base) {
      fatal(
        'This replica URL is missing an agent id. Open it from a Sightline run as /replica?agent=<id>.',
      );
      return;
    }
    void request(base, { headers: { Accept: 'application/json' } })
      .then((data) => {
        if (state.pollFailures > 0) clearError();
        state.pollFailures = 0;
        applyWorld(data);
        schedulePoll();
      })
      .catch((error) => {
        state.pollFailures++;
        setStatus('Replica server unavailable — retrying', true);
        if (state.pollFailures === 1) showError('World state unavailable: ' + error.message);
        schedulePoll();
      });
  }

  function schedulePoll() {
    clearTimeout(state.pollTimer);
    state.pollTimer = setTimeout(fetchWorld, document.hidden ? 2200 : 1000);
  }

  function bindEvents() {
    document.getElementById('searchForm').addEventListener('submit', (event) => {
      event.preventDefault();
      submitSearch(searchInput, null);
    });
    document.getElementById('dSearchForm').addEventListener('submit', (event) => {
      event.preventDefault();
      submitSearch(dSearchInput, dSearchCat);
    });

    document.addEventListener('click', (event) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target) return;
      const synthetic = target.closest('[data-synthetic]');
      if (synthetic) {
        event.preventDefault();
        toast('Synthetic demo — no account or payment flows.');
      }
    });

    view.addEventListener('click', (event) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target) return;

      const variantButton = target.closest('[data-variant]');
      if (variantButton) {
        event.preventDefault();
        const variantId = variantButton.getAttribute('data-variant');
        const productId = variantButton.getAttribute('data-product');
        if (!variantId || !productId) return;
        if (state.world && state.world.completed) {
          toast('Checkout is already complete.');
          return;
        }
        const selected = parseSelected(state.world ? state.world.selected : '');
        if (selected.product !== productId) {
          toast('Choose this product first.');
          return;
        }
        runAction('variant', variantId);
        return;
      }

      const addButton = target.closest('[data-add]');
      if (addButton) {
        event.preventDefault();
        addToCart(addButton.getAttribute('data-add'));
        return;
      }

      const goCheckout = target.closest('[data-go-checkout]');
      if (goCheckout) {
        event.preventDefault();
        if (state.world?.cart > 0 && !state.world.completed) window.location.hash = '#/checkout';
        else if (outOfStockMode()) {
          // Authored defect: the enabled Checkout control enters a stuck
          // loading state instead of reporting the empty cart.
          state.checkoutStuck = true;
          if (goCheckout instanceof HTMLButtonElement) {
            goCheckout.disabled = true;
            goCheckout.textContent = 'Checking out…';
          }
        } else {
          toast('Your cart is empty.');
        }
        return;
      }

      const checkoutButton = target.closest('[data-checkout]');
      if (checkoutButton) {
        event.preventDefault();
        completeCheckout();
      }
    });

    document.getElementById('backBtn').addEventListener('click', () => {
      if (window.history.length > 1) window.history.back();
      else window.location.hash = '#/';
    });

    document.getElementById('toTop').addEventListener('click', (event) => {
      event.preventDefault();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });

    document.addEventListener('change', (event) => {
      if (!(event.target instanceof Element) || event.target.id !== 'sortSel') return;
      const hashParts = window.location.hash.slice(1).split('?');
      const next = new URLSearchParams(hashParts[1] || '');
      const value = event.target.value;
      if (value) next.set('sort', value);
      else next.delete('sort');
      window.location.hash = '#/search?' + next.toString();
    });

    window.addEventListener('hashchange', () => render());
    window.addEventListener('error', (event) => {
      showError('Replica interface error: ' + (event.message || 'unknown error'));
    });
    window.addEventListener('unhandledrejection', (event) => {
      const reason = event.reason;
      showError('Replica request failed: ' + ((reason && reason.message) || 'unknown error'));
    });
  }

  function init() {
    if (!agentId || !/^[A-Za-z0-9_-]{1,64}$/.test(agentId)) {
      fatal(
        'This replica URL is missing a valid agent id. Open it from a Sightline run as /replica?agent=<id>.',
      );
      return;
    }
    renderSubNav();
    bindEvents();
    updateCartBadges();
    setStatus('Connecting to synthetic world…', false);
    render();
    fetchWorld();
  }

  init();
})();
