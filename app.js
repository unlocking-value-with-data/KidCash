// ─── Data Layer ───────────────────────────────────────────────
const STORAGE_KEY = 'kidcash_data';

function getDefaultData() {
  return {
    kids: [
      { id: generateId(), name: 'Kid 1' },
      { id: generateId(), name: 'Kid 2' },
    ],
    transactions: [],
    goals: [],
    activeKidIndex: 0,
  };
}

function loadData() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const data = JSON.parse(raw);
      if (!data.goals) data.goals = [];
      if (!data.wishlist) data.wishlist = [];
      return data;
    }
  } catch (e) {
    console.error('Failed to load data', e);
  }
  return getDefaultData();
}

function saveData(data) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  // Sync to Firestore if signed in
  if (currentUser && window.fbSetDoc) {
    saveToFirestore(currentUser.uid, data);
  }
}

async function saveToFirestore(uid, data) {
  try {
    const docRef = fbDoc(firebaseDb, 'users', uid);
    await fbSetDoc(docRef, {
      kids: data.kids || [],
      transactions: data.transactions || [],
      goals: data.goals || [],
      wishlist: data.wishlist || [],
      activeKidIndex: data.activeKidIndex || 0,
      updatedAt: Date.now(),
    });
  } catch (e) {
    console.error('Failed to save to Firestore:', e);
  }
}

async function loadFromFirestore(uid) {
  try {
    const docRef = fbDoc(firebaseDb, 'users', uid);
    const docSnap = await fbGetDoc(docRef);
    if (docSnap.exists()) {
      const data = docSnap.data();
      if (!data.goals) data.goals = [];
      if (!data.wishlist) data.wishlist = [];
      state = data;
    } else {
      // New user — initialize with defaults
      state = getDefaultData();
      state.wishlist = [];
      await saveToFirestore(uid, state);
    }
    // Cache locally
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (e) {
    console.error('Firestore load failed, using local data:', e);
    state = loadData();
  }
}

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// ─── State ────────────────────────────────────────────────────
let state = loadData();
let currentView = 'home'; // 'home' | 'activity' | 'goals' | 'settings'
let modalOpen = null; // null | 'transaction' | 'goal' | 'wishlist'
let txType = 'income';
let confirmAction = null;
let pendingWishlistPurchase = null;
let fetchStatus = null;
let fetchedProduct = { name: '', price: '', image: null };

// ─── Auth State ──────────────────────────────────────────────
let currentUser = null;
let appReady = false;
let authMode = 'login'; // 'login' | 'signup'
let authError = '';
let authBusy = false;

function getActiveKid() {
  return state.kids[state.activeKidIndex] || state.kids[0];
}

function getKidTransactions(kidId) {
  return state.transactions
    .filter(t => t.kidId === kidId)
    .sort((a, b) => b.timestamp - a.timestamp);
}

function getKidGoals(kidId) {
  return state.goals.filter(g => g.kidId === kidId);
}

function getKidWishlist(kidId) {
  return state.wishlist
    .filter(w => w.kidId === kidId)
    .sort((a, b) => b.addedAt - a.addedAt);
}

function getBalance(kidId) {
  return state.transactions
    .filter(t => t.kidId === kidId)
    .reduce((sum, t) => sum + (t.type === 'income' ? t.amount : -t.amount), 0);
}

function getTotalIncome(kidId) {
  return state.transactions
    .filter(t => t.kidId === kidId && t.type === 'income')
    .reduce((sum, t) => sum + t.amount, 0);
}

function getTotalExpenses(kidId) {
  return state.transactions
    .filter(t => t.kidId === kidId && t.type === 'expense')
    .reduce((sum, t) => sum + t.amount, 0);
}

// ─── Formatting ───────────────────────────────────────────────
function formatMoney(cents) {
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100);
  const remaining = abs % 100;
  const sign = cents < 0 ? '-' : '';
  return `${sign}$${dollars.toLocaleString()}.${remaining.toString().padStart(2, '0')}`;
}

function parseMoney(str) {
  const num = parseFloat(str);
  if (isNaN(num) || num <= 0) return 0;
  return Math.round(num * 100);
}

function formatDate(timestamp) {
  const d = new Date(timestamp);
  const now = new Date();
  const diff = now - d;
  if (diff < 60000) return 'Just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  if (diff < 604800000) {
    const days = Math.floor(diff / 86400000);
    return days === 1 ? 'Yesterday' : `${days}d ago`;
  }
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// ─── Sales Tax by State ──────────────────────────────────────
const STATE_TAX_RATES = {
  '': { name: 'No Tax', rate: 0 },
  'AL': { name: 'Alabama', rate: 4.00 },
  'AK': { name: 'Alaska', rate: 0 },
  'AZ': { name: 'Arizona', rate: 5.60 },
  'AR': { name: 'Arkansas', rate: 6.50 },
  'CA': { name: 'California', rate: 7.25 },
  'CO': { name: 'Colorado', rate: 2.90 },
  'CT': { name: 'Connecticut', rate: 6.35 },
  'DE': { name: 'Delaware', rate: 0 },
  'FL': { name: 'Florida', rate: 6.00 },
  'GA': { name: 'Georgia', rate: 4.00 },
  'HI': { name: 'Hawaii', rate: 4.00 },
  'ID': { name: 'Idaho', rate: 6.00 },
  'IL': { name: 'Illinois', rate: 6.25 },
  'IN': { name: 'Indiana', rate: 7.00 },
  'IA': { name: 'Iowa', rate: 6.00 },
  'KS': { name: 'Kansas', rate: 6.50 },
  'KY': { name: 'Kentucky', rate: 6.00 },
  'LA': { name: 'Louisiana', rate: 4.45 },
  'ME': { name: 'Maine', rate: 5.50 },
  'MD': { name: 'Maryland', rate: 6.00 },
  'MA': { name: 'Massachusetts', rate: 6.25 },
  'MI': { name: 'Michigan', rate: 6.00 },
  'MN': { name: 'Minnesota', rate: 6.875 },
  'MS': { name: 'Mississippi', rate: 7.00 },
  'MO': { name: 'Missouri', rate: 4.225 },
  'MT': { name: 'Montana', rate: 0 },
  'NE': { name: 'Nebraska', rate: 5.50 },
  'NV': { name: 'Nevada', rate: 6.85 },
  'NH': { name: 'New Hampshire', rate: 0 },
  'NJ': { name: 'New Jersey', rate: 6.625 },
  'NM': { name: 'New Mexico', rate: 4.875 },
  'NY': { name: 'New York', rate: 4.00 },
  'NC': { name: 'North Carolina', rate: 4.75 },
  'ND': { name: 'North Dakota', rate: 5.00 },
  'OH': { name: 'Ohio', rate: 5.75 },
  'OK': { name: 'Oklahoma', rate: 4.50 },
  'OR': { name: 'Oregon', rate: 0 },
  'PA': { name: 'Pennsylvania', rate: 6.00 },
  'RI': { name: 'Rhode Island', rate: 7.00 },
  'SC': { name: 'South Carolina', rate: 6.00 },
  'SD': { name: 'South Dakota', rate: 4.20 },
  'TN': { name: 'Tennessee', rate: 7.00 },
  'TX': { name: 'Texas', rate: 6.25 },
  'UT': { name: 'Utah', rate: 6.10 },
  'VT': { name: 'Vermont', rate: 6.00 },
  'VA': { name: 'Virginia', rate: 5.30 },
  'WA': { name: 'Washington', rate: 6.50 },
  'WV': { name: 'West Virginia', rate: 6.00 },
  'WI': { name: 'Wisconsin', rate: 5.00 },
  'WY': { name: 'Wyoming', rate: 4.00 },
  'DC': { name: 'Washington DC', rate: 6.00 },
};

let selectedState = localStorage.getItem('kidcash_state') || '';

function calcTax(amountCents, stateCode) {
  const info = STATE_TAX_RATES[stateCode];
  if (!info || info.rate === 0) return 0;
  return Math.round(amountCents * info.rate / 100);
}

// ─── Product Fetch ───────────────────────────────────────────
const RETAILER_RULES = [
  { match: /amazon\.|amzn\.|a\.co/i, priceSelector: '#corePrice_feature_div .a-offscreen, span.a-price[data-a-size] .a-offscreen, .a-price .a-offscreen, #priceblock_ourprice', imageSelector: '#landingImage, #imgBlkFront, img.a-dynamic-image, #main-image-container img' },
  { match: /walmart\./i, priceSelector: '[itemprop="price"], [data-automation="buybox-price"], span[class*="price-characteristic"]', imageSelector: '[data-testid="hero-image"] img' },
  { match: /target\./i, priceSelector: '[data-test="product-price"], span[class*="CurrentPrice"]', imageSelector: '[data-test="product-image"] img' },
  { match: /bestbuy\./i, priceSelector: '.priceView-customer-price span, [data-testid="customer-price"]', imageSelector: '.primary-image' },
  { match: /ebay\./i, priceSelector: '.x-price-primary span, #prcIsum', imageSelector: '#icImg, .ux-image-carousel img' },
  { match: /etsy\./i, priceSelector: '[data-buy-box-listing-price], .wt-text-title-03', imageSelector: '[data-listing-card-image] img' },
];

async function fetchProductInfo(url) {
  const microlinkResult = await fetchViaMicrolink(url);
  if (microlinkResult && (microlinkResult.name || microlinkResult.price)) {
    return microlinkResult;
  }
  const proxyResult = await fetchViaProxy(url);
  if (proxyResult && (proxyResult.name || proxyResult.price)) {
    return proxyResult;
  }
  return null;
}

// Build a Microlink API URL with optional retailer-specific data extraction
function buildMicrolinkUrl(url) {
  let apiUrl = `https://api.microlink.io/?url=${encodeURIComponent(url)}`;
  const rule = RETAILER_RULES.find(r => r.match.test(url));
  if (rule) {
    apiUrl += `&data.price.selector=${encodeURIComponent(rule.priceSelector)}&data.price.type=text`;
    if (rule.imageSelector) {
      apiUrl += `&data.productImage.selector=${encodeURIComponent(rule.imageSelector)}&data.productImage.type=image&data.productImage.attr=src`;
    }
  }
  return { apiUrl, rule };
}

// Parse a Microlink response into our result format
function parseMicrolinkResult(d, rule) {
  const result = { name: '', price: '', image: null };
  result.name = d.title || '';
  result.name = result.name
    .replace(/^Amazon\.com:\s*/i, '')
    .replace(/\s*[-|:]\s*(Amazon|Walmart|Target|Best Buy|eBay|Etsy).*$/i, '')
    .replace(/\s*[-|:]\s*[A-Z][a-z]+\.(com|ca|co\.uk).*$/i, '')
    .trim();

  // Filter out generic site logos, marketing images, and favicons
  const isGenericImage = (url) => /\/marketing\/|\/prime|\/sprite|\/logo|\/brand|\/badge|Logos\/|favicon/i.test(url || '');

  // Prefer retailer-specific product image over generic og:image
  if (d.productImage?.url && !isGenericImage(d.productImage.url)) {
    result.image = d.productImage.url;
  } else if (d.image?.url && !isGenericImage(d.image.url)) {
    result.image = d.image.url;
  }
  // Don't fall back to logo — it's usually a favicon or site icon, not useful

  // Extract price from custom selector
  if (d.price && !/^\s*-?\d+%/.test(d.price)) {
    // Skip percentage-only values like "-10%" (discount badges)
    const priceMatch = d.price.match(/\$?([\d,]+\.?\d{0,2})/);
    if (priceMatch) {
      const val = parseFloat(priceMatch[1].replace(',', ''));
      if (val > 0.5 && val < 100000) result.price = val.toFixed(2);
    }
  }
  // Fallback: look for price in description
  if (!result.price && d.description) {
    const priceMatch = d.description.match(/\$(\d[\d,]*\.?\d{0,2})/);
    if (priceMatch) {
      const val = parseFloat(priceMatch[1].replace(',', ''));
      if (val > 0 && val < 100000) result.price = val.toFixed(2);
    }
  }
  return result;
}

async function fetchViaMicrolink(url) {
  try {
    // First request
    const { apiUrl, rule } = buildMicrolinkUrl(url);
    const resp = await fetch(apiUrl, { signal: AbortSignal.timeout(15000) });
    if (!resp.ok) throw new Error('Microlink failed');
    const json = await resp.json();
    if (json.status !== 'success' || !json.data) throw new Error('Bad response');
    const d = json.data;

    // Check if the resolved URL is different (shortened URL was expanded)
    const resolvedUrl = d.url || url;
    const resolvedRule = RETAILER_RULES.find(r => r.match.test(resolvedUrl));

    // If the original URL didn't match a retailer but the resolved one does,
    // retry with retailer-specific selectors for better price/image extraction
    if (!rule && resolvedRule && resolvedUrl !== url) {
      console.log('Short URL resolved to retailer, retrying with selectors:', resolvedUrl);
      const { apiUrl: retryUrl } = buildMicrolinkUrl(resolvedUrl);
      const resp2 = await fetch(retryUrl, { signal: AbortSignal.timeout(15000) });
      if (resp2.ok) {
        const json2 = await resp2.json();
        if (json2.status === 'success' && json2.data) {
          return parseMicrolinkResult(json2.data, resolvedRule);
        }
      }
    }

    return parseMicrolinkResult(d, rule || resolvedRule);
  } catch (e) {
    console.warn('Microlink fetch failed:', e);
    return null;
  }
}

async function fetchViaProxy(url) {
  try {
    const proxyUrl = 'https://api.allorigins.win/raw?url=' + encodeURIComponent(url);
    const resp = await fetch(proxyUrl, { signal: AbortSignal.timeout(10000) });
    if (!resp.ok) throw new Error('Proxy fetch failed');
    const html = await resp.text();
    return parseProductFromHtml(html, url);
  } catch (e) {
    console.warn('Proxy fetch failed:', e);
    return null;
  }
}

function parseProductFromHtml(html, url) {
  const result = { name: '', price: '', image: null };
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  const ldScripts = doc.querySelectorAll('script[type="application/ld+json"]');
  for (const script of ldScripts) {
    try {
      let data = JSON.parse(script.textContent);
      if (Array.isArray(data)) data = data[0];
      if (data['@graph']) {
        data = data['@graph'].find(item =>
          item['@type'] === 'Product' || item['@type']?.includes?.('Product')
        ) || data;
      }
      if (data['@type'] === 'Product' || data['@type']?.includes?.('Product')) {
        result.name = data.name || result.name;
        if (data.image) {
          result.image = Array.isArray(data.image) ? data.image[0] : (typeof data.image === 'string' ? data.image : data.image.url);
        }
        const offers = data.offers;
        if (offers) {
          const offer = Array.isArray(offers) ? offers[0] : offers;
          const price = offer.price || offer.lowPrice;
          if (price) result.price = parseFloat(price).toFixed(2);
        }
      }
    } catch (e) { /* skip bad JSON-LD */ }
  }
  if (!result.name) {
    const ogTitle = doc.querySelector('meta[property="og:title"]');
    result.name = ogTitle?.content || '';
  }
  if (!result.image) {
    const ogImage = doc.querySelector('meta[property="og:image"]');
    result.image = ogImage?.content || null;
  }
  if (!result.price) {
    const priceTag = doc.querySelector('meta[property="product:price:amount"], meta[property="og:price:amount"]');
    if (priceTag?.content) result.price = parseFloat(priceTag.content).toFixed(2);
  }
  if (!result.name) {
    const title = doc.querySelector('title');
    result.name = title?.textContent?.trim()?.split('|')[0]?.split('-')[0]?.trim() || '';
  }
  if (!result.price) {
    const rule = RETAILER_RULES.find(r => r.match.test(url));
    const selectors = rule ? rule.priceSelector.split(',').map(s => s.trim()) : [];
    selectors.push('[data-price]', '.price', '.product-price', '#price',
      '[class*="price"]', '[class*="Price"]', 'span[class*="amount"]');
    for (const sel of selectors) {
      const el = doc.querySelector(sel);
      if (el) {
        const text = el.getAttribute('data-price') || el.getAttribute('content') || el.textContent;
        const match = text.match(/\$?([\d,]+\.?\d{0,2})/);
        if (match) {
          const val = parseFloat(match[1].replace(',', ''));
          if (val > 0 && val < 100000) {
            result.price = val.toFixed(2);
            break;
          }
        }
      }
    }
  }
  if (result.image && !result.image.startsWith('http')) {
    try {
      const base = new URL(url);
      result.image = new URL(result.image, base.origin).href;
    } catch (e) { result.image = null; }
  }
  if (result.name) {
    result.name = result.name
      .replace(/\s*[-|:]\s*(Amazon|Walmart|Target|Best Buy|eBay|Etsy).*$/i, '')
      .trim();
  }
  return result;
}

// ─── Category Icons ───────────────────────────────────────────
const CATEGORIES = {
  income: [
    { value: 'cash', label: 'Cash', icon: '💵' },
    { value: 'gift-card', label: 'Gift Card', icon: '🎁' },
    { value: 'allowance', label: 'Allowance', icon: '📅' },
    { value: 'birthday', label: 'Birthday Money', icon: '🎂' },
    { value: 'chores', label: 'Chore Payment', icon: '🧹' },
    { value: 'other-in', label: 'Other', icon: '💰' },
  ],
  expense: [
    { value: 'toy', label: 'Toy', icon: '🧸' },
    { value: 'game', label: 'Game', icon: '🎮' },
    { value: 'food', label: 'Food/Treats', icon: '🍕' },
    { value: 'clothes', label: 'Clothes', icon: '👕' },
    { value: 'book', label: 'Book', icon: '📚' },
    { value: 'other-out', label: 'Other', icon: '🛒' },
  ],
};

function getCategoryIcon(type, category) {
  const list = CATEGORIES[type] || CATEGORIES.income;
  const cat = list.find(c => c.value === category);
  return cat ? cat.icon : (type === 'income' ? '💰' : '🛒');
}

// ─── Navigation ──────────────────────────────────────────────
window.navigateTo = function(view) {
  currentView = view;
  window.scrollTo(0, 0);
  render();
};

// ─── Rendering ────────────────────────────────────────────────
function render() {
  const app = document.getElementById('app');

  // Auth loading state (initial check)
  if (!appReady) {
    app.innerHTML = '<div class="auth-loading"><div class="auth-spinner"></div></div>';
    return;
  }

  // Not signed in — show login screen
  if (!currentUser) {
    app.innerHTML = renderLoginScreen();
    return;
  }

  let pageContent = '';
  switch (currentView) {
    case 'home':     pageContent = renderHomePage(); break;
    case 'activity': pageContent = renderActivityPage(); break;
    case 'goals':    pageContent = renderGoalsPage(); break;
    case 'settings': pageContent = renderSettingsPage(); break;
    default:         pageContent = renderHomePage(); break;
  }

  app.innerHTML = `
    <div class="page-content">
      ${renderHeader()}
      ${currentView !== 'settings' ? renderKidTabs() : ''}
      ${pageContent}
    </div>
    ${renderBottomNav()}
  `;

  app.innerHTML += renderModal();
  app.innerHTML += renderConfirm();
  bindEvents();
}

// ─── Login Screen ─────────────────────────────────────────────
function renderLoginScreen() {
  const isSignup = authMode === 'signup';
  const errorHtml = authError
    ? `<div class="auth-error">${escapeHtml(authError)}</div>`
    : '';

  return `
    <div class="login-screen">
      <div class="login-card">
        <div class="login-logo">
          <h1>💰 KidCash</h1>
          <p>Family Money Tracker</p>
        </div>
        <div class="login-form">
          ${errorHtml}
          <input class="login-input" type="email" id="authEmail" placeholder="Email address" autocomplete="email" autocapitalize="off">
          <input class="login-input" type="password" id="authPassword" placeholder="Password" autocomplete="${isSignup ? 'new-password' : 'current-password'}">
          ${isSignup ? '<input class="login-input" type="password" id="authPasswordConfirm" placeholder="Confirm password" autocomplete="new-password">' : ''}
          <button class="login-btn" onclick="handleAuth()" ${authBusy ? 'disabled' : ''}>
            ${authBusy ? 'Please wait...' : (isSignup ? 'Create Account' : 'Sign In')}
          </button>
          <div class="login-divider">or</div>
          <button class="google-btn" onclick="handleGoogleSignIn()" ${authBusy ? 'disabled' : ''}>
            <svg viewBox="0 0 24 24"><path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/><path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/><path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/><path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/></svg>
            Continue with Google
          </button>
          <div class="login-toggle">
            ${isSignup
              ? 'Already have an account? <button onclick="toggleAuthMode()">Sign In</button>'
              : 'Don\'t have an account? <button onclick="toggleAuthMode()">Sign Up</button>'
            }
          </div>
        </div>
      </div>
    </div>
  `;
}

// ─── Shared Components ───────────────────────────────────────
function renderHeader() {
  const titles = {
    home: 'KidCash',
    activity: 'Activity',
    goals: 'Goals & Wishlist',
    settings: 'Settings',
  };
  return `
    <div class="header">
      <h1>${titles[currentView] || 'KidCash'}</h1>
    </div>
  `;
}

function renderKidTabs() {
  return `
    <div class="kid-tabs">
      ${state.kids.map((kid, i) => `
        <button class="kid-tab ${i === state.activeKidIndex ? 'active' : ''}"
                onclick="switchKid(${i})">${escapeHtml(kid.name)}</button>
      `).join('')}
    </div>
  `;
}

function renderBottomNav() {
  const tabs = [
    { id: 'home',     icon: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path><polyline points="9 22 9 12 15 12 15 22"></polyline></svg>', label: 'Home' },
    { id: 'activity', icon: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"></polyline></svg>', label: 'Activity' },
    { id: 'goals',    icon: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><circle cx="12" cy="12" r="6"></circle><circle cx="12" cy="12" r="2"></circle></svg>', label: 'Goals' },
    { id: 'settings', icon: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>', label: 'Settings' },
  ];

  return `
    <nav class="bottom-nav">
      ${tabs.map(tab => `
        <button class="bottom-nav-tab ${currentView === tab.id ? 'active' : ''}"
                onclick="navigateTo('${tab.id}')">
          <span class="bottom-nav-icon">${tab.icon}</span>
          <span class="bottom-nav-label">${tab.label}</span>
        </button>
      `).join('')}
    </nav>
  `;
}

// ─── Home Page ────────────────────────────────────────────────
function renderHomePage() {
  const kid = getActiveKid();
  if (!kid) return '<p>No kids set up.</p>';
  const balance = getBalance(kid.id);
  const income = getTotalIncome(kid.id);
  const expenses = getTotalExpenses(kid.id);
  const transactions = getKidTransactions(kid.id).slice(0, 3);
  const goals = getKidGoals(kid.id);
  const wishlist = getKidWishlist(kid.id);

  return `
    ${renderBalanceCard(kid, balance, income, expenses)}
    ${renderQuickActions()}
    ${renderGoalsSnapshot(goals, balance)}
    ${renderWishlistSnapshot(wishlist)}
    ${renderRecentActivitySnapshot(transactions)}
  `;
}

function renderBalanceCard(kid, balance, income, expenses) {
  return `
    <div class="balance-card">
      <div class="balance-label">${escapeHtml(kid.name)}'s Balance</div>
      <div class="balance-amount">${formatMoney(balance)}</div>
      <div class="balance-stats">
        <div class="balance-stat">
          <span class="stat-dot income"></span>
          In: ${formatMoney(income)}
        </div>
        <div class="balance-stat">
          <span class="stat-dot expense"></span>
          Out: ${formatMoney(expenses)}
        </div>
      </div>
    </div>
  `;
}

function renderQuickActions() {
  return `
    <div class="quick-actions">
      <button class="action-btn add" onclick="openTransactionModal('income')">+ Add</button>
      <button class="action-btn spend" onclick="openTransactionModal('expense')">- Spend</button>
      <button class="action-btn goal" onclick="navigateTo('goals')">🎯 Goals</button>
    </div>
  `;
}

function renderGoalsSnapshot(goals, balance) {
  if (goals.length === 0) return '';
  return `
    <div class="section">
      <div class="section-header">
        <h3 class="section-title">Goals</h3>
        <button class="section-link" onclick="navigateTo('goals')">See All</button>
      </div>
      <div class="goals-list">
        ${goals.slice(0, 2).map(g => renderGoalCardCompact(g, balance)).join('')}
      </div>
    </div>
  `;
}

function renderGoalCardCompact(goal, balance) {
  const percent = goal.target > 0 ? Math.min(100, Math.round((balance / goal.target) * 100)) : 0;
  const isComplete = percent >= 100;
  return `
    <div class="goal-card compact">
      <div class="goal-top">
        <div class="goal-name">🎯 ${escapeHtml(goal.name)}</div>
        <div class="goal-amount">${formatMoney(balance)} / ${formatMoney(goal.target)}</div>
      </div>
      <div class="goal-progress-bar">
        <div class="goal-progress-fill ${isComplete ? 'complete' : ''}" style="width: ${percent}%"></div>
      </div>
      <div class="goal-percent">${isComplete ? '🎉 Goal reached!' : `${percent}% saved`}</div>
    </div>
  `;
}

function renderWishlistSnapshot(wishlist) {
  if (wishlist.length === 0) return '';
  return `
    <div class="section">
      <div class="section-header">
        <h3 class="section-title">Wishlist</h3>
        <button class="section-link" onclick="navigateTo('goals')">See All</button>
      </div>
      <div class="wishlist-list">
        ${wishlist.slice(0, 2).map(w => renderWishlistCardCompact(w)).join('')}
      </div>
    </div>
  `;
}

function renderWishlistCardCompact(item) {
  const hasImage = item.image;
  return `
    <div class="wishlist-card compact" onclick="navigateTo('goals')">
      <div class="wishlist-top">
        ${hasImage ? `<img class="wishlist-image" src="${escapeHtml(item.image)}" alt="" onerror="this.style.display='none'">` : ''}
        <div class="wishlist-info">
          <div class="wishlist-name">${escapeHtml(item.name)}</div>
          <div class="wishlist-price">${formatMoney(item.price)}</div>
        </div>
      </div>
    </div>
  `;
}

function renderRecentActivitySnapshot(transactions) {
  return `
    <div class="section">
      <div class="section-header">
        <h3 class="section-title">Recent Activity</h3>
        ${transactions.length > 0 ? `
          <button class="section-link" onclick="navigateTo('activity')">See All</button>
        ` : ''}
      </div>
      ${transactions.length > 0 ? `
        <div class="transaction-list">
          ${transactions.map(t => renderTransaction(t)).join('')}
        </div>
      ` : `
        <div class="empty-state">
          <div class="empty-icon">📭</div>
          <p>No transactions yet. Add some money to get started!</p>
        </div>
      `}
    </div>
  `;
}

// ─── Activity Page ────────────────────────────────────────────
function renderActivityPage() {
  const kid = getActiveKid();
  if (!kid) return '<p>No kids set up.</p>';
  const transactions = getKidTransactions(kid.id);

  return `
    <div class="page-actions">
      <button class="action-btn add" onclick="openTransactionModal('income')">+ Add Money</button>
      <button class="action-btn spend" onclick="openTransactionModal('expense')">- Spend</button>
    </div>

    ${transactions.length > 0 ? `
      <div class="transaction-list">
        ${transactions.map(t => renderTransaction(t)).join('')}
      </div>
    ` : `
      <div class="empty-state">
        <div class="empty-icon">📭</div>
        <p>No transactions yet for ${escapeHtml(kid.name)}.</p>
      </div>
    `}
  `;
}

// ─── Goals Page ───────────────────────────────────────────────
function renderGoalsPage() {
  const kid = getActiveKid();
  if (!kid) return '<p>No kids set up.</p>';
  const balance = getBalance(kid.id);
  const goals = getKidGoals(kid.id);
  const wishlist = getKidWishlist(kid.id);

  return `
    <div class="page-actions">
      <button class="action-btn goal" onclick="openModal('goal')">🎯 New Goal</button>
      <button class="action-btn wishlist-add" onclick="openWishlistModal()">🔗 Add from Web</button>
    </div>

    <div class="section">
      <div class="section-header">
        <h3 class="section-title">Saving Goals</h3>
      </div>
      ${goals.length > 0 ? `
        <div class="goals-list">
          ${goals.map(g => renderGoalCard(g, balance)).join('')}
        </div>
      ` : `
        <div class="empty-state">
          <div class="empty-icon">🎯</div>
          <p>No saving goals yet. Create one to start tracking!</p>
        </div>
      `}
    </div>

    <div class="section">
      <div class="section-header">
        <h3 class="section-title">Wishlist</h3>
      </div>
      ${wishlist.length > 0 ? `
        <div class="wishlist-list">
          ${wishlist.map(w => renderWishlistCard(w)).join('')}
        </div>
      ` : `
        <div class="empty-state">
          <div class="empty-icon">✨</div>
          <p>No wishlist items yet. Paste a product link to add one!</p>
        </div>
      `}
    </div>
  `;
}

// ─── Settings Page ────────────────────────────────────────────
function renderSettingsPage() {
  const stateOptions = Object.entries(STATE_TAX_RATES).map(([code, info]) => {
    const rateLabel = code === '' ? '' : (info.rate === 0 ? ' (no tax)' : ` (${info.rate}%)`);
    return `<option value="${code}" ${code === selectedState ? 'selected' : ''}>${code === '' ? '-- No sales tax --' : info.name}${rateLabel}</option>`;
  }).join('');

  return `
    <div class="settings-section">
      <label class="settings-section-label">Kids</label>
      ${state.kids.map((kid, i) => `
        <div class="settings-kid">
          <input type="text" value="${escapeHtml(kid.name)}" onchange="renameKid(${i}, this.value)" placeholder="Name">
          ${state.kids.length > 1 ? `
            <button class="remove-kid" onclick="confirmRemoveKid(${i})">✕</button>
          ` : ''}
        </div>
      `).join('')}
      <button class="add-kid-btn" onclick="addKid()">+ Add Another Kid</button>
    </div>

    <div class="settings-section">
      <label class="settings-section-label">Default Sales Tax State</label>
      <div class="form-group" style="margin-bottom:0">
        <select id="settingsState" onchange="updateDefaultState(this.value)">
          ${stateOptions}
        </select>
      </div>
    </div>

    <div class="settings-section">
      <label class="settings-section-label">About</label>
      <p class="settings-about">KidCash helps families track kids' money without needing a bank account. Your data syncs securely across all your devices.</p>
    </div>

    <div class="settings-section">
      <label class="settings-section-label">Account</label>
      <p class="settings-user-email">Signed in as ${escapeHtml(currentUser?.email || 'Unknown')}</p>
      <button class="signout-btn" onclick="handleSignOut()">Sign Out</button>
    </div>
  `;
}

// ─── Reusable Card Components ────────────────────────────────
function renderGoalCard(goal, balance) {
  const percent = goal.target > 0 ? Math.min(100, Math.round((balance / goal.target) * 100)) : 0;
  const isComplete = percent >= 100;
  return `
    <div class="goal-card">
      <div class="goal-top">
        <div class="goal-name">🎯 ${escapeHtml(goal.name)}</div>
        <div class="goal-amount">${formatMoney(balance)} / ${formatMoney(goal.target)}</div>
      </div>
      <div class="goal-progress-bar">
        <div class="goal-progress-fill ${isComplete ? 'complete' : ''}" style="width: ${percent}%"></div>
      </div>
      <div class="goal-percent">${isComplete ? '🎉 Goal reached!' : `${percent}% saved`}</div>
      <div class="goal-actions">
        <button class="goal-action-btn delete" onclick="confirmDeleteGoal('${sanitizeId(goal.id)}')">Remove</button>
      </div>
    </div>
  `;
}

function renderTransaction(t) {
  const icon = getCategoryIcon(t.type, t.category);
  const taxInfo = t.tax ? `<span class="tx-tax">incl. ${formatMoney(t.tax)} tax (${escapeHtml(t.taxState || '')})</span>` : '';
  return `
    <div class="transaction-item">
      <div class="tx-icon ${t.type}">${icon}</div>
      <div class="tx-details">
        <div class="tx-description">${escapeHtml(t.description)}</div>
        <div class="tx-date">${formatDate(t.timestamp)}${taxInfo}</div>
      </div>
      <div class="tx-amount ${t.type}">${t.type === 'income' ? '+' : '-'}${formatMoney(t.amount)}</div>
      <button class="tx-delete" onclick="confirmDeleteTransaction('${sanitizeId(t.id)}')" title="Delete">✕</button>
    </div>
  `;
}

function renderWishlistCard(item) {
  const hasImage = item.image;
  return `
    <div class="wishlist-card">
      <div class="wishlist-top">
        ${hasImage ? `<img class="wishlist-image" src="${escapeHtml(item.image)}" alt="" onerror="this.style.display='none'">` : ''}
        <div class="wishlist-info">
          <div class="wishlist-name">${escapeHtml(item.name)}</div>
          <div class="wishlist-price">${formatMoney(item.price)}</div>
          <a class="wishlist-link" href="${sanitizeUrl(item.url)}" target="_blank" rel="noopener">View product ↗</a>
        </div>
      </div>
      <div class="wishlist-actions">
        <button class="wishlist-action-btn goal" onclick="wishlistToGoal('${sanitizeId(item.id)}')">🎯 Set Goal</button>
        <button class="wishlist-action-btn buy" onclick="wishlistToPurchase('${sanitizeId(item.id)}')">🛒 Buy</button>
        <button class="wishlist-action-btn delete" onclick="confirmDeleteWishlistItem('${sanitizeId(item.id)}')">Remove</button>
      </div>
    </div>
  `;
}

// ─── Modals ──────────────────────────────────────────────────
function renderModal() {
  if (modalOpen === 'transaction') return renderTransactionModal();
  if (modalOpen === 'goal') return renderGoalModal();
  if (modalOpen === 'wishlist') return renderWishlistModal();
  return '';
}

function renderTransactionModal() {
  const categories = CATEGORIES[txType];
  const stateOptions = Object.entries(STATE_TAX_RATES).map(([code, info]) => {
    const rateLabel = code === '' ? '' : (info.rate === 0 ? ' (no tax)' : ` (${info.rate}%)`);
    return `<option value="${code}" ${code === selectedState ? 'selected' : ''}>${code === '' ? '-- No sales tax --' : info.name}${rateLabel}</option>`;
  }).join('');

  return `
    <div class="modal-overlay open" onclick="handleOverlayClick(event)">
      <div class="modal">
        <div class="modal-handle"></div>
        <h2>${txType === 'income' ? 'Add Money' : 'Record Spending'}</h2>
        <div class="type-toggle">
          <button class="${txType === 'income' ? 'active-income' : ''}" onclick="setTxType('income')">💵 Add Money</button>
          <button class="${txType === 'expense' ? 'active-expense' : ''}" onclick="setTxType('expense')">🛒 Spending</button>
        </div>
        <div class="form-group">
          <label>${txType === 'expense' ? 'Price (before tax)' : 'Amount'}</label>
          <input type="number" id="txAmount" placeholder="0.00" step="0.01" min="0.01" inputmode="decimal" oninput="updateTaxPreview()">
        </div>
        ${txType === 'expense' ? `
          <div class="form-group">
            <label>Sales Tax State</label>
            <select id="txState" onchange="updateTaxPreview()">
              ${stateOptions}
            </select>
          </div>
          <div id="taxPreview" class="tax-preview" style="display:none">
            <div class="tax-row"><span>Subtotal</span><span id="taxSubtotal">$0.00</span></div>
            <div class="tax-row"><span>Tax (<span id="taxRateLabel">0%</span>)</span><span id="taxAmount">$0.00</span></div>
            <div class="tax-row tax-total"><span>Total</span><span id="taxTotal">$0.00</span></div>
          </div>
        ` : ''}
        <div class="form-group">
          <label>Description</label>
          <input type="text" id="txDescription" placeholder="${txType === 'income' ? 'e.g., Birthday money from Grandma' : 'e.g., New toy from Target'}">
        </div>
        <div class="form-group">
          <label>Category</label>
          <select id="txCategory">
            ${categories.map(c => `<option value="${c.value}">${c.icon} ${c.label}</option>`).join('')}
          </select>
        </div>
        <button class="submit-btn ${txType === 'income' ? 'green' : ''}" onclick="submitTransaction()" style="${txType === 'expense' ? 'background:var(--red)' : ''}">
          ${txType === 'income' ? 'Add Money' : 'Record Spending'}
        </button>
      </div>
    </div>
  `;
}

function renderGoalModal() {
  return `
    <div class="modal-overlay open" onclick="handleOverlayClick(event)">
      <div class="modal">
        <div class="modal-handle"></div>
        <h2>New Saving Goal</h2>
        <div class="form-group">
          <label>What are you saving for?</label>
          <input type="text" id="goalName" placeholder="e.g., New bicycle">
        </div>
        <div class="form-group">
          <label>Target Amount</label>
          <input type="number" id="goalTarget" placeholder="0.00" step="0.01" min="0.01" inputmode="decimal">
        </div>
        <button class="submit-btn" onclick="submitGoal()">Create Goal</button>
      </div>
    </div>
  `;
}

function renderWishlistModal() {
  const statusHtml = fetchStatus === 'loading'
    ? '<div class="fetch-status loading">Fetching product info...</div>'
    : fetchStatus === 'error'
    ? '<div class="fetch-status error">Could not auto-fetch. Enter details manually.</div>'
    : fetchStatus === 'done'
    ? '<div class="fetch-status success">Product info found!</div>'
    : '';

  const imagePreview = fetchedProduct.image
    ? `<img class="fetch-image-preview" src="${escapeHtml(fetchedProduct.image)}" alt="" onerror="this.style.display='none'">`
    : '';

  return `
    <div class="modal-overlay open" onclick="handleOverlayClick(event)">
      <div class="modal">
        <div class="modal-handle"></div>
        <h2>Add from Website</h2>
        <div class="form-group">
          <label>Product URL</label>
          <div class="url-input-group">
            <input type="url" id="wishlistUrl" placeholder="Paste product link here..." inputmode="url">
            <button class="fetch-btn" onclick="doFetchProduct()" ${fetchStatus === 'loading' ? 'disabled' : ''}>
              ${fetchStatus === 'loading' ? '...' : 'Fetch'}
            </button>
          </div>
        </div>
        ${statusHtml}
        ${imagePreview}
        <div class="form-group">
          <label>Product Name</label>
          <input type="text" id="wishlistName" placeholder="e.g., LEGO Star Wars Set" value="${escapeHtml(fetchedProduct.name)}">
        </div>
        <div class="form-group">
          <label>Price</label>
          <input type="number" id="wishlistPrice" placeholder="0.00" step="0.01" min="0.01" inputmode="decimal" ${fetchedProduct.price ? `value="${fetchedProduct.price}"` : ''}>
        </div>
        <button class="submit-btn" onclick="submitWishlistItem()" style="background:var(--purple)">Save to Wishlist</button>
      </div>
    </div>
  `;
}

function renderConfirm() {
  if (!confirmAction) return '';
  return `
    <div class="confirm-overlay" onclick="cancelConfirm()">
      <div class="confirm-box" onclick="event.stopPropagation()">
        <p>${confirmAction.message}</p>
        <div class="confirm-actions">
          <button class="confirm-cancel" onclick="cancelConfirm()">Cancel</button>
          <button class="confirm-delete" onclick="executeConfirm()">Delete</button>
        </div>
      </div>
    </div>
  `;
}

// ─── Event Handlers ───────────────────────────────────────────
function bindEvents() {
  if (modalOpen === 'transaction') {
    setTimeout(() => {
      const el = document.getElementById('txAmount');
      if (el) el.focus();
    }, 100);
  }
  if (modalOpen === 'goal') {
    setTimeout(() => {
      const el = document.getElementById('goalName');
      if (el) el.focus();
    }, 100);
  }
  if (modalOpen === 'wishlist') {
    setTimeout(() => {
      const el = document.getElementById('wishlistUrl');
      if (el) el.focus();
    }, 100);
  }
  if (modalOpen === 'transaction' && pendingWishlistPurchase) {
    setTimeout(() => {
      const amtEl = document.getElementById('txAmount');
      const descEl = document.getElementById('txDescription');
      if (amtEl && !amtEl.value) amtEl.value = (pendingWishlistPurchase.price / 100).toFixed(2);
      if (descEl && !descEl.value) descEl.value = pendingWishlistPurchase.name;
      updateTaxPreview();
    }, 100);
  }
}

window.switchKid = function(index) {
  state.activeKidIndex = index;
  saveData(state);
  render();
};

window.openTransactionModal = function(type) {
  txType = type;
  modalOpen = 'transaction';
  render();
};

window.openModal = function(type) {
  modalOpen = type;
  render();
};

window.closeModal = function() {
  modalOpen = null;
  render();
};

window.handleOverlayClick = function(e) {
  if (e.target.classList.contains('modal-overlay')) {
    closeModal();
  }
};

window.setTxType = function(type) {
  txType = type;
  render();
};

window.updateTaxPreview = function() {
  if (txType !== 'expense') return;
  const amountStr = document.getElementById('txAmount')?.value;
  const stateCode = document.getElementById('txState')?.value || '';
  const preview = document.getElementById('taxPreview');
  if (!preview) return;
  const amountCents = parseMoney(amountStr);
  const info = STATE_TAX_RATES[stateCode];
  if (!amountCents || !stateCode || !info || info.rate === 0) {
    preview.style.display = 'none';
    return;
  }
  const taxCents = calcTax(amountCents, stateCode);
  const totalCents = amountCents + taxCents;
  document.getElementById('taxSubtotal').textContent = formatMoney(amountCents);
  document.getElementById('taxRateLabel').textContent = info.rate + '%';
  document.getElementById('taxAmount').textContent = formatMoney(taxCents);
  document.getElementById('taxTotal').textContent = formatMoney(totalCents);
  preview.style.display = 'block';
};

window.submitTransaction = function() {
  const subtotal = parseMoney(document.getElementById('txAmount').value);
  const description = document.getElementById('txDescription').value.trim();
  const category = document.getElementById('txCategory').value;
  const kid = getActiveKid();
  if (!subtotal) { shakeElement('txAmount'); return; }
  let taxCents = 0;
  let taxState = '';
  let taxRate = 0;
  if (txType === 'expense') {
    const stateEl = document.getElementById('txState');
    taxState = stateEl ? stateEl.value : '';
    if (taxState) {
      selectedState = taxState;
      localStorage.setItem('kidcash_state', taxState);
      const info = STATE_TAX_RATES[taxState];
      if (info && info.rate > 0) {
        taxRate = info.rate;
        taxCents = calcTax(subtotal, taxState);
      }
    }
  }
  const totalAmount = txType === 'expense' ? subtotal + taxCents : subtotal;
  state.transactions.push({
    id: generateId(),
    kidId: kid.id,
    type: txType,
    amount: totalAmount,
    subtotal: txType === 'expense' ? subtotal : undefined,
    tax: taxCents || undefined,
    taxRate: taxRate || undefined,
    taxState: taxState || undefined,
    description: description || (txType === 'income' ? 'Added money' : 'Purchase'),
    category,
    timestamp: Date.now(),
  });
  saveData(state);
  modalOpen = null;
  render();
};

window.submitGoal = function() {
  const name = document.getElementById('goalName').value.trim();
  const target = parseMoney(document.getElementById('goalTarget').value);
  const kid = getActiveKid();
  if (!name) { shakeElement('goalName'); return; }
  if (!target) { shakeElement('goalTarget'); return; }
  state.goals.push({
    id: generateId(),
    kidId: kid.id,
    name,
    target,
  });
  saveData(state);
  modalOpen = null;
  render();
};

window.confirmDeleteTransaction = function(id) {
  confirmAction = {
    message: 'Delete this transaction? This will update the balance.',
    action: () => {
      state.transactions = state.transactions.filter(t => t.id !== id);
      saveData(state);
    },
  };
  render();
};

window.confirmDeleteGoal = function(id) {
  confirmAction = {
    message: 'Remove this saving goal?',
    action: () => {
      state.goals = state.goals.filter(g => g.id !== id);
      saveData(state);
    },
  };
  render();
};

window.confirmRemoveKid = function(index) {
  const kid = state.kids[index];
  confirmAction = {
    message: `Remove ${escapeHtml(kid.name)}? This will delete all their transactions and goals.`,
    action: () => {
      const kidId = kid.id;
      state.kids.splice(index, 1);
      state.transactions = state.transactions.filter(t => t.kidId !== kidId);
      state.goals = state.goals.filter(g => g.kidId !== kidId);
      if (state.activeKidIndex >= state.kids.length) {
        state.activeKidIndex = state.kids.length - 1;
      }
      saveData(state);
    },
  };
  render();
};

window.executeConfirm = function() {
  if (confirmAction && confirmAction.action) {
    confirmAction.action();
  }
  confirmAction = null;
  render();
};

window.cancelConfirm = function() {
  confirmAction = null;
  render();
};

window.renameKid = function(index, name) {
  if (name.trim()) {
    state.kids[index].name = name.trim();
    saveData(state);
  }
};

window.addKid = function() {
  state.kids.push({ id: generateId(), name: `Kid ${state.kids.length + 1}` });
  saveData(state);
  render();
};

window.updateDefaultState = function(stateCode) {
  selectedState = stateCode;
  localStorage.setItem('kidcash_state', stateCode);
};

// ─── Wishlist Handlers ────────────────────────────────────────
window.openWishlistModal = function() {
  fetchStatus = null;
  fetchedProduct = { name: '', price: '', image: null };
  modalOpen = 'wishlist';
  render();
};

window.doFetchProduct = async function() {
  const urlInput = document.getElementById('wishlistUrl');
  let url = urlInput?.value?.trim();
  if (!url) { shakeElement('wishlistUrl'); return; }
  if (!url.startsWith('http')) url = 'https://' + url;
  fetchStatus = 'loading';
  render();
  const result = await fetchProductInfo(url);
  if (result && (result.name || result.price)) {
    fetchedProduct = result;
    fetchStatus = 'done';
  } else {
    fetchStatus = 'error';
  }
  render();
  setTimeout(() => {
    const el = document.getElementById('wishlistUrl');
    if (el) el.value = url;
  }, 50);
};

window.submitWishlistItem = function() {
  const url = document.getElementById('wishlistUrl')?.value?.trim();
  const name = document.getElementById('wishlistName')?.value?.trim();
  const price = parseMoney(document.getElementById('wishlistPrice')?.value);
  const kid = getActiveKid();
  if (!name) { shakeElement('wishlistName'); return; }
  if (!price) { shakeElement('wishlistPrice'); return; }
  state.wishlist.push({
    id: generateId(),
    kidId: kid.id,
    name,
    price,
    url: url || '',
    image: fetchedProduct.image || null,
    addedAt: Date.now(),
  });
  saveData(state);
  fetchStatus = null;
  fetchedProduct = { name: '', price: '', image: null };
  modalOpen = null;
  render();
};

window.wishlistToGoal = function(id) {
  const item = state.wishlist.find(w => w.id === id);
  if (!item) return;
  const kid = getActiveKid();
  state.goals.push({
    id: generateId(),
    kidId: kid.id,
    name: item.name,
    target: item.price,
  });
  saveData(state);
  render();
};

window.wishlistToPurchase = function(id) {
  const item = state.wishlist.find(w => w.id === id);
  if (!item) return;
  pendingWishlistPurchase = item;
  txType = 'expense';
  modalOpen = 'transaction';
  render();
};

window.confirmDeleteWishlistItem = function(id) {
  confirmAction = {
    message: 'Remove this item from the wishlist?',
    action: () => {
      state.wishlist = state.wishlist.filter(w => w.id !== id);
      saveData(state);
    },
  };
  render();
};

// Clear pending wishlist purchase after transaction is submitted
const origSubmitTransaction = window.submitTransaction;
window.submitTransaction = function() {
  const pending = pendingWishlistPurchase;
  origSubmitTransaction();
  if (pending && modalOpen === null) {
    state.wishlist = state.wishlist.filter(w => w.id !== pending.id);
    pendingWishlistPurchase = null;
    saveData(state);
    render();
  }
};

// ─── Auth Handlers ───────────────────────────────────────────
window.toggleAuthMode = function() {
  authMode = authMode === 'login' ? 'signup' : 'login';
  authError = '';
  render();
};

function friendlyAuthError(code) {
  switch (code) {
    case 'auth/email-already-in-use': return 'An account with this email already exists.';
    case 'auth/invalid-email': return 'Please enter a valid email address.';
    case 'auth/user-not-found': return 'No account found with this email.';
    case 'auth/wrong-password': return 'Incorrect password.';
    case 'auth/weak-password': return 'Password must be at least 6 characters.';
    case 'auth/too-many-requests': return 'Too many attempts. Please try again later.';
    case 'auth/invalid-credential': return 'Invalid email or password.';
    case 'auth/popup-closed-by-user': return 'Sign-in popup was closed.';
    default: return 'Something went wrong. Please try again.';
  }
}

window.handleAuth = async function() {
  const email = document.getElementById('authEmail')?.value?.trim();
  const password = document.getElementById('authPassword')?.value;
  if (!email || !password) {
    authError = 'Please enter your email and password.';
    render();
    return;
  }
  if (authMode === 'signup') {
    const confirm = document.getElementById('authPasswordConfirm')?.value;
    if (password !== confirm) {
      authError = 'Passwords do not match.';
      render();
      return;
    }
  }
  authBusy = true;
  authError = '';
  render();
  try {
    if (authMode === 'signup') {
      await fbCreateAccount(firebaseAuth, email, password);
    } else {
      await fbSignInWithEmail(firebaseAuth, email, password);
    }
    // onAuthStateChanged will handle the rest
  } catch (e) {
    authBusy = false;
    authError = friendlyAuthError(e.code);
    render();
  }
};

window.handleGoogleSignIn = function() {
  authBusy = true;
  authError = '';
  // Use redirect instead of popup — more reliable across browsers/mobile
  fbSignInWithGoogle(firebaseAuth, firebaseGoogleProvider);
  // Page will redirect to Google, then back. initAuth() handles the result.
};

window.handleSignOut = async function() {
  try {
    await fbSignOut(firebaseAuth);
    currentUser = null;
    state = getDefaultData();
    state.wishlist = [];
    currentView = 'home';
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem('kidcash_state');
    render();
  } catch (e) {
    console.error('Sign out failed:', e);
  }
};

// ─── Helpers ──────────────────────────────────────────────────
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function sanitizeUrl(url) {
  if (!url) return '#';
  try {
    const parsed = new URL(url, 'https://placeholder.com');
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return escapeHtml(url);
  } catch {}
  return '#';
}

function sanitizeId(id) {
  return typeof id === 'string' ? id.replace(/[^a-z0-9]/gi, '') : '';
}

function shakeElement(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.style.borderColor = 'var(--red)';
  el.style.animation = 'none';
  el.offsetHeight;
  el.style.animation = 'shake 0.4s ease';
  setTimeout(() => { el.style.borderColor = ''; }, 1500);
}

const shakeStyle = document.createElement('style');
shakeStyle.textContent = `
  @keyframes shake {
    0%, 100% { transform: translateX(0); }
    20%, 60% { transform: translateX(-6px); }
    40%, 80% { transform: translateX(6px); }
  }
`;
document.head.appendChild(shakeStyle);

// ─── Init ─────────────────────────────────────────────────────

// Show loading spinner immediately
render();

async function initAuth() {
  // Check for Google redirect result (user returning from Google sign-in)
  try {
    await window.fbGetRedirectResult(firebaseAuth);
  } catch (e) {
    console.error('Redirect sign-in error:', e);
    authError = friendlyAuthError(e.code);
    authBusy = false;
    appReady = true;
    render();
  }

  fbOnAuthStateChanged(firebaseAuth, async (user) => {
    if (user) {
      currentUser = user;
      authBusy = false;
      appReady = false;
      render(); // show spinner while loading data
      await loadFromFirestore(user.uid);
      appReady = true;
      render();
    } else {
      currentUser = null;
      authBusy = false;
      appReady = true;
      render();
    }
  });
}

// Firebase module loads async — wait for it
if (window.fbOnAuthStateChanged) {
  initAuth();
} else {
  window.addEventListener('firebase-ready', initAuth);
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
